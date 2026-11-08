import { marked } from 'marked';
import { parse, parseFragment } from 'parse5';
import { phraseSpans } from './phrasesOf';

/**
 * @typedef {'markdown' | 'html' | 'plain' | 'lines'} TextFormat plain: paragraphs parted by blank
 *   lines; lines: every line on its own (source code)
 * @typedef {{ text: string, start: number, end: number }} ReadablePhrase a phrase to speak and the
 *   part of the source it was made from
 * @typedef {{ text: string, offsets: number[] }} TextBlock readable text and, for each of its
 *   characters, where it is in the source
 */

/** Elements whose content is not read (as the preview skips code blocks). */
const SKIPPED_ELEMENTS = new Set(['head', 'script', 'style', 'template', 'noscript', 'pre', 'svg', 'math', 'iframe', 'object', 'embed', 'canvas', 'audio', 'video', 'select', 'textarea', 'datalist']);
/** Elements that part the text around them. */
const BLOCK_ELEMENTS = new Set(['address', 'article', 'aside', 'blockquote', 'body', 'caption', 'center', 'dd', 'details', 'dialog', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'html', 'legend', 'li', 'main', 'menu', 'nav', 'ol', 'p', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul']);
const ENTITY = /^&[#\w]+;/;

/**
 * @param {string} languageId of a text document
 * @returns {TextFormat} how it is made readable
 */
export function formatOfLanguage(languageId) {
    if (languageId === 'markdown' || languageId === 'html') return languageId;
    return languageId === 'plaintext' ? 'plain' : 'lines';
}

/**
 * @param {string} text with no format known (the clipboard)
 * @returns {TextFormat} what its markup looks like
 */
export function guessMarkup(text) {
    if (/<(?:!doctype|html|body|head|div|p|span|a|ul|ol|li|h[1-6]|table|tr|td|br|strong|em|b|i)\b[^>]*>/i.test(text)) return 'html';
    if (/^(?:#{1,6}\s|\s*[-*+]\s|\s*\d+\.\s|>\s|```|~~~)/m.test(text) || /\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\n]+\)|`[^`\n]+`/.test(text)) return 'markdown';
    return 'plain';
}

/**
 * Text as marked sees it (line ends and leading tabs are what it replaces), so that the `raw` of its
 * tokens can be found in it.
 * @param {string} source
 * @returns {{ text: string, toSource: (offset: number) => number }}
 */
function normalized(source) {
    if (!/\r|^ *\t/m.test(source)) return { text: source, toSource: offset => offset };
    const parts = [];
    const origins = [];
    const push = (part, origin) => {
        parts.push(part);
        origins.push(origin);
    };
    let lineStart = true;
    for (let index = 0; index < source.length; index++) {
        const char = source[index];
        if (char === '\r') {
            if (source[index + 1] === '\n') continue;
            push('\n', index);
            lineStart = true;
        } else if (char === '\t' && lineStart) {
            for (let space = 0; space < 4; space++) push(' ', index);
        } else {
            if (char !== ' ') lineStart = char === '\n';
            push(char, index);
        }
    }
    return { text: parts.join(''), toSource: offset => origins[offset] ?? source.length };
}

/**
 * @param {string} value decoded text
 * @param {string} raw the same text in the source (with character references)
 * @param {number} start where raw is
 * @returns {number[]} where each character of value is in the source
 */
function alignedOffsets(value, raw, start) {
    const offsets = [];
    let at = 0;
    for (let index = 0; index < value.length; index++) {
        const entity = raw[at] === '&' ? raw.slice(at, at + 40).match(ENTITY)?.[0] : undefined;
        offsets.push(start + at);
        if (entity) {
            at += entity.length;
            // One reference may be two UTF-16 units (an emoji)
            if (/[\uD800-\uDBFF]/.test(value[index]) && index + 1 < value.length) {
                offsets.push(start + at - entity.length);
                index++;
            }
        } else {
            at++;
        }
    }
    return offsets;
}

/**
 * @param {string} raw text that may hold character references, no markup
 * @returns {string} decoded
 */
function decoded(raw) {
    if (!/&[#\w]+;/.test(raw)) return raw;
    return parseFragment(raw.replace(/</g, '&lt;')).childNodes.map(node => node.value ?? '').join('');
}

/** Blocks of readable text being collected: white space collapsed, each character keeping its place. */
class TextBlocks {

    constructor() {
        /** @type {TextBlock[]} */
        this.blocks = [];
        this._chars = [];
        this._offsets = [];
    }

    /**
     * @param {string} text
     * @param {(index: number) => number} offsetOf where its character is in the source
     */
    add(text, offsetOf) {
        for (let index = 0; index < text.length; index++) {
            const blank = /\s/u.test(text[index]);
            if (blank && (!this._chars.length || this._chars.at(-1) === ' ')) continue;
            this._chars.push(blank ? ' ' : text[index]);
            this._offsets.push(offsetOf(index));
        }
    }

    /**
     * @param {number} offset
     */
    space(offset) {
        this.add(' ', () => offset);
    }

    /** The text so far is one block. */
    flush() {
        if (this._chars.at(-1) === ' ') {
            this._chars.pop();
            this._offsets.pop();
        }
        if (this._chars.length) this.blocks.push({ text: this._chars.join(''), offsets: this._offsets });
        this._chars = [];
        this._offsets = [];
    }
}

/**
 * @param {string} text
 * @param {boolean} byLine every line a block, else the paragraphs parted by blank lines
 * @returns {TextBlock[]}
 */
function plainBlocks(text, byLine) {
    const out = new TextBlocks();
    let start = 0;
    while (start <= text.length) {
        const found = text.indexOf('\n', start);
        const end = found < 0 ? text.length : found;
        const line = text.slice(start, end);
        const lineStart = start;
        if (byLine || !line.trim()) out.flush();
        out.add(line, index => lineStart + index);
        out.space(end);
        start = end + 1;
    }
    out.flush();
    return out.blocks;
}

/**
 * Adds the text of HTML to blocks.
 * @param {string} html
 * @param {number} base where it is in the source
 * @param {TextBlocks} out
 */
function collectHtml(html, base, out) {
    const visit = (node) => {
        if (node.nodeName === '#text') {
            const location = node.sourceCodeLocation;
            if (!location) {
                out.add(node.value, () => base);
                return;
            }
            const offsets = alignedOffsets(node.value, html.slice(location.startOffset, location.endOffset), base + location.startOffset);
            out.add(node.value, index => offsets[index]);
            return;
        }
        const tag = node.tagName;
        if (!tag && !node.childNodes) return;
        if (SKIPPED_ELEMENTS.has(tag)) return;
        if (tag === 'br') {
            out.space(base + (node.sourceCodeLocation?.startOffset ?? 0));
            return;
        }
        const block = BLOCK_ELEMENTS.has(tag);
        if (block) out.flush();
        node.childNodes?.forEach(visit);
        if (block) out.flush();
    };
    visit(parse(html, { sourceCodeLocationInfo: true }));
    out.flush();
}

/**
 * Walks the tokens of marked: their `raw` are searched for in the source from where the last one
 * ended (inside lists and quotes the raw of a block has lost its indentation and `>`, its lines
 * have not).
 */
class MarkdownReader {

    /**
     * @param {string} source
     */
    constructor(source) {
        this._source = source;
        this._cursor = 0;
        this._limit = source.length;
        this._out = new TextBlocks();
    }

    /**
     * @returns {TextBlock[]}
     */
    read() {
        let at = 0;
        for (const token of marked.lexer(this._source, { gfm: true })) {
            const found = this._source.indexOf(token.raw, at);
            if (found >= 0) at = found;
            this._cursor = at;
            this._limit = at + token.raw.length;
            this._block(token);
            this._out.flush();
            at = this._limit;
        }
        return this._out.blocks;
    }

    /**
     * @param {string} needle
     * @returns {number} where it is from the cursor on, the cursor moved past it (-1: not found)
     */
    _place(needle) {
        const at = this._source.indexOf(needle, this._cursor);
        if (at < 0 || at + needle.length > this._limit) return -1;
        this._cursor = at + needle.length;
        return at;
    }

    /**
     * @param {any} token of a block
     */
    _block(token) {
        switch (token.type) {
            case 'heading':
            case 'paragraph':
            case 'text':
                if (token.tokens) this._inline(token.tokens);
                else this._text(token.raw);
                this._out.flush();
                break;
            case 'blockquote':
                token.tokens.forEach(child => this._block(child));
                break;
            case 'list':
                token.items.forEach(item => item.tokens.forEach(child => this._block(child)));
                break;
            case 'table':
                [...token.header, ...token.rows.flat()].forEach((cell) => {
                    this._inline(cell.tokens);
                    this._out.flush();
                });
                break;
            case 'html': {
                const at = this._place(token.raw);
                if (at >= 0) collectHtml(token.raw, at, this._out);
                break;
            }
            default:
                break;
        }
    }

    /**
     * @param {any[]} tokens inline
     */
    _inline(tokens) {
        for (const token of tokens) {
            switch (token.type) {
                case 'text':
                    if (token.tokens) this._inline(token.tokens);
                    else this._text(token.raw);
                    break;
                case 'strong':
                case 'em':
                case 'del':
                    this._inline(token.tokens);
                    break;
                case 'link':
                    // A bare address is not read
                    if (token.raw === token.href || token.raw === `<${token.href}>` || token.text === token.href) this._place(token.raw);
                    else this._inline(token.tokens);
                    break;
                case 'escape': {
                    const at = this._place(token.raw);
                    this._out.add(token.raw.slice(1), () => (at < 0 ? this._cursor : at + 1));
                    break;
                }
                case 'codespan': {
                    const at = this._place(token.raw);
                    const opening = token.raw.match(/^`+/)?.[0].length ?? 0;
                    const inner = token.raw.slice(opening, token.raw.length - opening);
                    this._out.add(inner, index => (at < 0 ? this._cursor : at + opening + index));
                    break;
                }
                case 'br':
                    this._out.space(this._cursor);
                    break;
                default:
                    if (token.raw) this._place(token.raw);
                    break;
            }
        }
    }

    /**
     * @param {string} raw plain text of the source, of one or several lines
     */
    _text(raw) {
        raw.split('\n').forEach((line, index) => {
            if (index) this._out.space(this._cursor);
            const content = line.trim();
            // The spaces at its ends part it from the bold or code next to it
            if (/^\s/u.test(line)) this._out.space(this._cursor);
            if (content) this._content(content);
            if (content && /\s$/u.test(line)) this._out.space(this._cursor);
        });
    }

    /**
     * @param {string} content a line of text without the white space at its ends
     */
    _content(content) {
        const at = this._place(content);
        const value = decoded(content);
        if (at < 0) {
            this._out.add(value, () => this._cursor);
            return;
        }
        const offsets = value === content ? null : alignedOffsets(value, content, at);
        this._out.add(value, position => (offsets ? offsets[position] : at + position));
    }
}

/**
 * @param {string} text normalized
 * @param {TextFormat} format
 * @returns {TextBlock[]}
 */
function blocksOf(text, format) {
    if (format === 'markdown') return new MarkdownReader(text).read();
    if (format === 'html') {
        const out = new TextBlocks();
        collectHtml(text, 0, out);
        return out.blocks;
    }
    return plainBlocks(text, format === 'lines');
}

/**
 * Text as it is read aloud: Markdown and HTML become plain readable text (no markup, addresses or
 * code blocks, as in the preview), split into phrases, each knowing the part of the source it came from.
 * @param {string} source
 * @param {TextFormat} format
 * @param {number} [base] where the source begins in its document
 * @returns {ReadablePhrase[]}
 */
export function readablePhrases(source, format, base = 0) {
    const { text, toSource } = normalized(source);
    return blocksOf(text, format).flatMap(({ text: block, offsets }) => phraseSpans(block).map(span => ({
        text: span.text,
        start: base + toSource(offsets[span.start]),
        end: base + toSource(offsets[span.end - 1]) + 1,
    })));
}
