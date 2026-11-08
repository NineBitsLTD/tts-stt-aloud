import { appendFile, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { encodeOnnxMetadata, readOnnxMetadata } from '../utils/readOnnxMetadata';
import { copy, download, exists, ModelStore } from './ModelStore';

/** @typedef {import('./SpeechSettings').SpeechSettings} SpeechSettings */
/** @typedef {import('./ModelStore').StoredModel} PiperModel a voice model; lang: of its config (`ru_RU`), else the voice of espeak (`ru`); ready: prepared for sherpa-onnx — its metadata and `tokens.txt` */

/** The voices of Piper, published by its authors. */
const REPOSITORY = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/';
const CATALOG = `${REPOSITORY}voices.json`;

/**
 * @typedef {object} PiperVoice a voice of the catalog
 * @property {string} key `ru_RU-irina-medium`
 * @property {string} lang `ru_RU`
 * @property {string} language `Russian (Русский), Russia`
 * @property {string} quality x_low, low, medium, high
 * @property {number} size bytes of the model
 * @property {boolean} added whether it is in the list already
 */

/**
 * @param {string} path of an `.onnx` model
 * @returns {Promise<{ lang: string } | null>} what its config (`<model>.onnx.json`) tells (null: no config)
 */
async function readConfig(path) {
    try {
        const config = JSON.parse(await readFile(`${path}.json`, 'utf8'));
        return { lang: String(config?.language?.code ?? config?.espeak?.voice ?? '') };
    } catch {
        return null;
    }
}

/**
 * The metadata sherpa-onnx needs in a Piper model (`model_type`: vits, `comment`: piper, language,
 * voice, has_espeak, n_speakers, sample_rate), written by its conversion script at the end of the model.
 * @param {string} path of an `.onnx` model
 * @returns {Promise<Record<string, string> | null>} null: not prepared for sherpa-onnx
 */
export async function readSherpaMeta(path) {
    const meta = await readOnnxMetadata(path);
    return meta?.model_type && meta.comment === 'piper' ? meta : null;
}

/**
 * @param {any} config of a Piper model (`<model>.onnx.json`)
 * @returns {Record<string, string | number>} the metadata the script of sherpa-onnx writes for it
 */
export function sherpaMetaOf(config) {
    return {
        model_type: 'vits',
        comment: 'piper',
        language: config?.language?.name_english ?? config?.espeak?.voice ?? '',
        voice: config?.espeak?.voice ?? '',
        has_espeak: Number(!!config && 'espeak' in config),
        n_speakers: config?.num_speakers ?? 1,
        sample_rate: config?.audio?.sample_rate ?? 22050,
    };
}

/**
 * @param {any} config of a Piper model
 * @returns {string} its `tokens.txt` for sherpa-onnx: a phoneme and its id a line, by id
 */
export function tokensOf(config) {
    return Object.entries(config?.phoneme_id_map ?? {})
        .sort(([, a], [, b]) => a[0] - b[0])
        .map(([phoneme, ids]) => `${phoneme} ${ids[0]}\n`).join('');
}

/**
 * The voice models of Piper (`ttsSttMdAloud.tts.models.piper`), for sherpa-onnx — the engine Piper
 * speaks with (`PiperSpeech`). A voice of the catalog of Piper (rhasspy/piper-voices on Hugging
 * Face) is downloaded into the storage of the extension (`piper/<voice>/`), a model of Piper chosen
 * on the disk (with its `.onnx.json`) is copied there — the file on the disk stays as it is —, and
 * there it is prepared as the script of sherpa-onnx prepares it: its metadata appended to the
 * model, `tokens.txt` from the config; the progress is in a notification that can cancel it. A
 * model prepared for sherpa-onnx already (its metadata, `tokens.txt` next to it: vits-piper-…) is
 * used where it is. Removing a model of the storage deletes its folder; a model used where it is
 * only leaves the list.
 */
export class PiperModels extends ModelStore {

    /**
     * @param {import('vscode').ExtensionContext} context
     * @param {SpeechSettings} settings
     */
    constructor(context, settings) {
        super(context, settings, { section: 'tts', driver: 'piper', label: 'Piper voice' });
        /** @type {Promise<Record<string, any>> | null} the catalog, loaded once a session */
        this._catalog = null;
    }

    /**
     * @param {string} path
     * @returns {Promise<PiperModel>}
     */
    async describe(path) {
        const model = await super.describe(path);
        const meta = model.exists ? await readSherpaMeta(path) : null;
        return {
            ...model,
            lang: (await readConfig(path))?.lang || meta?.voice || '',
            ready: !!meta && await exists(join(dirname(path), 'tokens.txt')),
        };
    }

    /**
     * @returns {Promise<PiperVoice[]>} the voices of the catalog, by language and name
     */
    async catalog() {
        this._catalog ??= fetch(CATALOG).then((response) => {
            if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
            return response.json();
        });
        let voices;
        try {
            voices = await this._catalog;
        } catch (error) {
            this._catalog = null;
            throw new Error(`The list of Piper voices could not be loaded: ${error?.message || error}`);
        }
        const added = new Set(this.paths().map(path => this.nameOf(path)));
        return Object.values(voices).map((voice) => {
            const language = voice.language ?? {};
            const model = Object.entries(voice.files ?? {}).find(([path]) => path.endsWith('.onnx'));
            return {
                key: String(voice.key),
                lang: String(language.code ?? ''),
                language: `${language.name_english ?? ''}${language.name_native && language.name_native !== language.name_english ? ` (${language.name_native})` : ''}${language.country_english ? `, ${language.country_english}` : ''}`,
                quality: String(voice.quality ?? ''),
                size: Number(model?.[1]?.size_bytes) || 0,
                added: added.has(String(voice.key)) || this.pending.has(String(voice.key)),
            };
        }).sort((a, b) => a.lang.localeCompare(b.lang) || a.key.localeCompare(b.key));
    }

    /**
     * Adds a model chosen on the disk: one prepared for sherpa-onnx (its metadata, `tokens.txt` next
     * to it) where it is; else, with its config `<model>.onnx.json` next to it, a copy prepared in the
     * storage (it begins here, the model is added when it is ready).
     * @param {string} path
     * @returns {Promise<string>} why it is not added ('' : added, or its copy began)
     */
    async addFile(path) {
        if (!/\.onnx$/i.test(path)) return 'Choose an .onnx file: a Piper voice model.';
        const info = await stat(path).catch(() => null);
        if (!info?.isFile()) return `There is no file ${path}.`;
        if (this.paths().includes(path)) return 'This model is in the list already.';
        if (await readSherpaMeta(path) && await exists(join(dirname(path), 'tokens.txt'))) {
            await this._settings.addModel(this.section, this.driver, path);
            return '';
        }
        const config = await stat(`${path}.json`).catch(() => null);
        if (!config?.isFile()) return `${basename(path)} cannot be prepared for sherpa-onnx: its config ${basename(path)}.json is not next to it.`;
        const name = this.nameOf(path);
        const refused = await this.refuseName(name);
        if (refused) return refused;
        this.install(name, 'preparing', config.size + info.size, (folder, options) => this._prepare(folder, name, {
            config: target => copy(`${path}.json`, target, { ...options, size: config.size }),
            model: (target, transform) => copy(path, target, { ...options, size: info.size, transform }),
        }));
        return '';
    }

    /**
     * Begins downloading a voice of the catalog (its model and config) and preparing it for
     * sherpa-onnx; the model is added when it is ready.
     * @param {string} key
     * @returns {Promise<string>} why it does not begin ('' : it began)
     */
    async download(key) {
        const listed = (await this.catalog()).find(item => item.key === key);
        const voice = (await this._catalog)[key];
        if (!listed || !voice) return `There is no Piper voice ${key}.`;
        if (this.pending.has(key)) return `${key} is being installed.`;
        if (listed.added || await exists(join(this.folder, key))) return 'This model is in the list already.';
        const remote = suffix => Object.entries(voice.files ?? {}).find(([path]) => path.endsWith(suffix));
        const [configPath, config] = remote('.onnx.json') ?? [];
        const [modelPath, model] = remote('.onnx') ?? [];
        if (!configPath || !modelPath) return `The catalog gives no model for ${key}.`;
        const url = path => REPOSITORY + path.split('/').map(encodeURIComponent).join('/');
        const size = file => Number(file?.size_bytes) || 0;
        this.install(key, 'downloading', size(config) + size(model), (folder, options) => this._prepare(folder, key, {
            config: target => download(url(configPath), target, { ...options, size: size(config) }),
            model: (target, transform) => download(url(modelPath), target, { ...options, size: size(model), transform }),
        }));
        return '';
    }

    /**
     * Writes a voice into its folder and prepares it for sherpa-onnx: `tokens.txt` from its config,
     * the metadata appended to the model when it has none.
     * @param {string} folder
     * @param {string} name
     * @param {{ config: (target: string) => Promise<void>, model: (target: string, transform: (part: string) => Promise<void>) => Promise<void> }} write
     * @returns {Promise<string>} the path of the model
     */
    async _prepare(folder, name, write) {
        const configPath = join(folder, `${name}.onnx.json`);
        const modelPath = join(folder, `${name}.onnx`);
        await write.config(configPath);
        const config = JSON.parse(await readFile(configPath, 'utf8'));
        await writeFile(join(folder, 'tokens.txt'), tokensOf(config));
        await write.model(modelPath, async (part) => {
            if (!(await readSherpaMeta(part))) await appendFile(part, encodeOnnxMetadata(sherpaMetaOf(config)));
        });
        return modelPath;
    }
}
