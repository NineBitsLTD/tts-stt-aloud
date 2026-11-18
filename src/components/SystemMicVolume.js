import { execFile } from 'node:child_process';

/** How long a tool of the system may take (ms). */
const TIMEOUT = 5000;

/**
 * @typedef {object} MicVolume the input volume of the default microphone of the system
 * @property {number | null} volume in % (PulseAudio may go above 100); null: it cannot be told
 * @property {string} tool what reads and sets it ('' : nothing)
 * @property {'' | 'unsupported' | 'no-tool' | 'no-volume' | 'failed'} reason why there is no volume: not on
 *   this system, no tool for it, the microphone has none, the tool failed (`error`)
 * @property {string} [error]
 *
 * @typedef {{ tool: string, get: () => Promise<number | null>, set: (volume: number) => Promise<void> }} VolumeTool
 *   get: null when the microphone has no volume; throws when the tool is missing or fails
 */

/**
 * @param {string} command
 * @param {string[]} args
 * @returns {Promise<string>} what it wrote (messages in English: `LC_ALL=C`)
 */
function run(command, args) {
    return new Promise((resolve, reject) => {
        execFile(command, args, { timeout: TIMEOUT, env: { ...process.env, LC_ALL: 'C' } }, (error, stdout, stderr) => {
            if (error) reject(Object.assign(error, { message: String(stderr || error.message).trim() }));
            else resolve(String(stdout));
        });
    });
}

/**
 * @param {string} text
 * @param {RegExp} pattern with the percent in its first group, global
 * @returns {number | null} the mean of the percents found (of the channels)
 */
function meanPercent(text, pattern) {
    const values = [...text.matchAll(pattern)].map(match => Number(match[1]));
    return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
}

/**
 * @param {string} text what `pactl get-source-volume` writes, or the block of a source of `pactl list sources`
 * @returns {number | null} its volume in % (its channels averaged)
 */
export function pactlVolume(text) {
    const line = text.match(/^\s*Volume:(.*)$/m)?.[1] ?? '';
    return meanPercent(line, /(\d+)%/g);
}

/**
 * @param {string} info what `pactl info` writes
 * @param {string} sources what `pactl list sources` writes
 * @returns {number | null} the volume of the default source in % (a PulseAudio older than 15 has no `get-source-volume`)
 */
export function pactlDefaultVolume(info, sources) {
    const name = info.match(/^Default Source:\s*(.+)$/m)?.[1].trim();
    const block = sources.split(/\n(?=Source #)/).find(item => item.match(/^\s*Name:\s*(.+)$/m)?.[1].trim() === name);
    return name && block ? pactlVolume(block) : null;
}

/**
 * @param {string} text what `wpctl get-volume` writes: `Volume: 0.80`, `Volume: 0.80 [MUTED]`
 * @returns {number | null} in %
 */
export function wpctlVolume(text) {
    const value = text.match(/Volume:\s*([\d.]+)/)?.[1];
    return value === undefined ? null : Math.round(Number(value) * 100);
}

/**
 * @param {string} text what `amixer sget Capture` writes: `Front Left: Capture 39 [61%] [12.00dB] [on]`
 * @returns {number | null} in % (its channels averaged)
 */
export function amixerVolume(text) {
    return meanPercent(text, /\[(\d+)%\]/g);
}

/**
 * @param {number | null} volume
 * @returns {number} it, when the output of the tool told it
 * @throws {Error} when it did not: the tool is not what is expected
 */
function told(volume) {
    if (volume === null) throw new Error('the output of the tool tells no volume');
    return volume;
}

/** @type {VolumeTool} macOS: the input volume of the volume settings (`missing value` when the microphone has none). */
const MACOS = {
    tool: 'macOS',
    get: async () => {
        const output = (await run('osascript', ['-e', 'input volume of (get volume settings)'])).trim();
        return /^\d+$/.test(output) ? Number(output) : null;
    },
    set: async (volume) => { await run('osascript', ['-e', `set volume input volume ${volume}`]); },
};

/** @type {VolumeTool} PulseAudio, also PipeWire through pipewire-pulse: the default source. */
const PACTL = {
    tool: 'pactl',
    get: async () => {
        try {
            return told(pactlVolume(await run('pactl', ['get-source-volume', '@DEFAULT_SOURCE@'])));
        } catch (error) {
            if (error.code === 'ENOENT') throw error;
        }
        const [info, sources] = await Promise.all([run('pactl', ['info']), run('pactl', ['list', 'sources'])]);
        return told(pactlDefaultVolume(info, sources));
    },
    set: async (volume) => { await run('pactl', ['set-source-volume', '@DEFAULT_SOURCE@', `${volume}%`]); },
};

/** @type {VolumeTool} PipeWire through WirePlumber: the default source. */
const WPCTL = {
    tool: 'wpctl',
    get: async () => told(wpctlVolume(await run('wpctl', ['get-volume', '@DEFAULT_AUDIO_SOURCE@']))),
    set: async (volume) => { await run('wpctl', ['set-volume', '@DEFAULT_AUDIO_SOURCE@', (volume / 100).toFixed(2)]); },
};

/** @type {VolumeTool} ALSA: the Capture control of the default card, as alsamixer shows it (`-M`). */
const AMIXER = {
    tool: 'amixer',
    get: async () => told(amixerVolume(await run('amixer', ['-M', 'sget', 'Capture']))),
    set: async (volume) => { await run('amixer', ['-q', '-M', 'sset', 'Capture', `${volume}%`]); },
};

/** The tools of each system, in order; Windows has none here. */
const TOOLS = { darwin: [MACOS], linux: [PACTL, WPCTL, AMIXER] };

/**
 * The input volume of the default microphone set in the system — not the gain the extension applies
 * to what it records: macOS (`osascript`), Linux (`pactl` of PulseAudio or PipeWire, else `wpctl` of
 * WirePlumber, else `amixer` of ALSA; the first that answers is kept). Settings made one after another
 * while one is being set are joined: the last one is set.
 */
export class SystemMicVolume {

    /**
     * @param {string} [platform]
     */
    constructor(platform = process.platform) {
        /** @type {VolumeTool[]} */
        this._tools = TOOLS[platform] ?? [];
        /** @type {VolumeTool | null} the tool that answered last */
        this._tool = null;
        /** @type {number | null} the volume to set next */
        this._wanted = null;
        /** @type {Promise<void> | null} */
        this._setting = null;
    }

    /** @returns {boolean} whether this system has tools for it */
    get supported() {
        return this._tools.length > 0;
    }

    /**
     * @returns {Promise<MicVolume>}
     */
    async get() {
        if (!this.supported) return { volume: null, tool: '', reason: 'unsupported' };
        let failure = null;
        for (const tool of this._tool ? [this._tool, ...this._tools.filter(item => item !== this._tool)] : this._tools) {
            try {
                const volume = await tool.get();
                this._tool = tool;
                return { volume, tool: tool.tool, reason: volume === null ? 'no-volume' : '' };
            } catch (error) {
                if (error?.code !== 'ENOENT') failure ??= { tool: tool.tool, error: String(error?.message || error) };
            }
        }
        this._tool = null;
        return failure ? { volume: null, tool: failure.tool, reason: 'failed', error: failure.error } : { volume: null, tool: '', reason: 'no-tool' };
    }

    /**
     * @param {number} volume in % (0–100)
     * @returns {Promise<MicVolume>} the volume afterwards, as the system tells it
     */
    async set(volume) {
        const value = Number(volume);
        if (!this.supported || !Number.isFinite(value)) return this.get();
        this._wanted = Math.round(Math.max(0, Math.min(100, value)));
        this._setting ??= this._apply().finally(() => { this._setting = null; });
        await this._setting;
        return this.get();
    }

    /** Sets the volumes wanted, the last one last. */
    async _apply() {
        while (this._wanted !== null) {
            const value = this._wanted;
            this._wanted = null;
            if (!this._tool) await this.get();
            // A failure shows in the volume read afterwards
            await this._tool?.set(value).catch(() => {});
        }
    }
}
