import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

/**
 * @typedef {object} DeviceRecord who has the device
 * @property {string} owner
 * @property {number} pid of its extension host: a record of a dead process is no record
 * @property {number} priority
 * @property {number} expires a record no longer written to ends then
 * @property {{ owner: string, pid: number, until: number } | null} playing who uses the device right now
 *   and till when at most: one whose record was overwritten by a higher priority goes on to its end
 * @typedef {{ signal?: AbortSignal, onWait?: (waiting: boolean) => void, force?: boolean }} HoldOptions onWait: another
 *   window has the device, it is waited for (and when that is over); force: the first mark overwrites
 *   whatever is there (a person asked for the device)
 */

/** Read the mark again no sooner than this after writing it: another window may have written over it meanwhile. */
const SETTLE_MS = 100;
/** How often the record is read while waiting for the device. */
const POLL_MS = 100;
/** A record not written to for this long is abandoned, whatever its process does. */
const RECORD_TTL = 5 * 60 * 1000;
/** A speech that said it would go on (a next phrase) keeps the device this long at most. */
const KEEP_MS = 5000;
/** Added to the time a sound is expected to take. */
const PLAYING_MARGIN = 1000;

/** The levels of `priority`: a higher one takes the device over. Reading a file or the clipboard is the lowest. */
export const DEVICE_PRIORITY = { low: 0, normal: 1, high: 2 };

/**
 * @param {unknown} owner who asks: `test` (the button of the side bar) high, anyone else normal
 * @param {unknown} [priority] given by the one who asks (0–2): the readings of a text give the lowest
 * @returns {number}
 */
export function priorityOf(owner, priority) {
    const given = Number(priority);
    if (priority !== undefined && priority !== null && Number.isFinite(given)) return Math.max(DEVICE_PRIORITY.low, Math.min(DEVICE_PRIORITY.high, Math.round(given)));
    return owner === 'test' ? DEVICE_PRIORITY.high : DEVICE_PRIORITY.normal;
}

/**
 * @returns {string} the folder of the records: the temporary folder of the system, one for all the
 *   windows and profiles of VS Code of this user
 */
function defaultFolder() {
    let user = process.env.USER ?? 'user';
    try {
        user = String(userInfo().uid);
    } catch {
        // No such user in the system: its name in the environment
    }
    return join(tmpdir(), `tts-stt-aloud-${user}`);
}

/**
 * @param {number} pid
 * @returns {boolean} whether the process is there
 */
function alive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error?.code === 'EPERM';
    }
}

/**
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>} after ms, sooner when aborted
 */
function pause(ms, signal) {
    return new Promise((resolve) => {
        if (signal?.aborted || ms <= 0) {
            resolve();
            return;
        }
        const done = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', done);
            resolve();
        };
        const timer = setTimeout(done, ms);
        signal?.addEventListener('abort', done, { once: true });
    });
}

/**
 * A device (the speaker, the microphone) shared by the windows of VS Code — each has its own
 * extension host — through a record in a file:
 * a free device, or one held at a lower priority, is marked as this window's while the sound is
 * made; after that (and at least 100 ms after the mark) the record is read again: when it is still
 * this window's the device is used, else its turn is waited for. Who overwrites a lower priority
 * waits for the sound being played to stop: who uses the device watches the record meanwhile (`watch`)
 * and stops when it is written over (a speech goes on later, a recording ends). After a sound the
 * record is removed when it is still this window's, or kept for the next phrase; one written over
 * stays. A record of a dead process counts for nothing. When the file cannot be written, the device
 * is simply used.
 */
export class DeviceLock {

    /**
     * @param {string} device the name of the file
     * @param {{ folder?: string, owner?: string, pid?: number }} [options]
     */
    constructor(device, { folder = defaultFolder(), owner = String(process.pid), pid = process.pid } = {}) {
        this._folder = folder;
        this._file = join(folder, `${device}.json`);
        this._owner = owner;
        this._pid = pid;
        /** Changes of the record of this window, one after the other. */
        this._queue = Promise.resolve();
        this._broken = false;
        this._keepTimer = undefined;
        this._writes = 0;
    }

    /**
     * Gets the device: returns when it can be used.
     * @param {number} priority
     * @param {Promise<unknown>} ready the sound being made (the record is read again after it)
     * @param {HoldOptions} [options]
     * @returns {Promise<boolean>} false: aborted (a mark may be left: `release`)
     */
    async hold(priority, ready, { signal, onWait, force = false } = {}) {
        clearTimeout(this._keepTimer);
        let marked = await this._mark(priority, force);
        await ready;
        let waiting = false;
        const wait = (value) => {
            if (waiting !== value) onWait?.(value);
            waiting = value;
        };
        try {
            while (!signal?.aborted) {
                if (this._broken) return true;
                if (marked) await pause(marked + SETTLE_MS - Date.now(), signal);
                marked = 0;
                const record = await this._read();
                if (record?.owner === this._owner) {
                    if (!this._playingElsewhere(record)) return !signal?.aborted;
                    wait(true);
                    await this._until(current => !current || current.owner !== this._owner || !this._playingElsewhere(current), signal);
                    continue;
                }
                wait(true);
                await this._until(current => !current || current.owner === this._owner || current.priority < priority, signal);
                if (!signal?.aborted) marked = await this._mark(priority);
            }
            return false;
        } finally {
            wait(false);
        }
    }

    /** @returns {Promise<boolean>} whether the record is still this window's */
    async holds() {
        return this._broken || (await this._read())?.owner === this._owner;
    }

    /**
     * Watches the record while the device is being used.
     * @param {() => void} onLost another window has written over it (once)
     * @returns {{ stop: () => void }}
     */
    watch(onLost) {
        let watching = true;
        const look = async () => {
            while (watching) {
                await pause(POLL_MS);
                const record = watching ? await this._read() : null;
                if (watching && record && record.owner !== this._owner) {
                    watching = false;
                    onLost();
                }
            }
        };
        look();
        return { stop: () => { watching = false; } };
    }

    /**
     * The device is being used now.
     * @param {number} ms how long at most
     */
    startPlaying(ms) {
        return this._change(async () => {
            const now = Date.now();
            const record = await this._read() ?? this._record(DEVICE_PRIORITY.low);
            await this._write({ ...record, expires: now + Math.max(RECORD_TTL, ms), playing: { owner: this._owner, pid: this._pid, until: now + ms + PLAYING_MARGIN } });
        });
    }

    /**
     * The device is no longer being used: the record is removed when it is this window's, unless
     * more is coming; one that was written over is left, saying the sound is over.
     * @param {boolean} keep a next phrase is coming
     */
    finishPlaying(keep) {
        return this._change(async () => {
            const record = await this._read();
            if (!record) return;
            if (record.owner === this._owner && !keep) {
                await this._remove();
                return;
            }
            if (record.playing?.owner === this._owner) await this._write({ ...record, playing: null });
            if (record.owner === this._owner) this._keepTimer = setTimeout(() => this.release(), KEEP_MS);
        });
    }

    /** Gives the device up: nothing more is coming from this window. */
    release() {
        clearTimeout(this._keepTimer);
        return this._change(async () => {
            const record = await this._read();
            if (record?.owner === this._owner) await this._remove();
            else if (record?.playing?.owner === this._owner) await this._write({ ...record, playing: null });
        });
    }

    /**
     * @param {number} priority
     * @param {boolean} [force] whatever is there
     * @returns {Promise<number>} when the record was marked as this window's (0: it was not: it is
     *   already, or held by another at the same priority or higher)
     */
    _mark(priority, force = false) {
        return this._change(async () => {
            const record = await this._read();
            if (record?.owner === this._owner) {
                if (record.priority !== priority) await this._write({ ...record, priority });
                return 0;
            }
            if (record && !force && record.priority >= priority) return 0;
            await this._write({ ...this._record(priority), playing: record?.playing ?? null });
            return Date.now();
        });
    }

    /**
     * @param {number} priority
     * @returns {DeviceRecord}
     */
    _record(priority) {
        return { owner: this._owner, pid: this._pid, priority, expires: Date.now() + RECORD_TTL, playing: null };
    }

    /**
     * @param {DeviceRecord} record
     * @returns {boolean} whether another window is using the device right now
     */
    _playingElsewhere(record) {
        return !!record.playing && record.playing.owner !== this._owner;
    }

    /**
     * @param {(record: DeviceRecord | null) => boolean} condition
     * @param {AbortSignal} [signal]
     */
    async _until(condition, signal) {
        while (!signal?.aborted && !condition(await this._read())) await pause(POLL_MS, signal);
    }

    /**
     * @template T
     * @param {() => Promise<T>} change of the record
     * @returns {Promise<T>} after the changes before it
     */
    _change(change) {
        const result = this._queue.then(change);
        this._queue = result.catch(() => {});
        return result;
    }

    /**
     * @returns {Promise<DeviceRecord | null>} the record in force (null: none, unreadable, or of a dead
     *   process, or abandoned); a sound that is over or of a dead process is left out
     */
    async _read() {
        let record;
        try {
            record = JSON.parse(await readFile(this._file, 'utf8'));
        } catch {
            return null;
        }
        const now = Date.now();
        if (!record?.owner || !(record.expires > now) || (record.owner !== this._owner && !alive(record.pid))) return null;
        const { playing } = record;
        return { ...record, playing: playing && playing.until > now && (playing.owner === this._owner || alive(playing.pid)) ? playing : null };
    }

    /**
     * Replaces the file at once (never seen half written).
     * @param {DeviceRecord} record
     */
    async _write(record) {
        const part = `${this._file}.${this._pid}.${this._owner}.${++this._writes}`;
        try {
            await mkdir(this._folder, { recursive: true, mode: 0o700 });
            await writeFile(part, JSON.stringify(record));
            await rename(part, this._file);
        } catch {
            this._broken = true;
            await rm(part, { force: true }).catch(() => {});
        }
    }

    async _remove() {
        await rm(this._file, { force: true }).catch(() => {});
    }
}
