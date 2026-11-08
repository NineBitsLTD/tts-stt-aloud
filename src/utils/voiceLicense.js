/**
 * @typedef {'free' | 'attribution' | 'sharealike' | 'noncommercial' | 'copyleft' | 'custom' | 'unknown'} VoiceLicenseKind
 * @typedef {{ label: string, kind: VoiceLicenseKind, text: string, url: string }} VoiceLicense label: short, for the
 *   list; text: as its card says it; url: of the dataset the voice was trained on
 */

/** The first that matches tells the license (the words are joined by hyphens, in lower case). */
const LICENSE_RULES = [
    [/by-nc-sa/, 'CC BY-NC-SA', 'noncommercial'],
    [/by-nc/, 'CC BY-NC', 'noncommercial'],
    [/non-?commercial/, 'Non-commercial', 'noncommercial'],
    [/agpl/, 'AGPL', 'copyleft'],
    [/\bgpl/, 'GPL', 'copyleft'],
    [/cc0/, 'CC0', 'free'],
    [/public-domain/, 'Public domain', 'free'],
    [/unlicense/, 'Unlicense', 'free'],
    [/by-sa|sharealike|share-alike/, 'CC BY-SA', 'sharealike'],
    [/cc-by|licenses\/by\/|attribution/, 'CC BY', 'attribution'],
    [/apache/, 'Apache-2.0', 'free'],
    [/\bmit\b/, 'MIT', 'free'],
    [/^$|^unknown|^see\b|^see-|^none/, 'Unknown', 'unknown'],
];

/**
 * @param {string} card the text of the `MODEL_CARD` of a voice of Piper ('' : it has none)
 * @returns {VoiceLicense} the license of the dataset it was trained on, as its card states it
 */
export function voiceLicense(card) {
    const text = card.match(/^\W*License\W*:?\s*(.*)$/im)?.[1].trim() ?? '';
    const url = card.match(/^\W*URL\W*:?\s*(\S+)/im)?.[1] ?? '';
    const words = text.toLowerCase().replace(/[\s_]+/g, '-');
    const [, label, kind] = LICENSE_RULES.find(([pattern]) => pattern.test(words)) ?? [null, 'Own terms', 'custom'];
    return { label, kind, text, url };
}
