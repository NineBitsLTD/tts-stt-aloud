import { createRequire } from 'node:module';
import { join } from 'node:path';

/** @type {Map<string, { module?: any, error?: Error }>} what was loaded, or why it was not */
const loaded = new Map();

/**
 * A part of the runtime of the voices copied into `dist` by `scripts/copy-runtime.mjs` (node_modules
 * is not packed): the native addon of sherpa-onnx for this machine or piper-phonemize. Loaded once.
 * @param {string} extensionPath
 * @param {'native/sherpa-onnx.node' | 'piper-phonemize/index.js'} part
 * @returns {any} the module
 * @throws {Error} when it is not in this build
 */
export function loadRuntime(extensionPath, part) {
    const dist = join(extensionPath, 'dist');
    const key = join(dist, part);
    if (!loaded.has(key)) {
        try {
            loaded.set(key, { module: createRequire(join(dist, 'extension.cjs'))(`./${part}`) });
        } catch (error) {
            loaded.set(key, { error: error instanceof Error ? error : new Error(String(error)) });
        }
    }
    const { module, error } = loaded.get(key);
    if (error) throw error;
    return module;
}
