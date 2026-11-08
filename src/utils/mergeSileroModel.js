import { encodeOnnxMetadata, readVarint, writeVarint } from './readOnnxMetadata';

/** The set of Silero the parts of which can be joined. */
export const SILERO_VERSION = 'v5_6_ru';
/** Its files are `<part>_<version>.onnx`. */
export const SILERO_PARTS = ['dur_predictor', 'pitch_predictor', 'acoustic', 'vocoder'];
/** Its voices, by their ids. */
export const SILERO_SPEAKERS = ['aidar', 'baya', 'kseniya', 'eugene', 'xenia'];
/** Its symbols, by their ids; the first three are not text: padding, the end, the start. */
export const SILERO_SYMBOLS = [...'_~|!+,-.:;?абвгдежзийклмнопрстуфхцчшщъыьэюяё–… '];

/** The id sherpa-onnx puts between the symbols of a Piper model (`_` in `tokens.txt`), taken out again by the model. */
const PAD = SILERO_SYMBOLS.length;
const INT64 = 7;
const FLOAT = 1;
const OPSET = 18;
/** What each part takes and gives; a set exported otherwise is refused. */
const SIGNATURES = {
    dur_predictor: { inputs: ['text', 'speaker_ids', 'mask', 'type_ids', 'focus_mask'], outputs: ['dur'] },
    pitch_predictor: { inputs: ['text', 'speaker_ids', 'mask', 'type_ids', 'focus_mask'], outputs: ['pitch'] },
    acoustic: { inputs: ['sequence', 'speaker_ids', 'durs_rate', 'gt_durs', 'gt_pitch', 'pitch_coefs', 'type_ids', 'focus_mask'], outputs: ['mel', 'dur'] },
    vocoder: { inputs: ['mel'], outputs: ['audio'] },
};

/** @typedef {{ no: number, wire: number, from: number, to: number, start: number, end: number }} ProtoField start, end: of its bytes when length-delimited */

/**
 * @param {Buffer} buffer
 * @param {number} offset
 * @returns {[number, number]} a varint and the offset after it
 */
function varintAt(buffer, offset) {
    const read = readVarint(buffer, offset);
    if (!read) throw new Error('not an ONNX model');
    return read;
}

/**
 * @param {Buffer} buffer a protobuf message
 * @param {number} start
 * @param {number} end
 * @yields {ProtoField}
 */
function* fields(buffer, start, end) {
    let at = start;
    while (at < end) {
        const from = at;
        const [tag, afterTag] = varintAt(buffer, at);
        const wire = tag % 8;
        at = afterTag;
        let [begin, finish] = [at, at];
        if (wire === 0) {
            while (buffer[at++] & 0x80);
        } else if (wire === 1) at += 8;
        else if (wire === 5) at += 4;
        else if (wire === 2) {
            const [length, afterLength] = varintAt(buffer, at);
            [begin, finish, at] = [afterLength, afterLength + length, afterLength + length];
        } else throw new Error('not an ONNX model');
        if (at > end) throw new Error('not an ONNX model');
        yield { no: Math.floor(tag / 8), wire, from, to: at, start: begin, end: finish };
    }
}

/** @param {number} no @param {Buffer[]} parts @returns {Buffer[]} a length-delimited field */
function delimited(no, parts) {
    return [writeVarint(no * 8 + 2), writeVarint(parts.reduce((sum, part) => sum + part.length, 0)), ...parts];
}

/** @param {number} no @param {string} value @returns {Buffer[]} */
function text(no, value) {
    return delimited(no, [Buffer.from(value, 'utf8')]);
}

/** @param {number} no @param {number} value @returns {Buffer[]} */
function number(no, value) {
    return [writeVarint(no * 8), writeVarint(value)];
}

/**
 * @param {number} kind of TensorProto
 * @param {number[]} dims
 * @param {number} value
 * @returns {Buffer[]} a TensorProto of one value
 */
function tensor(kind, dims, value) {
    const data = Buffer.alloc(kind === INT64 ? 8 : 4);
    if (kind === INT64) data.writeBigInt64LE(BigInt(value));
    else data.writeFloatLE(value);
    return [...dims.flatMap(dim => number(1, dim)), ...number(2, kind), ...delimited(9, [data])];
}

/** @param {Buffer[]} value a TensorProto @returns {Buffer[]} the attribute `value` of a node */
function valueAttribute(value) {
    return delimited(5, [...text(1, 'value'), ...number(20, 4), ...delimited(5, value)]);
}

/**
 * @param {string} op
 * @param {string[]} inputs
 * @param {string[]} outputs
 * @param {Buffer[]} [attributes]
 * @returns {Buffer[]} a node of GraphProto
 */
function node(op, inputs, outputs, attributes = []) {
    return delimited(1, [...inputs.flatMap(name => text(1, name)), ...outputs.flatMap(name => text(2, name)), ...text(4, op), ...attributes]);
}

/** @param {[string, string][]} pairs @returns {Buffer[]} nodes passing values on under other names */
function wires(pairs) {
    return pairs.flatMap(([from, to]) => node('Identity', [from], [to]));
}

/**
 * @param {number} no of GraphProto: 11 an input, 12 an output
 * @param {string} name
 * @param {number} elem
 * @param {(number | null)[]} dims null: as long as it comes
 * @returns {Buffer[]}
 */
function valueInfo(no, name, elem, dims) {
    const shape = dims.flatMap(dim => delimited(1, dim === null ? text(2, 'T') : number(1, dim)));
    return delimited(no, [...text(1, name), ...delimited(2, delimited(1, [...number(1, elem), ...delimited(2, shape)]))]);
}

/**
 * @param {Buffer} buffer
 * @param {ProtoField} field a message
 * @param {number[]} nameFields those of its fields that are names
 * @param {string} prefix
 * @returns {Buffer[]} the message with its names prefixed (an empty name is an input left out: it stays)
 */
function renamed(buffer, field, nameFields, prefix) {
    return [...fields(buffer, field.start, field.end)].flatMap((item) => {
        if (!nameFields.includes(item.no) || item.wire !== 2) return [buffer.subarray(item.from, item.to)];
        const name = buffer.toString('utf8', item.start, item.end);
        return text(item.no, name ? prefix + name : '');
    });
}

/**
 * @param {Buffer} buffer an ONNX model
 * @param {string} part
 * @param {string} prefix put before its names: the parts use the same ones
 * @returns {{ nodes: Buffer[], initializers: Buffer[] }} its nodes and weights, ready to be written
 * @throws {Error} when it is not the part that is expected
 */
function readPart(buffer, part, prefix) {
    const model = [...fields(buffer, 0, buffer.length)];
    const graph = model.find(field => field.no === 7);
    if (!graph) throw new Error(`${part}: not an ONNX model`);
    const opset = model.filter(field => field.no === 8).flatMap(field => [...fields(buffer, field.start, field.end)].filter(item => item.no === 2).map(item => varintAt(buffer, item.from + 1)[0]));
    const items = [...fields(buffer, graph.start, graph.end)];
    const namesOf = no => items.filter(item => item.no === no).map(item => buffer.toString('utf8', ...nameRange(buffer, item)));
    const same = (found, wanted) => found.length === wanted.length && wanted.every(name => found.includes(name));
    const { inputs, outputs } = SIGNATURES[part];
    if (!same(namesOf(11), inputs) || !same(namesOf(12), outputs) || opset.join() !== String(OPSET) || model.some(field => field.no === 25) || items.some(item => item.no === 15)) {
        throw new Error(`${part} is not the part of ${SILERO_VERSION} this extension knows`);
    }
    return {
        nodes: items.filter(item => item.no === 1).flatMap(item => delimited(1, renamed(buffer, item, [1, 2, 3], prefix))),
        initializers: items.filter(item => item.no === 5).flatMap(item => delimited(5, renamed(buffer, item, [8], prefix))),
    };
}

/**
 * @param {Buffer} buffer
 * @param {ProtoField} valueInfoField a ValueInfoProto
 * @returns {[number, number]} where its name is
 */
function nameRange(buffer, valueInfoField) {
    const name = [...fields(buffer, valueInfoField.start, valueInfoField.end)].find(item => item.no === 1);
    return name ? [name.start, name.end] : [0, 0];
}

/**
 * @returns {string} the `tokens.txt` of the joined model: the symbols of Silero, its start and end under the
 *   marks of Piper (`^`, `$`), `_` under an id of its own
 */
export function sileroTokens() {
    const ids = SILERO_SYMBOLS.map((symbol, id) => /** @type {[string, number]} */ ([symbol, id]));
    const marks = /** @type {[string, number][]} */ ([['_', PAD], ['^', SILERO_SYMBOLS.indexOf('|')], ['$', SILERO_SYMBOLS.indexOf('~')]]);
    return [...ids.filter(([symbol]) => !'_~|'.includes(symbol)), ...marks].sort((a, b) => a[1] - b[1]).map(([symbol, id]) => `${symbol} ${id}\n`).join('');
}

/**
 * Joins the parts of Silero `v5_6_ru` (exported to ONNX by silero-tts-onnx: a predictor of durations,
 * one of pitch, the acoustic model, the vocoder) into one model with the inputs of a Piper model
 * (`input`, `input_lengths`, `scales`, `sid`), which sherpa-onnx loads and speaks with: the symbols go
 * to the predictors, the durations and the pitch to the acoustic model, its mel to the vocoder. The
 * speed is the second of the scales. What Piper has no input for — the type of a sentence, the focus
 * of a word — is zero: every sentence a statement. The weights are not copied: the pieces are parts
 * of the buffers given.
 * @param {Record<string, Buffer>} parts the files, by `SILERO_PARTS`
 * @returns {Buffer[]} the file, in pieces, in order; its metadata in the last one
 * @throws {Error} when a file is not the part expected
 */
export function mergeSileroModel(parts) {
    const [durations, pitch, acoustic, vocoder] = [['dur_predictor', 'd/'], ['pitch_predictor', 'p/'], ['acoustic', 'a/'], ['vocoder', 'v/']].map(([part, prefix]) => readPart(parts[part], part, prefix));
    const scalar = (name, kind, value) => node('Constant', [], [name], valueAttribute(tensor(kind, [], value)));
    const fill = (name, kind, value) => node('ConstantOfShape', ['seq_shape'], [name], valueAttribute(tensor(kind, [1], value)));
    const predictor = (prefix, input) => wires([['seq', `${prefix}${input}`], ['sid', `${prefix}speaker_ids`], ['mask', `${prefix}mask`], ['zeros', `${prefix}type_ids`], ['zeros', `${prefix}focus_mask`]]);
    const nodes = [
        ...scalar('pad', INT64, PAD), ...scalar('zero', INT64, 0), ...scalar('one', FLOAT, 1), ...scalar('length_at', INT64, 1),
        ...node('Constant', [], ['axis0'], valueAttribute(tensor(INT64, [1], 0))),
        ...node('Equal', ['input', 'pad'], ['is_pad']),
        ...node('Not', ['is_pad'], ['keep2']),
        ...node('Squeeze', ['keep2', 'axis0'], ['keep']),
        ...node('Compress', ['input', 'keep'], ['seq'], delimited(5, [...text(1, 'axis'), ...number(3, 1), ...number(20, 2)])),
        ...node('Shape', ['seq'], ['seq_shape']),
        ...fill('zeros', INT64, 0), ...fill('ones', FLOAT, 1),
        ...node('Equal', ['seq', 'zero'], ['mask']),
        ...node('Gather', ['scales', 'length_at'], ['length_scale']),
        ...node('Div', ['ones', 'length_scale'], ['durs_rate']),
        ...predictor('d/', 'text'), ...predictor('p/', 'text'),
        ...durations.nodes, ...pitch.nodes,
        ...node('Exp', ['d/dur'], ['dur_exp']), ...node('Sub', ['dur_exp', 'one'], ['gt_durs']),
        ...wires([
            ['seq', 'a/sequence'], ['sid', 'a/speaker_ids'], ['durs_rate', 'a/durs_rate'], ['gt_durs', 'a/gt_durs'],
            ['p/pitch', 'a/gt_pitch'], ['ones', 'a/pitch_coefs'], ['zeros', 'a/type_ids'], ['zeros', 'a/focus_mask'],
        ]),
        ...acoustic.nodes,
        ...wires([['a/mel', 'v/mel']]),
        ...vocoder.nodes,
        ...wires([['v/audio', 'output']]),
    ];
    const graph = [
        ...nodes,
        ...text(2, `silero_${SILERO_VERSION}`),
        ...durations.initializers, ...pitch.initializers, ...acoustic.initializers, ...vocoder.initializers,
        ...valueInfo(11, 'input', INT64, [1, null]),
        ...valueInfo(11, 'input_lengths', INT64, [1]),
        ...valueInfo(11, 'scales', FLOAT, [3]),
        ...valueInfo(11, 'sid', INT64, [1]),
        ...valueInfo(12, 'output', FLOAT, [1, null]),
    ];
    return [
        ...number(1, 10),
        ...delimited(7, graph),
        ...delimited(8, number(2, OPSET)),
        encodeOnnxMetadata({
            model_type: 'vits', comment: 'piper', language: 'Russian', voice: 'ru', has_espeak: 1,
            n_speakers: SILERO_SPEAKERS.length, sample_rate: 48000,
            silero_version: SILERO_VERSION, silero_speakers: SILERO_SPEAKERS.join(','),
        }),
    ];
}
