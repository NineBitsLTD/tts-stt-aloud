import * as vscode from 'vscode';
import { pickVoice } from '../utils/pickVoice';
import { AudioPlayer, LEVEL_INTERVAL } from './AudioPlayer';
import { SystemSpeech } from './SystemSpeech';

/** @typedef {import('./SpeechSettings').SpeechSettings} SpeechSettings */
/** @typedef {import('./PiperSpeech').PiperSpeech} PiperSpeech */
/** @typedef {{ name: string, lang: string, score?: number, sample?: string, checked: boolean }} SpeechVoice */
/** @typedef {{ voice?: string, lang?: string, rate?: number }} SpeakOptions voice: '' or none picks the best (checked) voice of lang; rate: the speed of the settings when not given */

/** Phrases to try a voice with, by language, when the system gives none. */
const SAMPLES = {
    en: 'Hello! This is how this voice sounds.',
    ru: 'Здравствуйте! Так звучит этот голос.',
    uk: 'Вітаю! Так звучить цей голос.',
};

/**
 * The text to speech of the extension for the Markdown preview, the side bar and other extensions
 * (`activate` returns it, the commands `tts-stt-md-aloud.speak` / `stopSpeaking` / `voices`): the
 * driver, the volume and the speed of the settings. The voices of the system (`SystemSpeech`) and
 * of Piper (`PiperSpeech`, sherpa-onnx) are rendered to audio and played by `AudioPlayer` — the
 * volume is a share of the computer's, the levels go to `onLevels` —; the phrase to come is
 * rendered while one is spoken. One speech at a time: a new one ends the one being spoken,
 * whoever asked for it.
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
            vscode.commands.registerCommand('tts-stt-md-aloud.speak', (text, options) => this.speak(String(text ?? ''), options ?? {}, 'command')),
            vscode.commands.registerCommand('tts-stt-md-aloud.stopSpeaking', () => this.stop()),
            vscode.commands.registerCommand('tts-stt-md-aloud.voices', () => this.offeredVoices()),
            new vscode.Disposable(() => this.dispose()),
        );
    }

    dispose() {
        this.stop();
        this._levels.dispose();
    }

    /**
     * @returns {Promise<{ id: string, available: boolean, message: string }>} the driver in use:
     *   available when it can speak (message: why not)
     */
    async driver() {
        const { driver } = this._settings.get().tts;
        if (driver === 'system') return { id: driver, available: true, message: '' };
        if (driver === 'piper') {
            const message = this._piper.unavailable()
                || ((await this._piper.voices()).length ? '' : 'Piper has no voice model ready for sherpa-onnx: add one under Add driver → Piper.');
            return { id: driver, available: !message, message };
        }
        const name = this._settings.driverName('tts', driver);
        const message = driver.startsWith('external:') ? `${name}: speaking through external servers is not supported yet.`
            : `${name} is not installed yet: its models and tools come in a later version.`;
        return { id: driver, available: false, message };
    }

    /**
     * @param {{ refresh?: boolean }} [options] refresh: ask the system again (voices installed meanwhile)
     * @returns {Promise<SpeechVoice[]>} the voices of the driver in use, checked as in the settings
     */
    async voices({ refresh = false } = {}) {
        const driver = await this.driver();
        if (!driver.available) return [];
        const checked = new Set(this._settings.get().tts.voices[driver.id] ?? []);
        let voices;
        if (driver.id === 'piper') {
            voices = (await this._piper.voices()).map(({ name, lang, score }) => ({ name, lang, score }));
        } else {
            if (refresh || !this._systemVoices) this._systemVoices = this._system.voices();
            voices = await this._systemVoices;
        }
        return voices.map(voice => ({ ...voice, checked: checked.has(voice.name) }));
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
    async speak(text, { next, ...options } = {}, owner = null) {
        this.stop();
        const run = this._run;
        this._owner = owner;
        const settings = this._settings.get().tts;
        if (!settings.enabled || !text.trim()) return !!settings.enabled;
        const driver = await this.driver();
        if (!driver.available) throw new Error(driver.message);
        const phrase = await this._resolve(options);
        if (run !== this._run) return false;
        const volume = settings.volume / 100;
        const system = driver.id === 'system';
        if (system && !this._system.canRender) {
            await this._system.speak(text, { ...phrase, volume });
            return run === this._run;
        }
        let wav;
        try {
            wav = await this._render(driver.id, text, phrase);
        } catch (error) {
            if (!system) throw error;
            // The system cannot write this voice to a file: it speaks it itself
            if (run !== this._run) return false;
            await this._system.speak(text, { ...phrase, volume });
            return run === this._run;
        }
        if (next?.text?.trim()) this._renderAhead(driver.id, next.text, await this._resolve(next));
        if (run !== this._run) return false;
        const played = await this._player.play(wav, { volume, onLevels: (levels, interval) => this._levels.fire({ levels, interval }) });
        return played && run === this._run;
    }

    /**
     * Speaks the phrase the system gives to try a voice (else one of its language).
     * @param {string} name of the voice ('' : the best voice of English)
     * @returns {Promise<boolean>}
     */
    async test(name) {
        const voice = (await this.voices()).find(item => item.name === name);
        const lang = voice?.lang.slice(0, 2).toLowerCase() ?? 'en';
        return this.speak(voice?.sample || SAMPLES[lang] || SAMPLES.en, { voice: voice?.name, lang }, 'test');
    }

    /**
     * Ends the speech being spoken.
     * @param {unknown} [owner] only when it is the speech this owner asked for
     */
    stop(owner = undefined) {
        if (owner !== undefined && owner !== this._owner) return;
        this._run++;
        this._owner = null;
        this._player.stop();
        this._system.stop();
        this._levels.fire({ levels: [], interval: LEVEL_INTERVAL });
    }

    /**
     * @param {SpeakOptions} options
     * @returns {Promise<{ voice?: string, rate: number, lang?: string }>} the voice (the best checked
     *   one of the language when none is given) and the speed
     */
    async _resolve({ voice, lang, rate }) {
        const settings = this._settings.get().tts;
        const chosen = voice || (lang ? pickVoice(await this.voices(), lang, settings.voices[settings.driver] ?? []) : '');
        return { voice: chosen || undefined, rate: Number(rate) > 0 ? Number(rate) : settings.rate, lang };
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
