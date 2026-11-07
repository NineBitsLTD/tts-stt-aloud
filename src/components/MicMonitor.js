import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { WavAudio } from '../utils/WavAudio';

const SAMPLE_RATE = 16000;
/** Samples of one level: 50 ms */
const WINDOW = SAMPLE_RATE / 20;
/** The raw audio the recorders write: 16 kHz mono 16-bit PCM to stdout (FFmpeg output options). */
const RAW = ['-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-'];

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
 * The level of the default microphone, recorded by a tool of the system (the webviews of VS Code
 * get no microphone): SoX, else FFmpeg (AVFoundation on macOS, DirectShow on Windows, PulseAudio on
 * Linux), else arecord. macOS asks once whether VS Code may use the microphone.
 */
export class MicMonitor {

    constructor() {
        /** @type {import('node:child_process').ChildProcess | null} */
        this._child = null;
        this._run = 0;
        this._active = false;
    }

    /** @returns {boolean} whether it records or is starting to */
    get active() {
        return this._active;
    }

    /**
     * Starts recording (nothing when it records already).
     * @param {object} handlers
     * @param {(level: number) => void} handlers.onLevel the level of the sound from 0 to 1, every 50 ms
     * @param {(message: string) => void} handlers.onError no recorder, or it stopped
     * @param {() => number} handlers.gain the gain of the signal (1: as recorded)
     */
    async start(handlers) {
        if (this._active) return;
        this._active = true;
        const run = ++this._run;
        let failure = '';
        for (const [command, args] of await recorders()) {
            if (run !== this._run) return;
            const result = await this._record(command, args, run, handlers);
            if (result === 'stopped') return;
            if (result !== 'missing') failure = result;
        }
        if (run !== this._run) return;
        this._active = false;
        handlers.onError(failure || 'No recorder for the microphone level: install SoX (sox) or FFmpeg (ffmpeg).');
    }

    /** Stops recording. */
    stop() {
        this._run++;
        this._active = false;
        this._child?.kill();
        this._child = null;
    }

    /**
     * Records until stopped or the recorder ends.
     * @param {string} command
     * @param {string[]} args
     * @param {number} run
     * @param {{ onLevel: (level: number) => void, onError: (message: string) => void, gain: () => number }} handlers
     * @returns {Promise<string>} 'stopped', 'missing' (not installed), or why it failed
     */
    _record(command, args, run, { onLevel, onError, gain }) {
        return new Promise((resolve) => {
            const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
            const name = command.split('/').pop();
            this._child = child;
            let rest = Buffer.alloc(0);
            let heard = false;
            let err = '';
            child.stdout.on('data', (chunk) => {
                heard = true;
                rest = rest.length ? Buffer.concat([rest, chunk]) : chunk;
                const size = WINDOW * 2;
                let offset = 0;
                for (; offset + size <= rest.length; offset += size) {
                    let sum = 0;
                    for (let index = offset; index < offset + size; index += 2) {
                        const sample = rest.readInt16LE(index) / 32768;
                        sum += sample * sample;
                    }
                    if (run === this._run) onLevel(WavAudio.meter(Math.sqrt(sum / WINDOW) * gain()));
                }
                rest = rest.subarray(offset);
            });
            child.stderr.on('data', (chunk) => { err = (err + chunk).slice(-400); });
            child.on('error', (error) => {
                if (this._child === child) this._child = null;
                resolve(run !== this._run ? 'stopped' : error.code === 'ENOENT' ? 'missing' : `${name}: ${error.message}`);
            });
            child.on('close', (code) => {
                if (this._child === child) this._child = null;
                if (run !== this._run) {
                    resolve('stopped');
                } else if (heard) {
                    // It recorded, then stopped (the microphone was unplugged): no other recorder is tried
                    this._active = false;
                    this._run++;
                    onError(`${name} stopped recording${err.trim() ? `: ${err.trim().split('\n').pop()}` : ''}`);
                    resolve('stopped');
                } else {
                    resolve(`${name} could not record the microphone (exit code ${code})${err.trim() ? `: ${err.trim().split('\n').pop()}` : ''}`);
                }
            });
        });
    }
}
