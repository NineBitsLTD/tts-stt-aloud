import { createElement, createIcon } from './createElement';

/** @typedef {import('../utils/pickVoice').Voice & { checked?: boolean }} PickerVoice */

/**
 * A drop-down list of voices with check boxes: the checked voices are picked automatically for
 * reading aloud and offered to other extensions; the voice chosen (a click on its name) is the one
 * the test speaks with. A filter by name or language; the checked voices are listed first.
 */
export class VoicePicker {

    /**
     * @param {object} handlers
     * @param {(name: string) => void} handlers.onSelect a voice was chosen
     * @param {(name: string, checked: boolean) => void} handlers.onCheck a voice was checked or unchecked
     */
    constructor({ onSelect, onCheck }) {
        this._onSelect = onSelect;
        this._onCheck = onCheck;
        /** @type {PickerVoice[]} */
        this._voices = [];
        /** @type {Set<string>} */
        this._checked = new Set();
        this._chosen = '';
        /** @type {string[]} the order of the list while it is open */
        this._order = [];
        this._current =createElement('span', { className: 'speech-voices__current' });
        this._count = createElement('span', { className: 'speech-voices__count' });
        this._toggle = createElement('button', { className: 'speech-voices__toggle', type: 'button', ariaHasPopup: 'listbox', ariaExpanded: 'false' },
            this._current, this._count, createIcon('chevron-down'));
        this._filter = createElement('input', { className: 'speech-voices__filter', type: 'search', placeholder: 'Filter by name or language', spellcheck: false });
        this._list = createElement('ul', { className: 'speech-voices__list', role: 'listbox' });
        this._popup = createElement('div', { className: 'speech-voices__popup', hidden: true }, this._filter, this._list);
        this.element = createElement('div', { className: 'speech-voices' }, this._toggle, this._popup);
        this._toggle.addEventListener('click', () => (this._popup.hidden ? this._open() : this._close()));
        this._filter.addEventListener('input', () => this._renderList());
        this.element.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && !this._popup.hidden) {
                event.stopPropagation();
                this._close();
                this._toggle.focus();
            }
        });
        document.addEventListener('mousedown', (event) => {
            if (!this._popup.hidden && !this.element.contains(/** @type {Node} */ (event.target))) this._close();
        });
    }

    /** @returns {string} the voice the test speaks with ('' : there is none) */
    get selected() {
        return this._chosen;
    }

    /**
     * @param {PickerVoice[]} voices
     * @param {string[]} checked names of the checked voices
     * @param {string} chosen the voice chosen in the settings (else the first checked, else the first)
     */
    set(voices, checked, chosen) {
        this._voices = voices;
        this._checked = new Set(checked);
        const names = new Set(voices.map(voice => voice.name));
        this._chosen = names.has(chosen) ? chosen : checked.find(name => names.has(name)) ?? voices[0]?.name ?? '';
        const voice = voices.find(item => item.name === this._chosen);
        this._current.textContent = voice ? VoicePicker._label(voice) : 'No voices';
        this._toggle.title = voice ? `The voice tested: ${VoicePicker._label(voice)}` : 'This driver has no voices';
        this._toggle.disabled = !voices.length;
        const count = voices.filter(item => this._checked.has(item.name)).length;
        this._count.replaceChildren(...(count ? [createIcon('check'), String(count)] : []));
        this._count.title = count ? `${count} checked: picked automatically and offered to other extensions` : '';
        if (!voices.length) this._close();
        if (!this._popup.hidden) this._renderList();
    }

    _open() {
        this._popup.hidden = false;
        this._toggle.ariaExpanded = 'true';
        this._order = this._sorted();
        this._renderList();
        this._filter.focus();
    }

    _close() {
        this._popup.hidden = true;
        this._toggle.ariaExpanded = 'false';
        this._filter.value = '';
    }

    /**
     * @returns {string[]} the names in the order of the list, fixed while it is open (a check does not
     *   move a voice): the checked first, then by language and name
     */
    _sorted() {
        return [...this._voices].sort((a, b) => Number(this._checked.has(b.name)) - Number(this._checked.has(a.name))
            || a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name)).map(voice => voice.name);
    }

    _renderList() {
        const query = this._filter.value.trim().toLowerCase();
        const byName = new Map(this._voices.map(voice => [voice.name, voice]));
        const order = this._order.filter(name => byName.has(name));
        const shown = [...order, ...this._sorted().filter(name => !order.includes(name))].map(name => byName.get(name))
            .filter(voice => !query || voice.name.toLowerCase().includes(query) || voice.lang.toLowerCase().replace('_', '-').includes(query));
        if (!shown.length) {
            this._list.replaceChildren(createElement('li', { className: 'speech-voices__empty', textContent: 'No voice matches' }));
            return;
        }
        this._list.replaceChildren(...shown.map((voice) => {
            const box = createElement('input', { type: 'checkbox', checked: this._checked.has(voice.name), title: 'Pick this voice automatically and offer it to other extensions' });
            box.addEventListener('change', () => {
                if (box.checked) this._checked.add(voice.name);
                else this._checked.delete(voice.name);
                this._onCheck(voice.name, box.checked);
            });
            const name = createElement('button', { className: 'speech-voices__name', type: 'button', textContent: voice.name, title: `Test with ${voice.name}` });
            name.addEventListener('click', () => {
                this._onSelect(voice.name);
                this._close();
                this._toggle.focus();
            });
            const selected = voice.name === this._chosen;
            return createElement('li', { className: `speech-voices__item${selected ? ' speech-voices__item--selected' : ''}`, role: 'option', ariaSelected: String(selected) },
                box, name, createElement('span', { className: 'speech-voices__lang', textContent: voice.lang }));
        }));
    }

    /**
     * @param {PickerVoice} voice
     * @returns {string}
     */
    static _label(voice) {
        return voice.lang ? `${voice.name} (${voice.lang})` : voice.name;
    }
}
