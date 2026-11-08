import { posix } from 'node:path';
import * as vscode from 'vscode';
import { guessLanguage } from '../utils/guessLanguage';
import { localeText, spokenLocale } from '../utils/localeText';
import { clock, estimateReading } from '../utils/phraseSpans';
import { DEVICE_PRIORITY } from './DeviceLock';
import { formatOfLanguage, guessMarkup, readablePhrases } from '../utils/readablePhrases';

/** @typedef {import('./SpeechSettings').SpeechSettings} SpeechSettings */
/** @typedef {import('./TextToSpeech').TextToSpeech} TextToSpeech */
/**
 * @typedef {{ text: string, start: number, end: number, lang?: string }} PlayerPhrase start: -1 for the
 *   announcement, which is no part of the text
 * @typedef {{ kind: 'file' | 'clipboard', name: string, selected: boolean, document: vscode.TextDocument | null, phrases: PlayerPhrase[] }} PlayerTarget
 *   what can be read: phrases begin with the announcement
 * @typedef {object} PlayerReading
 * @property {PlayerTarget} target
 * @property {number[]} durations about how long each phrase takes, in ms
 * @property {number} total about how long all of them take
 * @property {number} index the phrase being read
 * @property {boolean} paused
 * @property {number} since when the phrase began
 * @property {string} language of the whole text: a phrase with little to tell by is in it
 * @typedef {object} PlayerState what the Player section shows
 * @property {'file' | 'clipboard'} source
 * @property {string} fileLabel the text file, with "(selection)" ('' : none)
 * @property {boolean} canPlay
 * @property {string} time about how long the source takes ('' : nothing to read)
 * @property {string} note why it cannot be read, or that it waits for another window
 * @property {boolean} waiting the reading waits for the speech of another window
 * @property {null | { kind: string, name: string, paused: boolean, hasPrevious: boolean, hasNext: boolean, phrase: string, position: string, duration: string }} reading
 */

/** The phrases the language of a text is told by. */
const LANGUAGE_SAMPLE = 100;
/** How long after a change of the selection or the text the time is counted again (ms). */
const REFRESH_DELAY = 150;
/** How often the clipboard is looked at while it is the source and the side bar is open (VS Code does not tell when it changes). */
const CLIPBOARD_INTERVAL = 2000;

/**
 * Reads aloud the text of an editor (its selection, else all of it) or the clipboard, phrase by
 * phrase — Markdown and HTML as plain text (`readablePhrases`) —, announcing first what it reads;
 * the phrase read is highlighted in its editor and scrolled to; pause / resume, a phrase back or on,
 * stop. The buttons are those of the editor title (`when`: the context keys `ttsSttAloud.player*`)
 * and of the Player section of the side bar (`state`, `onDidChange`), which also shows the time. It
 * speaks through `TextToSpeech`, so another speech beginning ends it.
 */
export class TextPlayer {

    /**
     * @param {SpeechSettings} settings
     * @param {TextToSpeech} tts
     */
    constructor(settings, tts) {
        this._settings = settings;
        this._tts = tts;
        /** @type {'file' | 'clipboard'} */
        this.source = 'file';
        /** @type {PlayerReading | null} */
        this._reading = null;
        /** @type {PlayerTarget | null} what the active editor would read */
        this._file = null;
        /** @type {PlayerTarget | null} */
        this._clipboard = null;
        /** @type {vscode.TextEditor | null} the last editor of a real document (the Output panel is an editor too) */
        this._editor = null;
        /** @type {{ key: string, phrases: PlayerPhrase[] } | null} the phrases of the whole document last read */
        this._whole = null;
        /** @type {{ text: string, target: PlayerTarget | null } | null} */
        this._clipboardRead = null;
        this._panelVisible = false;
        /** The speech waits for another window to finish. */
        this._waiting = false;
        this._run = 0;
        this._refreshRun = 0;
        this._refreshTimer = undefined;
        this._clipboardTimer = undefined;
        this._tick = undefined;
        /** @type {Record<string, boolean>} */
        this._contexts = {};
        /** @type {vscode.EventEmitter<void>} */
        this._changed = new vscode.EventEmitter();
        /** What the player shows changed. */
        this.onDidChange = this._changed.event;
        /** @type {vscode.EventEmitter<void>} */
        this._willPlay = new vscode.EventEmitter();
        /** Reading is about to begin. */
        this.onWillPlay = this._willPlay.event;
        this._decoration = vscode.window.createTextEditorDecorationType({
            backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
            overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.findMatchForeground'),
            overviewRulerLane: vscode.OverviewRulerLane.Center,
            borderRadius: '2px',
        });
    }

    /**
     * @returns {vscode.Disposable}
     */
    register() {
        const command = (name, run) => vscode.commands.registerCommand(`tts-stt-aloud.${name}`, run);
        this._rememberEditor(vscode.window.activeTextEditor);
        this._refresh();
        return vscode.Disposable.from(
            command('playerPlay', uri => this.playFile(uri)),
            command('playerPause', () => this.togglePause()),
            command('playerResume', () => this.togglePause()),
            command('playerBack', () => this.back()),
            command('playerForward', () => this.forward()),
            command('playerStop', () => this.stop()),
            vscode.window.onDidChangeActiveTextEditor((editor) => {
                this._rememberEditor(editor);
                this._schedule();
            }),
            vscode.window.onDidChangeTextEditorSelection(() => this._schedule()),
            vscode.window.onDidChangeVisibleTextEditors(() => this._highlight(false)),
            vscode.workspace.onDidChangeTextDocument(event => this._onEdit(event)),
            vscode.workspace.onDidCloseTextDocument((document) => {
                if (this._reading?.target.document === document) this.stop();
            }),
            this._settings.onDidChange(() => this._onSettings()),
            this._tts.onWaiting((waiting) => {
                this._waiting = waiting;
                this._publish();
            }),
            new vscode.Disposable(() => this.dispose()),
        );
    }

    dispose() {
        this.stop();
        clearTimeout(this._refreshTimer);
        clearInterval(this._clipboardTimer);
        this._decoration.dispose();
        this._changed.dispose();
        this._willPlay.dispose();
    }

    /**
     * @param {vscode.Uri} [uri] the document of an editor title
     * @returns {vscode.TextEditor | null} the editor of it, else the active one
     */
    editorFor(uri) {
        if (uri) {
            const shown = vscode.window.visibleTextEditors.find(editor => editor.document.uri.toString() === uri.toString());
            if (shown) return shown;
        }
        const active = vscode.window.activeTextEditor;
        if (!active) return null;
        return active.document.uri.scheme === 'output' ? this._editor : active;
    }

    /**
     * The side bar was shown or hidden: the clipboard is looked at only while it is open.
     * @param {boolean} visible
     */
    setPanelVisible(visible) {
        this._panelVisible = visible;
        this._watchClipboard();
        this._refresh();
    }

    /**
     * @param {'file' | 'clipboard'} source
     */
    setSource(source) {
        if (this._reading || (source !== 'file' && source !== 'clipboard')) return;
        this.source = source;
        this._watchClipboard();
        this._refresh();
    }

    /**
     * Reads the source of the Player section.
     */
    async play() {
        if (this.source === 'clipboard') this._begin(await this._clipboardTarget());
        else this._begin(this._fileTarget(this.editorFor()));
    }

    /**
     * Reads the text of an editor: its selection, else all of it (the source becomes the file).
     * @param {vscode.Uri} [uri]
     */
    playFile(uri) {
        this.source = 'file';
        this._watchClipboard();
        this._begin(this._fileTarget(this.editorFor(uri)));
    }

    togglePause() {
        const reading = this._reading;
        if (!reading) return;
        if (reading.paused) {
            this._speakFrom(reading.index);
            return;
        }
        reading.paused = true;
        this._run++;
        this._tts.stop(this);
        this._publish();
    }

    back() {
        if (this._hasPrevious()) this._speakFrom(this._reading.index - 1);
    }

    forward() {
        if (this._hasNext()) this._speakFrom(this._reading.index + 1);
    }

    /** Ends the reading (the highlight goes). */
    stop() {
        if (!this._reading) return;
        this._clearHighlight();
        this._reading = null;
        this._run++;
        this._tts.stop(this);
        clearInterval(this._tick);
        this._refresh();
    }

    /**
     * @returns {PlayerState}
     */
    state() {
        const reading = this._reading;
        const target = this.source === 'clipboard' ? this._clipboard : this._file;
        const readable = (target?.phrases.length ?? 0) > 1;
        return {
            source: this.source,
            fileLabel: this._file ? TextPlayer._label(this._file) : '',
            canPlay: readable && this._settings.get().tts.enabled,
            time: readable ? `~${clock(this._totalOf(target.phrases))}` : '',
            note: this._waiting && reading ? 'Waiting for the speech in another window…' : this._note(target, readable),
            waiting: this._waiting && !!reading,
            reading: reading && {
                kind: reading.target.kind,
                name: TextPlayer._label(reading.target),
                paused: reading.paused,
                hasPrevious: this._hasPrevious(),
                hasNext: this._hasNext(),
                phrase: reading.target.phrases[reading.index].text,
                position: clock(this._position()),
                duration: `~${clock(reading.total)}`,
            },
        };
    }

    /**
     * @param {PlayerTarget | null} target
     */
    _begin(target) {
        if (!target || target.phrases.length < 2 || !this._settings.get().tts.enabled) return;
        this._willPlay.fire();
        this._clearHighlight();
        const copy = { ...target, phrases: target.phrases.map(phrase => ({ ...phrase })) };
        this._reading = { target: copy, index: 0, paused: false, since: Date.now(), language: TextPlayer._textLanguage(copy.phrases.slice(1)), ...TextPlayer._timing(copy.phrases, this._settings.get().tts.rate) };
        clearInterval(this._tick);
        this._tick = setInterval(() => {
            if (this._reading && !this._reading.paused) this._publish();
        }, 1000);
        this._speakFrom(0);
    }

    /**
     * Reads from a phrase on (a jump drops the phrase being read).
     * @param {number} from
     */
    async _speakFrom(from) {
        const reading = this._reading;
        if (!reading) return;
        const run = ++this._run;
        const { phrases } = reading.target;
        // Reading gives way to any other speech; what it says on going on is in the language of the announcement
        const shared = { priority: DEVICE_PRIORITY.low, resumeText: localeText(phrases[0].lang, `player.resume.${reading.target.kind}`), resumeLang: phrases[0].lang };
        const optionsOf = phrase => ({ ...TextPlayer._options(phrase, reading.language), ...shared });
        reading.paused = false;
        for (let index = from; index < phrases.length; index++) {
            reading.index = index;
            reading.since = Date.now();
            this._highlight(true);
            this._publish();
            const next = phrases[index + 1];
            let finished = false;
            try {
                finished = await this._tts.speak(phrases[index].text, { ...optionsOf(phrases[index]), next: next ? { text: next.text, ...optionsOf(next) } : undefined }, this);
            } catch (error) {
                if (run === this._run) vscode.window.showErrorMessage(`Reading aloud failed: ${error?.message || error}`);
            }
            if (run !== this._run) return;
            // Stopped by someone else (another speech began, the speech was turned off)
            if (!finished) break;
        }
        this.stop();
    }

    _hasPrevious() {
        return !!this._reading && this._reading.index > 1;
    }

    _hasNext() {
        return !!this._reading && this._reading.index < this._reading.target.phrases.length - 1;
    }

    /**
     * @returns {number} how far the reading is, in ms by the estimate (a phrase restarts when resumed)
     */
    _position() {
        const reading = this._reading;
        const before = reading.durations.slice(0, reading.index).reduce((sum, duration) => sum + duration, 0);
        return before + (reading.paused ? 0 : Math.min(reading.durations[reading.index], Date.now() - reading.since));
    }

    /**
     * @param {PlayerPhrase[]} phrases
     * @returns {number} about how long they take, in ms
     */
    _totalOf(phrases) {
        return TextPlayer._timing(phrases, this._settings.get().tts.rate).total;
    }

    /**
     * @param {PlayerPhrase[]} phrases
     * @param {number} rate
     * @returns {{ durations: number[], total: number }} the estimate for all of them,
     *   shared out among the phrases
     */
    static _timing(phrases, rate) {
        const own = phrases.map(phrase => estimateReading(phrase.text, rate));
        const sum = own.reduce((all, duration) => all + duration, 0);
        const total = estimateReading(phrases.map(phrase => phrase.text).join(' '), rate);
        const scale = sum ? total / sum : 0;
        return { durations: own.map(duration => duration * scale), total };
    }

    /**
     * @param {PlayerPhrase} phrase
     * @param {string} language of the whole text
     * @returns {{ lang: string }} Auto: each phrase in the voice of its own language
     */
    static _options(phrase, language) {
        return { lang: phrase.lang ?? guessLanguage(phrase.text, language) };
    }

    /**
     * @param {PlayerPhrase[]} phrases of the text
     * @returns {string} its language ('' : it has no letters)
     */
    static _textLanguage(phrases) {
        return guessLanguage(phrases.slice(0, LANGUAGE_SAMPLE).map(phrase => phrase.text).join(' '), '');
    }

    /**
     * @param {PlayerTarget} target
     * @returns {string}
     */
    static _label(target) {
        return target.selected ? `${target.name} (selection)` : target.name;
    }

    /**
     * @param {PlayerTarget | null} target
     * @param {boolean} readable
     * @returns {string} why the source cannot be read ('' : it can)
     */
    _note(target, readable) {
        if (readable) return '';
        if (this.source === 'clipboard') return target ? 'The clipboard holds nothing to read.' : 'The clipboard is empty.';
        return target ? (target.selected ? 'The selection holds nothing to read.' : 'The file holds nothing to read.') : 'Open a text file to read it.';
    }

    /**
     * @param {vscode.TextEditor | null} editor
     * @returns {PlayerTarget | null} what it would read: its selections, else its text
     */
    _fileTarget(editor) {
        if (!editor) return null;
        const { document } = editor;
        const name = posix.basename(document.uri.path) || document.fileName;
        const format = formatOfLanguage(document.languageId);
        const selections = editor.selections.filter(selection => !selection.isEmpty).sort((a, b) => a.start.compareTo(b.start));
        if (selections.length) {
            const phrases = selections.flatMap(selection => readablePhrases(document.getText(selection), format, document.offsetAt(selection.start)));
            return { kind: 'file', name, selected: true, document, phrases: TextPlayer._announced('fragment', phrases, name, selections[0].start.line + 1) };
        }
        const key = `${document.uri}@${document.version}@${document.languageId}`;
        if (this._whole?.key !== key) this._whole = { key, phrases: readablePhrases(document.getText(), format) };
        return { kind: 'file', name, selected: false, document, phrases: TextPlayer._announced('file', this._whole.phrases, name) };
    }

    /**
     * @returns {Promise<PlayerTarget | null>} what the clipboard would read (null: it is empty)
     */
    async _clipboardTarget() {
        const text = await vscode.env.clipboard.readText();
        if (this._clipboardRead?.text !== text) {
            this._clipboardRead = {
                text,
                target: text.trim() ? { kind: 'clipboard', name: 'Clipboard', selected: false, document: null, phrases: TextPlayer._announced('clipboard', readablePhrases(text, guessMarkup(text)).map(phrase => ({ ...phrase, start: -1, end: -1 }))) } : null,
            };
        }
        return this._clipboardRead.target;
    }

    /**
     * @param {PlayerPhrase[]} phrases of the text
     * @returns {string} the language of the announcement: that of the text, else — the extension has no
     *   translations for it, the text has no letters — that of VS Code, else English
     */
    static _announcementLanguage(phrases) {
        return spokenLocale(TextPlayer._textLanguage(phrases), vscode.env.language);
    }

    /**
     * @param {'file' | 'fragment' | 'clipboard'} kind
     * @param {PlayerPhrase[]} phrases of the text
     * @param {string} [name] of the file
     * @param {number} [line] where the fragment begins
     * @returns {PlayerPhrase[]} the phrases after the one saying what is read (spoken in its own language,
     *   whatever the letters of the name of the file)
     */
    static _announced(kind, phrases, name = '', line = 0) {
        const lang = TextPlayer._announcementLanguage(phrases);
        return [{ text: localeText(lang, `player.announce.${kind}`, { name, line }), start: -1, end: -1, lang }, ...phrases];
    }

    /**
     * @param {vscode.TextEditor | undefined} editor
     */
    _rememberEditor(editor) {
        if (editor && editor.document.uri.scheme !== 'output') this._editor = editor;
    }

    /** The time is counted again a moment after the last change. */
    _schedule() {
        clearTimeout(this._refreshTimer);
        this._refreshTimer = setTimeout(() => this._refresh(), REFRESH_DELAY);
    }

    async _refresh() {
        const run = ++this._refreshRun;
        const file = this._fileTarget(this.editorFor());
        const clipboard = this.source === 'clipboard' ? await this._clipboardTarget().catch(() => null) : null;
        if (run !== this._refreshRun) return;
        this._file = file;
        this._clipboard = clipboard;
        this._publish();
    }

    _watchClipboard() {
        clearInterval(this._clipboardTimer);
        this._clipboardTimer = undefined;
        if (this.source === 'clipboard' && this._panelVisible) this._clipboardTimer = setInterval(() => this._refresh(), CLIPBOARD_INTERVAL);
    }

    _onSettings() {
        const { enabled, rate } = this._settings.get().tts;
        if (!enabled) this.stop();
        if (this._reading) Object.assign(this._reading, TextPlayer._timing(this._reading.target.phrases, rate));
        this._refresh();
    }

    /**
     * The text of the document being read changed: the phrases keep to their places.
     * @param {vscode.TextDocumentChangeEvent} event
     */
    _onEdit(event) {
        if (event.document === this.editorFor()?.document) this._schedule();
        const reading = this._reading;
        if (!reading || reading.target.document !== event.document || !event.contentChanges.length) return;
        for (const change of event.contentChanges) TextPlayer._shift(reading.target.phrases, change);
        this._highlight(false);
    }

    /**
     * @param {PlayerPhrase[]} phrases
     * @param {{ rangeOffset: number, rangeLength: number, text: string }} change
     */
    static _shift(phrases, { rangeOffset, rangeLength, text }) {
        const removedEnd = rangeOffset + rangeLength;
        const moved = offset => (offset <= rangeOffset ? offset : offset >= removedEnd ? offset + text.length - rangeLength : rangeOffset + text.length);
        for (const phrase of phrases) {
            if (phrase.start < 0) continue;
            phrase.start = moved(phrase.start);
            phrase.end = moved(phrase.end);
        }
    }

    /**
     * @returns {vscode.TextEditor[]} the editors showing the document being read
     */
    _readingEditors() {
        const document = this._reading?.target.document;
        return document ? vscode.window.visibleTextEditors.filter(editor => editor.document === document) : [];
    }

    /**
     * @param {boolean} reveal scroll to the phrase
     */
    _highlight(reveal) {
        const reading = this._reading;
        if (!reading?.target.document) return;
        const { start, end } = reading.target.phrases[reading.index];
        const { document } = reading.target;
        const range = start >= 0 ? new vscode.Range(document.positionAt(start), document.positionAt(end)) : null;
        for (const editor of this._readingEditors()) {
            editor.setDecorations(this._decoration, range ? [range] : []);
            if (range && reveal) editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        }
    }

    _clearHighlight() {
        for (const editor of this._readingEditors()) editor.setDecorations(this._decoration, []);
    }

    /** The context keys of the buttons and the side bar follow. */
    _publish() {
        const reading = this._reading;
        this._setContext('ttsSttAloud.playerActive', !!reading);
        this._setContext('ttsSttAloud.playerPaused', !!reading?.paused);
        this._setContext('ttsSttAloud.playerHasPrevious', this._hasPrevious());
        this._setContext('ttsSttAloud.playerHasNext', this._hasNext());
        this._changed.fire();
    }

    /**
     * @param {string} key
     * @param {boolean} value
     */
    _setContext(key, value) {
        if (this._contexts[key] === value) return;
        this._contexts[key] = value;
        vscode.commands.executeCommand('setContext', key, value);
    }
}
