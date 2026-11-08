import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import * as vscode from 'vscode';
import { mergeSileroModel, SILERO_PARTS, SILERO_SPEAKERS, SILERO_VERSION, sileroTokens } from '../utils/mergeSileroModel';
import { readOnnxMetadata } from '../utils/readOnnxMetadata';
import { download, exists, ModelStore, save } from './ModelStore';

const t = vscode.l10n.t;

/** @typedef {import('./SpeechSettings').SpeechSettings} SpeechSettings */
/** @typedef {import('../utils/voiceLicense').VoiceLicense} VoiceLicense */
/** @typedef {import('./ModelStore').SaveOptions} SaveOptions */
/** @typedef {import('./ModelStore').StoredModel & { voices: string[], license: VoiceLicense }} SileroModel a joined model; voices: of its speakers, by their ids */

/** The release of silero-tts-onnx the catalog downloads; its files are checked by size. */
const RELEASE = 'https://github.com/some1-in-here/silero-tts-onnx/releases/download/v0.5.0/';
/** @type {Record<string, number>} the bytes of the files of that release, by part */
const RELEASE_SIZES = { dur_predictor: 2529033, pitch_predictor: 2528662, acoustic: 26440521, vocoder: 150783704 };
/** The license of the model, as its authors publish it. */
const LICENSE = /** @type {VoiceLicense} */ ({
    label: 'CC BY-NC-SA',
    kind: 'noncommercial',
    scope: 'model',
    text: 'CC BY-NC-SA 4.0: Silero Team (silero-models), exported to ONNX by silero-tts-onnx.',
    url: 'https://github.com/snakers4/silero-models/blob/master/LICENSE',
});

/**
 * @param {string} part
 * @returns {string} the name of its file
 */
function partFile(part) {
    return `${part}_${SILERO_VERSION}.onnx`;
}

/**
 * @param {string} path of an `.onnx` model
 * @returns {Promise<Record<string, string> | null>} the metadata of a model joined by this extension (null: not one)
 */
export async function readSileroMeta(path) {
    const meta = await readOnnxMetadata(path);
    return meta?.silero_version ? meta : null;
}

/**
 * The models of Silero (`ttsSttAloud.tts.models.silero`), spoken with by sherpa-onnx (`SileroSpeech`)
 * as if they were models of Piper. Silero publishes TorchScript only; silero-tts-onnx exports
 * `v5_6_ru` to ONNX in parts, which `mergeSileroModel` joins into one file with `tokens.txt` next to
 * it, in `silero/v5_6_ru/`: the parts downloaded from its release (the catalog, deleted once joined)
 * or chosen on the disk (any of them, the others next to it; they stay as they are). A joined model
 * chosen on the disk is used where it is. Nothing of a model is in the package of the extension:
 * under its license (CC BY-NC-SA 4.0, non-commercial), shown when it is chosen, each user gets it.
 */
export class SileroModels extends ModelStore {

    /**
     * @param {import('vscode').ExtensionContext} context
     * @param {SpeechSettings} settings
     */
    constructor(context, settings) {
        super(context, settings, { section: 'tts', driver: 'silero', label: t('Silero model') });
    }

    /**
     * @param {string} path
     * @returns {Promise<SileroModel>}
     */
    async describe(path) {
        const model = await super.describe(path);
        const meta = model.exists ? await readSileroMeta(path) : null;
        return {
            ...model,
            lang: meta ? 'ru' : '',
            ready: !!meta && await exists(join(dirname(path), 'tokens.txt')),
            voices: meta?.silero_speakers?.split(',') ?? [],
            license: LICENSE,
        };
    }

    /**
     * @returns {Promise<{ key: string, lang: string, language: string, quality: string, size: number, added: boolean }[]>} the catalog
     */
    async catalog() {
        return [{
            key: SILERO_VERSION,
            lang: 'ru',
            language: t('Russian: {0}', SILERO_SPEAKERS.join(', ')),
            quality: SILERO_VERSION,
            size: Object.values(RELEASE_SIZES).reduce((sum, size) => sum + size, 0),
            added: this.paths().some(path => this.nameOf(path) === SILERO_VERSION) || this.pending.has(SILERO_VERSION),
        }];
    }

    /**
     * @returns {Promise<VoiceLicense>} the license of the model of the catalog
     */
    async license() {
        return LICENSE;
    }

    /**
     * Adds what was chosen on the disk: a joined model where it is, or a part of `v5_6_ru`, joined with
     * those next to it into the storage (it begins here, the model is added when it is ready).
     * @param {string} path
     * @returns {Promise<string>} why it is not added ('' : added, or the joining began)
     */
    async addFile(path) {
        if (!(await stat(path).catch(() => null))?.isFile()) return t('There is no file {0}.', path);
        if (this.paths().includes(path)) return t('This model is in the list already.');
        if (/\.onnx$/i.test(path) && await readSileroMeta(path)) {
            if (!(await exists(join(dirname(path), 'tokens.txt')))) return t('Its tokens are not next to it: {0}.', 'tokens.txt');
            await this._settings.addModel(this.section, this.driver, path);
            return '';
        }
        const names = SILERO_PARTS.map(partFile);
        if (!names.includes(basename(path))) return t('Choose one of the files of {0}: {1}.', SILERO_VERSION, names.join(', '));
        const paths = Object.fromEntries(SILERO_PARTS.map(part => [part, join(dirname(path), partFile(part))]));
        const sizes = await Promise.all(Object.values(paths).map(file => stat(file).catch(() => null)));
        const missing = names.filter((name, index) => !sizes[index]?.isFile());
        if (missing.length) return t('Not next to it: {0}.', missing.join(', '));
        const refused = await this.refuseName(SILERO_VERSION);
        if (refused) return refused;
        this.install(SILERO_VERSION, 'preparing', sizes.reduce((sum, size) => sum + size.size, 0), (folder, options) => this._join(folder, paths, options));
        return '';
    }

    /**
     * Begins downloading the parts of the model of the catalog and joining them; added when ready.
     * @param {string} key
     * @returns {Promise<string>} why it does not begin ('' : it began)
     */
    async download(key) {
        if (key !== SILERO_VERSION) return t('There is no Silero model {0}.', key);
        const refused = await this.refuseName(key);
        if (refused) return refused;
        const total = Object.values(RELEASE_SIZES).reduce((sum, size) => sum + size, 0);
        this.install(key, 'downloading', total, async (folder, options) => {
            const paths = Object.fromEntries(SILERO_PARTS.map(part => [part, join(folder, partFile(part))]));
            for (const part of SILERO_PARTS) await download(RELEASE + partFile(part), paths[part], { ...options, size: RELEASE_SIZES[part] });
            const model = await this._join(folder, paths, { signal: options.signal, onBytes: () => {} });
            await Promise.all(Object.values(paths).map(file => rm(file, { force: true })));
            return model;
        });
        return '';
    }

    /**
     * @param {string} folder of the model in the storage
     * @param {Record<string, string>} paths of the parts
     * @param {SaveOptions} options
     * @returns {Promise<string>} the path of the joined model
     */
    async _join(folder, paths, options) {
        const parts = Object.fromEntries(await Promise.all(SILERO_PARTS.map(async part => [part, await readFile(paths[part])])));
        options.signal.throwIfAborted();
        const model = join(folder, `${SILERO_VERSION}.onnx`);
        await save(Readable.from(mergeSileroModel(parts)), model, options);
        await writeFile(join(folder, 'tokens.txt'), sileroTokens());
        return model;
    }
}
