import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

/** ARPAbet vowels and consonants as a Russian speaker reads them. */
const VOWELS = {
    AA: 'а', AE: 'э', AH: 'а', AO: 'о', AW: 'ау', AY: 'ай', EH: 'э', ER: 'эр',
    EY: 'эй', IH: 'и', IY: 'и', OW: 'оу', OY: 'ой', UH: 'у', UW: 'у',
};
const CONSONANTS = {
    B: 'б', CH: 'ч', D: 'д', DH: 'д', F: 'ф', G: 'г', HH: 'х', JH: 'дж', K: 'к',
    L: 'л', M: 'м', N: 'н', NG: 'нг', P: 'п', R: 'р', S: 'с', SH: 'ш', T: 'т',
    TH: 'с', V: 'в', W: 'у', Y: 'й', Z: 'з', ZH: 'ж',
};
/** "Y" + vowel is one iotated Cyrillic letter: "you" -> "ю", "yes" -> "ес", "yard" -> "ярд". */
const IOTATED = { UW: 'ю', UH: 'ю', AH: 'я', AA: 'я', AE: 'я', EH: 'е', AO: 'ё', OW: 'ё' };
const RU_VOWELS = 'аеёиоуыэюя';

/**
 * @param {string} phone an ARPAbet phoneme with its stress digit (`OY1`)
 * @returns {[string, string]} the phoneme and its stress ('' : a consonant)
 */
function split(phone) {
    const base = phone.replace(/[012]$/, '');
    return [base, phone.slice(base.length)];
}

/**
 * English words read in Russian with their stress, for a Russian voice — a port of en2ru.py of
 * claude-ai. The pronunciation comes from CMUdict (`resources/cmudict/cmudict.dict.gz`, its license
 * next to it): ~135k words as ARPAbet phonemes with stress digits ("deploy D IH0 P L OY1"). Each
 * phoneme maps to Cyrillic; the vowel with the primary stress gets the mark "+" before it
 * ("deploy" -> "дипл+ой"). Voiced "th" (the) is read "д", voiceless (three) "с". The result is
 * English as a Russian speaker reads it: recognizable, with the right stress, with an accent.
 */
export class EnglishReading {

    /**
     * @param {string} dictionary the path of `cmudict.dict.gz`
     */
    constructor(dictionary) {
        this._path = dictionary;
        /** @type {Map<string, string> | null} word -> 'D IH0 P L OY1', loaded on first use */
        this._dict = null;
    }

    /**
     * @param {string} word
     * @returns {string[] | null} its ARPAbet phonemes (null: not in the dictionary)
     */
    phonemes(word) {
        const phones = this._load().get(word.toLowerCase());
        return phones ? phones.split(' ') : null;
    }

    /**
     * @param {string} word
     * @returns {string | null} its Russian reading with the stress marked (null: not in the dictionary)
     */
    reading(word) {
        const phones = this.phonemes(word);
        return phones ? EnglishReading._toRussian(phones) : null;
    }

    /**
     * Marks the English stress of a word on its Russian form ("деплой" -> "депл+ой"), when the vowel
     * groups of the Russian form match the English syllables one to one.
     * @param {string} word English
     * @param {string} russian one word, no "+" yet
     * @returns {string} the Russian form, with the stress when it could be placed
     */
    stressLike(word, russian) {
        const phones = this.phonemes(word);
        if (!phones || /[+ё ]/.test(russian)) return russian;
        const vowels = phones.filter(phone => /[012]$/.test(phone));
        const stressed = vowels.findIndex(phone => phone.endsWith('1'));
        const groups = [...russian.matchAll(new RegExp(`[${RU_VOWELS}]+`, 'g'))].map(match => match.index);
        // One syllable needs no mark; a mismatch would put it on the wrong vowel
        if (stressed < 0 || vowels.length < 2 || groups.length !== vowels.length) return russian;
        return `${russian.slice(0, groups[stressed])}+${russian.slice(groups[stressed])}`;
    }

    /**
     * @returns {Map<string, string>}
     */
    _load() {
        if (this._dict) return this._dict;
        this._dict = new Map();
        try {
            for (const line of gunzipSync(readFileSync(this._path)).toString('utf8').split('\n')) {
                const space = line.indexOf(' ');
                const word = line.slice(0, space);
                // Alternative pronunciations: the first one is the common one
                if (space < 1 || word.includes('(')) continue;
                const phones = line.slice(space + 1).split('#')[0].trim();
                if (phones && !this._dict.has(word)) this._dict.set(word, phones);
            }
        } catch {
            // No dictionary: the callers fall back to the reading rules
        }
        return this._dict;
    }

    /**
     * @param {string[]} phones
     * @returns {string}
     */
    static _toRussian(phones) {
        const out = [];
        for (let index = 0; index < phones.length; index++) {
            const [base, stress] = split(phones[index]);
            const next = phones[index + 1] ? split(phones[index + 1])[0] : null;
            if (base === 'Y' && next in IOTATED) {
                // After a consonant the iotated vowel needs a soft sign: "music" -> "мьюзик"
                if (out.length && !(RU_VOWELS + 'йь').includes(out.at(-1).at(-1))) out.push('ь');
                const letter = IOTATED[next];
                out.push((phones[index + 1].endsWith('1') && letter !== 'ё' ? '+' : '') + letter);
                index++;
            } else if (base in VOWELS) {
                // "first" -> "фёрст": ё is always stressed
                out.push(base === 'ER' && stress === '1' ? 'ёр' : (stress === '1' ? '+' : '') + VOWELS[base]);
            } else if (base in CONSONANTS) {
                out.push(CONSONANTS[base]);
            }
        }
        return out.join('');
    }
}
