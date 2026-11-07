import { createElement, createIcon } from './createElement';
import { VoicePicker } from './VoicePicker';

/** @typedef {import('../markdown/HostRequests').HostRequests} HostRequests */
/** @typedef {import('./ServerDialog').ServerDialog} ServerDialog */
/** @typedef {import('./VoicePicker').PickerVoice} PickerVoice */
/** @typedef {{ id: string, name: string, kind: 'system' | 'preset' | 'external', url?: string, enabled: boolean }} Driver */
/** @typedef {{ enabled: boolean, volume: number, driver: string, rate?: number, voice?: string, voices?: Record<string, string[]> }} SectionState */

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
 * (TTS), the level meter, the driver, "Add driver" with the drivers offered (the presets, the
 * external servers added by "Add External", removed by ×), the voices and their test (TTS). Every
 * change goes to the host, which keeps it in the settings of VS Code and sends the state back.
 */
export class SpeechSection {

    /**
     * @param {object} options
     * @param {'tts' | 'stt'} options.name
     * @param {string} options.title
     * @param {string} options.hint what the section is
     * @param {{ label: string, icon: string, max: number, title: string }} options.volume
     * @param {boolean} [options.speech] the speed, the voices and the test (TTS)
     * @param {HostRequests} options.host
     * @param {ServerDialog} options.dialog
     */
    constructor({ name, title, hint, volume, speech = false, host, dialog }) {
        this._name = name;
        this._title = title;
        this._host = host;
        this._dialog = dialog;
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
        /** @type {HTMLButtonElement | null} (TTS) */
        this._testButton = null;
        this._note = createElement('p', { className: 'speech-section__note' });
        this._status = createElement('p', { className: 'speech-section__status', role: 'status' });

        const rows = [
            this._volume.row,
            ...(speech ? [this._speedRow()] : []),
            SpeechSection._row(createIcon('pulse'), 'Level', this._meter.element),
            SpeechSection._row(createIcon('plug'), 'Driver', this._driverSelect),
            createElement('div', { className: 'speech-section__drivers' }, this._addToggle, this._driversPanel),
            this._note,
        ];
        if (speech) rows.push(...this._voiceRows());
        rows.push(this._status);
        this.element = createElement('section', { className: `speech-section speech-section--${name}` }, head, createElement('div', { className: 'speech-section__body' }, ...rows));
    }

    /**
     * @param {SectionState} state the settings of the section
     * @param {Driver[]} drivers
     * @param {string} note what the driver in use cannot do ('' : nothing)
     */
    setState(state, drivers, note) {
        this._state = state;
        this._drivers = drivers;
        this._switch.checked = state.enabled;
        this.element.classList.toggle('speech-section--off', !state.enabled);
        this._volume.set(state.volume);
        this._speed?.set(state.rate);
        this._driverSelect.replaceChildren(...drivers.filter(driver => driver.enabled).map(driver => new Option(driver.name, driver.id)));
        this._driverSelect.value = state.driver;
        this._renderDrivers();
        this._note.textContent = note;
        this._showVoices();
        this._syncTest();
    }

    /**
     * @param {{ driver: string, voices: PickerVoice[] }} message the voices of a driver
     */
    setVoices({ driver, voices }) {
        this._voicesOf = driver;
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
            onSelect: name => this._update('voice', name),
            onCheck: (name, checked) => this._host.send('voiceChecked', { name, checked }),
        });
        this._testButton = createElement('button', { className: 'speech-button speech-button--primary speech-section__test', type: 'button' });
        this._testButton.addEventListener('click', () => this._test());
        return [
            SpeechSection._row(createIcon('record-keys'), 'Voice', this._picker.element),
            createElement('div', { className: 'speech-section__actions' }, this._testButton),
        ];
    }

    /** Offered drivers besides System: check boxes; the external servers with × to remove them. */
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
            return item;
        }));
    }

    /** The voices of the driver in use, checked as in the settings (TTS). */
    _showVoices() {
        if (!this._picker || !this._state) return;
        const current = this._voicesOf === this._state.driver ? this._voices : [];
        this._picker.set(current, this._state.voices?.[this._state.driver] ?? [], this._state.voice ?? '');
    }

    /** Speaks the phrase of the voice chosen, or stops it. */
    async _test() {
        if (this._testing) {
            this._host.send('stopTest');
            return;
        }
        this._testing = true;
        this._syncTest();
        this.setStatus('');
        try {
            await this._host.request('test', { voice: this._picker.selected });
        } catch (error) {
            this.setStatus(error.message);
        } finally {
            this._testing = false;
            this._syncTest();
        }
    }

    _syncTest() {
        if (!this._testButton) return;
        this._testButton.replaceChildren(createIcon(this._testing ? 'debug-stop' : 'play'), this._testing ? 'Stop' : 'Test voice');
        this._testButton.title = this._testing ? 'Stop the test' : `Speak a phrase with ${this._picker.selected || 'the voice chosen'}`;
        this._testButton.disabled = !this._testing && (!this._state?.enabled || !this._picker.selected);
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
