/** WAVE_FORMAT_PCM, WAVE_FORMAT_IEEE_FLOAT, WAVE_FORMAT_EXTENSIBLE */
const PCM = 1;
const FLOAT = 3;
const EXTENSIBLE = 0xfffe;

/**
 * The audio of a WAV file (RIFF) with 16-bit integer or 32-bit float samples, any rate and number
 * of channels — what `say`, `System.Speech` and neural speech engines write. Gives the audio at a
 * lower volume and the levels of its sound for a level meter.
 */
export class WavAudio {

    /**
     * @param {Buffer} buffer the file
     * @param {{ channels: number, sampleRate: number, float: boolean, start: number, end: number }} format
     *   start / end: the samples in the buffer
     */
    constructor(buffer, format) {
        this.buffer = buffer;
        this.channels = format.channels;
        this.sampleRate = format.sampleRate;
        this._float = format.float;
        this._start = format.start;
        this._end = format.end;
    }

    /**
     * @param {Buffer} buffer
     * @returns {WavAudio | null} null when it is not a WAV file of 16-bit or float samples
     */
    static parse(buffer) {
        if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return null;
        let format = null;
        let data = null;
        for (let offset = 12; offset + 8 <= buffer.length;) {
            const id = buffer.toString('ascii', offset, offset + 4);
            const size = buffer.readUInt32LE(offset + 4);
            const start = offset + 8;
            if (id === 'fmt ' && start + 16 <= buffer.length) {
                let code = buffer.readUInt16LE(start);
                if (code === EXTENSIBLE && start + 26 <= buffer.length) code = buffer.readUInt16LE(start + 24);
                format = { code, channels: buffer.readUInt16LE(start + 2), sampleRate: buffer.readUInt32LE(start + 4), bits: buffer.readUInt16LE(start + 14) };
            } else if (id === 'data') {
                // A file written while streaming may leave the size of its data 0 or unknown
                data = { start, end: size && start + size <= buffer.length ? start + size : buffer.length };
                break;
            }
            offset = start + size + (size & 1);
        }
        if (!format || !data || !format.channels || !format.sampleRate) return null;
        const float = format.code === FLOAT && format.bits === 32;
        if (!float && !(format.code === PCM && format.bits === 16)) return null;
        const frame = (float ? 4 : 2) * format.channels;
        return new WavAudio(buffer, { channels: format.channels, sampleRate: format.sampleRate, float, start: data.start, end: data.start + Math.floor((data.end - data.start) / frame) * frame });
    }

    /**
     * @param {number} rms root mean square of samples from -1 to 1
     * @returns {number} the level of a meter from 0 to 1: -60 dBFS and below is 0, 0 dBFS is 1
     */
    static meter(rms) {
        return rms > 0 ? Math.max(0, Math.min(1, (20 * Math.log10(rms) + 60) / 60)) : 0;
    }

    /** @returns {number} seconds */
    get duration() {
        return (this._end - this._start) / ((this._float ? 4 : 2) * this.channels * this.sampleRate);
    }

    /**
     * @param {number} volume from 0 to 1
     * @returns {Buffer} the file with its samples at that volume (the same buffer at full volume)
     */
    withVolume(volume) {
        if (volume >= 1) return this.buffer;
        const gain = Math.max(0, volume);
        const out = Buffer.from(this.buffer);
        if (this._float) {
            for (let offset = this._start; offset < this._end; offset += 4) out.writeFloatLE(this.buffer.readFloatLE(offset) * gain, offset);
        } else {
            for (let offset = this._start; offset < this._end; offset += 2) out.writeInt16LE(Math.round(this.buffer.readInt16LE(offset) * gain), offset);
        }
        return out;
    }

    /**
     * @param {number} interval ms
     * @param {number} [gain] the volume the audio is played at
     * @returns {number[]} the level of the sound (`meter`) in each interval of the audio
     */
    levels(interval, gain = 1) {
        const bytes = this._float ? 4 : 2;
        const step = Math.max(1, Math.round((this.sampleRate * interval) / 1000)) * this.channels * bytes;
        const levels = [];
        for (let from = this._start; from < this._end; from += step) {
            const to = Math.min(this._end, from + step);
            let sum = 0;
            for (let offset = from; offset < to; offset += bytes) {
                const sample = this._float ? this.buffer.readFloatLE(offset) : this.buffer.readInt16LE(offset) / 32768;
                sum += sample * sample;
            }
            levels.push(WavAudio.meter(Math.sqrt(sum / ((to - from) / bytes)) * gain));
        }
        return levels;
    }
}
