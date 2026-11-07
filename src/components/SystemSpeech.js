import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { temporaryWav } from './AudioPlayer';

/**
 * @typedef {object} SystemVoice
 * @property {string} name
 * @property {string} lang language tag (`ru-RU`, `en_US`, …) as the system names it
 * @property {number} score 2 for the "Enhanced" / "Premium" voices, else 0
 * @property {string} [sample] a phrase the system gives to try the voice (macOS)
 */

/**
 * @param {string} name
 * @returns {number} the score of a voice: the "Enhanced" / "Premium" ones first, as in the webview
 */
function scoreOf(name) {
    return /enhanced|premium/i.test(name) ? 2 : 0;
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<string>} the output of a command
 */
function run(command, args, env = undefined) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { env: env ? { ...process.env, ...env } : process.env });
        let out = '';
        child.stdout.on('data', (chunk) => { out += chunk; });
        child.on('error', reject);
        child.on('close', code => (code === 0 ? resolve(out) : reject(new Error(`${command} exited with ${code}`))));
    });
}

/**
 * The speech of the operating system: macOS `say`, Windows `System.Speech` through PowerShell, Linux
 * `spd-say` (Speech Dispatcher). `render` writes a phrase to WAV audio (macOS, Windows) for
 * `AudioPlayer`; `speak` says it aloud itself (Linux: Speech Dispatcher writes no files), one phrase
 * at a time — a new phrase or `stop` ends the one being spoken.
 */
export class SystemSpeech {

    constructor() {
        /** @type {import('node:child_process').ChildProcess | null} */
        this._child = null;
    }

    /**
     * @returns {Promise<SystemVoice[]>} the installed voices (empty when the system has no speech)
     */
    async voices() {
        try {
            if (process.platform === 'darwin') {
                // "Milena              ru_RU    # Здравствуйте! Меня зовут Милена."; a long name leaves
                // one space before the language: "Milena (Russian (Russia)) ru_RU    # …"; a voice may be listed twice
                const voices = (await run('say', ['-v', '?'])).split('\n').map(line => line.match(/^(.+?)\s+([a-z]{2,3}[_-][A-Za-z0-9]+)\s+#\s*(.*)$/))
                    .filter(Boolean).map(([, name, lang, sample]) => ({ name: name.trim(), lang, score: scoreOf(name), sample: sample.trim() || undefined }));
                return voices.filter((voice, index) => voices.findIndex(other => other.name === voice.name) === index);
            }
            if (process.platform === 'win32') {
                const script = 'Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name + "|" + $_.VoiceInfo.Culture.Name }';
                return (await run('powershell', ['-NoProfile', '-Command', script])).split(/\r?\n/).filter(Boolean)
                    .map((line) => {
                        const [name, lang] = line.split('|');
                        return { name, lang: lang ?? '', score: scoreOf(name) };
                    });
            }
            // spd-say has no voice names worth choosing: the language picks the voice
            await run('spd-say', ['--version']);
            return [{ name: 'default', lang: '', score: 0 }];
        } catch {
            return [];
        }
    }

    /** @returns {boolean} whether `render` can write the speech to audio (macOS, Windows) */
    get canRender() {
        return process.platform === 'darwin' || process.platform === 'win32';
    }

    /**
     * Writes a phrase to WAV audio (16-bit samples); several phrases may be rendered at once.
     * @param {string} text
     * @param {{ voice?: string, rate?: number }} [options] rate: 1 is the normal speed
     * @returns {Promise<Buffer>}
     */
    async render(text, { voice, rate = 1 } = {}) {
        if (!this.canRender) throw new Error('The speech of this system is not written to files');
        const file = temporaryWav();
        try {
            if (process.platform === 'darwin') {
                await run('say', [...(voice ? ['-v', voice] : []), '-r', String(Math.round(175 * rate)), '-o', file, '--data-format=LEI16@22050', '--', text]);
            } else {
                const script = 'Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; '
                    + 'if ($env:SPEECH_VOICE) { $s.SelectVoice($env:SPEECH_VOICE) }; '
                    + `$s.Rate = ${SystemSpeech._windowsRate(rate)}; $s.SetOutputToWaveFile($env:SPEECH_FILE); $s.Speak($env:SPEECH_TEXT); $s.Dispose()`;
                await run('powershell', ['-NoProfile', '-Command', script], { SPEECH_TEXT: text, SPEECH_VOICE: voice ?? '', SPEECH_FILE: file });
            }
            return await readFile(file);
        } finally {
            rm(file, { force: true }).catch(() => {});
        }
    }

    /**
     * Speaks a phrase; resolves when it is spoken or stopped.
     * @param {string} text
     * @param {{ voice?: string, rate?: number, lang?: string, volume?: number }} [options] rate: 1 is
     *   the normal speed; volume: from 0 to 1 of the volume of the computer (not on macOS)
     * @returns {Promise<void>}
     */
    speak(text, { voice, rate = 1, lang, volume = 1 } = {}) {
        this.stop();
        const [command, args, env] = SystemSpeech._command(text, voice, rate, lang, Math.max(0, Math.min(1, volume)));
        return new Promise((resolve) => {
            const child = spawn(command, args, { env: env ? { ...process.env, ...env } : process.env, stdio: 'ignore' });
            this._child = child;
            const done = () => {
                if (this._child === child) this._child = null;
                resolve();
            };
            child.on('error', done);
            child.on('close', done);
        });
    }

    /** Ends the phrase being spoken. */
    stop() {
        this._child?.kill();
        this._child = null;
    }

    /**
     * @param {number} rate 1 is the normal speed
     * @returns {number} the rate of System.Speech, from -10 to 10
     */
    static _windowsRate(rate) {
        return Math.max(-10, Math.min(10, Math.round((rate - 1) * 10)));
    }

    /**
     * @param {string} text
     * @param {string | undefined} voice
     * @param {number} rate
     * @param {string | undefined} lang
     * @param {number} volume from 0 to 1
     * @returns {[string, string[], NodeJS.ProcessEnv?]} the command speaking the text
     */
    static _command(text, voice, rate, lang, volume) {
        if (process.platform === 'darwin') {
            // about 175 words a minute is the normal speed of say; it has no volume (its [[volm]] is
            // ignored by the voices of today), so macOS speaks through render and AudioPlayer
            return ['say', [...(voice ? ['-v', voice] : []), '-r', String(Math.round(175 * rate)), '--', text]];
        }
        if (process.platform === 'win32') {
            // The text and the voice go through the environment: no quoting in the script
            const script = 'Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; '
                + 'if ($env:SPEECH_VOICE) { $s.SelectVoice($env:SPEECH_VOICE) }; '
                + `$s.Rate = ${SystemSpeech._windowsRate(rate)}; $s.Volume = ${Math.round(volume * 100)}; $s.Speak($env:SPEECH_TEXT)`;
            return ['powershell', ['-NoProfile', '-Command', script], { SPEECH_TEXT: text, SPEECH_VOICE: voice ?? '' }];
        }
        return ['spd-say', ['-w', '-r', String(Math.max(-100, Math.min(100, Math.round((rate - 1) * 100)))),
            '-i', String(Math.round(volume * 200 - 100)), ...(lang ? ['-l', lang.slice(0, 2)] : []), '--', text]];
    }
}
