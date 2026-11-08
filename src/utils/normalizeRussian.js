/** @typedef {import('./EnglishReading').EnglishReading} EnglishReading */

/*
 * A port of normalize.py of claude-ai (without its RUNorm models): text for a Russian voice —
 * numbers, units, versions, file names and Latin words become Russian words, the stress of English
 * words marked with "+" before the vowel ("updated" -> "апд+эйтид").
 */

/** A letter, a digit or "_": the word characters of Python's regular expressions, Cyrillic too. */
const W = '[\\p{L}\\p{N}_]';
const START = `(?<!${W})`;
const END = `(?!${W})`;

const ONES = {
    m: ['ноль', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'],
    f: ['ноль', 'одна', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'],
};
const TEENS = ['десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'];
const TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
const HUNDREDS = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];
/** Thousands, millions, …: their forms and gender. */
const SCALES = [
    null,
    [['тысяча', 'тысячи', 'тысяч'], 'f'],
    [['миллион', 'миллиона', 'миллионов'], 'm'],
    [['миллиард', 'миллиарда', 'миллиардов'], 'm'],
    [['триллион', 'триллиона', 'триллионов'], 'm'],
];
/** The denominators of decimal fractions: one, two, … digits. */
const FRACTIONS = [null, ['десятая', 'десятых'], ['сотая', 'сотых'], ['тысячная', 'тысячных'], ['десятитысячная', 'десятитысячных'], ['стотысячная', 'стотысячных'], ['миллионная', 'миллионных']];

/** Feminine nouns take "одна" / "две": "двадцать одна тысяча", "две секунды". */
const FEMININE = new Set(['тысяча', 'минута', 'секунда', 'миллисекунда']);
const UNITS = new Map(Object.entries({
    'ТБ': ['терабайт', 'терабайта', 'терабайт'], TB: ['терабайт', 'терабайта', 'терабайт'],
    'ГБ': ['гигабайт', 'гигабайта', 'гигабайт'], GB: ['гигабайт', 'гигабайта', 'гигабайт'],
    'МБ': ['мегабайт', 'мегабайта', 'мегабайт'], MB: ['мегабайт', 'мегабайта', 'мегабайт'],
    'КБ': ['килобайт', 'килобайта', 'килобайт'], KB: ['килобайт', 'килобайта', 'килобайт'],
    'мс': ['миллисекунда', 'миллисекунды', 'миллисекунд'], ms: ['миллисекунда', 'миллисекунды', 'миллисекунд'],
    'сек': ['секунда', 'секунды', 'секунд'], 'мин': ['минута', 'минуты', 'минут'],
    '%': ['процент', 'процента', 'процентов'],
}));
const UNIT_RE = [...UNITS.keys()].sort((a, b) => b.length - a.length).map(unit => unit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
/** 4.7k, 12k, 1.2M, 3B: thousands, millions, billions. */
const MULTIPLIERS = new Map(Object.entries({
    k: ['тысяча', 'тысячи', 'тысяч'], K: ['тысяча', 'тысячи', 'тысяч'],
    M: ['миллион', 'миллиона', 'миллионов'], B: ['миллиард', 'миллиарда', 'миллиардов'],
}));
const EN_MULTIPLIERS = new Map(Object.entries({ k: 'thousand', K: 'thousand', M: 'million', B: 'billion' }));
const EN_UNITS = new Map(Object.entries({ TB: 'terabytes', GB: 'gigabytes', MB: 'megabytes', KB: 'kilobytes', ms: 'milliseconds' }));

/**
 * Readings that are not plain English pronunciation: names, products and tools ("python" is
 * "пайтон", not CMUdict's "пайсан"), words CMUdict does not know.
 */
const NAMES = new Map(Object.entries({
    claude: 'клод', anthropic: 'антр+опик', opus: '+опус', sonnet: 'с+онэт', haiku: 'х+айку',
    fable: 'ф+эйбл', git: 'гит', github: 'г+итхаб', gitlab: 'г+итлаб', node: 'нод',
    nodejs: 'нод джей эс', docker: 'д+окер', python: 'п+айтон', javascript: 'джаваскр+ипт',
    typescript: 'тайпскр+ипт', json: 'дж+эйсон', yaml: 'ямл', linux: 'л+инукс', macos: 'мак о эс',
    google: 'гугл', chrome: 'хром', safari: 'саф+ари', react: 'ри+экт', vue: 'вью',
    nginx: '+энджин икс', postgres: 'постгр+эс', redis: 'р+эдис', ollama: 'олл+ама',
    silero: 'сил+эро', piper: 'п+айпер', tailscale: 'т+эйлскейл', cloudflare: 'кл+аудфлэр',
    sudo: 'с+удо', tmux: 'ти макс', readme: 'р+идми', localhost: 'л+окалхост', labi: 'л+аби',
    devbox: 'д+эвбокс', macbook: 'м+экбук', iphone: '+айфон', wifi: 'вайф+ай', usb: 'ю эс би',
    http: 'эйч ти ти пи', https: 'эйч ти ти пи эс', www: 'дабл ю дабл ю дабл ю', api: 'эй пи +ай',
    id: 'ай д+и', io: 'ай +оу', ok: 'ок+эй', okay: 'ок+эй',
    ffmpeg: 'эф эф эм пэг', npx: 'эн пи икс', pnpm: 'пи эн пи эм', vite: 'вит', webpack: 'в+эбпак',
    kubectl: 'куб контр+ол', homebrew: 'х+оумбру', xterm: 'икс т+эрм', ssh: 'эс эс эйч',
    updated: 'апд+эйт',
}));
/** English function words read in full (CMUdict has their reduced forms: "the" -> "да"). */
const EN_WORDS = new Map(Object.entries({
    the: 'де', a: 'э', an: 'эн', and: 'энд', of: 'ов', to: 'ту', in: 'ин', is: 'из', it: 'ит',
    its: 'итс', "it's": 'итс', for: 'фор', on: 'он', with: 'уиз', this: 'дис', that: 'дэт',
    you: 'ю', i: 'ай', was: 'уоз', are: 'ар', be: 'би', at: 'эт', as: 'эз', or: 'ор',
    by: 'бай', from: 'фром', but: 'бат', not: 'нот', can: 'кэн', will: 'уил', has: 'хэз',
    have: 'хэв', do: 'ду', does: 'даз', if: 'иф', so: 'соу', no: 'ноу', we: 'уи', he: 'хи',
    she: 'ши', they: 'дэй', them: 'дэм', there: 'дэр', then: 'дэн', than: 'дэн', these: 'диз',
    those: 'доуз', my: 'май', your: 'ёр', our: '+ауэр', up: 'ап', all: 'ол', one: 'уан',
}));
/** IT words of Russian speech: inside a Russian sentence they keep their Russian form. */
const RU_TERMS = new Map(Object.entries({
    server: 'сервер', client: 'клиент', file: 'файл', files: 'файлы', index: 'индекс',
    test: 'тест', tests: 'тесты', start: 'старт', stop: 'стоп', master: 'мастер', main: 'мейн',
    commit: 'коммит', push: 'пуш', pull: 'пул', merge: 'мёрдж', branch: 'бранч', build: 'билд',
    deploy: 'деплой', install: 'инст+олл', run: 'ран', dev: 'дэв', config: 'к+онфиг', env: 'энв',
    cache: 'кэш', token: 'т+окен', tokens: 'т+окены', status: 'ст+атус', port: 'порт', host: 'хост',
    code: 'код', class: 'класс', method: 'м+етод', import: 'имп+орт', export: 'эксп+орт',
    script: 'скрипт', package: 'пак+ет', browser: 'бр+аузер', session: 'с+ессия', plan: 'план',
    bash: 'баш', shell: 'шелл', grep: 'греп', sed: 'сед', curl: 'кёрл', make: 'мейк', cat: 'кэт',
    touch: 'тач', app: 'апп', lib: 'либ', src: 'сорс', web: 'веб', box: 'бокс',
    workflow: 'в+оркфлоу', brew: 'бру', electron: 'электр+он', monaco: 'мон+ако', mac: 'мак',
    origin: '+ориджин', docs: 'доки', repo: 'р+эпо',
}));
const LETTERS = new Map(Object.entries({
    a: 'эй', b: 'би', c: 'си', d: 'ди', e: 'и', f: 'эф', g: 'джи', h: 'эйч', i: 'ай',
    j: 'джей', k: 'кей', l: 'эл', m: 'эм', n: 'эн', o: 'оу', p: 'пи', q: 'кью', r: 'ар',
    s: 'эс', t: 'ти', u: 'ю', v: 'ви', w: 'дабл ю', x: 'икс', y: 'уай', z: 'зед',
}));
/** Rough English reading rules, longest first: good enough to be recognizable. */
const RULES = [
    ['tion', 'шн'], ['sion', 'жн'], ['ture', 'чер'], ['ough', 'оф'], ['ight', 'айт'],
    ['sch', 'ск'], ['tch', 'ч'], ['che', 'че'], ['sh', 'ш'], ['ch', 'ч'], ['th', 'т'], ['ph', 'ф'],
    ['wh', 'в'], ['ck', 'к'], ['ng', 'нг'], ['qu', 'кв'], ['kn', 'н'], ['wr', 'р'],
    ['ee', 'и'], ['ea', 'и'], ['oo', 'у'], ['ou', 'ау'], ['ow', 'оу'], ['ai', 'ей'], ['ay', 'ей'],
    ['ey', 'ей'], ['oi', 'ой'], ['oy', 'ой'], ['au', 'о'], ['aw', 'о'], ['ie', 'и'], ['ue', 'ю'],
    ['er', 'ер'], ['ir', 'ёр'], ['ur', 'ёр'], ['or', 'ор'], ['ar', 'ар'],
    ['a', 'а'], ['b', 'б'], ['c', 'к'], ['d', 'д'], ['e', 'е'], ['f', 'ф'], ['g', 'г'], ['h', 'х'],
    ['i', 'и'], ['j', 'дж'], ['k', 'к'], ['l', 'л'], ['m', 'м'], ['n', 'н'], ['o', 'о'], ['p', 'п'],
    ['q', 'к'], ['r', 'р'], ['s', 'с'], ['t', 'т'], ['u', 'а'], ['v', 'в'], ['w', 'в'], ['x', 'кс'],
    ['y', 'и'], ['z', 'з'],
];
const SYMBOLS = new Map(Object.entries({
    '&': ' и ', '+': ' плюс ', '=': ' равно ', '@': ' собака ', '#': ' решётка ', '№': ' номер ',
    '→': ' — ', '->': ' — ', '=>': ' — ', '≈': ' примерно ', '~': ' примерно ', '×': ' на ',
}));
/** The dot before a file extension (server.js, Выборы 2004.mp3, index.html). */
const EXT_DOT = new RegExp(`(?<=${W})\\.(?=[A-Za-z][A-Za-z0-9]{0,4}${END})`, 'gu');

const EN_ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const EN_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const EN_SCALES = ['', 'thousand', 'million', 'billion', 'trillion'];

/**
 * @param {number | string} n
 * @param {string[]} forms (1 файл, 2 файла, 5 файлов)
 * @returns {string} the Russian plural form for n
 */
function plural(n, forms) {
    const rest = Math.abs(Number.parseInt(String(n), 10)) % 100;
    if (rest >= 11 && rest <= 19) return forms[2];
    const last = rest % 10;
    return last === 1 ? forms[0] : last >= 2 && last <= 4 ? forms[1] : forms[2];
}

/**
 * @param {number} n below 1000
 * @param {'m' | 'f'} gender
 * @returns {string[]}
 */
function hundredsWords(n, gender) {
    const words = [];
    if (n >= 100) words.push(HUNDREDS[Math.floor(n / 100)]);
    const rest = n % 100;
    if (rest >= 10 && rest < 20) words.push(TEENS[rest - 10]);
    else {
        if (rest >= 20) words.push(TENS[Math.floor(rest / 10)]);
        if (rest % 10) words.push(ONES[gender][rest % 10]);
    }
    return words;
}

/**
 * @param {string} digits
 * @param {'m' | 'f'} [gender]
 * @returns {string} a whole number in Russian words; long ids and zero-padded codes digit by digit
 */
function russianInteger(digits, gender = 'm') {
    if (digits.length > 15 || (digits.length > 1 && digits.startsWith('0'))) return [...digits].map(digit => ONES.m[Number(digit)]).join(' ');
    let n = Number(digits);
    if (!n) return ONES.m[0];
    const words = [];
    for (let scale = 0; n > 0; scale++, n = Math.floor(n / 1000)) {
        const group = n % 1000;
        if (!group) continue;
        const [forms, scaleGender] = SCALES[scale] ?? [null, 'm'];
        words.unshift(...hundredsWords(group, scale ? scaleGender : gender), ...(forms ? [plural(group, forms)] : []));
    }
    return words.join(' ');
}

/**
 * @param {string} whole
 * @param {string} fraction its digits
 * @returns {string} a decimal in Russian words: "четыре целых семь десятых"
 */
function russianDecimal(whole, fraction) {
    const digits = fraction.replace(/0+$/, '');
    const denominator = FRACTIONS[digits.length];
    if (!denominator) return `${russianInteger(whole)} точка ${[...fraction].map(digit => ONES.m[Number(digit)]).join(' ')}`;
    const wholeWord = plural(whole, ['целая', 'целых', 'целых']);
    const fractionNoun = plural(digits, [denominator[0], denominator[1], denominator[1]]);
    return `${russianInteger(whole, 'f')} ${wholeWord} ${russianInteger(String(Number(digits)), 'f')} ${fractionNoun}`;
}

/**
 * @param {string} number "12", "4.7"
 * @param {string[]} forms of its noun
 * @returns {string} a quantity with its noun: "двенадцать тысяч", "четыре целых семь десятых тысячи"
 *   (a fraction takes the genitive singular); a zero fraction ("2.0") is a whole number
 */
function amount(number, forms) {
    const [whole, fraction = ''] = number.replace(',', '.').split('.');
    if (/[1-9]/.test(fraction)) return `${russianDecimal(whole, fraction)} ${forms[1]}`;
    return `${russianInteger(whole, FEMININE.has(forms[0]) ? 'f' : 'm')} ${plural(whole, forms)}`;
}

/**
 * @param {number} n
 * @returns {string} a whole number in English words ("three thousand four hundred and forty three")
 */
function englishInteger(n) {
    if (!n) return EN_ONES[0];
    const below100 = rest => (rest < 20 ? EN_ONES[rest] : `${EN_TENS[Math.floor(rest / 10)]}${rest % 10 ? ` ${EN_ONES[rest % 10]}` : ''}`);
    const below1000 = (group) => {
        const rest = group % 100;
        const hundreds = Math.floor(group / 100);
        return [hundreds ? `${EN_ONES[hundreds]} hundred` : '', rest ? `${hundreds ? 'and ' : ''}${below100(rest)}` : ''].filter(Boolean).join(' ');
    };
    const words = [];
    for (let scale = 0; n > 0; scale++, n = Math.floor(n / 1000)) {
        if (n % 1000) words.unshift(`${below1000(n % 1000)}${EN_SCALES[scale] ? ` ${EN_SCALES[scale]}` : ''}`);
    }
    return words.join(' ');
}

/**
 * @param {string} number
 * @returns {string} a number in English words: a fraction digit by digit after "point"
 */
function englishNumber(number) {
    const [whole, fraction = ''] = number.split('.');
    const digits = fraction.replace(/0+$/, '');
    return digits ? `${englishInteger(Number(whole))} point ${[...digits].map(digit => EN_ONES[Number(digit)]).join(' ')}` : englishInteger(Number(whole));
}

/**
 * @param {string} text
 * @returns {string} its numbers in Russian words, in the nominative
 */
function numbers(text) {
    // A decimal or a number with a multiplier or a unit is a quantity (before the versions below,
    // which would read "4.7" as "четыре точка семь")
    text = text.replace(new RegExp(`${START}(\\d+(?:[.,]\\d+)?)\\s?([kKMB])${END}`, 'gu'), (match, number, unit) => amount(number, MULTIPLIERS.get(unit)));
    text = text.replace(new RegExp(`${START}(\\d+[.,]\\d+)\\s*(${UNIT_RE})${END}`, 'gu'), (match, number, unit) => amount(number, UNITS.get(unit)));
    // Versions and IPs: 2.1, 1.2.3, 100.84.9.76 -> parts joined by "точка"
    text = text.replace(new RegExp(`${START}\\d+(?:\\.\\d+)+${END}`, 'gu'), match => match.split('.').map(part => russianInteger(part)).join(' точка '));
    // A decimal comma without spaces: 2,5 -> "два запятая пять"
    text = text.replace(new RegExp(`${START}(\\d+),(\\d+)${END}`, 'gu'), (match, whole, rest) => `${russianInteger(whole)} запятая ${russianInteger(rest)}`);
    // A number and its unit, agreeing: 15 ГБ -> пятнадцать гигабайт, 3% -> три процента
    text = text.replace(new RegExp(`${START}(\\d+)\\s*(${UNIT_RE})${END}`, 'gu'), (match, number, unit) => {
        const forms = UNITS.get(unit);
        return `${russianInteger(number, FEMININE.has(forms[0]) ? 'f' : 'm')} ${plural(number, forms)}`;
    });
    return text.replace(/\d+/g, match => ` ${russianInteger(match)} `);
}

/**
 * @param {string} text of a sentence that is mostly English
 * @returns {string} its numbers in English words (read through CMUdict like the rest)
 */
function englishNumbers(text) {
    text = text.replace(new RegExp(`${START}(\\d+(?:\\.\\d+)?)\\s?([kKMB])(?![A-Za-z])`, 'gu'), (match, number, unit) => `${englishNumber(number)} ${EN_MULTIPLIERS.get(unit)}`);
    text = text.replace(new RegExp(`${START}(\\d+(?:\\.\\d+)?)\\s*(TB|GB|MB|KB|ms)${END}`, 'gu'), (match, number, unit) => {
        const name = EN_UNITS.get(unit);
        return `${englishNumber(number)} ${number === '1' ? name.slice(0, -1) : name}`;
    });
    text = text.replace(new RegExp(`${START}\\d+(?:\\.\\d+)+${END}`, 'gu'), match => match.split('.').map(part => englishInteger(Number(part))).join(' point '));
    text = text.replace(/(\d+)\s*%/g, (match, number) => `${englishInteger(Number(number))} percent`);
    return text.replace(/\d+/g, match => ` ${englishInteger(Number(match))} `);
}

/**
 * @param {string} word
 * @returns {boolean} whether all its letters are capitals (as Python's str.isupper)
 */
function isUpper(word) {
    return word === word.toUpperCase() && word !== word.toLowerCase();
}

/**
 * @param {string} word
 * @returns {string} spelled letter by letter: "npm" -> "эн пи эм"
 */
function spell(word) {
    return [...word.toLowerCase()].filter(letter => LETTERS.has(letter)).map(letter => LETTERS.get(letter)).join(' ');
}

/**
 * @param {string} word
 * @returns {string} read by the rough English rules
 */
function transliterate(word) {
    let lower = word.toLowerCase();
    // A silent final e: "file"-like words lose it
    if (lower.endsWith('e') && lower.length > 3 && !'aeiou'.includes(lower.at(-2))) lower = lower.slice(0, -1);
    const out = [];
    let index = 0;
    if (lower.startsWith('ex')) {
        out.push('экс');
        index = 2;
    } else if (lower.startsWith('e')) {
        // A Russian initial "е" would sound like "йе"
        out.push('э');
        index = 1;
    }
    while (index < lower.length) {
        const rule = RULES.find(([source]) => lower.startsWith(source, index));
        if (rule) {
            out.push(rule[1]);
            index += rule[0].length;
        } else {
            index++;
        }
    }
    return out.join('');
}

/**
 * @param {string} word Latin
 * @param {boolean} english the sentence is mostly English
 * @param {EnglishReading} reader
 * @returns {string} its Russian reading
 */
function latinWord(word, english, reader) {
    const lower = word.toLowerCase();
    if (NAMES.has(lower)) return NAMES.get(lower);
    if (EN_WORDS.has(lower) && (english || !isUpper(word))) return EN_WORDS.get(lower);
    if (RU_TERMS.has(lower) && !english) return reader.stressLike(lower, RU_TERMS.get(lower));
    const vowels = [...lower].filter(letter => 'aeiouy'.includes(letter)).length;
    // API, CSS, npm, js
    if ((isUpper(word) && word.length <= 5) || !vowels || (word.length <= 2 && !reader.phonemes(lower))) return spell(word);
    return reader.reading(lower) || transliterate(word);
}

/**
 * @param {string} text
 * @param {boolean} english
 * @param {EnglishReading} reader
 * @returns {string} its Latin words read in Russian; camelCase and snake_case as separate words
 */
function latin(text, english, reader) {
    text = text.replace(/(?<=[a-z])(?=[A-Z])/g, ' ');
    text = text.replace(/(?<=[A-Za-z0-9])[_/\\-](?=[A-Za-z0-9])/g, ' ');
    text = text.replace(/’/g, "'");
    return text.replace(/[A-Za-z]+(?:'[A-Za-z]+)*/g, word => latinWord(word, english, reader));
}

/**
 * @param {string} sentence
 * @returns {boolean} whether it is mostly Latin letters (the rule an English voice is picked by)
 */
export function isEnglish(sentence) {
    const cyrillic = (sentence.match(/[А-Яа-яЁё]/g) ?? []).length;
    const latinLetters = (sentence.match(/[A-Za-z]/g) ?? []).length;
    return latinLetters > cyrillic * 2;
}

/**
 * Text for a Russian voice: symbols, numbers, units, versions, file names and Latin words become
 * Russian words — "Версия 2.1, порт 3443, 15 ГБ" -> "Версия два точка один, порт три тысячи
 * четыреста сорок три, пятнадцать гигабайт"; "Claude запускает npm install" -> "клод запускает
 * эн пи эм инст+олл" —, the stress of English words marked with "+" before their vowel.
 * @param {string} text
 * @param {{ reader: EnglishReading, english?: boolean }} options english: the sentence is mostly
 *   English (its numbers are read in English, its words through CMUdict)
 * @returns {string}
 */
export function normalizeRussian(text, { reader, english = false }) {
    for (const symbol of [...SYMBOLS.keys()].sort((a, b) => b.length - a.length)) text = text.split(symbol).join(SYMBOLS.get(symbol));
    text = text.replace(EXT_DOT, ' точка ');
    if (english) text = englishNumbers(text);
    text = latin(numbers(text), english, reader);
    // Other inner dots (README.markdown) would make the voice pause
    text = text.replace(new RegExp(`(?<=${W})\\.(?=${W})`, 'gu'), ' ');
    // Whatever is left would only confuse the voice ("+" is the stress mark now: the symbol became "плюс")
    text = text.replace(/[^\p{L}\p{N}_\s.,!?;:…()«»"'+-]/gu, ' ');
    text = text.replace(/\+(?![аеёиоуыэюяАЕЁИОУЫЭЮЯ])/g, '');
    text = text.replace(/\s+([,.!?;:…])/g, '$1');
    return text.replace(/\s+/g, ' ').trim();
}
