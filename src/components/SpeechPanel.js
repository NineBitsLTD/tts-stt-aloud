import * as vscode from 'vscode';
import { createNonce } from '../utils/createNonce';
import { MicMonitor } from './MicMonitor';

/** @typedef {import('./SpeechSettings').SpeechSettings} SpeechSettings */
/** @typedef {import('./TextToSpeech').TextToSpeech} TextToSpeech */

/** STT recognizes nothing yet: what the section says of it. */
const STT_NOTE = 'Recognition (dictation) is planned: for now the settings are kept and the level of the microphone is shown.';

/**
 * The side bar of the speech settings (the speaker of the activity bar, the webview view
 * `tts-stt-md-aloud.speech`; `src/speech.js`): TTS — on / off, volume, speed, the level of the
 * sound, the driver, the drivers offered (Piper, Silero, external servers), the voices checked and
 * the voice tested —, STT — on / off, the gain and the level of the microphone, its drivers. The
 * settings are those of VS Code (`SpeechSettings`), so a change made elsewhere shows here.
 * @implements {vscode.WebviewViewProvider}
 */
export class SpeechPanel {

    static viewId = 'tts-stt-md-aloud.speech';

    /**
     * @param {vscode.ExtensionContext} context
     * @param {SpeechSettings} settings
     * @param {TextToSpeech} tts
     */
    constructor(context, settings, tts) {
        this._context = context;
        this._settings = settings;
        this._tts = tts;
        this._mic = new MicMonitor();
        /** @type {vscode.WebviewView | null} */
        this._view = null;
        /** the TTS driver whose voices the view shows */
        this._voicesOf = '';
    }

    /**
     * @returns {vscode.Disposable}
     */
    register() {
        return vscode.Disposable.from(
            vscode.window.registerWebviewViewProvider(SpeechPanel.viewId, this),
            this._settings.onDidChange(() => this._onSettings()),
            this._tts.onLevels(({ levels, interval }) => this._post({ type: 'level', section: 'tts', levels, interval })),
            new vscode.Disposable(() => this._mic.stop()),
        );
    }

    /**
     * @param {vscode.WebviewView} view
     */
    resolveWebviewView(view) {
        this._view = view;
        view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this._context.extensionUri, 'dist')] };
        view.webview.html = this._html(view.webview);
        const subscriptions = [
            view.webview.onDidReceiveMessage(message => this._onMessage(message)),
            view.onDidChangeVisibility(() => this._syncMic()),
        ];
        view.onDidDispose(() => {
            subscriptions.forEach(subscription => subscription.dispose());
            this._tts.stop('test');
            this._view = null;
            this._syncMic();
        });
    }

    /**
     * @param {any} message
     */
    async _onMessage(message) {
        const reply = (result, error = undefined) => this._view?.webview.postMessage({ type: 'hostReply', requestId: message.requestId, result, error });
        const section = message?.section === 'stt' ? 'stt' : 'tts';
        switch (message?.type) {
            case 'ready':
                this._postState();
                await this._postVoices(true);
                this._syncMic();
                break;
            case 'update':
                await this._settings.update(section, String(message.key), message.value);
                break;
            case 'driverEnabled':
                await this._settings.setDriverEnabled(section, String(message.id), !!message.enabled);
                break;
            case 'voiceChecked':
                await this._settings.setVoiceChecked(this._settings.get().tts.driver, String(message.name), !!message.checked);
                break;
            case 'addServer':
                reply(await this._settings.addServer(section, message.server ?? {}));
                break;
            case 'removeServer':
                await this._removeServer(section, String(message.id));
                break;
            case 'test':
                try {
                    reply(await this._tts.test(String(message.voice ?? '')));
                } catch (error) {
                    reply(undefined, String(error?.message || error));
                }
                break;
            case 'stopTest':
                this._tts.stop('test');
                break;
        }
    }

    /**
     * Removes an external server after asking (its key goes with it).
     * @param {'tts' | 'stt'} section
     * @param {string} id
     */
    async _removeServer(section, id) {
        const name = this._settings.driverName(section, id);
        const answer = await vscode.window.showWarningMessage(`Remove the ${section.toUpperCase()} server ${name}?`, { modal: true, detail: 'Its address and key are removed from VS Code.' }, 'Remove');
        if (answer === 'Remove') await this._settings.removeServer(section, id);
    }

    /** The settings changed: the view follows, the voices when the driver changed. */
    _onSettings() {
        this._postState();
        if (this._settings.get().tts.driver !== this._voicesOf) this._postVoices(false);
        this._syncMic();
    }

    _postState() {
        const settings = this._settings.get();
        this._post({
            type: 'state',
            settings,
            drivers: { tts: this._settings.drivers('tts'), stt: this._settings.drivers('stt') },
            notes: { tts: this._tts.driver().message, stt: STT_NOTE },
        });
    }

    /**
     * @param {boolean} refresh ask the system for its voices again
     */
    async _postVoices(refresh) {
        const driver = this._settings.get().tts.driver;
        this._voicesOf = driver;
        const voices = await this._tts.voices({ refresh });
        this._post({ type: 'voices', driver, voices });
    }

    /** The microphone is recorded while STT is on and the view is shown. */
    _syncMic() {
        if (!this._view?.visible || !this._settings.get().stt.enabled) {
            if (this._mic.active) this._post({ type: 'level', section: 'stt', level: 0 });
            this._mic.stop();
            return;
        }
        this._post({ type: 'status', section: 'stt', message: '' });
        this._mic.start({
            onLevel: level => this._post({ type: 'level', section: 'stt', level }),
            onError: message => this._post({ type: 'status', section: 'stt', message }),
            gain: () => this._settings.get().stt.volume / 100,
        });
    }

    /**
     * @param {any} message to the view while it is shown (it asks for the state when shown again)
     */
    _post(message) {
        if (this._view?.visible) this._view.webview.postMessage(message);
    }

    /**
     * @param {vscode.Webview} webview
     * @returns {string}
     */
    _html(webview) {
        const nonce = createNonce();
        const dist = (...path) => webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'dist', ...path));
        const source = webview.cspSource;
        const csp = [
            "default-src 'none'",
            `script-src 'nonce-${nonce}'`,
            `style-src ${source} 'unsafe-inline'`,
            `font-src ${source}`,
        ].join('; ');
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${dist('codicons', 'codicon.css')}" rel="stylesheet">
<link href="${dist('css', 'speech.css')}" rel="stylesheet">
<title>TTS / STT</title>
</head>
<body>
<main class="speech"></main>
<script nonce="${nonce}" src="${dist('js', 'speech.js')}"></script>
</body>
</html>`;
    }
}
