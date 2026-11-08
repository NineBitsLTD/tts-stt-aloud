import { mkdir, rm, writeFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import { AudioPlayer, LEVEL_INTERVAL } from './AudioPlayer';
import { MicRecorder } from './MicRecorder';

/** @typedef {import('./SpeechSettings').SpeechSettings} SpeechSettings */
/** @typedef {import('./WhisperRecognizer').WhisperRecognizer} WhisperRecognizer */
/** @typedef {import('./MicRecorder').Recording} Recording */
/**
 * @typedef {object} Heard what the speech of a recording was recognized as
 * @property {string | null} text null: not recognized (no recognizer, or it failed: `error`)
 * @property {string} lang the language Whisper heard or was given
 * @property {string} [error] why it was not recognized
 */
/** @typedef {'waiting' | 'recording' | 'playing' | 'recognizing' | 'idle'} MicState */
/** @typedef {{ waitMs?: number, maxMs?: number, silenceMs?: number }} ListenLimits */

/** The limits of a recording asked for by an extension: [min, default, max] in ms. */
const LIMITS = { waitMs: [500, 5000, 30000], maxMs: [1000, 10000, 60000], silenceMs: [300, 1000, 5000] };
/** The recording of the last test of the microphone (removed as the next test begins). */
const TEST_FILE = 'stt-test.wav';

/**
 * @param {ListenLimits} [limits]
 * @returns {{ waitMs: number, maxMs: number, silenceMs: number }} within their ranges
 */
function limitsOf(limits = {}) {
    return Object.fromEntries(Object.entries(LIMITS).map(([key, [min, fallback, max]]) => {
        const value = Number(limits?.[key]);
        return [key, Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback];
    }));
}

/**
 * The microphone of the extension for the side bar and other extensions (`activate` returns it,
 * the commands `tts-stt-md-aloud.record` / `stopRecording`): it records speech — waits for it to
 * begin, ends it after a pause or at its longest (`MicRecorder`) — with the gain of the settings.
 * Other extensions may record only while STT is on (`ttsSttMdAloud.stt.enabled`); the test of the
 * side bar records either way, keeps the recording in the storage of the extension and plays it.
 * With the Whisper driver the speech is recognized (`WhisperRecognizer`: the model and the language
 * of the settings — `ui`: the language of VS Code). The levels and the state of a recording go to
 * `onLevel` / `onState`, whoever records.
 */
export class SpeechToText {

    /**
     * @param {vscode.ExtensionContext} context
     * @param {SpeechSettings} settings
     * @param {WhisperRecognizer} whisper
     */
    constructor(context, settings, whisper) {
        this._storage = context.globalStorageUri;
        this._settings = settings;
        this._whisper = whisper;
        this._recorder = new MicRecorder();
        this._player = new AudioPlayer();
        /** @type {vscode.EventEmitter<{ level?: number, levels?: number[], interval?: number }>} */
        this._levels = new vscode.EventEmitter();
        /** The level of the microphone now (`level`), or the levels of a recording played (`levels`). */
        this.onLevel = this._levels.event;
        /** @type {vscode.EventEmitter<{ state: MicState, owner: unknown, limits?: object }>} */
        this._states = new vscode.EventEmitter();
        /** What the microphone does, for whom. */
        this.onState = this._states.event;
        /** @type {unknown} who records */
        this._owner = null;
        this._playing = false;
    }

    /**
     * The commands other extensions record with.
     * @returns {vscode.Disposable}
     */
    register() {
        return vscode.Disposable.from(
            vscode.commands.registerCommand('tts-stt-md-aloud.record', options => this.record(options ?? {}, 'command')),
            vscode.commands.registerCommand('tts-stt-md-aloud.stopRecording', () => this.stop()),
            new vscode.Disposable(() => this.dispose()),
        );
    }

    dispose() {
        this._recorder.finish();
        this._player.stop();
        this._levels.dispose();
        this._states.dispose();
    }

    /** @returns {string} the recording of the last test ('' : none) */
    get testFile() {
        return this._storage ? vscode.Uri.joinPath(this._storage, TEST_FILE).fsPath : '';
    }

    /**
     * Records speech for another extension.
     * @param {ListenLimits} [limits] waitMs: for the speech to begin (5 s), maxMs: the longest speech
     *   (10 s), silenceMs: the pause that ends it (1 s)
     * @param {unknown} [owner]
     * @returns {Promise<Recording & Heard>} the speech as a WAV file (null when none began) and its text
     */
    async record(limits = {}, owner = 'api') {
        if (!this._settings.get().stt.enabled) throw new Error('Speech to text is off: turn STT on in the TTS / STT side bar to let extensions use the microphone.');
        const recording = await this._record(limitsOf(limits), owner);
        return { ...recording, ...(recording.wav ? await this.recognize(recording.wav) : { text: null, lang: '' }) };
    }

    /**
     * @returns {Promise<{ id: string, available: boolean, message: string, model: string }>} the driver
     *   in use: available when it recognizes (message: why not; model: the model recognizing)
     */
    async recognition() {
        const { driver, model } = this._settings.get().stt;
        if (!driver) return { id: driver, available: false, message: 'Recognition: no driver — check Whisper under Add driver, then add a model.', model: '' };
        if (driver !== 'whisper') {
            return { id: driver, available: false, message: `Recognition: ${this._settings.driverName('stt', driver)} does not recognize speech yet; Whisper does (Add driver → Whisper).`, model: '' };
        }
        const missing = this._whisper.unavailable();
        if (missing) return { id: driver, available: false, message: missing, model: '' };
        const chosen = await this._whisper.model(model);
        if (!chosen) return { id: driver, available: false, message: 'Whisper has no model ready: add one under Add driver → Whisper.', model: '' };
        return { id: driver, available: true, message: '', model: chosen.name };
    }

    /**
     * Recognizes speech with the driver, the model and the language of the settings.
     * @param {Buffer} wav
     * @returns {Promise<Heard>}
     */
    async recognize(wav) {
        const recognition = await this.recognition();
        if (!recognition.available) return { text: null, lang: '', error: recognition.message };
        const { model, language } = this._settings.get().stt;
        try {
            const { text, lang } = await this._whisper.recognize(wav, { model, language: language === 'ui' ? vscode.env.language.split('-')[0].toLowerCase() : language });
            return { text, lang };
        } catch (error) {
            return { text: null, lang: '', error: String(error?.message || error) };
        }
    }

    /**
     * Ends the recording: the speech recorded so far is kept.
     * @param {unknown} [owner] only when this owner records
     */
    stop(owner = undefined) {
        if (owner === undefined || owner === this._owner) this._recorder.finish();
    }

    /**
     * The test of the side bar: removes the last recording, records speech (5 s for it to begin,
     * 10 s at most, ended by 1 s of silence), keeps it, plays it at the volume of the speech and
     * recognizes it meanwhile.
     * @param {number} volume from 0 to 1
     * @returns {Promise<Recording & Heard & { played: boolean }>}
     */
    async test(volume) {
        const file = this.testFile;
        if (file) await rm(file, { force: true });
        const recording = await this._record(limitsOf(), 'test');
        if (!recording.wav) return { ...recording, played: false, text: null, lang: '' };
        if (file) {
            await mkdir(this._storage.fsPath, { recursive: true });
            await writeFile(file, recording.wav);
        }
        const recognizing = (await this.recognition()).available;
        const heard = this.recognize(recording.wav);
        this._playing = true;
        this._states.fire({ state: 'playing', owner: 'test' });
        let played;
        try {
            played = await this._player.play(recording.wav, { volume, onLevels: (levels, interval) => this._levels.fire({ levels, interval }) });
        } finally {
            this._playing = false;
            this._levels.fire({ levels: [], interval: LEVEL_INTERVAL });
        }
        if (recognizing) this._states.fire({ state: 'recognizing', owner: 'test' });
        try {
            return { ...recording, played, ...(await heard) };
        } finally {
            this._states.fire({ state: 'idle', owner: 'test' });
        }
    }

    /**
     * Stops the test: the speech recorded so far is kept and played; playing stops.
     */
    stopTest() {
        this.stop('test');
        if (this._playing) this._player.stop();
    }

    /**
     * @param {{ waitMs: number, maxMs: number, silenceMs: number }} limits
     * @param {unknown} owner
     * @returns {Promise<Recording>}
     */
    async _record(limits, owner) {
        if (this._recorder.busy) throw new Error('The microphone is busy: another recording is going on.');
        this._owner = owner;
        try {
            return await this._recorder.record({
                ...limits,
                gain: this._settings.get().stt.volume / 100,
                onLevel: level => this._levels.fire({ level }),
                onState: state => this._states.fire({ state, owner, limits }),
            });
        } finally {
            this._owner = null;
            this._states.fire({ state: 'idle', owner });
        }
    }
}
