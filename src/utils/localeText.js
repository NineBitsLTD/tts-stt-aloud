import en from '../locales/en.json';
import ru from '../locales/ru.json';
import uk from '../locales/uk.json';

/** The translations of the extension (`src/locales/<language>.json`): a new language is a file listed here. */
const LOCALES = { en, ru, uk };

/**
 * @param {string} lang a language code
 * @returns {boolean} whether the extension has its translations
 */
export function hasLocale(lang) {
    return Object.hasOwn(LOCALES, lang);
}

/**
 * @param {string} lang the language of the text being read
 * @param {string} interfaceLanguage of VS Code (`en`, `zh-cn`)
 * @returns {string} the language to say something about it in: its own, else — the extension has no
 *   translations for it — that of VS Code, else English
 */
export function spokenLocale(lang, interfaceLanguage) {
    if (hasLocale(lang)) return lang;
    const shown = String(interfaceLanguage ?? '').split('-')[0].toLowerCase();
    return hasLocale(shown) ? shown : 'en';
}

/**
 * @param {string} lang a language code
 * @param {string} key of the text
 * @param {Record<string, string | number>} [values] what its `{name}` placeholders become
 * @returns {string} the text in that language, else in English
 */
export function localeText(lang, key, values = {}) {
    const template = LOCALES[lang]?.[key] ?? LOCALES.en[key] ?? key;
    return template.replace(/\{(\w+)\}/g, (placeholder, name) => String(values[name] ?? placeholder));
}
