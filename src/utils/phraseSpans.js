/** @typedef {{ text: string, start: number, end: number }} PhraseSpan a phrase and where it is in its text */

/** Marks that end a phrase wherever they stand (no space follows them in Chinese, Japanese; Arabic, Hindi … have their own). */
const CLOSING_MARKS = '。！？｡؟۔।॥։።။។';
const PHRASE = new RegExp(`(?:[^.!?…${CLOSING_MARKS}]|[.!?…](?=[\\p{L}\\p{N}])(?![\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}]))+[.!?…${CLOSING_MARKS}]*`, 'gu');
const PHRASE_END = new RegExp(`[.!?…]+(?=\\s|$)|[${CLOSING_MARKS}]+`, 'gu');

/**
 * @param {string} text
 * @returns {PhraseSpan[]} its phrases (sentences) with their places; "v2.1" or "app.js" do not end one
 */
export function phraseSpans(text) {
    return [...text.matchAll(PHRASE)].flatMap((match) => {
        const phrase = match[0].trim();
        if (!/[\p{L}\p{N}]/u.test(phrase)) return [];
        const start = match.index + match[0].search(/\S/u);
        return [{ text: phrase, start, end: start + phrase.length }];
    });
}

/**
 * @param {number} ms
 * @returns {string} `m:ss` or `h:mm:ss`
 */
export function clock(ms) {
    const seconds = Math.floor(ms / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds / 60) % 60;
    const rest = String(seconds % 60).padStart(2, '0');
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

/**
 * @param {string} text what is read
 * @param {number} [rate] the speed of the speech
 * @returns {number} about how long reading it takes, in ms (letters, syllables, ideographs and digits a
 *   second, a pause per phrase)
 */
export function estimateReading(text, rate = 1) {
    const count = pattern => (text.match(pattern) ?? []).length;
    const cyrillic = count(/\p{Script=Cyrillic}/gu);
    const latin = count(/\p{Script=Latin}/gu);
    const ideographs = count(/[\p{Script=Han}\p{Script=Hangul}]/gu);
    const kana = count(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu);
    const others = count(/\p{L}/gu) - cyrillic - latin - ideographs - kana;
    const seconds = cyrillic / 15 + (latin + others) / 13 + ideographs / 5 + kana / 8 + count(/\d/g) * 0.4 + (count(PHRASE_END) + 1) * 0.2;
    return (seconds * 1000) / (rate || 1);
}
