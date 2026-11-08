import * as vscode from 'vscode';
import { estimateReading } from '../utils/phraseSpans';
import { pickVoice } from '../utils/pickVoice';
import { WavAudio } from '../utils/WavAudio';
import { AudioPlayer, LEVEL_INTERVAL } from './AudioPlayer';
import { DeviceLock, priorityOf } from './DeviceLock';
import { SystemSpeech } from './SystemSpeech';

const t = vscode.l10n.t;

/** @typedef {import('./SpeechSettings').SpeechSettings} SpeechSettings */
/** @typedef {import('./PiperSpeech').PiperSpeech} PiperSpeech */
/**
 * @typedef {object} SpeechVoice a voice of an active driver
 * @property {string} key `<driver>:<name>`, unique among the drivers
 * @property {string} name its name for its driver
 * @property {string} lang
 * @property {number} [score] its quality: 2 Enhanced / Premium system voices, 1 Piper, 0 other system voices
 * @property {string} [sample] a phrase the system gives to try it
 * @property {string} driver the id of its driver
 * @property {string} driverName
 * @property {boolean} checked picked by Auto first, offered to other extensions
 */
/** @typedef {{ id: string, name: string, available: boolean, message: string }} DriverStatus available: it can speak (message: why not) */
/**
 * @typedef {{ voice?: string, lang?: string, rate?: number, priority?: number, resumeText?: string, resumeLang?: string }} SpeakOptions
 *   voice: '' or none picks the best (checked) voice of lang; rate: the speed of the settings when not given; priority: 0–2 among
 *   the windows of VS Code (`DeviceLock`); resumeText: said first when the phrase is said again after another window interrupted it,
 *   in resumeLang (else lang)
 */

/** @typedef {{ wav?: Buffer, text: string, phrase: { voice?: string, rate: number, lang?: string }, volume: number }} PlayedSound wav: none when the system speaks the text itself */

/** Phrases to try a voice with, by language, when the system gives none. */
const SAMPLES = {
    en: 'Hello! This is how this voice sounds.',
    ru: 'Здравствуйте! Так звучит этот голос.',
    uk: 'Вітаю! Так звучить цей голос.',
};

/**
 * The text to speech of the extension for the player of the editors, the side bar and other extensions
 * (`activate` returns it, the commands `tts-stt-aloud.speak` / `stopSpeaking` / `voices`): the
 * active drivers, the volume and the speed of the settings. The voices of the active drivers are
 * offered together (keyed `<driver>:<name>`); a phrase is spoken by the driver of its voice — the
 * voice given, else the best of its language: a checked one first, then by quality. The voices of
 * the system (`SystemSpeech`) and of Piper (`PiperSpeech`, sherpa-onnx) are rendered to audio and
 * played by `AudioPlayer` — the volume is a share of the computer's, the levels go to `onLevels` —;
 * the phrase to come is rendered while one is spoken. One speech at a time: a new one ends the one
 * being spoken, whoever asked for it. Among the windows of VS Code the speaker is shared through
 * `DeviceLock`: a speech waits for its turn (`onWaiting`); one of a higher priority pauses the speech
 * being played, which says its phrase again when the speaker is free, after its `resumeText`.
 */
export class TextToSpeech {

    /**
     * @param {SpeechSettings} settings
     * @param {PiperSpeech} piper
     */
    constructor(settings, piper) {
        this._settings = settings;
        this._piper = piper;
        this._system = new SystemSpeech();
        this._player = new AudioPlayer();
        /** @type {vscode.EventEmitter<{ levels: number[], interval: number }>} */
        this._levels = new vscode.EventEmitter();
        /** The levels of the sound as it starts playing (empty: silence). */
        this.onLevels = this._levels.event;
        /** @type {vscode.EventEmitter<boolean>} */
        this._waiting = new vscode.EventEmitter();
        /** The speech waits for another window to finish, or no longer. */
        this.onWaiting = this._waiting.event;
        this._speaker = new DeviceLock('speaker');
        /** @type {AbortController | null} ends the waiting for the speaker */
        this._waitingFor = null;
        this._run = 0;
        /** @type {unknown} who asked for the speech being spoken */
        this._owner = null;
        /** @type {{ key: string, wav: Promise<Buffer> } | null} the phrase to come, rendered ahead */
        this._ahead = null;
        /** @type {Promise<import('./SystemSpeech').SystemVoice[]> | null} */
        this._systemVoices = null;
    }

    /**
     * The commands other extensions speak with.
     * @returns {vscode.Disposable}
     */
    register() {
        return vscode.Disposable.from(
            vscode.commands.registerCommand('tts-stt-aloud.speak', (text, options) => this.speak(String(text ?? ''), options ?? {}, 'command')),
            vscode.commands.registerCommand('tts-stt-aloud.stopSpeaking', () => this.stop()),
            vscode.commands.registerCommand('tts-stt-aloud.voices', () => this.offeredVoices()),
            new vscode.Disposable(() => this.dispose()),
        );
    }

    dispose() {
        this.stop();
        this._levels.dispose();
        this._waiting.dispose();
    }

    /**
     * @returns {Promise<{ available: boolean, message: string, drivers: DriverStatus[] }>} the active
     *   drivers: available when one of them can speak; message: why those that cannot
     */
    async status() {
        const drivers = await Promise.all(this._settings.get().tts.active.map(id => this._status(id)));
        return { available: drivers.some(driver => driver.available), message: drivers.filter(driver => !driver.available).map(driver => driver.message).join(' '), drivers };
    }

    /**
     * @param {{ refresh?: boolean }} [options] refresh: ask the system again (voices installed meanwhile)
     * @returns {Promise<SpeechVoice[]>} the voices of the active drivers that can speak, checked as in the settings
     */
    async voices({ refresh = false } = {}) {
        const settings = this._settings.get().tts;
        const { drivers } = await this.status();
        const lists = await Promise.all(drivers.filter(driver => driver.available).map(async (driver) => {
            const checked = new Set(settings.voices[driver.id] ?? []);
            const voices = driver.id === 'piper' ? (await this._piper.voices()).map(({ name, lang, score }) => ({ name, lang, score })) : await this._systemVoicesOf(refresh);
            return voices.map(voice => ({ ...voice, key: `${driver.id}:${voice.name}`, driver: driver.id, driverName: driver.name, checked: checked.has(voice.name) }));
        }));
        return lists.flat();
    }

    /**
     * @returns {Promise<SpeechVoice[]>} the voices offered to other extensions: the checked ones,
     *   all of them when none is checked
     */
    async offeredVoices() {
        const voices = await this.voices();
        return voices.some(voice => voice.checked) ? voices.filter(voice => voice.checked) : voices;
    }

    /**
     * Speaks a phrase (a new one ends the phrase being spoken).
     * @param {string} text
     * @param {SpeakOptions & { next?: SpeakOptions & { text: string } }} [options] next: the phrase
     *   to come, rendered while this one is spoken
     * @param {unknown} [owner] who asks: `stop(owner)` ends only its own speech
     * @returns {Promise<boolean>} true when spoken to the end, false when stopped (or the speech is off)
     */
    async speak(text, { next, priority, resumeText, resumeLang, ...options } = {}, owner = null) {
        this._halt();
        const run = this._run;
        this._owner = owner;
        const settings = this._settings.get().tts;
        if (!settings.enabled || !text.trim()) return !!settings.enabled;
        const status = await this.status();
        if (!status.available) throw new Error(status.message);
        const { driver, phrase } = await this._resolve(options, status);
        if (run !== this._run) return false;
        const volume = settings.volume / 100;
        const system = driver === 'system';
        // The sound is made while the speaker is being marked as this window's
        const rendering = system && !this._system.canRender ? Promise.resolve({}) : this._render(driver, text, phrase).then(wav => ({ wav }), error => ({ error }));
        const level = priorityOf(owner, priority);
        const turn = await this._waitTurn(level, rendering);
        if (run !== this._run || !turn) return false;
        const { wav, error } = await rendering;
        if (error && !system) {
            this._speaker.release();
            throw error;
        }
        const going = !!next?.text?.trim();
        if (wav && going) {
            const coming = await this._resolve(next, status);
            this._renderAhead(coming.driver, next.text, coming.phrase);
            if (run !== this._run) return false;
        }
        const spoken = await this._playInTurn({ wav, text, phrase, volume }, level, run, { text: resumeText, lang: resumeLang });
        if (run === this._run) this._speaker.finishPlaying(going && spoken);
        return spoken && run === this._run;
    }

    /**
     * @param {number} level the priority of the speech
     * @param {Promise<unknown>} ready the sound being made
     * @returns {Promise<boolean>} whether the speaker is this window's (false: the speech was ended)
     */
    async _waitTurn(level, ready) {
        const abort = new AbortController();
        this._waitingFor = abort;
        const turn = await this._speaker.hold(level, ready, { signal: abort.signal, onWait: waiting => this._waiting.fire(waiting) });
        if (this._waitingFor === abort) this._waitingFor = null;
        return turn;
    }

    /**
     * Plays a phrase; when another window takes the speaker over it pauses, and when its turn comes
     * says what it was given to say on going on, then the phrase again.
     * @param {PlayedSound} sound
     * @param {number} level the priority of the speech
     * @param {number} run of this speech
     * @param {{ text?: string, lang?: string }} resume
     * @returns {Promise<boolean>} true when spoken to the end
     */
    async _playInTurn(sound, level, run, resume) {
        let interrupted = false;
        while (run === this._run) {
            const notice = interrupted ? await this._resumeSound(resume, sound) : null;
            if (run !== this._run) return false;
            const said = notice ? await this._playWatched(notice) : null;
            if (run !== this._run) return false;
            const result = said?.overtaken ? said : await this._playWatched(sound);
            if (!result.overtaken) return result.spoken;
            if (run !== this._run) return false;
            interrupted = true;
            // Says that the sound has stopped: the window that took the speaker over is waiting for that
            await this._speaker.finishPlaying(true);
            if (!await this._waitTurn(level, Promise.resolve())) return false;
        }
        return false;
    }

    /**
     * Plays a sound while watching the speaker: another window taking it over stops the sound. Without a
     * sound file (or when the system cannot write this voice to one) the system speaks the text itself.
     * @param {PlayedSound} sound
     * @returns {Promise<{ spoken: boolean, overtaken: boolean }>}
     */
    async _playWatched({ wav, text, phrase, volume }) {
        await this._speaker.startPlaying(wav ? (WavAudio.parse(wav)?.duration ?? 60) * 1000 : estimateReading(text, phrase.rate) * 2);
        let overtaken = false;
        const watching = this._speaker.watch(() => {
            overtaken = true;
            this._player.stop();
            this._system.stop();
            this._levels.fire({ levels: [], interval: LEVEL_INTERVAL });
        });
        try {
            const spoken = wav ? await this._player.play(wav, { volume, onLevels: (levels, interval) => this._levels.fire({ levels, interval }) }) : (await this._system.speak(text, { ...phrase, volume }), true);
            return { spoken, overtaken };
        } finally {
            watching.stop();
        }
    }

    /**
     * @param {{ text?: string, lang?: string }} resume
     * @param {PlayedSound} sound the phrase it comes before
     * @returns {Promise<PlayedSound | null>} what to say on going on (null: nothing, or it cannot be said)
     */
    async _resumeSound({ text, lang }, { phrase: { rate, lang: phraseLang }, volume }) {
        if (!text?.trim()) return null;
        try {
            const { driver, phrase } = await this._resolve({ lang: lang ?? phraseLang, rate }, await this.status());
            if (driver === 'system' && !this._system.canRender) return { text, phrase, volume };
            return { wav: await this._render(driver, text, phrase), text, phrase, volume };
        } catch {
            return null;
        }
    }

    /**
     * Speaks the phrase the system gives to try a voice (else one of its language).
     * @param {string} key of the voice (or its name; '' : the best voice of English)
     * @returns {Promise<boolean>}
     */
    async test(key) {
        const voices = await this.voices();
        const voice = voices.find(item => item.key === key) ?? voices.find(item => item.name === key);
        const lang = voice?.lang.slice(0, 2).toLowerCase() ?? 'en';
        return this.speak(voice?.sample || SAMPLES[lang] || SAMPLES.en, { voice: voice?.key, lang }, 'test');
    }

    /**
     * Ends the speech being spoken.
     * @param {unknown} [owner] only when it is the speech this owner asked for
     */
    stop(owner = undefined) {
        if (owner !== undefined && owner !== this._owner) return;
        this._halt();
        this._speaker.release();
    }

    /** Ends the speech being spoken (or waiting for its turn); the next phrase may keep the speaker. */
    _halt() {
        this._run++;
        this._owner = null;
        this._waitingFor?.abort();
        this._waitingFor = null;
        this._player.stop();
        this._system.stop();
        this._levels.fire({ levels: [], interval: LEVEL_INTERVAL });
    }

    /**
     * @param {SpeakOptions} options voice: a key or a name
     * @param {{ drivers: DriverStatus[] }} status of the active drivers
     * @returns {Promise<{ driver: string, phrase: { voice?: string, rate: number, lang?: string } }>} the
     *   driver speaking and how: the voice given, else the best of the language — a checked one first,
     *   then by quality —, else the first driver that can speak with its own choice
     */
    async _resolve({ voice, lang, rate }, status) {
        const voices = await this.voices();
        let chosen = voice ? voices.find(item => item.key === voice) ?? voices.find(item => item.name === voice) : null;
        if (!chosen && lang) {
            const key = pickVoice(voices.map(item => ({ name: item.key, lang: item.lang, score: item.score })), lang, voices.filter(item => item.checked).map(item => item.key));
            chosen = voices.find(item => item.key === key) ?? null;
        }
        return {
            driver: chosen?.driver ?? status.drivers.find(driver => driver.available).id,
            phrase: { voice: chosen?.name, rate: Number(rate) > 0 ? Number(rate) : this._settings.get().tts.rate, lang },
        };
    }

    /**
     * @param {string} id
     * @returns {Promise<DriverStatus>} whether an active driver can speak
     */
    async _status(id) {
        const name = this._settings.driverName('tts', id);
        if (id === 'system') return { id, name, available: true, message: '' };
        if (id === 'piper') {
            const message = this._piper.unavailable()
                || ((await this._piper.voices()).length ? '' : t('Piper has no voice model ready for sherpa-onnx: add one under Add driver → Piper.'));
            return { id, name, available: !message, message };
        }
        const message = id.startsWith('external:') ? t('{0}: speaking through external servers is not supported yet.', name)
            : t('{0} is not installed yet: its models and tools come in a later version.', name);
        return { id, name, available: false, message };
    }

    /**
     * @param {boolean} refresh ask the system again
     * @returns {Promise<{ name: string, lang: string, score: number, sample?: string }[]>} the voices of the system
     */
    _systemVoicesOf(refresh) {
        if (refresh || !this._systemVoices) this._systemVoices = this._system.voices();
        return this._systemVoices;
    }

    /**
     * @param {string} driver
     * @param {string} text
     * @param {{ voice?: string, rate: number, lang?: string }} phrase
     * @returns {Promise<Buffer>} the audio of a phrase (rendered ahead when it was the one to come)
     */
    _render(driver, text, phrase) {
        const key = JSON.stringify([driver, text, phrase.voice ?? '', phrase.rate]);
        const ahead = this._ahead;
        this._ahead = null;
        return ahead?.key === key ? ahead.wav : this._engine(driver).render(text, phrase);
    }

    /**
     * @param {string} driver
     * @param {string} text
     * @param {{ voice?: string, rate: number, lang?: string }} phrase
     */
    _renderAhead(driver, text, phrase) {
        const wav = this._engine(driver).render(text, phrase);
        wav.catch(() => {});
        this._ahead = { key: JSON.stringify([driver, text, phrase.voice ?? '', phrase.rate]), wav };
    }

    /**
     * @param {string} driver
     * @returns {{ render: (text: string, phrase: { voice?: string, rate: number, lang?: string }) => Promise<Buffer> }}
     */
    _engine(driver) {
        return driver === 'piper' ? this._piper : this._system;
    }
}
