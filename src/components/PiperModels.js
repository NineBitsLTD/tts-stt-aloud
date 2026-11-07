import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as vscode from 'vscode';

/** @typedef {import('./SpeechSettings').SpeechSettings} SpeechSettings */

/** The voices of Piper, published by its authors. */
const REPOSITORY = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/';
const CATALOG = `${REPOSITORY}voices.json`;
/**
 * The data of espeak-ng the Piper models of sherpa-onnx share (the phonemes of the languages): the
 * folder of a vits-piper model of the author of sherpa-onnx, at a fixed commit.
 */
const ESPEAK = 'espeak-ng-data';
const ESPEAK_REPO = 'csukuangfj/vits-piper-ru_RU-irina-medium';
const ESPEAK_REVISION = 'b095bed45c39813266edf14ffa2bade5ebfc929c';
/** Files of espeak-ng-data downloaded at once. */
const ESPEAK_PARALLEL = 6;
const DRIVER = 'piper';

/**
 * @typedef {object} PiperModel a voice model in the list of the settings
 * @property {string} path of its `.onnx` file
 * @property {string} name the file name without `.onnx`
 * @property {string} lang its language (`ru_RU`, else the voice of espeak: `ru`; '' : unknown)
 * @property {boolean} downloaded whether it was downloaded into the storage of the extension
 * @property {boolean} exists whether the file is there
 * @property {number} size bytes
 * @property {boolean} ready whether it is prepared for sherpa-onnx: its metadata and `tokens.txt`
 * @property {boolean} espeak whether it has `espeak-ng-data`: next to it, or shared (downloaded)
 *
 * @typedef {object} PiperVoice a voice of the catalog
 * @property {string} key `ru_RU-irina-medium`
 * @property {string} lang `ru_RU`
 * @property {string} language `Russian (Русский), Russia`
 * @property {string} quality x_low, low, medium, high
 * @property {number} size bytes of the model
 * @property {boolean} added whether it is in the list already
 *
 * @typedef {{ path: string, size: number }} RemoteFile a file of a repository and its size
 * @typedef {{ signal: AbortSignal, onBytes: (count: number) => void, transform?: (part: string) => Promise<void> }} SaveOptions
 * @typedef {{ size: number, save: (target: string, options: SaveOptions) => Promise<void> }} VoiceSource a file of a
 *   voice to install: its size and how it is written to the storage (downloaded, copied)
 */

/** The bytes at the end of an `.onnx` file read for its metadata (ONNX writes them last). */
const META_TAIL = 4096;
/** ONNX ModelProto.metadata_props: field 14, length-delimited; StringStringEntryProto key 1, value 2. */
const META_TAG = 0x72;
const KEY_TAG = 0x0a;
const VALUE_TAG = 0x12;

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
 * voice, has_espeak, n_speakers, sample_rate), written by its conversion script at the end of the
 * model: the entries of ModelProto.metadata_props in the last bytes of the file.
 * @param {string} path of an `.onnx` model
 * @returns {Promise<Record<string, string> | null>} null: not prepared for sherpa-onnx
 */
export async function readSherpaMeta(path) {
    let tail;
    try {
        const file = await open(path, 'r');
        try {
            const { size } = await file.stat();
            tail = Buffer.alloc(Math.min(size, META_TAIL));
            await file.read(tail, 0, tail.length, size - tail.length);
        } finally {
            await file.close();
        }
    } catch {
        return null;
    }
    // An entry: 0x72 <length> 0x0a <key length> <key> 0x12 <value length> <value> (short strings)
    const meta = {};
    for (let index = tail.indexOf(META_TAG); index >= 0 && index + 4 < tail.length; index = tail.indexOf(META_TAG, index + 1)) {
        const length = tail[index + 1];
        const keyLength = tail[index + 3];
        const valueAt = index + 4 + keyLength;
        if (length >= 0x80 || tail[index + 2] !== KEY_TAG || keyLength >= 0x80 || tail[valueAt] !== VALUE_TAG) continue;
        const valueLength = tail[valueAt + 1];
        if (valueLength >= 0x80 || 2 + keyLength + 2 + valueLength !== length || valueAt + 2 + valueLength > tail.length) continue;
        meta[tail.toString('utf8', index + 4, valueAt)] = tail.toString('utf8', valueAt + 2, valueAt + 2 + valueLength);
    }
    return meta.model_type && meta.comment === 'piper' ? meta : null;
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
 * @param {Record<string, string | number>} meta
 * @returns {Buffer} entries of ModelProto.metadata_props; appended to a model they are its metadata,
 *   as `onnx.save` of the script of sherpa-onnx writes them (byte for byte)
 */
export function encodeMeta(meta) {
    const varint = (value) => {
        const bytes = [];
        do {
            bytes.push((value & 0x7f) | (value > 0x7f ? 0x80 : 0));
            value >>>= 7;
        } while (value);
        return Buffer.from(bytes);
    };
    const field = (tag, bytes) => Buffer.concat([Buffer.from([tag]), varint(bytes.length), bytes]);
    return Buffer.concat(Object.entries(meta).map(([key, value]) => field(META_TAG,
        Buffer.concat([field(KEY_TAG, Buffer.from(key)), field(VALUE_TAG, Buffer.from(String(value)))]))));
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
 * @param {string} path
 * @returns {Promise<boolean>} whether a file or folder is there
 */
async function exists(path) {
    return !!(await stat(path).catch(() => null));
}

/**
 * Writes a stream to a file (to `<target>.part`, renamed when complete).
 * @param {NodeJS.ReadableStream} source
 * @param {string} target
 * @param {SaveOptions & { size?: number }} options size: checked when known; transform: changes the
 *   file before it is renamed
 */
async function save(source, target, { signal, size, onBytes, transform }) {
    const part = `${target}.part`;
    let received = 0;
    const count = async function* (chunks) {
        for await (const chunk of chunks) {
            received += chunk.length;
            onBytes(chunk.length);
            yield chunk;
        }
    };
    await mkdir(dirname(target), { recursive: true });
    await pipeline(source, count, createWriteStream(part), { signal });
    if (size && received !== size) throw new Error(`${basename(target)} came incomplete (${received} of ${size} bytes)`);
    if (transform) await transform(part);
    await rename(part, target);
}

/**
 * Downloads a file.
 * @param {string} url
 * @param {string} target
 * @param {SaveOptions & { size?: number }} options
 */
async function download(url, target, options) {
    const response = await fetch(url, { signal: options.signal });
    if (!response.ok || !response.body) throw new Error(`${response.status} ${response.statusText}: ${url}`);
    await save(Readable.fromWeb(response.body), target, options);
}

/**
 * The voice models of Piper (`ttsSttMdAloud.tts.models.piper`), for sherpa-onnx — the engine Piper
 * is to speak with. A voice of the catalog of Piper (rhasspy/piper-voices on Hugging Face) is
 * downloaded into the storage of the extension (`piper/<voice>/`), a model of Piper chosen on the
 * disk (with its `.onnx.json`) is copied there — the file on the disk stays as it is —, and there
 * it is prepared as the script of sherpa-onnx prepares it: its metadata appended to the model,
 * `tokens.txt` from the config; the shared `piper/espeak-ng-data` is downloaded with the first one;
 * the progress is in a notification that can cancel it. A model prepared for sherpa-onnx already
 * (its metadata, `tokens.txt` next to it: vits-piper-…) is used where it is. Removing a model of
 * the storage deletes its folder; a model used where it is only leaves the list.
 */
export class PiperModels {

    /**
     * @param {vscode.ExtensionContext} context
     * @param {SpeechSettings} settings
     */
    constructor(context, settings) {
        this._settings = settings;
        this.folder = join(context.globalStorageUri.fsPath, DRIVER);
        /** the shared data of espeak-ng of the downloaded models */
        this.espeakFolder = join(this.folder, ESPEAK);
        /** @type {Promise<Record<string, any>> | null} the catalog, loaded once a session */
        this._catalog = null;
        /** @type {Promise<void> | null} espeak-ng-data being downloaded */
        this._espeakDownload = null;
        /** @type {Map<string, 'downloading' | 'preparing'>} the voices being installed into the storage */
        this.pending = new Map();
        /** @type {vscode.EventEmitter<void>} */
        this._changed = new vscode.EventEmitter();
        /** Installing a voice began or ended. */
        this.onDidChange = this._changed.event;
    }

    dispose() {
        this._changed.dispose();
    }

    /**
     * @returns {Promise<PiperModel[]>} the models of the settings with what their files tell
     */
    async list() {
        const paths = this._settings.get().tts.models[DRIVER] ?? [];
        const shared = await exists(this.espeakFolder);
        return Promise.all(paths.map(async (path) => {
            const info = await stat(path).catch(() => null);
            const meta = info ? await readSherpaMeta(path) : null;
            const folder = dirname(path);
            const downloaded = this._isDownloaded(path);
            return {
                path,
                name: basename(path).replace(/\.onnx$/i, ''),
                lang: (await readConfig(path))?.lang || meta?.voice || '',
                downloaded,
                exists: !!info?.isFile(),
                size: info?.size ?? 0,
                ready: !!meta && await exists(join(folder, 'tokens.txt')),
                espeak: (downloaded && shared) || await exists(join(folder, ESPEAK)),
            };
        }));
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
        const added = new Set((this._settings.get().tts.models[DRIVER] ?? []).map(path => basename(path).replace(/\.onnx$/i, '')));
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
     * @returns {Promise<string>} the `.onnx` file chosen in the open dialog ('' : none)
     */
    async browse() {
        const [uri] = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Piper voice model': ['onnx'] }, openLabel: 'Choose' }) ?? [];
        return uri?.fsPath ?? '';
    }

    /**
     * Adds a model chosen on the disk: one prepared for sherpa-onnx (its metadata, `tokens.txt` next
     * to it; `espeak-ng-data` next to it is not checked — it may be shared) where it is; else, with
     * its config `<model>.onnx.json` next to it, a copy prepared in the storage (it begins here, the
     * model is added when it is ready).
     * @param {string} path
     * @returns {Promise<string>} why it is not added ('' : added, or its copy began)
     */
    async addFile(path) {
        if (!/\.onnx$/i.test(path)) return 'Choose an .onnx file: a Piper voice model.';
        const info = await stat(path).catch(() => null);
        if (!info?.isFile()) return `There is no file ${path}.`;
        if ((this._settings.get().tts.models[DRIVER] ?? []).includes(path)) return 'This model is in the list already.';
        if (await readSherpaMeta(path) && await exists(join(dirname(path), 'tokens.txt'))) {
            await this._settings.addModel(DRIVER, path);
            return '';
        }
        const config = await stat(`${path}.json`).catch(() => null);
        if (!config?.isFile()) return `${basename(path)} cannot be prepared for sherpa-onnx: its config ${basename(path)}.json is not next to it.`;
        const name = basename(path).replace(/\.onnx$/i, '');
        if (this.pending.has(name) || await exists(join(this.folder, name))) return `There is a model named ${name} in the storage of the extension already.`;
        this._install(name, 'preparing', {
            config: { size: config.size, save: (target, options) => save(createReadStream(`${path}.json`), target, { ...options, size: config.size }) },
            model: { size: info.size, save: (target, options) => save(createReadStream(path), target, { ...options, size: info.size }) },
        });
        return '';
    }

    /**
     * Begins downloading a voice of the catalog (its model and config, espeak-ng-data with the first
     * one) and preparing it for sherpa-onnx; the model is added when it is ready. The progress is in
     * a notification, which can cancel it.
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
        const source = (path, file) => {
            const size = Number(file?.size_bytes) || 0;
            return { size, save: (target, options) => download(REPOSITORY + path.split('/').map(encodeURIComponent).join('/'), target, { ...options, size }) };
        };
        this._install(key, 'downloading', { config: source(configPath, config), model: source(modelPath, model) });
        return '';
    }

    /**
     * Removes a model from the list after asking; one of the storage with its folder.
     * @param {string} path
     */
    async remove(path) {
        const downloaded = this._isDownloaded(path);
        const name = basename(path);
        const answer = await vscode.window.showWarningMessage(`Remove the Piper voice model ${name}?`, {
            modal: true,
            detail: downloaded ? 'Its files in the storage of the extension are deleted.' : 'It leaves the list; the file stays on the disk.',
        }, 'Remove');
        if (answer !== 'Remove') return;
        await this._settings.removeModel(DRIVER, path);
        if (!downloaded) return;
        // A voice has its own folder (piper/<voice>/); one downloaded before had its files in piper/
        if (dirname(path) !== this.folder) await rm(dirname(path), { recursive: true, force: true });
        else await Promise.all([rm(path, { force: true }), rm(`${path}.json`, { force: true })]);
    }

    /**
     * Installs a voice into the storage in the background, with a notification that can cancel it;
     * the model is added when it is ready, what went wrong is shown.
     * @param {string} name of the voice (its folder and files)
     * @param {'downloading' | 'preparing'} action
     * @param {{ config: VoiceSource, model: VoiceSource }} sources
     */
    _install(name, action, sources) {
        this.pending.set(name, action);
        this._changed.fire();
        const title = action === 'downloading' ? `Downloading the Piper voice ${name}` : `Preparing the Piper voice ${name} for sherpa-onnx`;
        vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true },
            (progress, token) => this._prepare(name, sources, progress, token))
            .then(async (path) => {
                if (path) await this._settings.addModel(DRIVER, path);
            }, (error) => {
                if (error?.name !== 'AbortError') vscode.window.showErrorMessage(`The Piper voice ${name} could not be ${action === 'downloading' ? 'downloaded' : 'prepared'}: ${error?.message || error}`);
            })
            .finally(() => {
                this.pending.delete(name);
                this._changed.fire();
            });
    }

    /**
     * Writes a voice into its folder of the storage and prepares it for sherpa-onnx (espeak-ng-data
     * first, once): `tokens.txt` from its config, the metadata appended to the model when it has none.
     * @param {string} name
     * @param {{ config: VoiceSource, model: VoiceSource }} sources
     * @param {vscode.Progress<{ message?: string, increment?: number }>} progress
     * @param {vscode.CancellationToken} token
     * @returns {Promise<string>} the path of the model
     */
    async _prepare(name, { config, model }, progress, token) {
        const abort = new AbortController();
        token.onCancellationRequested(() => abort.abort());
        const { signal } = abort;
        const folder = join(this.folder, name);
        try {
            const espeakFiles = !this._espeakDownload && !(await exists(this.espeakFolder)) ? await this._espeakFiles(signal) : [];
            const total = [config, model, ...espeakFiles].reduce((sum, file) => sum + file.size, 0) || 1;
            let done = 0;
            const onBytes = (count) => {
                done += count;
                progress.report({ increment: (count / total) * 100, message: `${Math.round((done / total) * 100)}% of ${(total / 2 ** 20).toFixed(0)} MB` });
            };
            if (espeakFiles.length) this._espeakDownload = this._downloadEspeak(espeakFiles, signal, onBytes);
            if (this._espeakDownload) await this._espeakDownload;
            const configPath = join(folder, `${name}.onnx.json`);
            const modelPath = join(folder, `${name}.onnx`);
            await config.save(configPath, { signal, onBytes });
            const settings = JSON.parse(await readFile(configPath, 'utf8'));
            await writeFile(join(folder, 'tokens.txt'), tokensOf(settings));
            await model.save(modelPath, {
                signal,
                onBytes,
                transform: async (part) => {
                    if (!(await readSherpaMeta(part))) await appendFile(part, encodeMeta(sherpaMetaOf(settings)));
                },
            });
            return modelPath;
        } catch (error) {
            await rm(folder, { recursive: true, force: true });
            throw token.isCancellationRequested ? Object.assign(new Error('Cancelled'), { name: 'AbortError' }) : error;
        }
    }

    /**
     * @param {AbortSignal} signal
     * @returns {Promise<RemoteFile[]>} the files of espeak-ng-data in its repository
     */
    async _espeakFiles(signal) {
        const response = await fetch(`https://huggingface.co/api/models/${ESPEAK_REPO}/tree/${ESPEAK_REVISION}/${ESPEAK}?recursive=true`, { signal });
        if (!response.ok) throw new Error(`The list of espeak-ng-data could not be loaded: ${response.status} ${response.statusText}`);
        const files = (await response.json()).filter(item => item?.type === 'file').map(item => ({ path: String(item.path), size: Number(item.size) || 0 }));
        if (!files.length) throw new Error('The list of espeak-ng-data is empty');
        return files;
    }

    /**
     * Downloads espeak-ng-data into `piper/espeak-ng-data` (through `.part`), several files at once.
     * @param {RemoteFile[]} files
     * @param {AbortSignal} signal
     * @param {(count: number) => void} onBytes
     */
    async _downloadEspeak(files, signal, onBytes) {
        const part = `${this.espeakFolder}.part`;
        try {
            await rm(part, { recursive: true, force: true });
            const queue = [...files];
            const worker = async () => {
                for (let file = queue.shift(); file; file = queue.shift()) {
                    const inside = file.path.slice(ESPEAK.length + 1);
                    await download(`https://huggingface.co/${ESPEAK_REPO}/resolve/${ESPEAK_REVISION}/${file.path.split('/').map(encodeURIComponent).join('/')}`,
                        join(part, ...inside.split('/')), { signal, size: file.size, onBytes });
                }
            };
            await Promise.all(Array.from({ length: ESPEAK_PARALLEL }, worker));
            await rename(part, this.espeakFolder);
        } catch (error) {
            await rm(part, { recursive: true, force: true });
            throw error;
        } finally {
            this._espeakDownload = null;
        }
    }

    /**
     * @param {string} path
     * @returns {boolean} whether a model is in the storage of the extension (downloaded)
     */
    _isDownloaded(path) {
        const inside = relative(this.folder, path);
        const parts = inside.split(sep);
        return !!inside && !inside.startsWith('..') && !isAbsolute(inside) && parts.length <= 2 && !parts[0].startsWith(ESPEAK);
    }
}
