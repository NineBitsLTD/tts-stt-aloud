import { createElement, createIcon } from './createElement';
import { DriverPicker } from './DriverPicker';
import { megabytes } from './ModelDialog';
import { VoicePicker } from './VoicePicker';

/** @typedef {import('../markdown/HostRequests').HostRequests} HostRequests */
/** @typedef {import('./ServerDialog').ServerDialog} ServerDialog */
/** @typedef {import('./ModelDialog').ModelDialog} ModelDialog */
/** @typedef {{ path: string, name: string, lang: string, downloaded: boolean, exists: boolean, size: number, ready: boolean, languages?: string[], multilingual?: boolean }} VoiceModel ready: the engine can use it; languages: those Whisper recognizes */
/** @typedef {{ models: VoiceModel[], pending: { name: string, action: string }[] }} DriverModels the voice models of a driver, those being installed (downloading, preparing) */
/** @typedef {import('./VoicePicker').PickerVoice} PickerVoice */
/** @typedef {{ id: string, name: string, kind: 'system' | 'preset' | 'external', url?: string, enabled: boolean }} Driver */
/** @typedef {{ enabled: boolean, volume: number, driver: string, active?: string[], rate?: number, voice?: string, voices?: Record<string, string[]>, model?: string, language?: string }} SectionState active: the drivers speaking together (TTS); voice: the key of the voice tested */
/** @typedef {{ heard: boolean, duration: number, ended: string, text: string | null, lang?: string, note?: string }} MicTest the result of the microphone test; text null: not recognized (note: why) */

/** How a recording of the microphone test ended, as the section says it. */
const ENDINGS = { pause: 'after a pause', limit: 'at its longest', stopped: 'stopped' };
/** What the block of the models of a driver and its dialog say. */
const MODEL_TEXTS = {
    piper: {
        title: 'Piper voice models',
        add: 'Add voice model',
        dialog: 'Add Piper Voice Model',
        empty: 'No voice models yet',
        problem: 'not prepared for sherpa-onnx',
        disk: 'A Piper model with its .onnx.json next to it is copied into the storage of the extension and prepared there for sherpa-onnx (the file stays as it is); a model of sherpa-onnx (vits-piper-…, with tokens.txt next to it) is used where it is.',
        catalog: 'The voices of Piper (rhasspy/piper-voices) are prepared for sherpa-onnx as they are downloaded.',
    },
    whisper: {
        title: 'Whisper models',
        add: 'Add model',
        dialog: 'Add Whisper Model',
        empty: 'No models yet',
        problem: 'not a Whisper model of sherpa-onnx, or its decoder or tokens are missing',
        disk: 'Choose the encoder of a Whisper model of sherpa-onnx (<name>-encoder.onnx or <name>-encoder.int8.onnx): its decoder and <name>-tokens.txt must be next to it; it is used where it is.',
        catalog: 'The Whisper models of sherpa-onnx (int8), downloaded into the storage of the extension. All the models without .en are multilingual — 99 languages, Whisper detects the language —, but distil-large-v3, English only like the .en ones. For Russian take small or a larger one: tiny and base are fast but rough.',
    },
};
/** The languages listed first in the language of recognition. */
const FIRST_LANGUAGES = ['ru', 'uk', 'en'];

/**
 * @param {string} code
 * @returns {string} the English name of a language ("Russian"; the code when unknown)
 */
function languageName(code) {
    try {
        return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
    } catch {
        return code;
    }
}

/**
 * @param {number} ms
 * @returns {string} seconds with one decimal
 */
function seconds(ms) {
    return `${(ms / 1000).toFixed(1)} s`;
}

/**
 * A level meter: the bar follows a level at once and falls back slowly; it plays the levels of a
 * sound (given ahead, as the host starts playing it) or shows the levels as they come.
 */
class LevelMeter {

    constructor() {
        this._cover = createElement('div', { className: 'speech-meter__cover' });
        this.element = createElement('div', { className: 'speech-meter', role: 'meter', ariaValueMin: '0', ariaValueMax: '100' }, this._cover);
        this._shown = 0;
        this._level = 0;
        /** @type {{ levels: number[], interval: number, start: number } | null} */
        this._sound = null;
        this._frame = 0;
    }

    /**
     * @param {number} level from 0 to 1, until the next one
     */
    show(level) {
        this._sound = null;
        this._level = Math.max(0, Math.min(1, Number(level) || 0));
        this._schedule();
    }

    /**
     * @param {number[]} levels of a sound starting now, one per interval (empty: silence)
     * @param {number} interval ms
     */
    play(levels, interval) {
        this._sound = levels.length ? { levels, interval, start: performance.now() } : null;
        if (!this._sound) this._level = 0;
        this._schedule();
    }

    _schedule() {
        this._frame ||= requestAnimationFrame(() => this._draw());
    }

    _draw() {
        this._frame = 0;
        if (this._sound) {
            const index = Math.floor((performance.now() - this._sound.start) / this._sound.interval);
            if (index < this._sound.levels.length) {
                this._level = this._sound.levels[index];
            } else {
                this._sound = null;
                this._level = 0;
            }
        }
        this._shown = this._level >= this._shown ? this._level : Math.max(this._level, this._shown - 0.03);
        this._cover.style.transform = `scaleX(${1 - this._shown})`;
        this.element.ariaValueNow = String(Math.round(this._shown * 100));
        if (this._sound || this._shown > this._level || this._shown > 0) this._schedule();
    }
}

/**
 * A section of the speech side bar (TTS or STT): the title with the on / off switch, the volume
 * (TTS: of the speech, a share of the computer's; STT: the gain of the microphone), the speed
 * (TTS), the level meter, the driver (TTS: the drivers speaking together, `DriverPicker`), "Add driver" with the drivers offered (the presets, the
 * external servers added by "Add External", removed by ×; under a driver with models — Piper,
 * Whisper — its models and "Add model"), the voices and their test (TTS), the model and the language
 * Whisper recognizes with and the test of the microphone — recorded, played, the text recognized
 * below (STT). Every change goes to the host, which keeps it
 * in the settings of VS Code and sends the state back.
 */
export class SpeechSection {

    /**
     * @param {object} options
     * @param {'tts' | 'stt'} options.name
     * @param {string} options.title
     * @param {string} options.hint what the section is
     * @param {{ label: string, icon: string, max: number, title: string }} options.volume
     * @param {HostRequests} options.host
     * @param {ServerDialog} options.dialog
     * @param {ModelDialog} options.modelDialog
     */
    constructor({ name, title, hint, volume, host, dialog, modelDialog }) {
        this._name = name;
        this._title = title;
        this._host = host;
        this._dialog = dialog;
        this._modelDialog = modelDialog;
        /** @type {Record<string, DriverModels>} by driver */
        this._models = {};
        /** @type {SectionState | null} */
        this._state = null;
        /** @type {Driver[]} */
        this._drivers = [];
        /** @type {PickerVoice[]} */
        this._voices = [];
        this._voicesOf = '';
        this._testing = false;

        this._switch = createElement('input', { className: 'speech-switch__input', type: 'checkbox', role: 'switch', title: `Turn ${title} on or off` });
        this._switch.addEventListener('change', () => this._update('enabled', this._switch.checked));
        const head = createElement('header', { className: 'speech-section__head' },
            createElement('h2', { className: 'speech-section__title', textContent: title }),
            createElement('span', { className: 'speech-section__hint', textContent: hint }),
            createElement('label', { className: 'speech-switch' }, this._switch, createElement('span', { className: 'speech-switch__track' })));

        this._volume = this._range({ ...volume, min: 0, step: 5, format: value => `${value}%`, key: 'volume' });
        this._meter = new LevelMeter();
        this._driverSelect = createElement('select', { className: 'speech-row__select', title: `Driver of ${title}` });
        this._driverSelect.addEventListener('change', () => this._update('driver', this._driverSelect.value));
        /** @type {DriverPicker | null} the drivers speaking together (TTS) */
        this._driverPicker = name === 'tts' ? new DriverPicker({ title: 'Drivers of TTS: check several to have their voices together', onChange: ids => this._update('active', ids) }) : null;
        this._addToggle = createElement('button', { className: 'speech-button speech-section__add', type: 'button', ariaExpanded: 'false' },
            createIcon('add'), 'Add driver', createIcon('chevron-down'));
        this._driverList = createElement('div', { className: 'speech-drivers__list' });
        const external = createElement('button', { className: 'speech-button speech-drivers__external', type: 'button' }, createIcon('globe'), 'Add External');
        external.addEventListener('click', () => this._dialog.open(`Add External ${title} Server`, server => this._host.request('addServer', { section: this._name, server })));
        this._driversPanel = createElement('div', { className: 'speech-drivers', hidden: true }, this._driverList, external);
        this._addToggle.addEventListener('click', () => {
            this._driversPanel.hidden = !this._driversPanel.hidden;
            this._addToggle.ariaExpanded = String(!this._driversPanel.hidden);
            this._addToggle.classList.toggle('speech-section__add--open', !this._driversPanel.hidden);
        });
        /** @type {{ row: HTMLElement, set: (value: number) => void } | null} the speed slider (TTS) */
        this._speed = null;
        /** @type {VoicePicker | null} (TTS) */
        this._picker = null;
        this._testButton = createElement('button', { className: 'speech-button speech-button--primary speech-section__test', type: 'button' });
        this._testButton.addEventListener('click', () => this._test());
        /** @type {HTMLElement | null} what the microphone does (STT) */
        this._progress = null;
        /** @type {HTMLElement | null} the result of the microphone test (STT): its text and how it was recorded */
        this._result = null;
        this._resultText = null;
        this._resultMeta = null;
        this._progressTimer = 0;
        /** @type {HTMLSelectElement | null} the model recognizing (STT, Whisper) */
        this._modelSelect = null;
        /** @type {HTMLSelectElement | null} the language of recognition (STT, Whisper) */
        this._languageSelect = null;
        /** @type {HTMLElement[]} the rows of the model and the language, shown with Whisper */
        this._recognitionRows = [];
        this._uiLanguage = 'en';
        this._note = createElement('p', { className: 'speech-section__note' });
        this._status = createElement('p', { className: 'speech-section__status', role: 'status' });

        const tts = name === 'tts';
        const rows = [
            this._volume.row,
            ...(tts ? [this._speedRow()] : []),
            SpeechSection._row(createIcon('pulse'), 'Level', this._meter.element),
            SpeechSection._row(createIcon('plug'), tts ? 'Drivers' : 'Driver', this._driverPicker?.element ?? this._driverSelect),
            createElement('div', { className: 'speech-section__drivers' }, this._addToggle, this._driversPanel),
            ...(tts ? [] : this._recognitionRowsOf()),
            this._note,
            ...(tts ? this._voiceRows() : [this._microphoneTest()]),
            this._status,
        ];
        this.element = createElement('section', { className: `speech-section speech-section--${name}` }, head, createElement('div', { className: 'speech-section__body' }, ...rows));
    }

    /**
     * @param {SectionState} state the settings of the section
     * @param {Driver[]} drivers
     * @param {string} note what the driver in use cannot do ('' : nothing)
     * @param {Record<string, DriverModels>} [models] the models of the drivers that have them
     * @param {string} [uiLanguage] the language of VS Code (`en`, `ru`, `zh-cn`)
     */
    setState(state, drivers, note, models = {}, uiLanguage = 'en') {
        this._state = state;
        this._drivers = drivers;
        this._models = models;
        this._uiLanguage = uiLanguage.split('-')[0].toLowerCase();
        this._switch.checked = state.enabled;
        this.element.classList.toggle('speech-section--off', !state.enabled);
        this._volume.set(state.volume);
        this._speed?.set(state.rate);
        const offered = drivers.filter(driver => driver.enabled);
        this._driverSelect.replaceChildren(...(offered.length ? offered.map(driver => new Option(driver.name, driver.id)) : [new Option('None: check one under Add driver', '')]));
        this._driverSelect.disabled = !offered.length;
        this._driverSelect.value = state.driver;
        this._driverPicker?.set(drivers.filter(driver => driver.enabled), state.active ?? [state.driver]);
        this._renderDrivers();
        this._showRecognition();
        this._note.textContent = note;
        this._showVoices();
        this._syncTest();
    }

    /**
     * @param {{ drivers: string, voices: PickerVoice[] }} message the voices of the active drivers (joined)
     */
    setVoices({ drivers, voices }) {
        this._voicesOf = drivers;
        this._voices = voices;
        this._showVoices();
        this._syncTest();
    }

    /**
     * @param {{ levels?: number[], interval?: number, level?: number }} message levels of a sound
     *   (TTS) or the level now (STT)
     */
    showLevel({ levels, interval, level }) {
        if (Array.isArray(levels)) this._meter.play(levels, interval ?? 50);
        else this._meter.show(level ?? 0);
    }

    /**
     * @param {string} message ('' : none)
     */
    setStatus(message) {
        this._status.textContent = message;
    }

    /**
     * What the microphone does (STT), for the test or another extension.
     * @param {{ state: 'waiting' | 'recording' | 'playing' | 'recognizing' | 'idle', test: boolean, limits?: { waitMs: number, maxMs: number, silenceMs: number } }} message
     */
    setMicState({ state, test, limits }) {
        if (!this._progress) return;
        clearInterval(this._progressTimer);
        const since = performance.now();
        const show = () => {
            const elapsed = performance.now() - since;
            const left = Math.max(0, Math.ceil(((limits?.waitMs ?? 5000) - elapsed) / 1000));
            if (state === 'waiting') {
                this._progress.textContent = test ? `Speak now — waiting for speech ${left} s` : `An extension waits for speech: ${left} s`;
            } else if (state === 'recording') {
                this._progress.textContent = test
                    ? `Recording ${seconds(elapsed)} — ends after ${seconds(limits?.silenceMs ?? 1000)} of silence, at ${seconds(limits?.maxMs ?? 10000)} at most`
                    : `An extension records: ${seconds(elapsed)}`;
            }
        };
        if (state === 'waiting' || state === 'recording') {
            show();
            this._progressTimer = setInterval(show, 100);
        } else {
            this._progress.textContent = state === 'playing' ? 'Playing the recording' : state === 'recognizing' ? 'Recognizing the speech…' : '';
        }
        this._progress.classList.toggle('speech-section__progress--live', state !== 'idle');
    }

    /**
     * @param {string} key
     * @param {unknown} value
     */
    _update(key, value) {
        this._host.send('update', { section: this._name, key, value });
    }

    /**
     * A slider with its value; the value goes to the host as the slider is let go.
     * @param {{ label: string, icon: string, title: string, min: number, max: number, step: number, format: (value: number) => string, key: string }} options
     * @returns {{ row: HTMLElement, set: (value: number) => void }}
     */
    _range({ label, icon, title, min, max, step, format, key }) {
        const input = createElement('input', { className: 'speech-row__range', type: 'range', min: String(min), max: String(max), step: String(step), title });
        const output = createElement('output', { className: 'speech-row__value' });
        input.addEventListener('input', () => { output.textContent = format(Number(input.value)); });
        input.addEventListener('change', () => this._update(key, Number(input.value)));
        return {
            row: SpeechSection._row(createIcon(icon), label, input, output),
            set: (value) => {
                input.value = String(value);
                output.textContent = format(Number(value));
            },
        };
    }

    /**
     * @returns {HTMLElement} the speed slider (TTS)
     */
    _speedRow() {
        this._speed = this._range({ label: 'Speed', icon: 'dashboard', title: 'Speed of the speech (also the speed of reading the Markdown preview)', min: 0.5, max: 2, step: 0.05, format: value => `${value.toFixed(2)}×`, key: 'rate' });
        return this._speed.row;
    }

    /**
     * @returns {HTMLElement[]} the voice list and the test button (TTS)
     */
    _voiceRows() {
        this._picker = new VoicePicker({
            onSelect: key => this._update('voice', key),
            onCheck: (key, checked) => this._host.send('voiceChecked', { key, checked }),
        });
        return [
            SpeechSection._row(createIcon('record-keys'), 'Voice', this._picker.element),
            createElement('div', { className: 'speech-section__actions' }, this._testButton),
        ];
    }

    /**
     * @returns {HTMLElement} the test of the microphone (STT): the button, what the microphone does,
     *   the result — it works while STT is off too (the switch is for other extensions)
     */
    _microphoneTest() {
        this._progress = createElement('p', { className: 'speech-section__progress', role: 'status' });
        this._resultText = createElement('p', { className: 'speech-section__result-text' });
        this._resultMeta = createElement('p', { className: 'speech-section__result-meta' });
        this._result = createElement('div', { className: 'speech-section__result', hidden: true },
            createElement('span', { className: 'speech-section__result-label', textContent: 'Recognized text' }), this._resultText, this._resultMeta);
        return createElement('div', { className: 'speech-section__microphone' },
            createElement('div', { className: 'speech-section__actions' }, this._testButton), this._progress, this._result);
    }

    /**
     * @returns {HTMLElement[]} the rows of the model and the language of recognition (STT), shown with Whisper
     */
    _recognitionRowsOf() {
        this._modelSelect = createElement('select', { className: 'speech-row__select', title: 'The Whisper model that recognizes speech' });
        this._modelSelect.addEventListener('change', () => this._update('model', this._modelSelect.value));
        this._languageSelect = createElement('select', { className: 'speech-row__select', title: 'The language of the speech recognized' });
        this._languageSelect.addEventListener('change', () => this._update('language', this._languageSelect.value));
        this._recognitionRows = [
            SpeechSection._row(createIcon('file-binary'), 'Model', this._modelSelect),
            SpeechSection._row(createIcon('globe'), 'Language', this._languageSelect),
        ];
        return this._recognitionRows;
    }

    /** The model and the language of recognition: the ready Whisper models, the languages of the one chosen. */
    _showRecognition() {
        if (!this._modelSelect || !this._state) return;
        const whisper = this._state.driver === 'whisper';
        this._recognitionRows.forEach((row) => { row.hidden = !whisper; });
        if (!whisper) return;
        const ready = (this._models.whisper?.models ?? []).filter(model => model.exists && model.ready);
        const chosen = ready.find(model => model.path === this._state.model) ?? ready[0];
        this._modelSelect.replaceChildren(...(ready.length
            ? ready.map(model => new Option(model.lang === 'en' ? `${model.name} (English only)` : model.name, model.path))
            : [new Option('No model ready', '')]));
        this._modelSelect.value = chosen?.path ?? '';
        this._modelSelect.disabled = !ready.length;
        const languages = chosen?.languages ?? [];
        const order = code => (FIRST_LANGUAGES.includes(code) ? FIRST_LANGUAGES.indexOf(code) : FIRST_LANGUAGES.length);
        const sorted = [...languages].sort((a, b) => order(a) - order(b) || languageName(a).localeCompare(languageName(b)));
        const options = chosen && !chosen.multilingual ? [new Option('English (the model knows English only)', '')] : [
            new Option('Auto: Whisper detects the language', ''),
            new Option(`As VS Code: ${languageName(this._uiLanguage)}`, 'ui'),
            ...sorted.map(code => new Option(languageName(code), code)),
        ];
        this._languageSelect.replaceChildren(...options);
        this._languageSelect.value = [...this._languageSelect.options].some(option => option.value === this._state.language) ? this._state.language : '';
        this._languageSelect.disabled = !chosen || !chosen.multilingual;
    }

    /**
     * @param {MicTest | null} result of the microphone test (null: a test begins)
     */
    _showResult(result) {
        if (!this._result) return;
        this._result.hidden = !result?.heard;
        if (!result) return;
        if (!result.heard) {
            this._progress.textContent = result.ended === 'no-speech' ? 'No speech was heard: speak right after pressing Test.' : 'The test was stopped.';
            return;
        }
        this._resultText.textContent = result.text || (result.text === '' ? 'Nothing was recognized.' : `Not recognized: ${result.note || 'no recognizer'}`);
        this._resultText.classList.toggle('speech-section__result-text--none', !result.text);
        const language = result.text && result.lang ? `, ${languageName(result.lang)}` : '';
        this._resultMeta.textContent = `Recorded ${result.duration.toFixed(1)} s, ended ${ENDINGS[result.ended] ?? result.ended}${language}`;
    }

    /** The drivers that can be offered (TTS: besides System): check boxes; the external servers with × to remove them. */
    _renderDrivers() {
        const extra = this._drivers.filter(driver => driver.kind !== 'system');
        this._driverList.replaceChildren(...extra.map((driver) => {
            const box = createElement('input', { type: 'checkbox', checked: driver.enabled });
            box.addEventListener('change', () => this._host.send('driverEnabled', { section: this._name, id: driver.id, enabled: box.checked }));
            const item = createElement('div', { className: `speech-drivers__item speech-drivers__item--${driver.kind}` },
                createElement('label', { className: 'speech-drivers__label', title: driver.url ?? `Offer ${driver.name} as a driver` }, box,
                    createElement('span', { className: 'speech-drivers__name', textContent: driver.name }),
                    ...(driver.url ? [createElement('span', { className: 'speech-drivers__url', textContent: driver.url })] : [])));
            if (driver.kind === 'external') {
                const remove = createElement('button', { className: 'speech-drivers__remove', type: 'button', title: `Remove ${driver.name}` }, createIcon('close'));
                remove.addEventListener('click', () => this._host.send('removeServer', { section: this._name, id: driver.id }));
                item.append(remove);
            }
            const models = this._models[driver.id];
            return driver.enabled && models ? [item, this._modelsBlock(driver, models)] : [item];
        }).flat());
    }

    /**
     * @param {Driver} driver offered, with models (Piper, Whisper)
     * @param {DriverModels} models
     * @returns {HTMLElement} its models (× removes one) and "Add model"
     */
    _modelsBlock(driver, { models, pending: installing }) {
        const texts = MODEL_TEXTS[driver.id] ?? MODEL_TEXTS.whisper;
        const items = models.map((model) => {
            const problem = !model.exists ? 'the file is missing' : !model.ready ? texts.problem : '';
            const meta = [model.lang, model.downloaded ? megabytes(model.size) : 'from the disk'].filter(Boolean).join(' · ');
            const remove = createElement('button', { className: 'speech-drivers__remove', type: 'button', title: `Remove ${model.name}` }, createIcon('close'));
            remove.addEventListener('click', () => this._host.send('removeModel', { driver: driver.id, path: model.path }));
            return createElement('li', { className: `speech-models__item${model.exists ? '' : ' speech-models__item--missing'}`, title: model.path },
                createElement('span', { className: 'speech-models__name', textContent: model.name }),
                createElement('span', { className: `speech-models__meta${problem ? ' speech-models__meta--problem' : ''}` },
                    ...(problem ? [createIcon('warning'), problem] : [meta])),
                remove);
        });
        const pending = installing.map(({ name, action }) => createElement('li', { className: 'speech-models__item speech-models__item--pending' },
            createElement('span', { className: 'speech-models__name', textContent: name }),
            createElement('span', { className: 'speech-models__meta' }, createIcon('loading codicon-modifier-spin'), `${action}…`)));
        const add = createElement('button', { className: 'speech-button speech-models__add', type: 'button' }, createIcon('add'), texts.add);
        add.addEventListener('click', () => this._modelDialog.open(texts.dialog, {
            browse: () => this._host.request('browseModel', { driver: driver.id }),
            catalog: () => this._host.request('modelCatalog', { driver: driver.id }),
            add: choice => this._host.request('addModel', { driver: driver.id, ...choice }),
        }, { disk: texts.disk, catalog: texts.catalog }));
        return createElement('div', { className: 'speech-models' },
            createElement('span', { className: 'speech-models__title', textContent: texts.title }),
            createElement('ul', { className: 'speech-models__list' }, ...items, ...pending,
                ...(items.length || pending.length ? [] : [createElement('li', { className: 'speech-models__empty', textContent: texts.empty })])),
            add);
    }

    /** The voices of the active drivers, checked as in the settings (TTS). */
    _showVoices() {
        if (!this._picker || !this._state) return;
        const active = this._state.active ?? [this._state.driver];
        const current = this._voicesOf === active.join(',') ? this._voices : [];
        const checked = Object.entries(this._state.voices ?? {}).filter(([driver]) => active.includes(driver)).flatMap(([driver, names]) => names.map(name => `${driver}:${name}`));
        this._picker.set(current, checked, this._state.voice ?? '');
    }

    /**
     * The test: TTS speaks a phrase with the voice chosen; STT records speech, plays it and shows the
     * text recognized (the old recording is removed). Pressed again, it stops (STT: the speech
     * recorded so far is kept and played).
     */
    async _test() {
        if (this._testing) {
            this._host.send('stopTest', { section: this._name });
            return;
        }
        this._testing = true;
        this._syncTest();
        this.setStatus('');
        this._showResult(null);
        try {
            const result = await this._host.request('test', { section: this._name, voice: this._picker?.selected });
            this._showResult(result);
        } catch (error) {
            this.setStatus(error.message);
        } finally {
            this._testing = false;
            this._syncTest();
        }
    }

    _syncTest() {
        const voice = this._picker?.selected ?? '';
        const idle = this._picker ? 'Test voice' : 'Test microphone';
        this._testButton.replaceChildren(createIcon(this._testing ? 'debug-stop' : this._picker ? 'play' : 'record'), this._testing ? 'Stop' : idle);
        this._testButton.title = this._testing ? 'Stop the test'
            : this._picker ? `Speak a phrase with ${voice || 'the voice chosen'}`
                : 'Record speech (it waits 5 s for it, records up to 10 s, until 1 s of silence) and play it back';
        this._testButton.disabled = !this._testing && !!this._picker && (!this._state?.enabled || !voice);
    }

    /**
     * @param {HTMLElement} icon
     * @param {string} label
     * @param {...HTMLElement} controls
     * @returns {HTMLElement}
     */
    static _row(icon, label, ...controls) {
        return createElement('div', { className: 'speech-row' }, createElement('span', { className: 'speech-row__label' }, icon, label), ...controls);
    }
}
