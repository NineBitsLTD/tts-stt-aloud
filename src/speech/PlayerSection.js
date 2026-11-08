import { createElement, createIcon } from './createElement';

/** @typedef {import('../markdown/HostRequests').HostRequests} HostRequests */
/** @typedef {import('../components/TextPlayer').PlayerState & { speech: boolean, microphone: boolean, dictating: boolean }} PlayerSectionState */

/**
 * The Player section of the speech side bar: the source (the text file, its selection, or the
 * clipboard), dictation and reading aloud — Play with the time it takes next to it; while reading a
 * phrase back, pause, a phrase on, stop and how far it is; the phrase read when it is the clipboard,
 * which no editor shows. The buttons of reading go with TTS, the one of dictation with STT, the
 * section with both. All of it is `TextPlayer` and `Dictation` on the host.
 */
export class PlayerSection {

    /**
     * @param {HostRequests} host
     */
    constructor(host) {
        this._host = host;
        this._fileOption = new Option('No text file', 'file');
        this._source = createElement('select', { className: 'speech-row__select', title: 'What is read aloud' }, this._fileOption, new Option('Clipboard', 'clipboard'));
        this._source.addEventListener('change', () => this._send('source', this._source.value));
        this._record = this._button('record', 'record');
        this._play = this._button('play', 'play', 'Read aloud');
        this._play.classList.add('speech-button--primary');
        this._back = this._button('debug-reverse-continue', 'back', 'Previous phrase');
        this._pause = this._button('debug-pause', 'pause', 'Pause');
        this._forward = this._button('debug-continue', 'forward', 'Next phrase');
        this._stop = this._button('debug-stop', 'stop', 'Stop reading');
        this._time = createElement('span', { className: 'speech-player__time' });
        this._phrase = createElement('p', { className: 'speech-player__phrase', hidden: true });
        this._note = createElement('p', { className: 'speech-section__note' });
        this.element = createElement('section', { className: 'speech-section speech-section--player', hidden: true },
            createElement('header', { className: 'speech-section__head' },
                createElement('h2', { className: 'speech-section__title', textContent: 'Player' }),
                createElement('span', { className: 'speech-section__hint', textContent: 'Read aloud and dictate' })),
            createElement('div', { className: 'speech-section__body' },
                createElement('div', { className: 'speech-row' }, createElement('span', { className: 'speech-row__label' }, createIcon('file-text'), 'Source'), this._source),
                createElement('div', { className: 'speech-player__controls' }, this._record, this._play, this._back, this._pause, this._forward, this._stop, this._time),
                this._phrase,
                this._note));
    }

    /**
     * @param {PlayerSectionState} state
     */
    setState(state) {
        const { reading, speech, microphone, dictating } = state;
        this.element.hidden = !speech && !microphone;
        this._fileOption.text = (reading?.kind === 'file' ? reading.name : state.fileLabel) || 'No text file';
        this._source.value = reading ? reading.kind : state.source;
        this._source.disabled = !!reading;
        this._showRecord(state);
        this._play.hidden = !speech || !!reading;
        this._play.disabled = !state.canPlay;
        for (const button of [this._back, this._pause, this._forward, this._stop]) button.hidden = !speech || !reading;
        this._back.disabled = !reading?.hasPrevious;
        this._forward.disabled = !reading?.hasNext;
        this._pause.replaceChildren(createIcon(reading?.paused ? 'play' : 'debug-pause'));
        this._pause.title = reading?.paused ? 'Resume' : 'Pause';
        this._time.textContent = !speech ? '' : reading ? `${reading.position} / ${reading.duration}` : state.time;
        this._phrase.hidden = reading?.kind !== 'clipboard';
        this._phrase.textContent = reading?.kind === 'clipboard' ? reading.phrase : '';
        this._note.textContent = speech && !reading && !dictating ? state.note : '';
    }

    /**
     * @param {PlayerSectionState} state
     */
    _showRecord({ microphone, dictating, source, fileLabel }) {
        this._record.hidden = !microphone;
        this._record.disabled = !dictating && source === 'file' && !fileLabel;
        this._record.replaceChildren(createIcon(dictating ? 'stop-circle' : 'record'));
        this._record.classList.toggle('speech-player__record--on', dictating);
        this._record.title = dictating ? 'Stop dictation' : source === 'clipboard' ? 'Dictate into the clipboard' : 'Dictate at the cursor of the file';
    }

    /**
     * @param {string} icon
     * @param {string} action
     * @param {string} [title]
     * @returns {HTMLButtonElement}
     */
    _button(icon, action, title = '') {
        const button = createElement('button', { className: 'speech-button speech-player__icon', type: 'button', title, hidden: true }, createIcon(icon));
        button.addEventListener('click', () => this._send(action));
        return button;
    }

    /**
     * @param {string} action
     * @param {unknown} [value]
     */
    _send(action, value) {
        this._host.send('player', { action, value });
    }
}
