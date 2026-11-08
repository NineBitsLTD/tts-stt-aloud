/** The translations of the interface, put into the page by the host (`vscode.l10n.bundle`; none: English). */
const bundle = /** @type {Record<string, string>} */ (/** @type {any} */ (globalThis).speechBundle ?? {});

/**
 * @param {number} value
 * @param {number} digits after the decimal mark
 * @returns {string} the number as the language of VS Code writes it (0,4 in Russian)
 */
export function fixed(value, digits) {
    return value.toLocaleString(document.documentElement.lang || 'en', { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false });
}

/**
 * @param {string} message in English, with `{0}`, `{1}` … for its values
 * @param {...(string | number)} values
 * @returns {string} in the language of VS Code
 */
export function t(message, ...values) {
    return (bundle[message] ?? message).replace(/\{(\d+)\}/g, (placeholder, index) => String(values[Number(index)] ?? placeholder));
}
