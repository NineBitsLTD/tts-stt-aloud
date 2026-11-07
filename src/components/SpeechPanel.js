import * as vscode from 'vscode';
import { createNonce } from '../utils/createNonce';

/** @typedef {import('./SpeechSettings').SpeechSettings} SpeechSettings */
/** @typedef {import('./TextToSpeech').TextToSpeech} TextToSpeech */
/** @typedef {import('./SpeechToText').SpeechToText} SpeechToText */
/** @typedef {import('./PiperModels').PiperModels} PiperModels */

/**
 * The side bar of the speech settings (the speaker of the activity bar, the webview view
 * `tts-stt-md-aloud.speech`; `src/speech.js`): TTS — on / off, volume, speed, the level of the
 * sound, the driver, the drivers offered (Piper, Silero, external servers), the voices checked and
 * the voice tested —, STT — on / off (whether other extensions may use the microphone), the gain
 * and the level of the microphone, its drivers, the test of the microphone (recorded, played); the
 * voice models of Piper while it is offered (`PiperModels`: chosen on the disk or downloaded, prepared for sherpa-onnx). The
 * settings are those of VS Code (`SpeechSettings`), so a change made elsewhere shows here.
 * @implements {vscode.WebviewViewProvider}
 */
export class SpeechPanel {

    static viewId = 'tts-stt-md-aloud.speech';

    /**
     * @param {vscode.ExtensionContext} context
     * @param {SpeechSettings} settings
     * @param {TextToSpeech} tts
     * @param {SpeechToText} stt
     * @param {PiperModels} piper
     */
    constructor(context, settings, tts, stt, piper) {
        this._context = context;
        this._settings = settings;
        this._tts = tts;
        this._stt = stt;
        this._piper = piper;
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
            this._stt.onLevel(level => this._post({ type: 'level', section: 'stt', ...level })),
            this._stt.onState(({ state, owner, limits }) => this._post({ type: 'micState', state, test: owner === 'test', limits })),
            this._piper.onDidChange(() => this._postState()),
        );
    }

    /**
     * @param {vscode.WebviewView} view
     */
    resolveWebviewView(view) {
        this._view = view;
        view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this._context.extensionUri, 'dist')] };
        view.webview.html = this._html(view.webview);
        const subscription = view.webview.onDidReceiveMessage(message => this._onMessage(message));
        view.onDidDispose(() => {
            subscription.dispose();
            this._tts.stop('test');
            this._stt.stopTest();
            this._view = null;
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
                await this._postState();
                await this._postVoices(true);
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
                    reply(section === 'stt' ? await this._testMicrophone() : await this._tts.test(String(message.voice ?? '')));
                } catch (error) {
                    reply(undefined, String(error?.message || error));
                }
                break;
            case 'stopTest':
                if (section === 'stt') this._stt.stopTest();
                else this._tts.stop('test');
                break;
            case 'browseModel':
                reply(await this._piper.browse());
                break;
            case 'modelCatalog':
                try {
                    reply(await this._piper.catalog());
                } catch (error) {
                    reply(undefined, String(error?.message || error));
                }
                break;
            case 'addModel':
                try {
                    reply(message.key ? await this._piper.download(String(message.key)) : await this._piper.addFile(String(message.path ?? '')));
                } catch (error) {
                    reply(String(error?.message || error));
                }
                break;
            case 'removeModel':
                await this._piper.remove(String(message.path ?? ''));
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
    }

    /**
     * Records speech and plays it (the speech being spoken stops: it would be recorded).
     * @returns {Promise<{ heard: boolean, duration: number, ended: string, text: string | null }>}
     *   text: null — recognition is not connected yet
     */
    async _testMicrophone() {
        this._tts.stop();
        const { wav, duration, ended } = await this._stt.test(this._settings.get().tts.volume / 100);
        return { heard: !!wav, duration, ended, text: null };
    }

    async _postState() {
        const settings = this._settings.get();
        const piper = await this._piper.list();
        this._post({
            type: 'state',
            settings,
            drivers: { tts: this._settings.drivers('tts'), stt: this._settings.drivers('stt') },
            models: { tts: { piper: { models: piper, pending: [...this._piper.pending].map(([name, action]) => ({ name, action })) } } },
            notes: {
                tts: (await this._tts.driver()).message,
                stt: settings.stt.enabled ? 'Other extensions may use the microphone.' : 'Other extensions may not use the microphone (the test works anyway).',
            },
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
