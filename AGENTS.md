# AGENTS.md

Guidelines for AI agents (Claude, Gemini, GPT, Codex, etc.)

## Overview

VS Code extension **TTS / STT MD Aloud** (`tts-stt-md-aloud`), moved out of babylon-editor (`../babylon-editor`). It contributes:
- A **Markdown preview** (`tts-stt-md-aloud.preview`, a custom text editor of `*.md` / `*.markdown` with priority `option`, so the files open as text; "Open Preview (Translate, Read Aloud)" in the editor title of the text — a sheet with a lens, `resources/open-preview-*.svg` — and "Open as Raw Markdown" in the preview, each replacing the active tab: `MarkdownPreview.open` / `openRaw`; both views edit one text document, so unsaved changes stay): `src/components/MarkdownPreview.js` sends the text live (150 ms after an edit) and the Markdown files of its folder (the file name is left to the tab and the breadcrumbs); the webview (`src/markdown.js` → `dist/js/markdown.js`, `src/scss/markdown.scss`) renders it as the labi.one docs viewer does — `MarkdownView`: GitHub flavoured `marked`, `DOMPurify`, `highlight.js` (token colors for light / dark themes), headings with GitHub anchors, relative images through a `<base>` of the folder; a click on `#…` scrolls, other links go to the host (`openLink`: web / mail addresses in the browser, a Markdown file in this preview, a folder in the Explorer, other files in their editor) —; the header has DEF / RU / UA / EN (`PreviewTranslation`, as the claude-ai preview: the text nodes translated in place — code, `translate="no"` and `.notranslate` skipped —, cached per text, the language kept in the webview state; a language model of VS Code translates through the host — `vscode.lm`, batches of 60 texts / 8000 characters, a JSON array in and out —, without one Chrome's on-device Translator (the source language by `LanguageDetector`, else by its letters — `guessLanguage`: English when Latin letters are more than twice the Cyrillic ones, else Russian, Ukrainian with its own letters), else an error in the header), reading aloud (`ReadAloud`, as the claude-ai preview: the shown text phrase by phrase — blocks split into sentences, code skipped —, the block read highlighted and scrolled to, back / pause / on, the time read and an estimate before; it speaks through the host — `TextToSpeech`, the active drivers, volume and speed of the speech settings, their voices in one select with their drivers, the phrase to come sent as `next` to be rendered ahead —, with the voices of the webview — `speechSynthesis` — only when the drivers have none; in Auto each phrase in the best voice of its language — of the translation when one is shown; the checked voices first, then by quality: `pickVoice` —, else the chosen voice; the key of the voice kept in `globalState` — `ttsSttMdAloud.reading` —, the speed is `ttsSttMdAloud.tts.rate`; hidden while TTS is off; stopped when another speech begins), a back to the top button.
- A **formatted view of `.json` / `.jsonc` files** (`tts-stt-md-aloud.openFormattedJson`, "Open Formatted JSON", a button in the editor title of the raw text; back with `tts-stt-md-aloud.openRawJson`, each replacing the active tab — not while the tab it replaces has unsaved changes): `src/components/JsonFormattedView.js` is a `FileSystemProvider` for the `json-formatted` scheme (`json-formatted:<path>?<real file uri>`) that serves the file formatted (`formatJson`, indented as the editor indents JSON; JSONC comments and trailing commas left out — `stripJsonc`; a text that is not valid JSON as it is) and saves it compact (`minifyJson`, also without comments; these change only the whitespace outside of strings, so numbers keep their form; a line break at the end when the file had one) after a modal warning once per file and session; text that is not valid JSON is not saved. A change of the file shows in the view (`watch`). The raw text stays the default editor of `.json` files and saves the file as it is. babylon-editor keeps the same view for its model files (`.babylon`, `.gltf`, `.gltf2`) under its own scheme `babylon-json`.
- **Speech settings for all of VS Code** — a speaker in the activity bar (`viewsContainers` `tts-stt-md-aloud`, icon `resources/speaker.svg`) opens the webview view `tts-stt-md-aloud.speech` (`src/components/SpeechPanel.js`; webview `src/speech.js` → `dist/js/speech.js`, `src/speech/`, `src/scss/speech.scss`). The settings are those of VS Code (`contributes.configuration`, `ttsSttMdAloud.tts.*` / `ttsSttMdAloud.stt.*`, scope `application`, written to the user settings), so any extension reads them; `SpeechSettings` checks them as it reads them (ranges; a driver no longer offered: TTS System, STT the first offered) and keeps the keys of external servers in the secret storage (`context.secrets`). Sections:
  - **TTS** — an on / off switch by the title; Volume (0–100 % of the volume set on the computer: `AudioPlayer` scales the samples, the system volume is not touched); Speed (0.5–2×, also the speed of the preview); a level meter of the sound played (the host sends the levels of each sound as it starts — `WavAudio.levels`, 50 ms each); **Drivers** (a drop-down with check boxes — `DriverPicker` — of System and the drivers offered: the checked ones speak together, `ttsSttMdAloud.tts.activeDrivers`, at least one stays checked; the `tts.driver` of 1.x is read as the only one until the list is set; a driver no longer offered leaves it); **Add driver** unfolds check boxes — Piper, Silero, the external servers with × to remove them (asked in a modal); under Piper, while it is checked, its voice models for sherpa-onnx — the engine chosen for Piper (`PiperModels`, `ttsSttMdAloud.tts.models.piper`: `.onnx` files — the name, the language, the size or "from the disk", a warning when the file is missing or the model is not prepared for sherpa-onnx; × removes one after asking: one of the storage with its folder, one used where it is only from the list) and **Add voice model** (a `<dialog>`: a file on the disk — Browse… opens the open dialog of VS Code; one prepared for sherpa-onnx — `readSherpaMeta` reads ModelProto.metadata_props from the last 4 KB: `model_type`, `comment` = piper, …; `tokens.txt` next to it — is used where it is, a model of Piper with its `.onnx.json` next to it is copied into `piper/<name>/` and prepared there like a download (the file on the disk stays as it is, nothing is written next to it: `tokens.txt` has one name a folder), one without either is refused; a note in the dialog says so — or a voice of the catalog of rhasspy/piper-voices on Hugging Face — `voices.json`, filtered by name or language, the voices added are shown but cannot be chosen — downloaded into `globalStorageUri/piper/<voice>/` and prepared there as the script of sherpa-onnx prepares it: its metadata appended to the model — `sherpaMetaOf`, `encodeMeta`; byte for byte the sherpa-onnx model of ru_RU-irina-medium, while sherpa-onnx's own models of some languages say `language: English` —, `tokens.txt` from the config by id — `tokensOf` —; the progress is in a notification that can cancel it and in the list meanwhile — a spinner and the bytes written of the total, "12.3 of 99.0 MB" / "0.45 of 1.70 GB", downloading or preparing in its tooltip: `ModelStore.onProgress`, 4 times a second at most, posted as `modelProgress` and shown in the line of the model only —; OK / Cancel) — and **Add External** (a `<dialog>`: name, address, key; Add / Cancel; the host refuses a name in use or an address that is not http(s)); a drop-down of the voices of the active drivers with check boxes — each with its driver, keyed `<driver>:<name>`; the checked ones (`ttsSttMdAloud.tts.voices`, by driver) are picked by Auto and offered to other extensions; the one chosen (`ttsSttMdAloud.tts.voice`, a key) is the voice of **Test voice** (the phrase `say -v ?` gives for it, else one of its language).
  - **STT** — an on / off switch: whether other extensions may record the microphone (it does not turn the microphone on); Mic (gain 0–200 %, applied to the samples recorded); a level meter of the microphone while it records (for the test or another extension) and of the recording played; the driver (Whisper — offered from the start: `stt.drivers` defaults to it —, external servers; no System driver: VS Code may not use the speech recognition of macOS — its Info.plist does not ask for it —; none offered: "None", nothing recognized; Add driver / Add External as in TTS; under Whisper, while it is checked, its models and **Add model** — the same block and dialog as the voice models of Piper, `WhisperModels`, `ttsSttMdAloud.stt.models.whisper`); with Whisper, **Model** (the ready models, `ttsSttMdAloud.stt.model`; English-only ones say so) and **Language** (`ttsSttMdAloud.stt.language`: Auto — Whisper detects it —, "As VS Code" — `ui`, the language of `vscode.env.language` —, or a language of the model chosen, from its metadata `all_language_codes`, Russian / Ukrainian / English first, named by `Intl.DisplayNames`); **Test microphone** (works while STT is off too): records speech — waits 5 s for it to begin, records it until 1 s of silence, 10 s at most; Stop keeps what was recorded —, keeps it in the storage of the extension (`globalStorageUri/stt-test.wav`, removed as the next test begins), plays it at the volume of TTS (the speech being spoken stops first) while it is recognized, and shows the text recognized below with its language (else why not: no recognizer, nothing recognized). The microphone is recorded by the host (`MicRecorder`: `sox`, else `ffmpeg` — AVFoundation / DirectShow / PulseAudio —, else `arecord`, 16 kHz mono; the webviews of VS Code get no microphone); `SpeechDetector` finds the speech by its level (the noise floor is the quietest 50 ms heard while waiting, at most -40 dBFS; loud is 12 dB above it, at least -45 dBFS; the speech begins with 3 loud windows of 4, 300 ms before it and after it are kept).
  - Several drivers speak together: `TextToSpeech.voices()` gives the voices of the active drivers that can speak (`status()`: which cannot, and why — the note of the section), a phrase is spoken by the driver of its voice — the voice given (a key, or a name), else the best of its language (`pickVoice` over the keys): a checked one first, then by quality — 2 Enhanced / Premium system voices, 1 Piper, 0 other system voices —, else the first driver that can speak with its own choice.
  - Drivers that speak: System (`SystemSpeech`: macOS `say -o` and Windows `System.Speech` render each phrase to WAV, played by `AudioPlayer` — `afplay`, PowerShell `SoundPlayer`, `paplay` / `aplay`; Linux `spd-say` speaks itself, `-i` volume, no level meter) and Piper (`PiperSpeech`, available when the runtime is in the build and a model is ready: its voices are the models, named by their files, with the language of their config). Piper speaks through **sherpa-onnx 2.x** (`sherpa-onnx-node`, a native addon — 2.x has no espeak-ng and takes phonemes: `generationConfig.phonemeCodepoints`) and **piper-phonemize** (espeak-ng compiled to WASM with its `espeak-ng-data`, by the author of sherpa-onnx; GPL-3.0-or-later): the text becomes phonemes for the espeak-ng voice of the model (its metadata `voice`), a Russian text normalized first by `normalizeRussian` — a port of normalize.py of claude-ai, identical output without its RUNorm models: symbols, numbers, units, versions, file names and Latin words become Russian words; English words are read through CMUdict by `EnglishReading` (a port of en2ru.py; `resources/cmudict/cmudict.dict.gz`, BSD-style license next to it) with their stress marked "+" —; espeak-ng takes no stress mark in the text (+, ', U+0301, capitals, all ignored), so `stressMarks` / `applyStress` put the marked stress into its phonemes word by word (the reduced vowel made full: ʌ → o …; words that do not line up are left as espeak-ng made them). sherpa-onnx loads a model asynchronously (two kept), makes the audio asynchronously (`offlineTtsGenerateAsyncWithConfig`, speed = the speed of the settings, `enableExternalBuffer: false` — Electron, the extension host of VS Code, allows no external buffers: with them the addon fails with "TTS settlement failed") — the extension host is not blocked. Silero and external servers can be offered and chosen but do not speak / recognize yet (the section says so).
  - The driver that recognizes: Whisper (`WhisperRecognizer`, through the same addon of sherpa-onnx — `createOfflineRecognizerAsync`, `decodeOfflineStreamAsync`: asynchronous; the recognizer of the last model and language kept loaded): the model chosen, else the first ready one; the language given when the model knows it, else detected (the result says which). A Whisper model is an encoder with its decoder and tokens next to it (`<name>-encoder[.int8].onnx`, `<name>-decoder[.int8].onnx`, `<name>-tokens.txt`, as sherpa-onnx exports them; `readWhisperMeta`: its metadata — `model_type` whisper-…, `is_multilingual`, `all_language_codes`, `n_mels`, the feature dimension given to sherpa-onnx — from the last 64 KB of the encoder): one chosen on the disk (the encoder or the decoder) is used where it is, one of the catalog — the int8 models of csukuangfj/sherpa-onnx-whisper-<model> on Hugging Face: tiny, base, small, medium, turbo, large-v3 — multilingual, 99 languages — and the English-only distil-large-v3, tiny.en, base.en, small.en, distil-small.en, medium.en (`englishOnly`: `.en` and `distil-…` — Distil-Whisper is distilled on English only —, also for a model of that name on the disk, whatever its metadata says; the note under the catalog says so), their sizes from the API of Hugging Face — is downloaded into `whisper/<model>/`. The models of Piper and Whisper share `ModelStore` (the list of the settings, the open dialog, the install into `<driver>/<name>/` with the progress and cancel, the removal). `SpeechToText.recognition()` says whether the driver recognizes (the note of the section), `recognize(wav)` gives `{ text, lang }` (text null: not recognized, `error` why).
  - Other extensions: `activate` returns `{ tts: { voices, speak, stop }, stt: { record, stop }, settings, onDidChangeSettings }` (`voices`: the checked voices of the active drivers — with `key`, `driver`, `driverName` —, all when none is checked; `speak(text, { voice, lang, rate })`: `voice` a key or a name; `record(limits)`: `{ wav, duration, ended, text, lang }` — the text recognized with the Whisper driver, null without it (`error`: why); rejected while STT is off or the microphone is busy; limits `waitMs` / `maxMs` / `silenceMs`); the commands `tts-stt-md-aloud.speak` (text, options), `tts-stt-md-aloud.stopSpeaking`, `tts-stt-md-aloud.voices`, `tts-stt-md-aloud.record` (limits), `tts-stt-md-aloud.stopRecording` (hidden from the Command Palette). One speech and one recording at a time: a new speech ends the one being spoken (`speak` resolves false for the speech ended).

## Commands

```bash
npm run build      # full production build into dist/ (clean → extension → webview → css → codicons)
npm run watch      # build once, then run all watchers concurrently (esbuild --watch + sass)
npm run pack       # scripts/pack.mjs: vsce runs the build (vscode:prepublish), then packs tts-stt-md-aloud-<platform>-<arch>-<version>.vsix for this machine
npx eslint src     # lint (no "lint" npm script)
```

The extension prefers the UI side (`extensionKind`: ui, then workspace): with Remote (SSH, WSL, containers) it runs on the local machine, so the speech, the audio player and the microphone are those of the user; the preview reads the files of the workspace through the API of VS Code either way.

There are no tests yet. To run/debug the extension, launch an Extension Development Host with `--extensionDevelopmentPath` of this folder (a `.vscode/launch.json` "Run Extension" config, see the README; `.vscode/` is gitignored). The entry point is `dist/extension.cjs`, so **build (or watch) before launching**.

## Build architecture

Source is authored as **ESM** (`"type": "module"`) and bundled with **esbuild** into two targets, the runtime of Piper copied next to them:

1. **Extension host** — `src/extension.js` → `dist/extension.cjs` (CJS for Node, `vscode` external): `src/components/` (`MarkdownPreview`, `JsonFormattedView`, `SpeechPanel`, `SpeechSettings`, `TextToSpeech`, `SystemSpeech`, `PiperSpeech`, `AudioPlayer`, `SpeechToText`, `MicRecorder` with `SpeechDetector`, `WhisperRecognizer`, `ModelStore` with `PiperModels` / `WhisperModels`) and `src/utils/` (`createNonce`, `formatJson` with `minifyJson` / `stripJsonc`, `WavAudio` — reads WAV files and their samples, writes 16-bit ones from PCM or float samples —, `pickVoice` — also bundled into the preview —, `normalizeRussian`, `EnglishReading`, `readOnnxMetadata` with `encodeOnnxMetadata`, `loadRuntime` — the runtime in `dist`, loaded once).
3. **The runtime of Piper**, not bundled by esbuild (a native addon, WASM with data files): `scripts/copy-runtime.mjs` (`copy:runtime`, the last step of `build`) copies the addon of sherpa-onnx for this machine with its libraries (`node_modules/sherpa-onnx-<platform>-<arch>` → `dist/native/`) and piper-phonemize (`dist/piper-phonemize/`, with a `package.json` of `"type": "commonjs"` — the project is a module); `loadRuntime` loads them with `createRequire` next to `dist/extension.cjs` (`PiperSpeech`, `WhisperRecognizer`). `npm install` installs the addon of the machine only (optional dependencies), so a VSIX holds the addon of the machine it is packed on: `scripts/pack.mjs` packs it with `vsce --target <platform>-<arch>` (darwin-arm64 / x64, linux-arm64 / x64, win32-arm64 / x64); a build on a machine sherpa-onnx has no addon for warns and leaves Piper out. The addon behaves differently in Node and in the extension host (Electron: no external buffers; on macOS the main `Code` binary refuses libraries of other teams, the extension host — `Code Helper (Plugin)`, `disable-library-validation` — loads them), so check native code in the extension host or in its binary as Node: `ELECTRON_RUN_AS_NODE=1 "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)" script.js`.
2. **Webviews** (browser) — `src/markdown.js` → `dist/js/markdown.js`, the preview: `src/markdown/` (`MarkdownView`, `PreviewTranslation`, `ReadAloud`, `HostRequests` — webview → host requests answered by `{ type: 'hostReply', requestId, result | error }`, used by both webviews); `src/speech.js` → `dist/js/speech.js`, the speech side bar: `src/speech/` (`SpeechSection` with its level meter, `VoicePicker`, `DriverPicker`, `ServerDialog`, `ModelDialog`, `createElement`).

The webview pages are template strings of `MarkdownPreview._html` and `SpeechPanel._html` with a Content Security Policy: scripts only by nonce, styles from the extension and inline (the preview: images from the extension, the workspace / folder of the document, `https:` and `data:`); they load `dist/codicons/codicon.css` (`copy:codicons`) and `dist/css/markdown.css` / `dist/css/speech.css`. SCSS in `src/scss/` is compiled by `sass`, then bundled by esbuild into `dist/css/`.

Preview messages: host → webview `markdown` (text, siblings), `reading` (the key of the kept voice and the speech settings: rate, enabled, volume, the active drivers, the keys of the checked voices — sent again when the settings change), `hostReply`; webview → host `ready`, `openLink`, `reading` (voice to keep, rate to the settings), `translate`, `voices`, `speak` (text, options with `next`; replies false when stopped), `stopSpeaking`.

Speech side bar messages: host → webview `state` (settings, drivers, notes, models — by section and driver: the models of Piper and Whisper and those being installed —, `uiLanguage`), `voices` (of the active TTS drivers, keyed), `level` (`levels` of a sound starting — TTS, the STT test recording —, or the microphone `level` now), `micState` (waiting / recording / playing / recognizing / idle, test or another extension, limits), `modelProgress` (section, driver, name, action, done, total: the bytes of a model being installed), `status`, `hostReply`; webview → host `ready`, `update` (section, key, value — TTS `active`: the drivers checked), `driverEnabled`, `voiceChecked` (the key of a voice), `addServer` (reply: why not added), `removeServer`, `test` (section; reply when spoken / for STT `{ heard, duration, ended, text, lang, note }`), `stopTest` (section), `browseModel` (driver; reply: the file chosen), `modelCatalog` (driver; reply: the models of the catalog), `addModel` (driver, path or key; reply: why not added), `removeModel` (driver, path). The host posts only while the view is shown; shown again, the view asks for the state (`ready`).

## Icon

`resources/icon.png` (256 px, the `icon` of package.json; the Marketplace takes no SVG) is made by `swift scripts/make-icon.swift` (macOS, AppKit draws the SVG) from `resources/icon-space.svg` — the icon of the universe page of gw with two stars moved, kept in the package as the source —: turned by -90°, white with a black outline (`ink` / `paper`), its drawn bounds filling a black square with rounded corners (with a margin; nothing is drawn outside it), the label TTS/STT MD in their bottom right corner (right edge at the outermost star, bottom level with the big star on the left). babylon-editor has the same picture with the label BABYLON.

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