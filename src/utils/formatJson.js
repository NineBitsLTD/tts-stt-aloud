/**
 * JSON text helpers working on the text itself (no parse tree), so numbers keep their form and
 * keys their order: formatting with indentation, compacting, and JSONC (comments, trailing commas)
 * as plain JSON (also in the `collapseBabylon` module of babylon-editor, for model files).
 */

const QUOTE = 34;
const BACKSLASH = 92;

/**
 * @param {string} text
 * @param {number} start index of the opening quote
 * @returns {number} index after the closing quote
 */
function stringEnd(text, start) {
    for (let index = start + 1; index < text.length; index++) {
        const code = text.charCodeAt(index);
        if (code === BACKSLASH) index++;
        else if (code === QUOTE) return index + 1;
    }
    return text.length;
}

/**
 * @param {string} text
 * @param {number} start index of a `/`
 * @returns {number} index after the comment that starts there (JSONC: `// …` up to the end of the
 *   line, `/* … *\/`), or -1 when no comment starts there
 */
function commentEnd(text, start) {
    const next = text[start + 1];
    if (next === '/') {
        const end = text.indexOf('\n', start);
        return end < 0 ? text.length : end;
    }
    if (next === '*') {
        const end = text.indexOf('*/', start + 2);
        return end < 0 ? text.length : end + 2;
    }
    return -1;
}

/**
 * @param {string} text
 * @param {number} start index of `[` or `{`
 * @returns {number} index after the matching bracket
 */
function containerEnd(text, start) {
    let depth = 0;
    for (let index = start; index < text.length; index++) {
        const char = text[index];
        if (char === '"') {
            index = stringEnd(text, index) - 1;
        } else if (char === '/' && commentEnd(text, index) >= 0) {
            index = commentEnd(text, index) - 1;
        } else if (char === '[' || char === '{') {
            depth++;
        } else if (char === ']' || char === '}') {
            depth--;
            if (depth === 0) return index + 1;
        }
    }
    return text.length;
}

/**
 * Pretty-prints JSON text without re-serializing values (numbers keep their exact text).
 * Arrays of primitives stay on one line.
 * @param {string} text
 * @param {string} [indent]
 * @param {string} [prefix] put before every line but the first (to insert the value into indented text)
 * @param {number} [inlineObjects] objects without nested objects whose compact text is at most this
 *   long stay on one line (e.g. animation keys); 0 expands all objects
 * @returns {string}
 */
export function formatJson(text, indent = '  ', prefix = '', inlineObjects = 0) {
    const out = [];
    let depth = 0;
    // Where the last line break written ends: text written after it is on a new line
    let lineStart = -1;
    const newline = () => {
        out.push('\n', prefix, indent.repeat(depth));
        lineStart = out.length;
    };
    // A line break just written is taken back (before a closing bracket, a trailing comment)
    const unline = () => {
        if (lineStart !== out.length) return false;
        out.length -= 3;
        lineStart = -1;
        return true;
    };
    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        if (char === '"') {
            const end = stringEnd(text, index);
            out.push(text.slice(index, end));
            index = end - 1;
        } else if (char === '/' && commentEnd(text, index) >= 0) {
            // JSONC: a comment after a value on its line stays there, others get a line of their own
            const end = commentEnd(text, index);
            if (!startsLine(text, index) && unline()) out.push(' ');
            else if (lineStart !== out.length && out.length) newline();
            out.push(text.slice(index, end));
            newline();
            index = end - 1;
        } else if (char === '{' || char === '[') {
            const end = containerEnd(text, index);
            const inner = text.slice(index + 1, end - 1);
            if (inner.trim() === '') {
                out.push(char, char === '{' ? '}' : ']');
                index = end - 1;
            } else if (char === '[' && isFlat(inner)) {
                out.push('[', compactItems(inner), ']');
                index = end - 1;
            } else if (char === '{' && end - index <= inlineObjects * 2 && isShallow(inner) && compactItems(inner).length <= inlineObjects) {
                out.push('{', compactItems(inner), '}');
                index = end - 1;
            } else {
                out.push(char);
                depth++;
                newline();
            }
        } else if (char === '}' || char === ']') {
            // After a trailing comma or a comment the line break is already there
            unline();
            depth--;
            newline();
            out.push(char);
        } else if (char === ',') {
            out.push(',');
            newline();
        } else if (char === ':') {
            out.push(': ');
        } else if (!/\s/.test(char)) {
            out.push(char);
        }
    }
    return out.join('');
}

/**
 * @param {string} text
 * @param {number} index
 * @returns {boolean} only whitespace is before the index on its line
 */
function startsLine(text, index) {
    for (let before = index - 1; before >= 0; before--) {
        const char = text[before];
        if (char === '\n') return true;
        if (!/\s/.test(char)) return false;
    }
    return true;
}

/**
 * The JSON text without whitespace outside of strings (the values are written as they are: numbers
 * keep their form, keys their order). JSONC comments are not expected: `stripJsonc` first.
 * @param {string} text
 * @returns {string}
 */
export function minifyJson(text) {
    const out = [];
    let from = 0;
    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        if (char === '"') {
            index = stringEnd(text, index) - 1;
        } else if (/\s/.test(char)) {
            out.push(text.slice(from, index));
            from = index + 1;
        }
    }
    out.push(text.slice(from));
    return out.join('');
}

/**
 * JSON with comments and trailing commas (JSONC, as VS Code settings or tsconfig files) as plain
 * JSON text: the comments and the commas before a closing bracket are removed, the rest of the
 * text (values, whitespace) stays as it is.
 * @param {string} text
 * @returns {string}
 */
export function stripJsonc(text) {
    const out = [];
    let from = 0;
    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        if (char === '"') {
            index = stringEnd(text, index) - 1;
        } else if (char === '/' && commentEnd(text, index) >= 0) {
            const end = commentEnd(text, index);
            out.push(text.slice(from, index));
            from = end;
            index = end - 1;
        } else if (char === ',' && closesAfter(text, index + 1)) {
            out.push(text.slice(from, index));
            from = index + 1;
        }
    }
    out.push(text.slice(from));
    return out.join('');
}

/**
 * @param {string} text
 * @param {number} start
 * @returns {boolean} a closing bracket comes next, after whitespace and comments
 */
function closesAfter(text, start) {
    for (let index = start; index < text.length; index++) {
        const char = text[index];
        if (char === '}' || char === ']') return true;
        if (char === '/' && commentEnd(text, index) >= 0) index = commentEnd(text, index) - 1;
        else if (!/\s/.test(char)) return false;
    }
    return false;
}

/**
 * @param {string} inner array content
 * @returns {boolean} whether it has no nested arrays or objects (nor comments, which need lines)
 */
function isFlat(inner) {
    for (let index = 0; index < inner.length; index++) {
        const char = inner[index];
        if (char === '"') index = stringEnd(inner, index) - 1;
        else if (char === '[' || char === '{' || (char === '/' && commentEnd(inner, index) >= 0)) return false;
    }
    return true;
}

/**
 * @param {string} inner object content
 * @returns {boolean} whether it has no nested objects and its arrays are flat
 */
function isShallow(inner) {
    let depth = 0;
    for (let index = 0; index < inner.length; index++) {
        const char = inner[index];
        if (char === '"') index = stringEnd(inner, index) - 1;
        else if (char === '{' || (char === '/' && commentEnd(inner, index) >= 0)) return false;
        else if (char === '[' && ++depth > 1) return false;
        else if (char === ']') depth--;
    }
    return true;
}

/**
 * @param {string} inner content of a flat array or a shallow object
 * @returns {string} items separated by ", " (and keys by ": ")
 */
function compactItems(inner) {
    const out = [];
    for (let index = 0; index < inner.length; index++) {
        const char = inner[index];
        if (char === '"') {
            const end = stringEnd(inner, index);
            out.push(inner.slice(index, end));
            index = end - 1;
        } else if (char === ',') {
            out.push(', ');
        } else if (char === ':') {
            out.push(': ');
        } else if (!/\s/.test(char)) {
            out.push(char);
        }
    }
    // A trailing comma closes the list without a space
    return out.join('').replace(/, $/, ',');
}
