/**
 * Runs inside the Markdown preview of VS Code (`markdown.previewScripts`): marks the block being read
 * aloud and scrolls to it. An extension cannot post to that preview, and the one message it can
 * cause (`_markdown.copyImage`) brings the preview to the front, so `PreviewHighlight` writes what is
 * read into a style sheet next to this script and the preview looks at it: often while its own file
 * is read, seldom otherwise.
 */
const MARK = 'tts-stt-aloud-reading';
const VARIABLE = '--tts-stt-aloud-reading';
const READING_INTERVAL = 300;
const IDLE_INTERVAL = 2000;
/** A state older than this was left by a window that is gone (ms). */
const STALE_AFTER = 15 * 60 * 1000;
const stateUrl = new URL('preview-reading-state.css', /** @type {HTMLScriptElement} */ (document.currentScript).src).href;

/** @type {HTMLLinkElement | null} */
let sheet = null;
/** the line of the source being read (-1: none) */
let reading = -1;
/** whether the file of this preview is being read (what it reads is announced first, with no line) */
let active = false;

/** @returns {string} the address of the file this preview shows */
function previewSource() {
    try {
        return JSON.parse(document.getElementById('vscode-markdown-preview-data').getAttribute('data-settings')).source;
    } catch {
        return '';
    }
}

/**
 * @returns {{ source: string, line: number, time: number } | null} what is being read
 */
function readState() {
    const value = getComputedStyle(document.documentElement).getPropertyValue(VARIABLE).trim().slice(1, -1);
    if (!value) return null;
    try {
        return JSON.parse(decodeURIComponent(value));
    } catch {
        return null;
    }
}

/**
 * @param {number} line of the source
 * @returns {HTMLElement | null} the block it is in: the last that begins at it or before it
 */
function blockAt(line) {
    let block = null;
    for (const element of document.getElementsByClassName('code-line')) {
        const begins = Number(element.getAttribute('data-line'));
        if (Number.isNaN(begins) || begins > line || element.tagName === 'UL' || element.tagName === 'OL') continue;
        block = element.tagName === 'CODE' && element.parentElement?.tagName === 'PRE' ? element.parentElement : element;
    }
    return /** @type {HTMLElement | null} */ (block);
}

/**
 * @param {boolean} reveal scroll to the block when it is out of sight
 */
function mark(reveal) {
    const block = reading >= 0 ? blockAt(reading) : null;
    for (const marked of [...document.getElementsByClassName(MARK)]) {
        if (marked !== block) marked.classList.remove(MARK);
    }
    if (!block) return;
    block.classList.add(MARK);
    const { top, bottom } = block.getBoundingClientRect();
    if (reveal && (top < 0 || bottom > window.innerHeight)) block.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/** The state was loaded: the mark follows it. */
function applyState() {
    const state = readState();
    active = !!state && state.source === previewSource() && Date.now() - state.time < STALE_AFTER;
    const line = active ? state.line : -1;
    if (line === reading) return;
    reading = line;
    mark(true);
}

/**
 * The style sheet is loaded again (its address stays the same: VS Code asks whether the file changed).
 */
function look() {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = stateUrl;
    const next = () => setTimeout(look, active ? READING_INTERVAL : IDLE_INTERVAL);
    link.onload = () => {
        applyState();
        sheet?.remove();
        sheet = link;
        next();
    };
    link.onerror = () => {
        link.remove();
        next();
    };
    document.head.append(link);
}

// An edit of the file puts new content into the preview
window.addEventListener('vscode.markdown.updateContent', () => mark(false));
look();
