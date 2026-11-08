import * as vscode from 'vscode';

/** @typedef {import('./SpeechSettings').SpeechSettings} SpeechSettings */
/** @typedef {import('./TextToSpeech').TextToSpeech} TextToSpeech */
/** @typedef {import('./SpeechToText').SpeechToText} SpeechToText */
/** @typedef {import('./TextPlayer').TextPlayer} TextPlayer */
/**
 * @typedef {object} DictationSession
 * @property {vscode.TextDocument | null} document where the text goes (null: the clipboard)
 * @property {string} text what was put into the clipboard so far
 * @property {Promise<void>} queue the phrases being recognized, in order
 */

/** One phrase of the dictation: the next begins to be listened for as it ends. */
const LIMITS = { waitMs: 30000, maxMs: 60000, silenceMs: 1000 };

/**
 * Dictation: while it is on, speech is recorded phrase by phrase (a pause ends one), each recognized
 * while the next is listened for and written where the cursor of its editor is — replacing the
 * selection — or, with the clipboard as the source of the player, added to the clipboard. The same
 * button ends it; what was said so far is still written.
 */
export class Dictation {

    /**
     * @param {SpeechSettings} settings
     * @param {TextToSpeech} tts
     * @param {SpeechToText} stt
     * @param {TextPlayer} player
     */
    constructor(settings, tts, stt, player) {
        this._settings = settings;
        this._tts = tts;
        this._stt = stt;
        this._player = player;
        /** @type {DictationSession | null} */
        this._session = null;
        /** @type {vscode.EventEmitter<void>} */
        this._changed = new vscode.EventEmitter();
        /** It began or ended. */
        this.onDidChange = this._changed.event;
    }

    /** @returns {boolean} whether it listens */
    get active() {
        return !!this._session;
    }

    /**
     * @returns {vscode.Disposable}
     */
    register() {
        return vscode.Disposable.from(
            vscode.commands.registerCommand('tts-stt-md-aloud.dictate', uri => this.start(uri)),
            vscode.commands.registerCommand('tts-stt-md-aloud.stopDictation', () => this.stop()),
            this._player.onWillPlay(() => this.stop()),
            this._settings.onDidChange(() => {
                if (!this._settings.get().stt.enabled) this.stop();
            }),
            new vscode.Disposable(() => {
                this.stop();
                this._changed.dispose();
            }),
        );
    }

    /**
     * Begins or ends the dictation (the button of the side bar).
     */
    toggle() {
        if (this._session) this.stop();
        else this.start();
    }

    /**
     * @param {vscode.Uri} [uri] the document of an editor title (none: the source of the player)
     */
    async start(uri) {
        if (this._session || !this._settings.get().stt.enabled) return;
        const toClipboard = !uri && this._player.source === 'clipboard';
        const document = toClipboard ? null : this._player.editorFor(uri)?.document ?? null;
        if (!toClipboard && !document) {
            vscode.window.showWarningMessage('Open a text file to dictate into it.');
            return;
        }
        const recognition = await this._stt.recognition();
        if (!recognition.available) {
            vscode.window.showWarningMessage(recognition.message);
            return;
        }
        if (this._session) return;
        // The microphone would hear the speech
        this._player.stop();
        this._tts.stop();
        const session = { document, text: '', queue: Promise.resolve() };
        this._session = session;
        this._publish();
        this._listen(session);
    }

    /** Ends it: what was said so far is still recognized and written. */
    stop() {
        if (!this._session) return;
        this._session = null;
        this._stt.stop(this);
        this._publish();
    }

    /**
     * @param {DictationSession} session
     */
    async _listen(session) {
        try {
            while (this._session === session) {
                const { wav, ended } = await this._stt.listen(LIMITS, this, { keep: true });
                if (wav) session.queue = session.queue.then(() => this._recognize(session, wav));
                if (ended === 'interrupted' && this._session === session) {
                    vscode.window.showInformationMessage('Dictation stopped: a recording was started with the microphone.');
                    this.stop();
                }
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Dictation failed: ${error?.message || error}`);
            if (this._session === session) this.stop();
        } finally {
            this._stt.releaseMicrophone(this);
        }
    }

    /**
     * @param {DictationSession} session
     * @param {Buffer} wav
     */
    async _recognize(session, wav) {
        try {
            const { text, error } = await this._stt.recognize(wav);
            if (error) throw new Error(error);
            const heard = text?.trim() ?? '';
            // Whisper names what it hears when there are no words: [Music], (шум)
            if (!/[\p{L}\p{N}]/u.test(heard) || /^[[(].*[\])]$/.test(heard)) return;
            await this._write(session, heard);
        } catch (error) {
            vscode.window.showErrorMessage(`Dictation failed: ${error?.message || error}`);
            if (this._session === session) this.stop();
        }
    }

    /**
     * @param {DictationSession} session
     * @param {string} text
     */
    async _write(session, text) {
        if (!session.document) {
            session.text = session.text ? `${session.text} ${text}` : text;
            await vscode.env.clipboard.writeText(session.text);
            return;
        }
        if (session.document.isClosed) throw new Error('The file was closed.');
        const editor = vscode.window.visibleTextEditors.find(item => item.document === session.document)
            ?? await vscode.window.showTextDocument(session.document, { preserveFocus: true, preview: false });
        const { document, selection } = editor;
        const { start } = selection;
        const before = start.character ? document.getText(new vscode.Range(start.translate(0, -1), start)) : '';
        const written = before && !/[\s([{«"'“]/u.test(before) ? ` ${text}` : text;
        if (!await editor.edit(edit => edit.replace(selection, written))) throw new Error('The file cannot be changed.');
        const end = document.positionAt(document.offsetAt(start) + written.length);
        editor.selection = new vscode.Selection(end, end);
    }

    _publish() {
        vscode.commands.executeCommand('setContext', 'ttsSttMdAloud.dictating', this.active);
        this._changed.fire();
    }
}
