import { createElement } from './createElement';

/**
 * @typedef {{ name: string, url: string, key: string }} ServerFields
 */

/**
 * The modal dialog adding an external server: its name, address and key; Add or Cancel. The host
 * checks the server (`addServer`) and the dialog shows why it is not added, else closes.
 */
export class ServerDialog {

    constructor() {
        const field = (label, input) => createElement('label', { className: 'speech-dialog__field' }, createElement('span', { className: 'speech-dialog__label', textContent: label }), input);
        this._title = createElement('h2', { className: 'speech-dialog__title' });
        this._name = createElement('input', { className: 'speech-dialog__input', type: 'text', placeholder: 'My server', spellcheck: false, autocomplete: 'off' });
        this._url = createElement('input', { className: 'speech-dialog__input', type: 'text', placeholder: 'https://host:port/path', spellcheck: false, autocomplete: 'off' });
        this._key = createElement('input', { className: 'speech-dialog__input', type: 'password', placeholder: 'Optional', autocomplete: 'new-password' });
        this._error = createElement('p', { className: 'speech-dialog__error', role: 'alert' });
        this._add = createElement('button', { className: 'speech-button speech-button--primary', type: 'submit', textContent: 'Add' });
        const cancel = createElement('button', { className: 'speech-button', type: 'button', textContent: 'Cancel' });
        this._form = createElement('form', { className: 'speech-dialog__form', noValidate: true },
            this._title, field('Name', this._name), field('Address', this._url), field('Key', this._key), this._error,
            createElement('div', { className: 'speech-dialog__buttons' }, cancel, this._add));
        this._dialog = createElement('dialog', { className: 'speech-dialog' }, this._form);
        document.body.append(this._dialog);
        cancel.addEventListener('click', () => this._dialog.close());
        this._form.addEventListener('submit', (event) => {
            event.preventDefault();
            this._submit();
        });
        /** @type {((server: ServerFields) => Promise<string>) | null} */
        this._onAdd = null;
    }

    /**
     * @param {string} title
     * @param {(server: ServerFields) => Promise<string>} onAdd adds the server: why it is not added ('' : added)
     */
    open(title, onAdd) {
        this._title.textContent = title;
        this._onAdd = onAdd;
        this._form.reset();
        this._error.textContent = '';
        this._add.disabled = false;
        this._dialog.showModal();
        this._name.focus();
    }

    async _submit() {
        const server = { name: this._name.value.trim(), url: this._url.value.trim(), key: this._key.value };
        const missing = !server.name ? this._name : !server.url ? this._url : null;
        if (missing) {
            this._error.textContent = missing === this._name ? 'Enter the name of the server.' : 'Enter the address of the server.';
            missing.focus();
            return;
        }
        this._add.disabled = true;
        try {
            const error = await this._onAdd(server);
            if (!error) this._dialog.close();
            this._error.textContent = error;
        } catch (error) {
            this._error.textContent = String(error?.message || error);
        } finally {
            this._add.disabled = false;
        }
    }
}
