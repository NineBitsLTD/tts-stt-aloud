import { mkdir, rm, writeFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import { AudioPlayer, LEVEL_INTERVAL } from './AudioPlayer';
import { DEVICE_PRIORITY, DeviceLock } from './DeviceLock';
import { MicRecorder } from './MicRecorder';

const t = vscode.l10n.t;

/** @typedef {import('./SpeechSettings').SpeechSettings} SpeechSettings */
/** @typedef {import('./WhisperRecognizer').WhisperRecognizer} WhisperRecognizer */
/** @typedef {import('./MicRecorder').Recording} Recording */
/**
 * @typedef {object} Heard what the speech of a recording was recognized as
 * @property {string | null} text null: not recognized (no recognizer, or it failed: `error`)
 * @property {string} lang the language Whisper heard or was given
 * @property {string} [error] why it was not recognized
 */
/** @typedef {'queued' | 'waiting' | 'recording' | 'playing' | 'recognizing' | 'idle'} MicState queued: another window has the microphone */
/** @typedef {{ waitMs?: number, maxMs?: number, silenceMs?: number }} ListenLimits */
/** @typedef {{ owner: unknown, abort: AbortController, recording: boolean }} MicrophoneCall a recording asked for: going on, or waiting for the microphone */

/** The limits of a recording asked for by an extension: [min, default, max] in ms. */
const LIMITS = { waitMs: [500, 5000, 30000], maxMs: [1000, 10000, 60000], silenceMs: [300, 1000, 5000] };
/** Who records for an application; anyone else records because a person pressed a button. */
const APPLICATIONS = new Set(['api', 'command']);
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
 * the commands `tts-stt-aloud.record` / `stopRecording`): it records speech — waits for it to
 * begin, ends it after a pause or at its longest (`MicRecorder`) — with the gain of the settings.
 * Other extensions may record only while STT is on (`ttsSttAloud.stt.enabled`); the test of the
 * side bar records either way, keeps the recording in the storage of the extension and plays it.
 * With the Whisper driver the speech is recognized (`WhisperRecognizer`: the model and the language
 * of the settings — `ui`: the language of VS Code). The levels and the state of a recording go to
 * `onLevel` / `onState`, whoever records. The microphone is shared through `DeviceLock`, within a window
 * and among the windows of VS Code: a person (the buttons) stops the recording going on — it ends with what
 * it has, `ended: 'interrupted'` —, an application waits for the microphone to be free (state `queued`).
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
        /** @type {Set<MicrophoneCall>} */
        this._calls = new Set();
        /** @type {Map<unknown, DeviceLock>} the microphone kept between the phrases of a dictation, by who keeps it */
        this._kept = new Map();
        this._lockCount = 0;
        this._player = new AudioPlayer();
        /** @type {vscode.EventEmitter<{ level?: number, levels?: number[], interval?: number }>} */
        this._levels = new vscode.EventEmitter();
        /** The level of the microphone now (`level`), or the levels of a recording played (`levels`). */
        this.onLevel = this._levels.event;
        /** @type {vscode.EventEmitter<{ state: MicState, owner: unknown, limits?: object }>} */
        this._states = new vscode.EventEmitter();
        /** What the microphone does, for whom. */
        this.onState = this._states.event;
        this._playing = false;
    }

    /**
     * The commands other extensions record with.
     * @returns {vscode.Disposable}
     */
    register() {
        return vscode.Disposable.from(
            vscode.commands.registerCommand('tts-stt-aloud.record', options => this.record(options ?? {}, 'command')),
            vscode.commands.registerCommand('tts-stt-aloud.stopRecording', () => this.stop()),
            new vscode.Disposable(() => this.dispose()),
        );
    }

    dispose() {
        this.stop();
        for (const lock of this._kept.values()) lock.release();
        this._kept.clear();
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
        const recording = await this.listen(limits, owner);
        return { ...recording, ...(recording.wav ? await this.recognize(recording.wav) : { text: null, lang: '' }) };
    }

    /**
     * Records speech without recognizing it (the dictation listens for the next phrase meanwhile).
     * @param {ListenLimits} [limits]
     * @param {unknown} [owner]
     * @param {{ keep?: boolean }} [options] keep: another phrase follows, the microphone stays this
     *   window's (`releaseMicrophone` ends that)
     * @returns {Promise<Recording>}
     */
    async listen(limits = {}, owner = 'api', { keep = false } = {}) {
        if (!this._settings.get().stt.enabled) throw new Error(t('Speech to text is off: turn STT on in the TTS / STT side bar to let extensions use the microphone.'));
        return this._record(limitsOf(limits), owner, { keep });
    }

    /**
     * No more phrases follow: others may have the microphone.
     * @param {unknown} owner who kept it
     */
    releaseMicrophone(owner) {
        this._kept.get(owner)?.release();
        this._kept.delete(owner);
    }

    /**
     * @returns {Promise<{ id: string, available: boolean, message: string, model: string }>} the driver
     *   in use: available when it recognizes (message: why not; model: the model recognizing)
     */
    async recognition() {
        const { driver, model } = this._settings.get().stt;
        if (!driver) return { id: driver, available: false, message: t('Recognition: no driver — check Whisper under Add driver, then add a model.'), model: '' };
        if (driver !== 'whisper') {
            return { id: driver, available: false, message: t('Recognition: {0} does not recognize speech yet; Whisper does (Add driver → Whisper).', this._settings.driverName('stt', driver)), model: '' };
        }
        const missing = this._whisper.unavailable();
        if (missing) return { id: driver, available: false, message: missing, model: '' };
        const chosen = await this._whisper.model(model);
        if (!chosen) return { id: driver, available: false, message: t('Whisper has no model ready: add one under Add driver → Whisper.'), model: '' };
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
     * @param {unknown} [owner] only of this owner (waiting for the microphone too)
     */
    stop(owner = undefined) {
        for (const call of this._calls) {
            if (owner !== undefined && owner !== call.owner) continue;
            call.abort.abort();
            if (call.recording) this._recorder.finish();
        }
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
     * Gets the microphone and records: a person stops the recording going on, an application waits.
     * @param {{ waitMs: number, maxMs: number, silenceMs: number }} limits
     * @param {unknown} owner
     * @param {{ keep?: boolean }} [options] keep: another phrase follows
     * @returns {Promise<Recording>}
     */
    async _record(limits, owner, { keep = false } = {}) {
        const person = !APPLICATIONS.has(owner);
        const continuing = this._kept.has(owner);
        const lock = this._kept.get(owner) ?? this._createLock(`${process.pid}.${++this._lockCount}`);
        if (keep) this._kept.set(owner, lock);
        const call = { owner, abort: new AbortController(), recording: false };
        this._calls.add(call);
        try {
            // Between the phrases of a dictation someone may have taken the microphone over
            if (continuing && !await lock.holds()) return { wav: null, duration: 0, ended: 'interrupted' };
            const turn = await lock.hold(person ? DEVICE_PRIORITY.high : DEVICE_PRIORITY.low, Promise.resolve(), {
                force: person && !continuing,
                signal: call.abort.signal,
                onWait: waiting => waiting && this._states.fire({ state: 'queued', owner, limits }),
            });
            if (!turn) {
                lock.release();
                return { wav: null, duration: 0, ended: 'cancelled' };
            }
            return await this._recordInTurn(limits, call, lock, keep);
        } finally {
            this._calls.delete(call);
            if (![...this._calls].some(item => item.recording)) this._states.fire({ state: 'idle', owner });
        }
    }

    /**
     * Records while the microphone is this one's: taken over, the recording ends with what it has.
     * @param {{ waitMs: number, maxMs: number, silenceMs: number }} limits
     * @param {MicrophoneCall} call
     * @param {DeviceLock} lock
     * @param {boolean} keep another phrase follows
     * @returns {Promise<Recording>}
     */
    async _recordInTurn(limits, call, lock, keep) {
        await lock.startPlaying(limits.waitMs + limits.maxMs);
        let interrupted = false;
        let recorded = false;
        const watching = lock.watch(() => {
            interrupted = true;
            this._recorder.finish();
        });
        call.recording = true;
        try {
            const recording = await this._recorder.record({
                ...limits,
                gain: this._settings.get().stt.volume / 100,
                onLevel: level => this._levels.fire({ level }),
                onState: state => this._states.fire({ state, owner: call.owner, limits }),
            });
            recorded = true;
            return interrupted ? { ...recording, ended: 'interrupted' } : recording;
        } finally {
            call.recording = false;
            watching.stop();
            await lock.finishPlaying(keep && recorded && !interrupted);
        }
    }

    /**
     * @param {string} owner in the record
     * @returns {DeviceLock} of the microphone, for one recording (or one dictation)
     */
    _createLock(owner) {
        return new DeviceLock('microphone', { owner });
    }
}
