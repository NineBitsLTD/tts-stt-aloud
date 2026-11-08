import { mkdir, readdir, rename, rmdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as vscode from 'vscode';

const t = vscode.l10n.t;

/** What the extension was called before version 2. */
const OLD_ID = 'ninebits.tts-stt-md-aloud';
const OLD_SECTION = 'ttsSttMdAloud';
const NEW_SECTION = 'ttsSttAloud';
/** Set in the state of the extension when all has come over. */
const DONE = 'migratedFromOldName';

/**
 * @param {string} path
 * @returns {Promise<boolean>} whether something is there
 */
async function exists(path) {
    return !!(await stat(path).catch(() => null));
}

/**
 * Moves what the old extension kept (the models, the last recording) into the storage of this one:
 * what is there already stays.
 * @param {string} from
 * @param {string} to
 */
async function moveStorage(from, to) {
    const names = await readdir(from).catch(() => null);
    if (!names) return;
    await mkdir(to, { recursive: true });
    for (const name of names) {
        if (!await exists(join(to, name))) await rename(join(from, name), join(to, name));
    }
    await rmdir(from).catch(() => {});
}

/**
 * @template T
 * @param {T} value of a setting
 * @param {string} from the old storage
 * @param {string} to the new one
 * @returns {T} with the paths into the old storage made paths into the new one
 */
function relocated(value, from, to) {
    if (typeof value === 'string') return /** @type {any} */ (value.startsWith(from) ? to + value.slice(from.length) : value);
    if (Array.isArray(value)) return /** @type {any} */ (value.map(item => relocated(item, from, to)));
    if (value && typeof value === 'object') return /** @type {any} */ (Object.fromEntries(Object.entries(value).map(([key, item]) => [key, relocated(item, from, to)])));
    return value;
}

/**
 * Copies the user settings of the old name to the new one, unless they are set already. The old ones
 * stay in settings.json: VS Code writes only settings some extension declares.
 * @param {vscode.ExtensionContext} context
 * @param {string} from the old storage
 * @param {string} to the new one
 */
async function moveSettings(context, from, to) {
    const config = vscode.workspace.getConfiguration();
    const oldValue = key => config.inspect(key.replace(NEW_SECTION, OLD_SECTION))?.globalValue;
    for (const key of Object.keys(context.extension.packageJSON.contributes.configuration.properties)) {
        const value = oldValue(key);
        if (value !== undefined && config.inspect(key)?.globalValue === undefined) await config.update(key, relocated(value, from, to), vscode.ConfigurationTarget.Global);
    }
    // The only driver of 1.x, if the list of the active ones was never set
    const active = `${NEW_SECTION}.tts.activeDrivers`;
    const driver = config.inspect(`${OLD_SECTION}.tts.driver`)?.globalValue;
    if (driver !== undefined && oldValue(active) === undefined && vscode.workspace.getConfiguration().inspect(active)?.globalValue === undefined) {
        await config.update(active, [driver], vscode.ConfigurationTarget.Global);
    }
}

/**
 * Brings over once, on the first start after the rename, what the extension had under its old name:
 * the models in its storage and its user settings. The keys of external servers cannot come: the
 * secret storage of an extension is closed to others. A failure is told and tried again next time.
 * @param {vscode.ExtensionContext} context
 */
export async function migrateOldName(context) {
    if (context.globalState.get(DONE)) return;
    try {
        const storage = context.globalStorageUri.fsPath;
        const oldStorage = join(dirname(storage), OLD_ID);
        await moveStorage(oldStorage, storage);
        await moveSettings(context, oldStorage, storage);
        await context.globalState.update(DONE, true);
    } catch (error) {
        vscode.window.showWarningMessage(t('The settings and models of TTS / STT MD Aloud could not be brought over: {0}', error?.message || error));
    }
}
