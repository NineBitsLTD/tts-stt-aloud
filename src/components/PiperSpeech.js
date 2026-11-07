import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { EnglishReading } from '../utils/EnglishReading';
import { isEnglish, normalizeRussian } from '../utils/normalizeRussian';
import { speaksLanguage } from '../utils/pickVoice';
import { WavAudio } from '../utils/WavAudio';
import { readSherpaMeta } from './PiperModels';

/** @typedef {import('./PiperModels').PiperModels} PiperModels */
/** @typedef {{ name: string, lang: string, score: number, path: string }} PiperVoice a ready model as a voice */
/** @typedef {{ index: number, letter: string, vowels: number }} StressMark the stressed vowel of a word: its index among the vowel letters, the letter, how many there are */

/** Vowels of the IPA espeak-ng writes; the reduced ones, which a stress makes full again. */
const IPA_VOWELS = 'aɑɐʌæeɛəɜiɪɨoɔɒuʊyʉɯɵøœᵻ';
const REDUCED = 'ʌəɐɪᵻɨʊ';
/** The stressed vowel espeak-ng writes for a Russian vowel letter. */
const STRESSED = { а: 'ɑ', я: 'ɑ', о: 'o', ё: 'ɵ', у: 'u', ю: 'u', ы: 'y', и: 'i', е: 'e', э: 'ɛ' };
const RU_VOWELS = /[аеёиоуыэюя]/giu;
/** Models kept loaded (a model takes tens of MB). */
const ENGINES = 2;

/**
 * The stress marks of a normalized Russian text ("апд+эйтид"): espeak-ng takes no mark in the
 * text, so they are put into its phonemes afterwards (`applyStress`).
 * @param {string} text
 * @returns {{ clean: string, marks: (StressMark | null)[] }} the text without the marks; a mark (or
 *   null) for each word with letters
 */
export function stressMarks(text) {
    const marks = [];
    for (const word of text.split(/\s+/)) {
        if (!/\p{L}/u.test(word)) continue;
        const plus = word.indexOf('+');
        if (plus < 0) {
            marks.push(null);
            continue;
        }
        const before = word.slice(0, plus).replace(/\+/g, '');
        const clean = word.replace(/\+/g, '');
        marks.push({ index: (before.match(RU_VOWELS) ?? []).length, letter: clean[before.length]?.toLowerCase() ?? '', vowels: (clean.match(RU_VOWELS) ?? []).length });
    }
    return { clean: text.replace(/\+/g, ''), marks };
}

/**
 * @param {string} word in IPA
 * @param {StressMark} mark
 * @returns {string} the word stressed on the marked vowel (its reduced vowel made full); unchanged when
 *   its vowels do not line up with the letters
 */
function stressWord(word, mark) {
    const chars = [...word.replace(/[ˈˌ]/g, '')];
    const vowels = chars.flatMap((char, index) => (IPA_VOWELS.includes(char) ? [index] : []));
    if (vowels.length !== mark.vowels || mark.index >= vowels.length) return word;
    const at = vowels[mark.index];
    if (REDUCED.includes(chars[at]) && STRESSED[mark.letter]) chars[at] = STRESSED[mark.letter];
    chars.splice(at, 0, 'ˈ');
    return chars.join('');
}

/**
 * Puts the stress marks into the phonemes of the sentences, word by word.
 * @param {string[]} sentences IPA, words separated by spaces
 * @param {(StressMark | null)[]} marks of the words of the text
 * @returns {string[]} unchanged when espeak-ng made other words of the text (an abbreviation it expanded)
 */
export function applyStress(sentences, marks) {
    if (!marks.some(Boolean)) return sentences;
    const words = sentences.map(sentence => sentence.split(' '));
    const spoken = words.flatMap((list, sentence) => list.flatMap((word, index) => (/\p{L}/u.test(word) ? [[sentence, index]] : [])));
    if (spoken.length !== marks.length) return sentences;
    marks.forEach((mark, index) => {
        if (!mark) return;
        const [sentence, word] = spoken[index];
        words[sentence][word] = stressWord(words[sentence][word], mark);
    });
    return words.map(list => list.join(' '));
}

/**
 * The voices of Piper through sherpa-onnx — the native addon of this machine in `dist/native` —
 * and piper-phonemize — espeak-ng in WASM, with its data, in `dist/piper-phonemize`; both copied
 * there by `scripts/copy-runtime.mjs`. A voice is a model of `PiperModels` prepared for sherpa-onnx.
 * The text becomes phonemes for the espeak-ng voice of the model (its metadata); a Russian text is
 * normalized first (`normalizeRussian`, from claude-ai: numbers, units, Latin words with their
 * stress), the stress marks put into the phonemes. sherpa-onnx makes the audio asynchronously.
 */
export class PiperSpeech {

    /**
     * @param {import('vscode').ExtensionContext} context
     * @param {PiperModels} models
     */
    constructor(context, models) {
        this._root = join(context.extensionUri.fsPath, 'dist');
        this._models = models;
        this._reader = new EnglishReading(join(context.extensionUri.fsPath, 'resources', 'cmudict', 'cmudict.dict.gz'));
        /** @type {{ addon: any, phonemizer: any } | null | undefined} undefined: not loaded yet; null: missing */
        this._runtime = undefined;
        this._missing = '';
        /** @type {Map<string, Promise<any>>} model path -> its engine (oldest first) */
        this._engines = new Map();
    }

    /**
     * @returns {string} why Piper cannot speak in this build ('' : it can)
     */
    unavailable() {
        this._load();
        return this._missing;
    }

    /**
     * @returns {Promise<PiperVoice[]>} the models prepared for sherpa-onnx
     */
    async voices() {
        return (await this._models.list()).filter(model => model.exists && model.ready)
            .map(model => ({ name: model.name, lang: model.lang, score: 1, path: model.path }));
    }

    /**
     * @param {string} text
     * @param {{ voice?: string, rate?: number, lang?: string }} [options] voice: the name of a model
     *   (else one of the language, else the first)
     * @returns {Promise<Buffer>} WAV audio
     */
    async render(text, { voice, rate = 1, lang } = {}) {
        const runtime = this._load();
        if (!runtime) throw new Error(this._missing);
        const voices = await this.voices();
        const model = voices.find(item => item.name === voice) ?? voices.find(item => lang && speaksLanguage(item, lang)) ?? voices[0];
        if (!model) throw new Error('Piper has no voice model ready: add one under Add driver → Piper.');
        const espeakVoice = (await readSherpaMeta(model.path))?.voice || model.lang.slice(0, 2).toLowerCase() || 'en-us';
        const phonemes = this._phonemize(runtime.phonemizer, text, espeakVoice);
        const engine = await this._engine(runtime.addon, model.path);
        if (!phonemes.some(sentence => sentence.length)) return WavAudio.fromFloat32([], 22050);
        // Electron (the extension host of VS Code) allows no external buffers (the V8 memory cage):
        // with them, the default, the addon fails with "TTS settlement failed"
        let audio;
        try {
            audio = await runtime.addon.offlineTtsGenerateAsyncWithConfig(engine, {
                text: '',
                enableExternalBuffer: false,
                generationConfig: { sid: 0, speed: rate, phonemeCodepoints: phonemes },
            });
        } catch (error) {
            throw new Error(`Piper (sherpa-onnx) could not speak with ${model.name}: ${error?.message || error}`);
        }
        return WavAudio.fromFloat32(audio.samples, audio.sampleRate);
    }

    /**
     * @param {any} phonemizer piper-phonemize
     * @param {string} text
     * @param {string} voice of espeak-ng (`ru`, `en-us`, …)
     * @returns {number[][]} the code points of the phonemes, a list a sentence
     */
    _phonemize(phonemizer, text, voice) {
        if (!/^ru\b/.test(voice)) return phonemizer.phonemize(text, voice) ?? [];
        const { clean, marks } = stressMarks(normalizeRussian(text, { reader: this._reader, english: isEnglish(text) }));
        const sentences = (phonemizer.phonemize(clean, voice) ?? []).map(points => String.fromCodePoint(...points));
        return applyStress(sentences, marks).map(sentence => [...sentence].map(char => char.codePointAt(0)));
    }

    /**
     * @param {any} addon
     * @param {string} path of a model
     * @returns {Promise<any>} its engine of sherpa-onnx (`tokens.txt` next to it), loaded once
     */
    _engine(addon, path) {
        let engine = this._engines.get(path);
        if (!engine) {
            engine = addon.createOfflineTtsAsync({ model: { vits: { model: path, tokens: join(dirname(path), 'tokens.txt') }, numThreads: 2, provider: 'cpu', debug: 0 }, maxNumSentences: 1 });
            engine.catch(() => this._engines.delete(path));
            this._engines.set(path, engine);
            while (this._engines.size > ENGINES) this._engines.delete(this._engines.keys().next().value);
        }
        return engine;
    }

    /**
     * @returns {{ addon: any, phonemizer: any } | null} the runtime copied into `dist` (null: not in this build)
     */
    _load() {
        if (this._runtime !== undefined) return this._runtime;
        try {
            const load = createRequire(join(this._root, 'extension.cjs'));
            this._runtime = { addon: load('./native/sherpa-onnx.node'), phonemizer: load('./piper-phonemize/index.js') };
        } catch (error) {
            this._runtime = null;
            this._missing = `Piper cannot speak in this build for ${process.platform}-${process.arch}: sherpa-onnx or piper-phonemize is missing (${error?.message || error}).`;
        }
        return this._runtime;
    }
}
