import { createElement, createIcon } from './createElement';

/** @typedef {{ id: string, name: string }} PickedDriver */

/**
 * A drop-down list of the drivers offered with check boxes: the checked ones work together (TTS:
 * their voices in one list). At least one stays checked — its box cannot be unchecked. A change
 * goes to `onChange` with the ids checked, in the order of the drivers.
 */
export class DriverPicker {

    /**
     * @param {object} options
     * @param {string} options.title of the button
     * @param {(ids: string[]) => void} options.onChange
     */
    constructor({ title, onChange }) {
        this._onChange = onChange;
        this._title = title;
        /** @type {PickedDriver[]} */
        this._drivers = [];
        /** @type {Set<string>} */
        this._active = new Set();
        this._current = createElement('span', { className: 'speech-checklist__current' });
        this._toggle = createElement('button', { className: 'speech-checklist__toggle', type: 'button', title, ariaHasPopup: 'listbox', ariaExpanded: 'false' },
            this._current, createIcon('chevron-down'));
        this._list = createElement('ul', { className: 'speech-checklist__list', role: 'listbox', ariaMultiSelectable: 'true' });
        this._popup = createElement('div', { className: 'speech-checklist__popup', hidden: true }, this._list);
        this.element = createElement('div', { className: 'speech-checklist' }, this._toggle, this._popup);
        this._toggle.addEventListener('click', () => this._show(this._popup.hidden));
        this.element.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && !this._popup.hidden) {
                event.stopPropagation();
                this._show(false);
                this._toggle.focus();
            }
        });
        document.addEventListener('mousedown', (event) => {
            if (!this._popup.hidden && !this.element.contains(/** @type {Node} */ (event.target))) this._show(false);
        });
    }

    /**
     * @param {PickedDriver[]} drivers offered
     * @param {string[]} active the ids checked
     */
    set(drivers, active) {
        this._drivers = drivers;
        this._active = new Set(active.filter(id => drivers.some(driver => driver.id === id)));
        const names = drivers.filter(driver => this._active.has(driver.id)).map(driver => driver.name);
        this._current.textContent = names.join(', ') || 'No driver';
        this._toggle.title = names.length > 1 ? `${names.join(', ')} speak together: their voices are in one list` : this._title;
        this._render();
    }

    /**
     * @param {boolean} open
     */
    _show(open) {
        this._popup.hidden = !open;
        this._toggle.ariaExpanded = String(open);
    }

    _render() {
        const last = this._active.size <= 1;
        this._list.replaceChildren(...this._drivers.map((driver) => {
            const checked = this._active.has(driver.id);
            const box = createElement('input', { type: 'checkbox', checked, disabled: checked && last });
            box.addEventListener('change', () => {
                if (box.checked) this._active.add(driver.id);
                else this._active.delete(driver.id);
                this._onChange(this._drivers.filter(item => this._active.has(item.id)).map(item => item.id));
            });
            return createElement('li', { className: 'speech-checklist__item', role: 'option', ariaSelected: String(checked) },
                createElement('label', { className: 'speech-checklist__label', title: checked && last ? 'At least one driver speaks' : `${driver.name}: its voices in the list` },
                    box, createElement('span', { textContent: driver.name })));
        }));
    }
}
