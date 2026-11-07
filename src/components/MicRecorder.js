import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { WavAudio } from '../utils/WavAudio';

export const SAMPLE_RATE = 16000;
/** ms of audio in a window: the level, the speech or silence are judged per window */
const WINDOW_MS = 50;
const WINDOW = (SAMPLE_RATE * WINDOW_MS) / 1000;
/** The raw audio the recorders write: 16 kHz mono 16-bit PCM to stdout (FFmpeg output options). */
const RAW = ['-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-'];
/** Windows kept before the speech (300 ms) and after it. */
const PRE_ROLL = 6;
const TAIL = 6;
/** -45 dBFS: the lowest threshold; -40 dBFS: the loudest noise floor; +12 dB above it is loud */
const MIN_THRESHOLD = 10 ** (-45 / 20);
const MAX_NOISE = 10 ** (-40 / 20);
const NOISE_MARGIN = 10 ** (12 / 20);

/**
 * @typedef {object} RecordOptions
 * @property {number} [waitMs] how long to wait for the speech to begin (5 s)
 * @property {number} [maxMs] the longest speech recorded (10 s)
 * @property {number} [silenceMs] the silence that ends the speech (1 s)
 * @property {number} [gain] of the signal (1: as recorded)
 * @property {(level: number) => void} [onLevel] the level of the sound from 0 to 1, every 50 ms
 * @property {(state: 'waiting' | 'recording') => void} [onState] waiting for the speech, recording it
 *
 * @typedef {'pause' | 'limit' | 'stopped' | 'no-speech' | 'cancelled'} RecordingEnd pause: the
 *   speech was followed by silence; limit: the longest speech; stopped: by `finish` or the
 *   recorder; no-speech: none began in time; cancelled: stopped before the speech began
 *
 * @typedef {object} Recording
 * @property {Buffer | null} wav the speech as a WAV file (16 kHz mono 16-bit; null: no speech)
 * @property {number} duration seconds
 * @property {RecordingEnd} ended
 */

/**
 * @param {string} name
 * @returns {string} the tool, from Homebrew when VS Code was started without its PATH (macOS)
 */
function tool(name) {
    if (process.platform !== 'darwin') return name;
    return ['/opt/homebrew/bin', '/usr/local/bin'].map(folder => `${folder}/${name}`).find(path => existsSync(path)) ?? name;
}

/**
 * @param {string} command
 * @param {string[]} args
 * @returns {Promise<string>} what a command wrote to stderr ('' when it is not installed)
 */
function stderrOf(command, args) {
    return new Promise((resolve) => {
        const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let err = '';
        child.stderr.on('data', (chunk) => { err += chunk; });
        child.on('error', () => resolve(''));
        child.on('close', () => resolve(err));
    });
}

/**
 * @param {string} ffmpeg
 * @returns {Promise<string>} the first DirectShow microphone FFmpeg lists ('' : none) — Windows has
 *   no default device name for FFmpeg
 */
async function windowsMicrophone(ffmpeg) {
    const listing = await stderrOf(ffmpeg, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']);
    return listing.match(/"([^"]+)"\s*\(audio\)/)?.[1] ?? '';
}

/**
 * @returns {Promise<[string, string[]][]>} the commands recording the default microphone, in order of
 *   preference: SoX, FFmpeg, ALSA's arecord (Linux)
 */
async function recorders() {
    const ffmpeg = tool('ffmpeg');
    const ffmpegArgs = input => ['-hide_banner', '-loglevel', 'error', ...input, ...RAW];
    /** @type {[string, string[]][]} */
    const commands = [[tool('sox'), ['-q', '-d', '-t', 'raw', '-r', String(SAMPLE_RATE), '-e', 'signed-integer', '-b', '16', '-c', '1', '-']]];
    if (process.platform === 'darwin') {
        commands.push([ffmpeg, ffmpegArgs(['-f', 'avfoundation', '-i', ':default'])]);
    } else if (process.platform === 'win32') {
        const device = await windowsMicrophone(ffmpeg);
        if (device) commands.push([ffmpeg, ffmpegArgs(['-f', 'dshow', '-i', `audio=${device}`])]);
    } else {
        commands.push([ffmpeg, ffmpegArgs(['-f', 'pulse', '-i', 'default'])], ['arecord', ['-q', '-f', 'S16_LE', '-r', String(SAMPLE_RATE), '-c', '1', '-t', 'raw']]);
    }
    return commands;
}

/**
 * @param {Int16Array} window
 * @returns {number} its root mean square, from 0 to 1
 */
function rmsOf(window) {
    let sum = 0;
    for (const sample of window) sum += (sample / 32768) ** 2;
    return Math.sqrt(sum / window.length);
}

/**
 * Finds the speech in the audio of a microphone, window by window: the noise floor is the quietest
 * window heard while waiting, no louder than -40 dBFS (a voice heard from the start is not taken
 * for noise); a window is loud 12 dB above it, -45 dBFS at least; the speech begins with 3 loud
 * windows of 4 (300 ms before them are kept, not to cut its first sound) and ends with silence
 * (3 dB under the threshold) or at its longest; 300 ms of the silence after it are kept.
 */
export class SpeechDetector {

    /**
     * @param {{ waitMs: number, maxMs: number, silenceMs: number }} limits
     */
    constructor({ waitMs, maxMs, silenceMs }) {
        this._waitWindows = Math.ceil(waitMs / WINDOW_MS);
        this._maxWindows = Math.ceil(maxMs / WINDOW_MS);
        this._silenceWindows = Math.ceil(silenceMs / WINDOW_MS);
        /** @type {'waiting' | 'recording' | RecordingEnd} */
        this.state = 'waiting';
        this._heard = 0;
        this._noise = Infinity;
        /** @type {boolean[]} the last windows heard while waiting: loud or not */
        this._recent = [];
        /** @type {Int16Array[]} the windows before the speech, then the speech */
        this._windows = [];
        this._speechStart = 0;
        this._lastLoud = 0;
        this._silent = 0;
    }

    /**
     * @param {Int16Array} window of 50 ms
     * @returns {'waiting' | 'recording' | RecordingEnd} the state after it
     */
    push(window) {
        const rms = rmsOf(window);
        this._heard++;
        if (this.state === 'waiting') {
            this._noise = Math.min(this._noise, rms);
            this._recent = [...this._recent.slice(-3), rms > this._threshold()];
            this._windows = [...this._windows.slice(-(PRE_ROLL + 3)), window];
            if (this._recent.filter(Boolean).length >= 3) {
                this.state = 'recording';
                this._speechStart = Math.max(0, this._windows.length - 4);
                this._lastLoud = this._windows.length;
            } else if (this._heard >= this._waitWindows) {
                this.state = 'no-speech';
            }
        } else if (this.state === 'recording') {
            this._windows.push(window);
            if (rms > this._threshold() / Math.SQRT2) {
                this._lastLoud = this._windows.length;
                this._silent = 0;
            } else {
                this._silent++;
            }
            if (this._silent >= this._silenceWindows) this.state = 'pause';
            else if (this._windows.length - this._speechStart >= this._maxWindows) this.state = 'limit';
        }
        return this.state;
    }

    /**
     * Ends the recording now (`finish`, the recorder stopped).
     */
    stop() {
        if (this.state === 'recording') this.state = 'stopped';
        else if (this.state === 'waiting') this.state = 'cancelled';
    }

    /**
     * @returns {Int16Array | null} the speech with what is kept before and after it (null: none began)
     */
    speech() {
        if (this.state === 'waiting' || this.state === 'no-speech' || this.state === 'cancelled') return null;
        const kept = this._windows.slice(0, Math.min(this._windows.length, this._lastLoud + TAIL));
        const out = new Int16Array(kept.reduce((sum, window) => sum + window.length, 0));
        let offset = 0;
        for (const window of kept) {
            out.set(window, offset);
            offset += window.length;
        }
        return out;
    }

    /** @returns {number} the level above which a window is loud */
    _threshold() {
        return Math.max(MIN_THRESHOLD, Math.min(this._noise, MAX_NOISE) * NOISE_MARGIN);
    }
}


/**
 * Records speech from the default microphone with a tool of the system (the webviews of VS Code get
 * no microphone): SoX, else FFmpeg (AVFoundation on macOS, DirectShow on Windows, PulseAudio on
 * Linux), else arecord. It waits for the speech to begin, records it until it pauses or at its
 * longest (`SpeechDetector`) and gives it as a WAV file. One recording at a time. macOS asks once
 * whether VS Code may use the microphone.
 */
export class MicRecorder {

    constructor() {
        /** @type {{ detector: SpeechDetector, child: import('node:child_process').ChildProcess | null, stop: boolean } | null} */
        this._session = null;
    }

    /** @returns {boolean} whether it records (or waits for the speech) */
    get busy() {
        return !!this._session;
    }

    /**
     * @param {RecordOptions} [options]
     * @returns {Promise<Recording>}
     */
    async record({ waitMs = 5000, maxMs = 10000, silenceMs = 1000, gain = 1, onLevel, onState } = {}) {
        if (this._session) throw new Error('The microphone is busy: another recording is going on.');
        const session = { detector: new SpeechDetector({ waitMs, maxMs, silenceMs }), child: null, stop: false };
        this._session = session;
        try {
            let failure = '';
            for (const [command, args] of await recorders()) {
                if (session.stop) break;
                const result = await this._run(command, args, session, { gain, onLevel, onState });
                if (result === 'missing') continue;
                if (result === 'done') break;
                failure = result.message;
                // It recorded, then stopped (the microphone was unplugged): no other tool is tried
                if (result.heard) break;
            }
            if (!session.stop && session.detector.state === 'waiting') {
                throw new Error(failure || 'No recorder for the microphone: install SoX (sox) or FFmpeg (ffmpeg).');
            }
            session.detector.stop();
            const speech = session.detector.speech();
            return {
                wav: speech ? WavAudio.fromPcm16(speech, SAMPLE_RATE) : null,
                duration: speech ? speech.length / SAMPLE_RATE : 0,
                ended: /** @type {RecordingEnd} */ (session.detector.state),
            };
        } finally {
            this._session = null;
        }
    }

    /**
     * Ends the recording: the speech recorded so far is kept (none: cancelled).
     */
    finish() {
        if (!this._session) return;
        this._session.stop = true;
        this._session.detector.stop();
        this._session.child?.kill();
    }

    /**
     * Records with one tool until the speech is over, it is stopped or the tool ends.
     * @param {string} command
     * @param {string[]} args
     * @param {{ detector: SpeechDetector, child: any, stop: boolean }} session
     * @param {{ gain: number, onLevel?: (level: number) => void, onState?: (state: 'waiting' | 'recording') => void }} handlers
     * @returns {Promise<'done' | 'missing' | { message: string, heard: boolean }>} done: the speech is
     *   over or it was stopped; missing: not installed; else why it stopped (heard: after recording)
     */
    _run(command, args, session, { gain, onLevel, onState }) {
        return new Promise((resolve) => {
            const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
            const name = command.split('/').pop();
            const { detector } = session;
            session.child = child;
            let rest = Buffer.alloc(0);
            let heard = false;
            let err = '';
            child.stdout.on('data', (chunk) => {
                if (!heard) onState?.('waiting');
                heard = true;
                rest = rest.length ? Buffer.concat([rest, chunk]) : chunk;
                let offset = 0;
                for (; offset + WINDOW * 2 <= rest.length && !session.stop; offset += WINDOW * 2) {
                    const window = new Int16Array(WINDOW);
                    for (let index = 0; index < WINDOW; index++) {
                        window[index] = Math.max(-32768, Math.min(32767, Math.round(rest.readInt16LE(offset + index * 2) * gain)));
                    }
                    onLevel?.(WavAudio.meter(rmsOf(window)));
                    const before = detector.state;
                    const state = detector.push(window);
                    if (state === 'recording' && before === 'waiting') onState?.('recording');
                    if (state !== 'waiting' && state !== 'recording') {
                        session.stop = true;
                        child.kill();
                    }
                }
                rest = rest.subarray(offset);
            });
            child.stderr.on('data', (chunk) => { err = (err + chunk).slice(-400); });
            child.on('error', (error) => {
                if (session.child === child) session.child = null;
                resolve(error.code === 'ENOENT' ? 'missing' : { message: `${name}: ${error.message}`, heard });
            });
            child.on('close', (code) => {
                if (session.child === child) session.child = null;
                onLevel?.(0);
                const why = err.trim() ? `: ${err.trim().split('\n').pop()}` : '';
                if (session.stop) resolve('done');
                else if (heard) resolve({ message: `${name} stopped recording${why}`, heard });
                else resolve({ message: `${name} could not record the microphone (exit code ${code})${why}`, heard });
            });
        });
    }
}
