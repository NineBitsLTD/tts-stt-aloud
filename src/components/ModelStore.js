import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as vscode from 'vscode';

/** @typedef {import('./SpeechSettings').SpeechSettings} SpeechSettings */
/** @typedef {import('./SpeechSettings').SpeechSection} SpeechSection */

/**
 * @typedef {object} StoredModel a model in the list of the settings, as its files tell
 * @property {string} path of its main `.onnx` file
 * @property {string} name
 * @property {string} lang its language ('' : unknown)
 * @property {boolean} downloaded whether it is in the storage of the extension
 * @property {boolean} exists whether the file is there
 * @property {number} size bytes
 * @property {boolean} ready whether the engine can use it
 *
 * @typedef {{ signal: AbortSignal, onBytes: (count: number) => void, transform?: (part: string) => Promise<void> }} SaveOptions
 *   transform: changes a file before it is renamed
 */

/**
 * @param {string} path
 * @returns {Promise<boolean>} whether a file or folder is there
 */
export async function exists(path) {
    return !!(await stat(path).catch(() => null));
}

/**
 * Writes a stream to a file (to `<target>.part`, renamed when complete).
 * @param {NodeJS.ReadableStream} source
 * @param {string} target
 * @param {SaveOptions & { size?: number }} options size: checked when known
 */
export async function save(source, target, { signal, size, onBytes, transform }) {
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
export async function download(url, target, options) {
    const response = await fetch(url, { signal: options.signal });
    if (!response.ok || !response.body) throw new Error(`${response.status} ${response.statusText}: ${url}`);
    await save(Readable.fromWeb(response.body), target, options);
}

/**
 * Copies a file.
 * @param {string} path
 * @param {string} target
 * @param {SaveOptions & { size?: number }} options
 */
export async function copy(path, target, options) {
    await save(createReadStream(path), target, options);
}

/**
 * The models of a driver (`ttsSttMdAloud.<section>.models.<driver>`): files chosen on the disk, used
 * where they are, or installed into the storage of the extension (`<driver>/<name>/`: downloaded,
 * copied and prepared) in the background with a notification that can cancel it — listed as
 * downloading / preparing meanwhile, added when ready. Removing a model of the storage deletes its
 * folder; one used where it is only leaves the list. The drivers give what is theirs: `describe`,
 * `catalog`, `addFile`, `download` (`PiperModels`, `WhisperModels`).
 */
export class ModelStore {

    /**
     * @param {vscode.ExtensionContext} context
     * @param {SpeechSettings} settings
     * @param {{ section: SpeechSection, driver: string, label: string }} kind label: what a model
     *   is called in messages ("Piper voice", "Whisper model")
     */
    constructor(context, settings, { section, driver, label }) {
        this._settings = settings;
        this.section = section;
        this.driver = driver;
        this.label = label;
        this.folder = join(context.globalStorageUri.fsPath, driver);
        /** @type {Map<string, 'downloading' | 'preparing'>} the models being installed into the storage */
        this.pending = new Map();
        /** @type {vscode.EventEmitter<void>} */
        this._changed = new vscode.EventEmitter();
        /** Installing a model began or ended. */
        this.onDidChange = this._changed.event;
    }

    dispose() {
        this._changed.dispose();
    }

    /** @returns {string[]} the paths of the settings */
    paths() {
        return this._settings.get()[this.section].models[this.driver] ?? [];
    }

    /**
     * @returns {Promise<StoredModel[]>} the models of the settings with what their files tell
     */
    list() {
        return Promise.all(this.paths().map(path => this.describe(path)));
    }

    /**
     * @param {string} path
     * @returns {Promise<StoredModel>}
     */
    async describe(path) {
        const info = await stat(path).catch(() => null);
        return { path, name: this.nameOf(path), lang: '', downloaded: this.isStored(path), exists: !!info?.isFile(), size: info?.size ?? 0, ready: false };
    }

    /**
     * @param {string} path
     * @returns {string} the name of a model shown and asked about
     */
    nameOf(path) {
        return basename(path).replace(/\.onnx$/i, '');
    }

    /**
     * @returns {Promise<string>} the `.onnx` file chosen in the open dialog ('' : none)
     */
    async browse() {
        const [uri] = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { [this.label]: ['onnx'] }, openLabel: 'Choose' }) ?? [];
        return uri?.fsPath ?? '';
    }

    /**
     * Removes a model from the list after asking; one of the storage with its folder.
     * @param {string} path
     */
    async remove(path) {
        const stored = this.isStored(path);
        const answer = await vscode.window.showWarningMessage(`Remove the ${this.label} ${this.nameOf(path)}?`, {
            modal: true,
            detail: stored ? 'Its files in the storage of the extension are deleted.' : 'It leaves the list; its files stay on the disk.',
        }, 'Remove');
        if (answer !== 'Remove') return;
        await this._settings.removeModel(this.section, this.driver, path);
        if (!stored) return;
        // A model has its own folder (<driver>/<name>/); a Piper voice downloaded before had its files in piper/
        if (dirname(path) !== this.folder) await rm(dirname(path), { recursive: true, force: true });
        else await Promise.all([rm(path, { force: true }), rm(`${path}.json`, { force: true })]);
    }

    /**
     * @param {string} path
     * @returns {boolean} whether a model is in the storage of the extension
     */
    isStored(path) {
        const inside = relative(this.folder, path);
        return !!inside && !inside.startsWith('..') && !isAbsolute(inside) && inside.split(sep).length <= 2;
    }

    /**
     * @param {string} name
     * @returns {Promise<string>} why a model of this name cannot be installed ('' : it can)
     */
    async refuseName(name) {
        if (this.pending.has(name)) return `${name} is being installed.`;
        if (this.paths().some(path => this.nameOf(path) === name) || await exists(join(this.folder, name))) return `There is a model named ${name} in the list or the storage of the extension already.`;
        return '';
    }

    /**
     * Installs a model into its folder of the storage in the background, with a notification that
     * can cancel it; the model is added when it is ready, what went wrong is shown.
     * @param {string} name of the model (its folder)
     * @param {'downloading' | 'preparing'} action
     * @param {number} total bytes written (for the progress)
     * @param {(folder: string, options: SaveOptions) => Promise<string>} write writes the files into the
     *   folder: the path of the model
     */
    install(name, action, total, write) {
        this.pending.set(name, action);
        this._changed.fire();
        const title = `${action === 'downloading' ? 'Downloading' : 'Preparing'} the ${this.label} ${name}`;
        vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, (progress, token) => this._write(name, total, write, progress, token))
            .then(async (path) => {
                if (path) await this._settings.addModel(this.section, this.driver, path);
            }, (error) => {
                if (error?.name !== 'AbortError') vscode.window.showErrorMessage(`The ${this.label} ${name} could not be ${action === 'downloading' ? 'downloaded' : 'prepared'}: ${error?.message || error}`);
            })
            .finally(() => {
                this.pending.delete(name);
                this._changed.fire();
            });
    }

    /**
     * @param {string} name
     * @param {number} total
     * @param {(folder: string, options: SaveOptions) => Promise<string>} write
     * @param {vscode.Progress<{ message?: string, increment?: number }>} progress
     * @param {vscode.CancellationToken} token
     * @returns {Promise<string>} the path of the model (the folder is removed when it fails)
     */
    async _write(name, total, write, progress, token) {
        const abort = new AbortController();
        token.onCancellationRequested(() => abort.abort());
        const folder = join(this.folder, name);
        const sum = total || 1;
        let done = 0;
        const onBytes = (count) => {
            done += count;
            progress.report({ increment: (count / sum) * 100, message: `${Math.round((done / sum) * 100)}% of ${(sum / 2 ** 20).toFixed(0)} MB` });
        };
        try {
            return await write(folder, { signal: abort.signal, onBytes });
        } catch (error) {
            await rm(folder, { recursive: true, force: true });
            throw token.isCancellationRequested ? Object.assign(new Error('Cancelled'), { name: 'AbortError' }) : error;
        }
    }
}
