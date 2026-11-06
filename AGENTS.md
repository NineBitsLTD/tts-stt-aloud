# AGENTS.md

Guidelines for AI agents (Claude, Gemini, GPT, Codex, etc.)

## Overview

VS Code extension **TTS / STT MD Aloud** (`tts-stt-md-aloud`), moved out of babylon-editor (`../babylon-editor`). It contributes:
- A **Markdown preview** (`tts-stt-md-aloud.preview`, a custom text editor of `*.md` / `*.markdown` with priority `option`, so the files open as text; "Open Preview (Translate, Read Aloud)" in the editor title of the text — a sheet with a lens, `resources/open-preview-*.svg` — and "Open as Raw Markdown" in the preview, each replacing the active tab: `MarkdownPreview.open` / `openRaw`; both views edit one text document, so unsaved changes stay): `src/components/MarkdownPreview.js` sends the text live (150 ms after an edit) and the Markdown files of its folder (the file name is left to the tab and the breadcrumbs); the webview (`src/markdown.js` → `dist/js/markdown.js`, `src/scss/markdown.scss`) renders it as the labi.one docs viewer does — `MarkdownView`: GitHub flavoured `marked`, `DOMPurify`, `highlight.js` (token colors for light / dark themes), headings with GitHub anchors, relative images through a `<base>` of the folder; a click on `#…` scrolls, other links go to the host (`openLink`: web / mail addresses in the browser, a Markdown file in this preview, a folder in the Explorer, other files in their editor) —; the header has DEF / RU / UA / EN (`PreviewTranslation`, as the claude-ai preview: the text nodes translated in place — code, `translate="no"` and `.notranslate` skipped —, cached per text, the language kept in the webview state; a language model of VS Code translates through the host — `vscode.lm`, batches of 60 texts / 8000 characters, a JSON array in and out —, without one Chrome's on-device Translator (the source language by `LanguageDetector`, else by its letters — `guessLanguage`: English when Latin letters are more than twice the Cyrillic ones, else Russian, Ukrainian with its own letters), else an error in the header), reading aloud (`ReadAloud`, as the claude-ai preview: the shown text phrase by phrase — blocks split into sentences, code skipped —, the block read highlighted and scrolled to, back / pause / on, the time read and an estimate before; the voices of the webview — `speechSynthesis`, system voices on macOS; "Enhanced" / "Premium" and local voices first —, else those of the operating system through the host — `SystemSpeech`: `say`, PowerShell `System.Speech`, `spd-say`; in Auto each phrase in the best voice of its language — of the translation when one is shown —, else the chosen voice; voice and speed kept in `globalState` — `ttsSttMdAloud.reading`), a back to the top button.
- A **formatted view of `.json` / `.jsonc` files** (`tts-stt-md-aloud.openFormattedJson`, "Open Formatted JSON", a button in the editor title of the raw text; back with `tts-stt-md-aloud.openRawJson`, each replacing the active tab — not while the tab it replaces has unsaved changes): `src/components/JsonFormattedView.js` is a `FileSystemProvider` for the `json-formatted` scheme (`json-formatted:<path>?<real file uri>`) that serves the file formatted (`formatJson`, indented as the editor indents JSON; JSONC comments and trailing commas left out — `stripJsonc`; a text that is not valid JSON as it is) and saves it compact (`minifyJson`, also without comments; these change only the whitespace outside of strings, so numbers keep their form; a line break at the end when the file had one) after a modal warning once per file and session; text that is not valid JSON is not saved. A change of the file shows in the view (`watch`). The raw text stays the default editor of `.json` files and saves the file as it is. babylon-editor keeps the same view for its model files (`.babylon`, `.gltf`, `.gltf2`) under its own scheme `babylon-json`.
- **STT** (speech to text, e.g. dictation into Markdown) is planned, not implemented yet.

## Commands

```bash
npm run build      # full production build into dist/ (clean → extension → webview → css → codicons)
npm run watch      # build once, then run all watchers concurrently (esbuild --watch + sass)
npm run pack       # vsce runs the build (vscode:prepublish), then packs tts-stt-md-aloud-<version>.vsix
npx eslint src     # lint (no "lint" npm script)
```

There are no tests yet. To run/debug the extension, launch an Extension Development Host with `--extensionDevelopmentPath` of this folder (a `.vscode/launch.json` "Run Extension" config, see the README; `.vscode/` is gitignored). The entry point is `dist/extension.cjs`, so **build (or watch) before launching**.

## Build architecture

Source is authored as **ESM** (`"type": "module"`) and bundled with **esbuild** into two targets:

1. **Extension host** — `src/extension.js` → `dist/extension.cjs` (CJS for Node, `vscode` external): `src/components/` (`MarkdownPreview`, `SystemSpeech`, `JsonFormattedView`) and `src/utils/` (`createNonce`, `formatJson` with `minifyJson` / `stripJsonc`).
2. **Preview webview** — `src/markdown.js` → `dist/js/markdown.js` (browser): `src/markdown/` (`MarkdownView`, `PreviewTranslation`, `ReadAloud`, `HostRequests` — webview → host requests answered by `{ type: 'hostReply', requestId, result | error }`).

The webview page is a template string of `MarkdownPreview._html` with a Content Security Policy: scripts only by nonce, styles from the extension and inline, images from the extension, the workspace / folder of the document, `https:` and `data:`; it loads `dist/codicons/codicon.css` (`copy:codicons`) and `dist/css/markdown.css`. SCSS in `src/scss/` is compiled by `sass`, then bundled by esbuild into `dist/css/`.

Messages: host → webview `markdown` (text, siblings), `reading` (kept voice / speed), `hostReply`; webview → host `ready`, `openLink`, `reading` (to keep), `translate`, `voices`, `speak`, `stopSpeaking`.

## Ignored files

`dist/`, `node_modules/`, `.vscode/` and `*.vsix` are gitignored (also macOS `.DS_Store` and the `._*` files exFAT volumes get).

## AI Coding Principles

### 1. Study Existing Code and Reuse Analogues

Before implementing a task, carefully study the surrounding environment and existing codebase.
Find similar implementations, analyze them, and use these analogues as a basis for the current task.

If an analogue contains logic errors, does not handle certain edge cases,
or requires changes to be made universal enough to apply to the current task —
always propose fixes to those existing modules as part of the work.

### 2. Think Beyond the Current Task

Do not strictly limit reasoning to the immediate task.
Analyze adjacent modules and the overall project context to anticipate
how the created modules and their functions may be used in similar cases elsewhere.

### 3. Plan Before Complex Implementation

Before implementing a complex task, always create a plan and analyze it thoroughly multiple times.
Only begin implementation after the plan is approved — execute steps one by one,
verifying each step's result and checking for errors and compliance with the plan.

### 4. Prefer Universality Over Narrow Specificity

Sometimes it is worth sacrificing strict specificity and minimalism in favor of universality.
A more universal solution simplifies future use of the module,
allows it to be applied in different situations,
and eliminates code duplication.

### 5. Modular Code Organization

Write code in a modular way, grouping functionality by entity.
This makes code easier to study, remember, apply, and reuse.

- Do not split code into many tiny files.
- Do not overload methods and files with multiple unrelated responsibilities.
- Each logical block must be written as a separate function.

### 6. Anticipate All Behavioral Scenarios

Identify and account for all possible code behavior scenarios depending on incoming data.
Analyze: empty values, unexpected types, unavailable resources, boundary conditions.
Evaluate each scenario against the current task requirements and expected behavior —
not every edge case requires handling, but every case must be consciously considered.

### 7. Scoped Changes and Controlled Refactoring

Only change what is directly necessary for the current task.
Do not refactor unrelated code along the way — unless it is a pattern used by the current task
or inherits from it. In that case, do not silently refactor it either:
propose the fix for discussion and approval before applying.
Do not add unused abstractions "for the future" —
but design the code being written so that it can naturally be reused in future tasks.

### 8. State Assumptions and Uncertainties Explicitly

Never guess silently. If something is assumed rather than confirmed —
state it explicitly before proceeding.
Flag unclear requirements, ambiguous context, or missing information
so that decisions are made consciously, not accidentally.

### 9. Report All Bugs — Fix Only Task-Related Issues

Report every bug discovered; never ignore or fix them silently.
Inside current task: Fix it immediately.
Outside current task: Report it, pause the current task, and wait for a response before proceeding. Do not apply the fix without explicit approval.

### 10. Naming Conventions — Files vs Identifiers

A file is named after its primary export, using that export's casing:
**PascalCase** for classes/components (`components/MarkdownPreview.js`,
`markdown/ReadAloud.js`), **camelCase** for single-function modules
(`utils/createNonce.js`, `utils/formatJson.js`). Files without a single
named primary export (stylesheets, entry points, infrastructure modules) and
folders use **kebab-case** (`scss/markdown.scss`).
When in doubt, follow the convention already used in the target directory.
Do not rename existing files just to match this rule.

Identifiers in code (variables, functions, types, components, named exports) use
**PascalCase** for types/components/classes and **camelCase** for variables/functions —
matching their JavaScript semantics.

Conventional uppercase markdown files (`README.md`, `AGENTS.md`, `CLAUDE.md`,
`LICENSE.md`) keep their canonical casing.

### 11. No Comments in SCSS

Do not write comments inside `*.scss` files (no `//` and no `/* */`).
The selector tree itself (`.block { &__elem { ... } }`) is the documentation;
class names follow BEM and CSS variables are self-describing. If a rule needs
explanation, the explanation belongs in the component's JSX/markdown, not the
stylesheet. Move existing helpful notes out when you touch surrounding code.

### 12. Group SCSS Selectors by BEM Prefix

Do not write SCSS as a flat list of sibling selectors. Nest sub-elements
inside their parent block using `&-suffix` chains so each "section" collapses
to a single foldable group in the IDE. Apply to every BEM family
(`&__a`, `&__a-b`, `&__a-c` → nest `&-b` and `&-c` inside `&__a`). Modifiers of
the same element (`&--variant`), pseudo-elements (`&::before`), and descendant
overrides (`.card-header` inside the block) all go inside their owning selector —
never as siblings on the root level.