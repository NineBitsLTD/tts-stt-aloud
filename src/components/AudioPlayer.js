import { spawn } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WavAudio } from '../utils/WavAudio';

/** ms of audio a level of the meter stands for */
export const LEVEL_INTERVAL = 50;

let fileCount = 0;

/**
 * @returns {string} a new path for a temporary sound file
 */
export function temporaryWav() {
    return join(tmpdir(), `tts-stt-md-aloud-${process.pid}-${++fileCount}.wav`);
}

/**
 * @param {string} file
 * @returns {[string, string[], NodeJS.ProcessEnv?][]} the commands playing a file, in order of preference
 */
function players(file) {
    if (process.platform === 'darwin') return [['afplay', [file]]];
    if (process.platform === 'win32') {
        return [['powershell', ['-NoProfile', '-Command', '(New-Object System.Media.SoundPlayer $env:SOUND_FILE).PlaySync()'], { SOUND_FILE: file }]];
    }
    // PulseAudio / PipeWire, else ALSA
    return [['paplay', [file]], ['aplay', ['-q', file]]];
}

/**
 * Plays WAV audio with the player of the operating system: macOS `afplay`, Windows
 * `System.Media.SoundPlayer` through PowerShell, Linux `paplay`, else `aplay`. The volume scales the
 * samples, so it is a share of the volume set on the computer; the levels of the sound are given
 * as it starts playing. One sound at a time: a new one or `stop` ends the one playing.
 */
export class AudioPlayer {

    constructor() {
        /** @type {import('node:child_process').ChildProcess | null} */
        this._child = null;
        this._run = 0;
    }

    /**
     * @param {Buffer} wav
     * @param {{ volume?: number, onLevels?: (levels: number[], interval: number) => void }} [options]
     *   volume: from 0 to 1 of the volume of the computer; onLevels: as playing starts (empty for
     *   audio it cannot read)
     * @returns {Promise<boolean>} true when played to the end, false when stopped
     */
    async play(wav, { volume = 1, onLevels } = {}) {
        this.stop();
        const run = this._run;
        const audio = WavAudio.parse(wav);
        const file = temporaryWav();
        await writeFile(file, audio ? audio.withVolume(volume) : wav);
        try {
            if (run !== this._run) return false;
            return await this._spawn(players(file), run, () => onLevels?.(audio ? audio.levels(LEVEL_INTERVAL, Math.min(1, volume)) : [], LEVEL_INTERVAL));
        } finally {
            rm(file, { force: true }).catch(() => {});
        }
    }

    /** Ends the sound playing. */
    stop() {
        this._run++;
        this._child?.kill();
        this._child = null;
    }

    /**
     * Plays with the first player found.
     * @param {[string, string[], NodeJS.ProcessEnv?][]} commands
     * @param {number} run
     * @param {() => void} onStart
     * @returns {Promise<boolean>}
     */
    _spawn(commands, run, onStart) {
        const [[command, args, env], ...rest] = commands;
        return new Promise((resolve, reject) => {
            const child = spawn(command, args, { env: env ? { ...process.env, ...env } : process.env, stdio: 'ignore' });
            this._child = child;
            child.on('spawn', onStart);
            child.on('error', (error) => {
                if (this._child === child) this._child = null;
                if (error.code === 'ENOENT' && rest.length && run === this._run) resolve(this._spawn(rest, run, onStart));
                else if (error.code === 'ENOENT') reject(new Error(`No audio player found (${players('').map(([name]) => name).join(', ')})`));
                else resolve(run === this._run);
            });
            child.on('close', () => {
                if (this._child === child) this._child = null;
                resolve(run === this._run);
            });
        });
    }
}
