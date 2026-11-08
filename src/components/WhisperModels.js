import { stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { readOnnxMetadata } from '../utils/readOnnxMetadata';
import { download, exists, ModelStore } from './ModelStore';

/** @typedef {import('./SpeechSettings').SpeechSettings} SpeechSettings */
/**
 * @typedef {import('./ModelStore').StoredModel & { languages: string[], multilingual: boolean, mels: number, files: WhisperFiles | null }} WhisperModel
 *   lang: `multilingual` or `en`; languages: the codes it recognizes; mels: the features of its encoder;
 *   ready: a Whisper model of sherpa-onnx with its decoder and tokens
 * @typedef {{ name: string, encoder: string, decoder: string, tokens: string }} WhisperFiles
 * @typedef {{ key: string, lang: string, language: string, quality: string, size: number, added: boolean }} WhisperEntry a model of the catalog
 */

/** The Whisper models of sherpa-onnx, by its author: `csukuangfj/sherpa-onnx-whisper-<key>`. */
const REPOSITORY = 'https://huggingface.co/csukuangfj/';
/** The models of the catalog, smallest first; the others multilingual (99 languages), but those `englishOnly`. */
const MODELS = ['tiny', 'base', 'small', 'medium', 'turbo', 'distil-large-v3', 'large-v3', 'tiny.en', 'base.en', 'small.en', 'distil-small.en', 'medium.en'];
/** The bytes at the end of an encoder read for its metadata (its lists of tokens and languages are long). */
const META_TAIL = 64 * 1024;

/**
 * @param {string} name of a Whisper model (`small`, `tiny.en`, `distil-large-v3`)
 * @returns {boolean} whether it knows English only: an `.en` model, or one of Distil-Whisper (`distil-…`:
 *   distilled on English speech only, while its metadata may call it multilingual — its tokens are)
 */
export function englishOnly(name) {
    return /\.en$/i.test(name) || /^distil-/i.test(name);
}

/**
 * @param {string} path of the encoder or the decoder of a Whisper model of sherpa-onnx
 *   (`<name>-encoder[.int8].onnx`)
 * @returns {WhisperFiles | null} its files, next to each other (null: not named so)
 */
export function whisperFiles(path) {
    const match = basename(path).match(/^(.+)-(?:encoder|decoder)((?:\.int8)?)\.onnx$/i);
    if (!match) return null;
    const [, name, int8] = match;
    const folder = dirname(path);
    return {
        name,
        encoder: join(folder, `${name}-encoder${int8}.onnx`),
        decoder: join(folder, `${name}-decoder${int8}.onnx`),
        tokens: join(folder, `${name}-tokens.txt`),
    };
}

/**
 * @param {string} encoder
 * @returns {Promise<Record<string, string> | null>} the metadata of a Whisper encoder of sherpa-onnx
 *   (`model_type` whisper-…, `is_multilingual`, `all_language_codes`, `n_mels`; null: not one)
 */
export async function readWhisperMeta(encoder) {
    const meta = await readOnnxMetadata(encoder, META_TAIL);
    return meta?.model_type?.startsWith('whisper') ? meta : null;
}

/**
 * The Whisper models (`ttsSttMdAloud.stt.models.whisper`) sherpa-onnx recognizes speech with
 * (`WhisperRecognizer`): an encoder, its decoder and tokens next to it (`<name>-encoder[.int8].onnx`,
 * `<name>-decoder[.int8].onnx`, `<name>-tokens.txt`, as sherpa-onnx exports them). One chosen on the
 * disk (the encoder or the decoder) is used where it is; one of the catalog — the int8 models of
 * the author of sherpa-onnx on Hugging Face — is downloaded into `whisper/<name>/`.
 */
export class WhisperModels extends ModelStore {

    /**
     * @param {import('vscode').ExtensionContext} context
     * @param {SpeechSettings} settings
     */
    constructor(context, settings) {
        super(context, settings, { section: 'stt', driver: 'whisper', label: 'Whisper model' });
        /** @type {Promise<(WhisperEntry & { files: { path: string, size: number }[] })[]> | null} the catalog, loaded once a session */
        this._catalog = null;
    }

    /**
     * @param {string} path
     * @returns {string} the name of the model (`small`, `tiny.en`)
     */
    nameOf(path) {
        return whisperFiles(path)?.name ?? super.nameOf(path);
    }

    /**
     * @param {string} path of the encoder
     * @returns {Promise<WhisperModel>}
     */
    async describe(path) {
        const model = await super.describe(path);
        const files = whisperFiles(path);
        const meta = model.exists ? await readWhisperMeta(path) : null;
        const decoder = files ? await stat(files.decoder).catch(() => null) : null;
        const multilingual = meta?.is_multilingual === '1' && !englishOnly(files?.name ?? '');
        return {
            ...model,
            lang: meta ? (multilingual ? 'multilingual' : 'en') : '',
            size: model.size + (decoder?.size ?? 0),
            ready: !!meta && !!decoder?.isFile() && await exists(files.tokens),
            languages: multilingual ? (meta.all_language_codes ?? '').split(',').filter(Boolean) : meta ? ['en'] : [],
            multilingual,
            mels: Number(meta?.n_mels) || 80,
            files,
        };
    }

    /**
     * @returns {Promise<WhisperEntry[]>} the models of the catalog with their sizes
     */
    async catalog() {
        this._catalog ??= Promise.all(MODELS.map(key => this._entry(key))).then(entries => entries.filter(Boolean));
        const entries = await this._catalog;
        if (!entries.length) {
            this._catalog = null;
            throw new Error('The list of Whisper models could not be loaded from Hugging Face.');
        }
        const added = new Set(this.paths().map(path => this.nameOf(path)));
        return entries.map(entry => ({
            key: entry.key, lang: entry.lang, language: entry.language, quality: entry.quality, size: entry.size,
            added: added.has(entry.key) || this.pending.has(entry.key),
        }));
    }

    /**
     * Adds a model chosen on the disk — its encoder or decoder —, used where it is.
     * @param {string} path
     * @returns {Promise<string>} why it is not added ('' : added)
     */
    async addFile(path) {
        const files = whisperFiles(path);
        if (!/\.onnx$/i.test(path) || !files) return 'Choose the encoder of a Whisper model of sherpa-onnx: <name>-encoder.onnx or <name>-encoder.int8.onnx.';
        if (!(await stat(files.encoder).catch(() => null))?.isFile()) return `There is no encoder ${files.encoder}.`;
        if (!(await readWhisperMeta(files.encoder))) return `${basename(files.encoder)} is not a Whisper model of sherpa-onnx: it has no metadata of one.`;
        if (!(await exists(files.decoder))) return `Its decoder is not next to it: ${basename(files.decoder)}.`;
        if (!(await exists(files.tokens))) return `Its tokens are not next to it: ${basename(files.tokens)}.`;
        if (this.paths().includes(files.encoder)) return 'This model is in the list already.';
        await this._settings.addModel(this.section, this.driver, files.encoder);
        return '';
    }

    /**
     * Begins downloading a model of the catalog (its encoder, decoder and tokens); added when ready.
     * @param {string} key
     * @returns {Promise<string>} why it does not begin ('' : it began)
     */
    async download(key) {
        await this.catalog();
        const entry = (await this._catalog).find(item => item.key === key);
        if (!entry) return `There is no Whisper model ${key}.`;
        const refused = await this.refuseName(key);
        if (refused) return refused;
        this.install(key, 'downloading', entry.size, async (folder, options) => {
            for (const file of entry.files) {
                await download(`${REPOSITORY}sherpa-onnx-whisper-${key}/resolve/main/${encodeURIComponent(file.path)}`, join(folder, file.path), { ...options, size: file.size });
            }
            return join(folder, `${key}-encoder.int8.onnx`);
        });
        return '';
    }

    /**
     * @param {string} key
     * @returns {Promise<(WhisperEntry & { files: { path: string, size: number }[] }) | null>} a model of the
     *   catalog with its files and their sizes (null: its repository does not answer)
     */
    async _entry(key) {
        try {
            const response = await fetch(`https://huggingface.co/api/models/csukuangfj/sherpa-onnx-whisper-${key}/tree/main`);
            if (!response.ok) return null;
            const listed = new Map((await response.json()).map(item => [item.path, Number(item.size) || 0]));
            const files = [`${key}-encoder.int8.onnx`, `${key}-decoder.int8.onnx`, `${key}-tokens.txt`].map(path => ({ path, size: listed.get(path) }));
            if (files.some(file => file.size === undefined)) return null;
            const english = englishOnly(key);
            return {
                key,
                lang: english ? 'en' : 'multilingual',
                language: english ? 'English only' : 'Multilingual: Whisper detects the language',
                quality: key,
                size: files.reduce((sum, file) => sum + file.size, 0),
                added: false,
                files,
            };
        } catch {
            return null;
        }
    }
}
