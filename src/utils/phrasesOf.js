/** @typedef {{ text: string, start: number, end: number }} PhraseSpan a phrase and where it is in its text */

/**
 * @param {string} text
 * @returns {PhraseSpan[]} its phrases (sentences) with their places; "v2.1" or "app.js" do not end one
 */
export function phraseSpans(text) {
    return [...text.matchAll(/(?:[^.!?…]|[.!?…](?=[\p{L}\p{N}]))+[.!?…]*/gu)].flatMap((match) => {
        const phrase = match[0].trim();
        if (!/[\p{L}\p{N}]/u.test(phrase)) return [];
        const start = match.index + match[0].search(/\S/u);
        return [{ text: phrase, start, end: start + phrase.length }];
    });
}

/**
 * @param {string} text
 * @returns {string[]} its phrases (sentences)
 */
export function phrasesOf(text) {
    return phraseSpans(text).map(phrase => phrase.text);
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
 * @returns {number} about how long reading it takes, in ms (letters and digits a second, a pause per phrase)
 */
export function estimateReading(text, rate = 1) {
    const count = pattern => (text.match(pattern) ?? []).length;
    const seconds = count(/[а-яёіїєґ]/gi) / 15 + count(/[a-z]/gi) / 13 + count(/\d/g) * 0.4 + (count(/[.!?…]+(?=\s|$)/g) + 1) * 0.2;
    return (seconds * 1000) / (rate || 1);
}

/**
 * @param {string} text
 * @returns {string} its language by its letters: English when Latin letters are more than twice the
 *   Cyrillic ones, else Russian, Ukrainian with its own letters
 */
export function guessLanguage(text) {
    const sample = text.slice(0, 4000);
    const cyrillic = (sample.match(/[а-яёіїєґ]/gi) ?? []).length;
    const latin = (sample.match(/[a-z]/gi) ?? []).length;
    if (latin > cyrillic * 2) return 'en';
    return /[іїєґ]/i.test(sample) ? 'uk' : 'ru';
}
