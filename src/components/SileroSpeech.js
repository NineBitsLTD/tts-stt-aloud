import { SILERO_SYMBOLS } from '../utils/mergeSileroModel';
import { isEnglish, normalizeRussian } from '../utils/normalizeRussian';
import { IPA_VOWELS, PiperSpeech } from './PiperSpeech';

/** @typedef {import('./SileroModels').SileroModels} SileroModels */

/** What can be in a text for the model: the symbols of Silero but padding, its start and its end. */
const TEXT_SYMBOLS = new Set(SILERO_SYMBOLS.slice(3));
const RU_VOWELS = /[аеёиоуыэюя]/gu;
/** A word, with the stress marked already if it is. */
const WORD = /[а-яё+]+/gu;
const SENTENCE = /[^.!?…]+[.!?…]*/gu;
/** The longest piece given to the model at once, in symbols. */
const LONGEST_PIECE = 800;
/** A voice of Silero comes after the Enhanced voices of the system, before Piper. */
const SCORE = 1.5;

/**
 * @param {string} ipa of one word, as espeak-ng writes it
 * @param {number} vowels how many vowel letters the word has
 * @returns {number} the index of its stressed vowel among them (-1: not told, or they do not line up)
 */
export function stressedVowel(ipa, vowels) {
    let count = 0;
    let stressed = -1;
    for (const char of ipa) {
        if (char === 'ˈ' && stressed < 0) stressed = count;
        else if (IPA_VOWELS.includes(char)) count++;
    }
    return count === vowels && stressed < count ? stressed : -1;
}

/**
 * @param {string} word in lower case
 * @param {(word: string) => number} stressOf the index of the stressed vowel of a word of several (-1: not told)
 * @returns {string} the word with "+" before its stressed vowel, as the model takes it: a word of one
 *   vowel too; one marked already stays, one that cannot be told goes without
 */
function stressedWord(word, stressOf) {
    if (word.includes('+')) return word;
    const vowels = [...word.matchAll(RU_VOWELS)].map(match => match.index);
    if (!vowels.length) return word;
    const at = vowels.length === 1 ? vowels[0] : word.includes('ё') ? word.indexOf('ё') : vowels[stressOf(word)];
    return at === undefined ? word : `${word.slice(0, at)}+${word.slice(at)}`;
}

/**
 * @param {string} sentence
 * @returns {string[]} it in pieces the model takes, cut after a comma or else at a space
 */
function shortPieces(sentence) {
    const pieces = [];
    let rest = sentence;
    while (rest.length > LONGEST_PIECE) {
        const head = rest.slice(0, LONGEST_PIECE);
        const cut = (head.lastIndexOf(',') + 1) || (head.lastIndexOf(' ') + 1) || LONGEST_PIECE;
        pieces.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
    }
    return [...pieces, rest];
}

/**
 * @param {string} text normalized (`normalizeRussian`: no digits, no Latin letters)
 * @param {(word: string) => number} stressOf the index of the stressed vowel of a word of several (-1: not told)
 * @returns {string[]} its sentences in the symbols of the model, every word stressed and each with its end mark
 */
export function sileroSentences(text, stressOf) {
    const clean = [...text.toLowerCase().replace(/[—―]/gu, '–').replace(/[‐‑]/gu, '-')].map(char => (TEXT_SYMBOLS.has(char) ? char : ' ')).join('').replace(/\s+/gu, ' ').trim();
    return (clean.match(SENTENCE) ?? []).flatMap(sentence => shortPieces(sentence.trim()))
        .filter(piece => /[а-яё]/u.test(piece))
        .map((piece) => {
            const stressed = piece.replace(/[\s,:;–-]+$/u, '').replace(WORD, word => stressedWord(word, stressOf));
            return /[.!?…]$/u.test(stressed) ? stressed : `${stressed}.`;
        });
}

/**
 * The voices of Silero: the speakers of a joined model (`SileroModels`), each with its id, spoken through
 * the same sherpa-onnx as Piper — the model has the inputs of a Piper model. It takes letters, not
 * phonemes: a text normalized (`normalizeRussian`, the words of English read with their stress), every
 * word with "+" before its stressed vowel. The model has none of its own and Silero's own is another
 * neural network, so the stress comes from espeak-ng (the phonemes of each word, once).
 */
export class SileroSpeech extends PiperSpeech {

    /**
     * @param {import('vscode').ExtensionContext} context
     * @param {SileroModels} models
     */
    constructor(context, models) {
        super(context, /** @type {any} */ (models));
        this._name = 'Silero';
        /** @type {Map<string, number>} the stressed vowel of the words seen */
        this._stress = new Map();
    }

    /**
     * @returns {Promise<(import('./PiperSpeech').PiperVoice & { sid: number })[]>} the speakers of the models ready
     */
    async voices() {
        const models = /** @type {import('./SileroModels').SileroModel[]} */ (await this._models.list());
        return models.filter(model => model.exists && model.ready)
            .flatMap(model => model.voices.map((name, sid) => ({ name, lang: model.lang, score: SCORE, path: model.path, sid })));
    }

    /**
     * @param {{ phonemizer: any }} runtime
     * @param {string} text
     * @returns {Promise<number[][]>} the code points of its sentences
     */
    async _codepoints({ phonemizer }, text) {
        const normalized = normalizeRussian(text, { reader: this._reader, english: isEnglish(text) });
        return sileroSentences(normalized, word => this._stressOf(phonemizer, word)).map(sentence => [...sentence].map(char => char.codePointAt(0)));
    }

    /**
     * @param {any} phonemizer piper-phonemize
     * @param {string} word in lower case, of several vowels
     * @returns {number} the index of its stressed vowel as espeak-ng tells it (-1: it does not)
     */
    _stressOf(phonemizer, word) {
        if (!this._stress.has(word)) {
            const ipa = (phonemizer.phonemize(word, 'ru') ?? []).map(points => String.fromCodePoint(...points)).join('');
            this._stress.set(word, stressedVowel(ipa, word.match(RU_VOWELS)?.length ?? 0));
        }
        return this._stress.get(word);
    }
}
