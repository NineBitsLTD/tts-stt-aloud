import { rename, writeFile } from 'node:fs/promises';
import * as vscode from 'vscode';

/**
 * Tells the Markdown previews of VS Code which block is being read aloud: `src/preview-reading.js`,
 * inside them, reads a style sheet in the folder of the extension (the only place a preview may load
 * from and an extension may write to). When that folder is read-only, nothing is marked.
 */
export class PreviewHighlight {

    /**
     * @param {vscode.ExtensionContext} context
     */
    constructor(context) {
        this._file = vscode.Uri.joinPath(context.extensionUri, 'dist', 'js', 'preview-reading-state.css').fsPath;
        /** what was written last */
        this._written = '';
        this._queue = Promise.resolve();
    }

    /**
     * @param {vscode.Uri} uri of the file of the preview
     * @param {number} line of it being read (-1: none yet)
     */
    show(uri, line) {
        const key = `${uri}#${line}`;
        if (key === this._written) return;
        this._written = key;
        this._write(JSON.stringify({ source: uri.toString(), line, time: Date.now() }));
    }

    /** Nothing is being read in a preview. */
    clear() {
        if (!this._written) return;
        this._written = '';
        this._write('');
    }

    /**
     * Replaces the file at once, one write after the other.
     * @param {string} state
     */
    _write(state) {
        const css = `:root { --tts-stt-aloud-reading: "${encodeURIComponent(state)}"; }\n`;
        this._queue = this._queue.then(async () => {
            await writeFile(`${this._file}.tmp`, css);
            await rename(`${this._file}.tmp`, this._file);
        }).catch(() => {});
    }
}
