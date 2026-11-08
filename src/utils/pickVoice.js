/**
 * The voices of a language, for `TextToSpeech` and `PiperSpeech`.
 * @typedef {object} Voice
 * @property {string} name
 * @property {string} lang language tag as the engine names it (`ru-RU`, `en_US`, … ; '' unknown)
 * @property {number} [score] higher is better: "Enhanced" / "Premium" voices, local ones
 */

/**
 * @param {Voice} voice
 * @param {string} lang a language tag or its primary subtag (`ru`, `en-US`)
 * @returns {boolean} whether the voice speaks the language
 */
export function speaksLanguage(voice, lang) {
    const tag = voice.lang.toLowerCase().replace('_', '-');
    // Norwegian: nb_NO of the systems, no_NO of Piper
    return !!lang && (tag.startsWith(lang.toLowerCase()) || (lang.toLowerCase() === 'nb' && tag.startsWith('no')));
}

/**
 * The best voice of a language: of the checked voices when one of them speaks it, else of all
 * voices; the higher score first, then by name.
 * @param {Voice[]} voices
 * @param {string} lang
 * @param {string[]} [checked] names of the checked voices
 * @returns {string} the name of the voice ('' : no voice speaks it, the engine picks)
 */
export function pickVoice(voices, lang, checked = []) {
    const best = list => list.filter(voice => speaksLanguage(voice, lang))
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.name.localeCompare(b.name))[0]?.name;
    const chosen = new Set(checked);
    return best(voices.filter(voice => chosen.has(voice.name))) ?? best(voices) ?? '';
}
