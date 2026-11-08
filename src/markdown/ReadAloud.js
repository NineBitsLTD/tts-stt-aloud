import { pickVoice, speaksLanguage } from '../utils/pickVoice';
import { guessLanguage } from './PreviewTranslation';

/** @typedef {import('./HostRequests').HostRequests} HostRequests */
/** @typedef {import('../utils/pickVoice').Voice & { key: string, driverName?: string }} Voice key: `<driver>:<name>` from the host, the name for the voices of the webview */
/** @typedef {{ voice?: string, rate: number, lang?: string, volume?: number }} PhraseOptions */
/**
 * @typedef {object} ReadingSettings
 * @property {string} voice the key of the voice of the preview ('' : Auto)
 * @property {number} rate the speed of the speech settings
 * @property {boolean} enabled whether text to speech is on
 * @property {number} volume % of the volume of the computer
 * @property {string} drivers the active drivers of the speech settings, joined
 * @property {string[]} checked the keys of the checked voices (Auto picks them first)
 */

/** Elements read as parts of the text. */
const BLOCKS = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,dt,dd,td,th,figcaption,caption';
/** Blocks read with the paragraphs inside them. */
const MERGING = 'li,dd,blockquote,td,th';
/** Parts of a merging block that are read on their own. */
const SEPARATE = 'ul,ol,dl,table,h1,h2,h3,h4,h5,h6,pre,script,style';

/**
 * @param {number} ms
 * @returns {string} `m:ss` or `h:mm:ss`
 */
function clock(ms) {
    const seconds = Math.floor(ms / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds / 60) % 60;
    const rest = String(seconds % 60).padStart(2, '0');
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

/**
 * @param {string} text
 * @returns {string[]} its phrases (sentences); "v2.1" or "app.js" do not end one
 */
function phrasesOf(text) {
    return text.match(/(?:[^.!?…]|[.!?…](?=[\p{L}\p{N}]))+[.!?…]*/gu)?.map(phrase => phrase.trim()).filter(phrase => /[\p{L}\p{N}]/u.test(phrase)) ?? [];
}

/**
 * The voices of the webview (Web Speech API), when the drivers of the speech settings have none.
 */
class WebSpeech {

    /**
     * @returns {Promise<Voice[]>} the voices, waiting a moment for them to be loaded
     */
    static async voices() {
        if (!('speechSynthesis' in window)) return [];
        let voices = speechSynthesis.getVoices();
        if (!voices.length) {
            await new Promise((resolve) => {
                speechSynthesis.addEventListener('voiceschanged', resolve, { once: true });
                setTimeout(resolve, 1500);
            });
            voices = speechSynthesis.getVoices();
        }
        // As the claude-ai voice: the "Enhanced" / "Premium" system voices first, then local ones
        return voices.map(voice => ({ name: voice.name, lang: voice.lang, score: (/enhanced|premium/i.test(voice.name) ? 2 : 0) + (voice.localService ? 1 : 0) }));
    }

    /**
     * @param {string} text
     * @param {PhraseOptions} options
     * @returns {Promise<boolean>} true when spoken (or it failed), false when stopped
     */
    speak(text, { voice, rate, volume = 100 }) {
        return new Promise((resolve) => {
            const utterance = new SpeechSynthesisUtterance(text);
            const chosen = speechSynthesis.getVoices().find(candidate => candidate.name === voice);
            if (chosen) {
                utterance.voice = chosen;
                utterance.lang = chosen.lang;
            }
            utterance.rate = rate;
            utterance.volume = Math.max(0, Math.min(1, volume / 100));
            utterance.onend = () => resolve(true);
            utterance.onerror = event => resolve(event.error !== 'interrupted' && event.error !== 'canceled');
            speechSynthesis.speak(utterance);
        });
    }

    stop() {
        speechSynthesis.cancel();
    }
}

/**
 * The active drivers of the speech settings, through the host (`TextToSpeech`): its volume, the level
 * meter of the side bar, the phrase to come rendered ahead.
 */
class HostSpeech {

    /**
     * @param {HostRequests} host
     */
    constructor(host) {
        this._host = host;
    }

    /**
     * @returns {Promise<Voice[]>}
     */
    voices() {
        return this._host.request('voices');
    }

    /**
     * @param {string} text
     * @param {PhraseOptions & { next?: PhraseOptions & { text: string } }} options
     * @returns {Promise<boolean>} true when spoken to the end, false when stopped (by the host too:
     *   another speech began, the speech was turned off)
     */
    speak(text, options) {
        return this._host.request('speak', { text, options });
    }

    stop() {
        this._host.send('stopSpeaking');
    }
}

/**
 * Reading the preview aloud as in the claude-ai preview: the text shown (in its translation) phrase
 * by phrase — blocks split into sentences, code blocks skipped —, the block being read highlighted
 * and scrolled to; Pause / resume, a phrase back or on, the time read and, before, an estimate of
 * the time it takes. It speaks with the active drivers of the speech settings through the host
 * (their voices together, the volume and speed; Auto picks the checked voices first, then by
 * quality), with the voices of the webview when the drivers have none; hidden while TTS is off.
 */
export class ReadAloud {

    /**
     * @param {object} options
     * @param {HTMLElement} options.root the rendered document
     * @param {HTMLElement} options.head the header with the controls
     * @param {HostRequests} options.host
     * @param {(settings: { voice: string, rate: number }) => void} options.onSettings the voice or speed was chosen
     */
    constructor({ root, head, host, onSettings }) {
        this._root = root;
        this._host = host;
        this._onSettings = onSettings;
        this._speakButton = head.querySelector('.md-head__speak');
        this._bar = head.querySelector('.md-reading');
        this._prev = head.querySelector('.md-reading__prev');
        this._pause = head.querySelector('.md-reading__pause');
        this._next = head.querySelector('.md-reading__next');
        this._voiceSelect = /** @type {HTMLSelectElement} */ (head.querySelector('.md-head__voice'));
        this._rateSelect = /** @type {HTMLSelectElement} */ (head.querySelector('.md-head__rate'));
        /** @type {WebSpeech | HostSpeech | null} */
        this._engine = null;
        /** @type {Voice[]} */
        this._voices = [];
        /** @type {ReadingSettings} */
        this._settings = { voice: '', rate: 1, enabled: true, volume: 100, drivers: 'system', checked: [] };
        /** the active drivers whose voices are loaded */
        this._drivers = 'system';
        /** the language of the shown text ('' : the document's own) */
        this._lang = '';
        /** @type {{ phrases: { text: string, element: HTMLElement | null }[], index: number, paused: boolean, run: number, lit: HTMLElement | null, spent: number, since: number | null } | null} */
        this._reading = null;
        this._timer = null;
        this._run = 0;
        this._speakButton.addEventListener('click', () => (this._reading ? this.stop() : this._start()));
        this._prev.addEventListener('click', () => this._reading && this._reading.index > 0 && this._play(this._reading.index - 1));
        this._next.addEventListener('click', () => this._reading && this._reading.index < this._reading.phrases.length - 1 && this._play(this._reading.index + 1));
        this._pause.addEventListener('click', () => this._togglePause());
        this._voiceSelect.addEventListener('change', () => this._choose({ voice: this._voiceSelect.value }));
        this._rateSelect.addEventListener('change', () => this._choose({ rate: Number(this._rateSelect.value) || 1 }));
        this._ready = this._loadVoices();
    }

    /**
     * @param {Partial<ReadingSettings>} settings of the host: the voice of the preview, the speech settings
     */
    setSettings(settings) {
        this._settings = {
            voice: settings?.voice ?? '',
            rate: Number(settings?.rate) || 1,
            enabled: settings?.enabled !== false,
            volume: Number.isFinite(Number(settings?.volume)) ? Number(settings.volume) : 100,
            drivers: settings?.drivers ?? 'system',
            checked: Array.isArray(settings?.checked) ? settings.checked : [],
        };
        this._showRate();
        if (!this._settings.enabled) this.stop();
        if (this._settings.drivers !== this._drivers) {
            // Other drivers, other voices
            this.stop();
            this._ready = this._loadVoices();
        }
        this._ready.then(() => {
            this._fillVoices();
            this._sync();
        });
    }

    /**
     * The shown text or its language changed: the estimate and the default voice follow.
     * @param {string} lang the language of a translation ('' for the original)
     */
    refresh(lang) {
        this._lang = lang;
        this._fillVoices();
        this._sync();
    }

    /** Stops reading (the text is replaced, the tab is closed). */
    stop() {
        if (!this._reading) return;
        this._highlight(null);
        this._reading = null;
        this._run++;
        this._engine?.stop();
        this._sync();
    }

    async _loadVoices() {
        this._drivers = this._settings.drivers;
        const hosted = new HostSpeech(this._host);
        const voices = await hosted.voices().catch(() => []);
        if (voices.length) {
            this._engine = hosted;
            this._voices = voices;
        } else {
            const web = await WebSpeech.voices();
            this._engine = web.length ? new WebSpeech() : null;
            this._voices = web.map(voice => ({ ...voice, key: voice.name }));
        }
        this._fillVoices();
        this._sync();
    }

    /** The speed select shows the speed of the settings, one between its steps too. */
    _showRate() {
        const value = String(this._settings.rate);
        this._rateSelect.querySelectorAll('option[data-custom]').forEach(option => option.remove());
        const options = [...this._rateSelect.options];
        if (!options.some(option => option.value === value)) {
            const option = new Option(`${value}×`, value);
            option.dataset.custom = '';
            this._rateSelect.insertBefore(option, options.find(item => Number(item.value) > this._settings.rate) ?? null);
        }
        this._rateSelect.value = value;
    }

    /**
     * @returns {string} the language tag the text is read in: the translation, else Cyrillic or Latin letters
     */
    _textLang() {
        return this._lang || guessLanguage(this._root.textContent);
    }

    /**
     * @param {string} lang
     * @returns {string} the key of the best voice of a language — a checked one first, then by quality —
     *   ('' : none, the driver picks)
     */
    _voiceFor(lang) {
        return pickVoice(this._voices.map(voice => ({ name: voice.key, lang: voice.lang, score: voice.score })), lang, this._settings.checked);
    }

    /**
     * @param {string} text a phrase
     * @returns {PhraseOptions} how it is read: Auto, the voice of its language
     */
    _phraseOptions(text) {
        const lang = this._lang || guessLanguage(text);
        return { voice: this._settings.voice || this._voiceFor(lang), rate: this._settings.rate, lang, volume: this._settings.volume };
    }

    /**
     * The voice select: Auto (each phrase with the best voice of its language, named for the
     * language of the text) or a chosen voice; the voices of that language first, the checked ones
     * among them first.
     */
    _fillVoices() {
        const lang = this._textLang();
        const ofLang = voice => speaksLanguage(voice, lang);
        const checked = new Set(this._settings.checked);
        const sorted = [...this._voices].sort((a, b) => Number(ofLang(b)) - Number(ofLang(a))
            || Number(checked.has(b.key)) - Number(checked.has(a.key)) || a.name.localeCompare(b.name));
        const automatic = this._voices.find(voice => voice.key === this._voiceFor(lang));
        const label = voice => `${voice.name}${voice.lang ? ` (${voice.lang})` : ''}${voice.driverName ? ` · ${voice.driverName}` : ''}`;
        this._voiceSelect.replaceChildren(
            new Option(automatic ? `Auto (${label(automatic)})` : 'Auto', ''),
            ...sorted.map(voice => new Option(label(voice), voice.key)),
        );
        this._voiceSelect.value = this._voices.some(voice => voice.key === this._settings.voice) ? this._settings.voice : '';
        this._voiceSelect.hidden = !this._voices.length || !this._settings.enabled;
    }

    /**
     * @param {{ voice?: string, rate?: number }} change
     */
    _choose(change) {
        this._settings = { ...this._settings, ...change };
        this._onSettings(this._settings);
        this._sync();
        // The next phrase is read with the new voice or speed
        if (this._reading && !this._reading.paused) this._play(this._reading.index);
    }

    /**
     * @returns {{ element: HTMLElement | null, text: string }[]} the readable parts of the preview,
     *   without code blocks: an item, quote or cell with its paragraphs; nested lists, tables and
     *   headings on their own
     */
    _blocks() {
        const textOf = (element) => {
            const copy = /** @type {HTMLElement} */ (element.cloneNode(true));
            copy.querySelectorAll(SEPARATE).forEach(part => part.remove());
            copy.querySelectorAll(`${BLOCKS},div,br`).forEach(part => part.after(' '));
            return copy.textContent.replace(/\s+/g, ' ').trim();
        };
        const merged = element => element.parentElement?.closest(BLOCKS)?.matches(MERGING) && !element.matches(`${MERGING},h1,h2,h3,h4,h5,h6`);
        return [...this._root.querySelectorAll(BLOCKS)]
            .filter(element => !element.closest('pre') && !merged(element) && (element.matches(MERGING) || !element.querySelector(BLOCKS)))
            .map(element => ({ element: /** @type {HTMLElement} */ (element), text: textOf(element) }))
            .filter(block => /[\p{L}\p{N}]/u.test(block.text));
    }

    /**
     * @returns {number} about how long reading takes, in ms (letters and digits a second, a pause per phrase)
     */
    _estimate() {
        const text = this._blocks().map(block => block.text).join(' ');
        const count = pattern => (text.match(pattern) ?? []).length;
        const seconds = count(/[а-яёіїєґ]/gi) / 15 + count(/[a-z]/gi) / 13 + count(/\d/g) * 0.4 + (count(/[.!?…]+(?=\s|$)/g) + 1) * 0.2;
        return (seconds * 1000) / (this._settings.rate || 1);
    }

    _start() {
        if (!this._settings.enabled) return;
        const phrases = this._blocks().flatMap(block => phrasesOf(block.text).map(text => ({ text, element: block.element })));
        if (!phrases.length || !this._engine) return;
        this._reading = { phrases, index: 0, paused: false, run: 0, lit: null, spent: 0, since: Date.now() };
        this._play(0);
    }

    /**
     * Reads from a phrase on (a jump drops the phrase being read).
     * @param {number} from
     */
    async _play(from) {
        const reading = this._reading;
        if (!reading) return;
        const run = ++this._run;
        this._engine.stop();
        reading.paused = false;
        reading.since ??= Date.now();
        for (let index = from; index < reading.phrases.length; index++) {
            reading.index = index;
            this._highlight(reading.phrases[index].element);
            this._sync();
            // Auto: each phrase in the voice of its own language (an English name in a Russian text)
            const text = reading.phrases[index].text;
            const next = reading.phrases[index + 1]?.text;
            const finished = await this._engine.speak(text, { ...this._phraseOptions(text), next: next ? { text: next, ...this._phraseOptions(next) } : undefined })
                .catch(() => false);
            if (run !== this._run) return;
            // Stopped by someone else (another speech began, the speech was turned off)
            if (!finished) break;
        }
        this.stop();
    }

    _togglePause() {
        const reading = this._reading;
        if (!reading) return;
        if (reading.paused) {
            this._play(reading.index);
            return;
        }
        reading.paused = true;
        reading.spent += Date.now() - reading.since;
        reading.since = null;
        this._run++;
        this._engine.stop();
        this._sync();
    }

    /**
     * @param {HTMLElement | null} element
     */
    _highlight(element) {
        const reading = this._reading;
        reading?.lit?.classList.remove('md-reading--lit');
        if (!reading || !element) return;
        element.classList.add('md-reading--lit');
        element.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        reading.lit = element;
    }

    /** The buttons and the clocks as the reading is. */
    _sync() {
        const reading = this._reading;
        clearInterval(this._timer);
        this._bar.hidden = !reading;
        const elapsed = () => (reading ? reading.spent + (reading.since ? Date.now() - reading.since : 0) : 0);
        const showClock = () => { this._pause.querySelector('.md-head__time').textContent = clock(elapsed()); };
        if (reading) {
            this._pause.querySelector('.codicon').className = `codicon codicon-${reading.paused ? 'debug-continue-small' : 'debug-pause'}`;
            this._pause.title = reading.paused ? 'Resume' : 'Pause';
            this._prev.disabled = reading.index <= 0;
            this._next.disabled = reading.index >= reading.phrases.length - 1;
            showClock();
            if (!reading.paused) this._timer = setInterval(showClock, 1000);
        }
        this._speakButton.querySelector('.codicon').className = `codicon codicon-${reading ? 'debug-stop' : 'unmute'}`;
        const estimate = reading || !this._engine ? 0 : this._estimate();
        this._speakButton.querySelector('.md-head__time').textContent = estimate >= 1000 ? `~${clock(estimate)}` : '';
        this._speakButton.title = reading ? 'Stop reading' : this._lang ? 'Read aloud (the translation)' : 'Read aloud';
        this._speakButton.disabled = !this._engine || (!reading && !this._voices.length);
        this._speakButton.hidden = !this._settings.enabled;
        this._rateSelect.hidden = !this._settings.enabled;
    }
}
