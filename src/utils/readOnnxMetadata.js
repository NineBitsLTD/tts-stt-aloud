import { open } from 'node:fs/promises';

/** ONNX ModelProto.metadata_props: field 14, length-delimited; StringStringEntryProto key 1, value 2. */
const META_TAG = 0x72;
const KEY_TAG = 0x0a;
const VALUE_TAG = 0x12;

/**
 * @param {Buffer} buffer
 * @param {number} offset
 * @returns {[number, number] | null} a varint and the offset after it (null: not one)
 */
export function readVarint(buffer, offset) {
    let value = 0;
    for (let shift = 0, index = offset; index < buffer.length && shift < 35; shift += 7, index++) {
        value += (buffer[index] & 0x7f) * 2 ** shift;
        if (!(buffer[index] & 0x80)) return [value, index + 1];
    }
    return null;
}

/**
 * @param {number} value below 2^32
 * @returns {Buffer} its varint
 */
export function writeVarint(value) {
    const bytes = [];
    do {
        bytes.push((value & 0x7f) | (value > 0x7f ? 0x80 : 0));
        value >>>= 7;
    } while (value);
    return Buffer.from(bytes);
}

/**
 * @param {Buffer} buffer
 * @param {number} offset of a tag 0x72
 * @returns {{ key: string, value: string, end: number } | null} the metadata entry there (null: the
 *   bytes are not one — the tag byte can occur anywhere in a model)
 */
function readEntry(buffer, offset) {
    const length = readVarint(buffer, offset + 1);
    if (!length || length[1] + length[0] > buffer.length || buffer[length[1]] !== KEY_TAG) return null;
    const end = length[1] + length[0];
    const keyLength = readVarint(buffer, length[1] + 1);
    if (!keyLength) return null;
    const keyEnd = keyLength[1] + keyLength[0];
    if (keyEnd >= end || buffer[keyEnd] !== VALUE_TAG) return null;
    const valueLength = readVarint(buffer, keyEnd + 1);
    if (!valueLength || valueLength[1] + valueLength[0] !== end) return null;
    return { key: buffer.toString('utf8', keyLength[1], keyEnd), value: buffer.toString('utf8', valueLength[1], end), end };
}

/**
 * The metadata of an ONNX model (ModelProto.metadata_props): `onnx.save` writes them after the
 * graph, so they are in the last bytes of the file — the scripts of sherpa-onnx put there what
 * their models are (`model_type`, the language, the sample rate, the languages of Whisper, …).
 * @param {string} path of an `.onnx` model
 * @param {number} [tail] the bytes read at the end of the file (more for long values)
 * @returns {Promise<Record<string, string> | null>} null: the file cannot be read
 */
export async function readOnnxMetadata(path, tail = 4096) {
    let buffer;
    try {
        const file = await open(path, 'r');
        try {
            const { size } = await file.stat();
            buffer = Buffer.alloc(Math.min(size, tail));
            await file.read(buffer, 0, buffer.length, size - buffer.length);
        } finally {
            await file.close();
        }
    } catch {
        return null;
    }
    const meta = {};
    for (let index = buffer.indexOf(META_TAG); index >= 0; index = buffer.indexOf(META_TAG, index + 1)) {
        const entry = readEntry(buffer, index);
        if (!entry) continue;
        meta[entry.key] = entry.value;
        index = entry.end - 1;
    }
    return meta;
}

/**
 * @param {Record<string, string | number>} meta
 * @returns {Buffer} entries of ModelProto.metadata_props; appended to a model they are its metadata,
 *   as `onnx.save` writes them (byte for byte)
 */
export function encodeOnnxMetadata(meta) {
    const field = (tag, bytes) => Buffer.concat([Buffer.from([tag]), writeVarint(bytes.length), bytes]);
    return Buffer.concat(Object.entries(meta).map(([key, value]) => field(META_TAG,
        Buffer.concat([field(KEY_TAG, Buffer.from(key)), field(VALUE_TAG, Buffer.from(String(value)))]))));
}
