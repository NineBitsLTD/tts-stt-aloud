/** How much of a text its language is told by. */
const SAMPLE_LENGTH = 4000;
/** Scripts that tell the language by themselves. */
const LANGUAGE_OF_SCRIPT = {
    Greek: 'el', Armenian: 'hy', Georgian: 'ka', Hebrew: 'he', Devanagari: 'hi', Bengali: 'bn', Gurmukhi: 'pa', Gujarati: 'gu', Oriya: 'or',
    Tamil: 'ta', Telugu: 'te', Kannada: 'kn', Malayalam: 'ml', Sinhala: 'si', Thai: 'th', Lao: 'lo', Khmer: 'km', Myanmar: 'my', Ethiopic: 'am', Tibetan: 'bo',
};
/** A sign of these scripts says as much as several letters of an alphabet. */
const DENSE_SCRIPTS = new Set(['Han', 'Hiragana', 'Katakana', 'Hangul']);
const SCRIPTS = ['Latin', 'Cyrillic', 'Arabic', ...DENSE_SCRIPTS, ...Object.keys(LANGUAGE_OF_SCRIPT)]
    .map(name => ({ name, pattern: new RegExp(`\\p{Script=${name}}`, 'gu'), weight: DENSE_SCRIPTS.has(name) ? 3 : 1 }));

/** Letters that tell a language written in Cyrillic, the first match wins. */
const CYRILLIC_MARKS = [['mk', /[ѓќѕ]/iu], ['sr', /[ђћјљњџ]/iu], ['kk', /[әғқңұ]/iu], ['mn', /[өү]/iu], ['be', /ў/iu], ['uk', /[іїєґ]/iu]];
const CYRILLIC_LANGUAGES = new Set(['ru', 'bg', ...CYRILLIC_MARKS.map(([lang]) => lang)]);
/** How long a text must be to tell Bulgarian from Russian by the lack of ыэё. */
const BULGARIAN_LENGTH = 200;
/** Letters that tell a language written in the Arabic script, the first match wins. */
const ARABIC_MARKS = [['ur', /[ٹڈڑںے]/u], ['fa', /[پچژگ]/u]];
const ARABIC_LANGUAGES = new Set(['ar', ...ARABIC_MARKS.map(([lang]) => lang)]);

/** The commonest words of the languages written in Latin letters. */
const LATIN_WORDS = {
    en: 'the of and to in is it that for with as on was are this be you not have from by at or an will can',
    de: 'der die das und ist nicht ein eine einer mit für auf von zu den dem des sich auch wird sind im nach bei aus ich sie wir es',
    fr: 'le la les des une un est et dans pour que qui sur avec pas vous nous au aux ce cette sont être il elle du en plus',
    es: 'el la los las del una un es y en que por con para no como se su al lo más pero este esta son',
    it: 'il lo la le gli di che è per un una con non sono del della dei delle nel nella si da come più anche',
    pt: 'o os as um uma de do da dos das em no na que para com não é se por mais como ao sua seu são',
    nl: 'de het een van en is dat op te zijn niet met voor aan er ook als bij naar maar deze',
    pl: 'i w na nie to się jest z do że jak o co ale tak po od dla przez są',
    cs: 'a v na je se že to s z do pro ale jako by si ve o jsou nebo',
    sk: 'a v na je sa že to s z do pre ale ako by si vo o sú alebo',
    ro: 'și în de la cu un o este că pe din pentru nu sunt mai care ce',
    hu: 'a az és egy hogy nem is van ez meg de csak már mint',
    tr: 've bir bu için ile de da çok daha olarak olan gibi en ama',
    sv: 'och i att det som en på är av för med den till inte har jag',
    da: 'og i at det som en på er af for med den til ikke har jeg efter hvad nogle',
    nb: 'og i at det som en på er av for med den til ikke har jeg etter hva noen',
    fi: 'ja on ei että se oli en mutta kun niin hän tämä',
    vi: 'và của là có cho không một những được trong với các',
    id: 'dan yang di ke dari untuk dengan ini itu pada tidak dalam adalah',
    ca: 'el la els les de i que en per amb no un una és del al',
    hr: 'i u je na se da za od su ali kao to',
};
/** Letters that tell (or hint at) the languages written in Latin letters. */
const LATIN_MARKS = {
    de: /[äöüß]/giu, fr: /[âæçèêëîïœûÿ]/giu, es: /[ñ¿¡]/giu, it: /[àèìòù]/giu, pt: /[ãõâêôç]/giu, pl: /[ąćęłńśźż]/giu,
    cs: /[čďěňřšťůž]/giu, sk: /[äčďĺľňôŕšťž]/giu, ro: /[ăâîșşțţ]/giu, hu: /[őű]/giu, tr: /[çğıöşü]/giu, sv: /[åäö]/giu,
    da: /[æøå]/giu, nb: /[æøå]/giu, fi: /[äö]/giu, vi: /[đơư\u1EA0-\u1EF9]/giu, ca: /[àçèïòŀ]/giu, hr: /[čćđšž]/giu,
};
const LATIN_LANGUAGES = new Set(Object.keys(LATIN_WORDS));
/** word -> the languages it is common in */
const LANGUAGES_OF_WORD = new Map();
for (const [lang, words] of Object.entries(LATIN_WORDS)) {
    for (const word of words.split(' ')) LANGUAGES_OF_WORD.set(word, [...(LANGUAGES_OF_WORD.get(word) ?? []), lang]);
}

/**
 * @param {string} sample
 * @returns {string} the script most of its letters are in; a text in another script keeps it among
 *   Latin words, unless they are more than twice its letters ('' : no letters)
 */
function dominantScript(sample) {
    let latin = 0;
    let top = '';
    let topCount = 0;
    for (const { name, pattern, weight } of SCRIPTS) {
        const found = (sample.match(pattern) ?? []).length * weight;
        if (name === 'Latin') latin = found;
        else if (found > topCount) {
            top = name;
            topCount = found;
        }
    }
    if (!latin && !topCount) return '';
    return latin > topCount * 2 ? 'Latin' : top;
}

/**
 * @param {string} sample
 * @param {[string, RegExp][]} marks
 * @returns {string} the language of the first mark found ('' : none)
 */
function markedLanguage(sample, marks) {
    return marks.find(([, pattern]) => pattern.test(sample))?.[0] ?? '';
}

/**
 * @param {string} sample
 * @param {string} fallback
 * @returns {string} by its own letters; Bulgarian takes many ъ and none of ыэё, too little for a phrase
 */
function cyrillicLanguage(sample, fallback) {
    const marked = markedLanguage(sample, CYRILLIC_MARKS);
    if (marked) return marked;
    if (sample.length >= BULGARIAN_LENGTH && (sample.match(/ъ/giu) ?? []).length >= 3 && !/[ыэё]/iu.test(sample)) return 'bg';
    return CYRILLIC_LANGUAGES.has(fallback) ? fallback : 'ru';
}

/**
 * @param {string} sample
 * @param {string} fallback
 * @returns {string}
 */
function arabicLanguage(sample, fallback) {
    return markedLanguage(sample, ARABIC_MARKS) || (ARABIC_LANGUAGES.has(fallback) ? fallback : 'ar');
}

/**
 * @param {string} sample
 * @param {string} fallback
 * @returns {string} the language whose common words and letters it has most of; with too little to
 *   tell (a name, a command, a tie) the fallback when it is written in Latin letters too, else English
 */
function latinLanguage(sample, fallback) {
    const scores = new Map();
    const add = (lang, score) => scores.set(lang, (scores.get(lang) ?? 0) + score);
    for (const word of sample.toLowerCase().match(/\p{L}+/gu) ?? []) LANGUAGES_OF_WORD.get(word)?.forEach(lang => add(lang, 1));
    for (const [lang, pattern] of Object.entries(LATIN_MARKS)) add(lang, (sample.match(pattern) ?? []).length * 2);
    const [[best, score] = ['', 0], [, second] = ['', 0]] = [...scores].sort((a, b) => b[1] - a[1]);
    if (score >= 2 && score > second) return best;
    return LATIN_LANGUAGES.has(fallback) ? fallback : 'en';
}

/**
 * The language of a text by its letters (a script, then the letters and common words of the languages
 * written in it): a phrase has little to tell by, so the language of the whole text helps it.
 * @param {string} text
 * @param {string} [fallback] the language of the text around it; also what is returned when there are no
 *   letters at all
 * @returns {string} a two-letter language code
 */
export function guessLanguage(text, fallback = 'en') {
    const sample = text.slice(0, SAMPLE_LENGTH);
    const script = dominantScript(sample);
    switch (script) {
        case '':
            return fallback;
        case 'Latin':
            return latinLanguage(sample, fallback);
        case 'Cyrillic':
            return cyrillicLanguage(sample, fallback);
        case 'Arabic':
            return arabicLanguage(sample, fallback);
        case 'Han':
            return fallback === 'ja' || /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(sample) ? 'ja' : 'zh';
        case 'Hiragana':
        case 'Katakana':
            return 'ja';
        case 'Hangul':
            return 'ko';
        default:
            return LANGUAGE_OF_SCRIPT[script];
    }
}
