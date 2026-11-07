import { createElement, createIcon } from './createElement';

/**
 * @typedef {{ key: string, lang: string, language: string, quality: string, size: number, added: boolean }} CatalogVoice
 * @typedef {{ path: string } | { key: string }} ModelChoice a file on the disk or a voice of the catalog to download
 * @typedef {object} ModelSource what the dialog asks the host for
 * @property {() => Promise<string>} browse the open dialog of VS Code: the file chosen ('' : none)
 * @property {() => Promise<CatalogVoice[]>} catalog the voices that can be downloaded
 * @property {(choice: ModelChoice) => Promise<string>} add why the model is not added ('' : added, or its download began)
 */

/**
 * @param {number} bytes
 * @returns {string} the size in MB ('' : unknown)
 */
export function megabytes(bytes) {
    return bytes ? `${Math.max(1, Math.round(bytes / 2 ** 20))} MB` : '';
}

/**
 * The modal dialog adding a voice model: a file on the disk (Browse… opens the open dialog of VS
 * Code; a note says how it is prepared for sherpa-onnx) or a voice of the catalog to download
 * (a filter by name or language, the voices added already are shown but cannot be chosen); OK or
 * Cancel.
 */
export class ModelDialog {

    constructor() {
        this._title = createElement('h2', { className: 'speech-dialog__title' });
        this._diskMode = createElement('input', { type: 'radio', name: 'model-source', value: 'disk', checked: true });
        this._catalogMode = createElement('input', { type: 'radio', name: 'model-source', value: 'catalog' });
        const mode = (input, label) => createElement('label', { className: 'speech-dialog__mode' }, input, label);
        this._path = createElement('input', { className: 'speech-dialog__input speech-dialog__path', type: 'text', readOnly: true, placeholder: 'No file chosen' });
        const browse = createElement('button', { className: 'speech-button', type: 'button' }, createIcon('folder-opened'), 'Browse…');
        this._disk = createElement('div', { className: 'speech-dialog__disk' }, this._path, browse,
            createElement('p', { className: 'speech-dialog__note speech-dialog__note--wide', textContent: 'A Piper model with its .onnx.json next to it is copied into the storage of the extension and prepared there for sherpa-onnx (the file stays as it is); a model of sherpa-onnx (vits-piper-…, with tokens.txt next to it) is used where it is.' }));
        this._filter = createElement('input', { className: 'speech-dialog__input', type: 'search', placeholder: 'Filter by name or language', spellcheck: false });
        this._list = createElement('ul', { className: 'speech-dialog__catalog-list', role: 'listbox' });
        this._catalogPanel = createElement('div', { className: 'speech-dialog__catalog', hidden: true }, this._filter, this._list,
            createElement('p', { className: 'speech-dialog__note', textContent: 'The voices of Piper (rhasspy/piper-voices) are prepared for sherpa-onnx as they are downloaded.' }));
        this._error = createElement('p', { className: 'speech-dialog__error', role: 'alert' });
        this._ok = createElement('button', { className: 'speech-button speech-button--primary', type: 'submit', textContent: 'OK' });
        const cancel = createElement('button', { className: 'speech-button', type: 'button', textContent: 'Cancel' });
        this._form = createElement('form', { className: 'speech-dialog__form', noValidate: true },
            this._title,
            createElement('div', { className: 'speech-dialog__modes', role: 'radiogroup' }, mode(this._diskMode, 'File on the disk'), mode(this._catalogMode, 'Download')),
            this._disk, this._catalogPanel, this._error,
            createElement('div', { className: 'speech-dialog__buttons' }, cancel, this._ok));
        this._dialog = createElement('dialog', { className: 'speech-dialog speech-dialog--wide' }, this._form);
        document.body.append(this._dialog);

        /** @type {ModelSource | null} */
        this._source = null;
        /** @type {CatalogVoice[] | null} */
        this._voices = null;
        this._chosenKey = '';
        this._diskMode.addEventListener('change', () => this._showMode());
        this._catalogMode.addEventListener('change', () => this._showMode());
        browse.addEventListener('click', () => this._browse());
        this._filter.addEventListener('input', () => this._renderList());
        cancel.addEventListener('click', () => this._dialog.close());
        this._form.addEventListener('submit', (event) => {
            event.preventDefault();
            this._submit();
        });
    }

    /**
     * @param {string} title
     * @param {ModelSource} source
     */
    open(title, source) {
        this._title.textContent = title;
        this._source = source;
        this._voices = null;
        this._chosenKey = '';
        this._path.value = '';
        this._filter.value = '';
        this._diskMode.checked = true;
        this._error.textContent = '';
        this._showMode();
        this._dialog.showModal();
    }

    _showMode() {
        const catalog = this._catalogMode.checked;
        this._disk.hidden = catalog;
        this._catalogPanel.hidden = !catalog;
        this._error.textContent = '';
        if (catalog && !this._voices) this._loadCatalog();
        this._sync();
    }

    async _browse() {
        const path = await this._source.browse();
        if (path) this._path.value = path;
        this._error.textContent = '';
        this._sync();
    }

    async _loadCatalog() {
        this._list.replaceChildren(createElement('li', { className: 'speech-dialog__catalog-empty', textContent: 'Loading the list of voices…' }));
        try {
            this._voices = await this._source.catalog();
            this._renderList();
        } catch (error) {
            this._list.replaceChildren(createElement('li', { className: 'speech-dialog__catalog-empty', textContent: error.message }));
        }
    }

    _renderList() {
        if (!this._voices) return;
        const query = this._filter.value.trim().toLowerCase();
        const shown = this._voices.filter(voice => !query || `${voice.key} ${voice.language} ${voice.lang.replace('_', '-')}`.toLowerCase().includes(query));
        if (!shown.length) {
            this._list.replaceChildren(createElement('li', { className: 'speech-dialog__catalog-empty', textContent: 'No voice matches' }));
            return;
        }
        this._list.replaceChildren(...shown.map((voice) => {
            const chosen = voice.key === this._chosenKey;
            const item = createElement('li', {
                className: `speech-dialog__catalog-item${chosen ? ' speech-dialog__catalog-item--chosen' : ''}${voice.added ? ' speech-dialog__catalog-item--added' : ''}`,
                role: 'option', ariaSelected: String(chosen), ariaDisabled: String(voice.added), tabIndex: voice.added ? -1 : 0,
                title: voice.added ? `${voice.key} is added already` : voice.language,
            },
            createElement('span', { className: 'speech-dialog__catalog-name', textContent: voice.key }),
            createElement('span', { className: 'speech-dialog__catalog-meta', textContent: voice.added ? 'added' : megabytes(voice.size) }));
            if (!voice.added) {
                const choose = () => {
                    this._chosenKey = voice.key;
                    this._error.textContent = '';
                    this._renderList();
                    this._sync();
                };
                item.addEventListener('click', choose);
                item.addEventListener('keydown', (event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        choose();
                    }
                });
            }
            return item;
        }));
    }

    /** OK: when a file or a voice is chosen. */
    _sync() {
        this._ok.disabled = this._catalogMode.checked ? !this._chosenKey : !this._path.value;
    }

    async _submit() {
        const choice = this._catalogMode.checked ? { key: this._chosenKey } : { path: this._path.value };
        if (!('key' in choice ? choice.key : choice.path)) return;
        this._ok.disabled = true;
        try {
            const error = await this._source.add(choice);
            if (!error) this._dialog.close();
            this._error.textContent = error;
        } catch (error) {
            this._error.textContent = String(error?.message || error);
        } finally {
            this._sync();
        }
    }
}
