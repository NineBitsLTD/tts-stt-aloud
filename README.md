# TTS / STT MD Aloud

A Visual Studio Code extension that previews Markdown files, translates the preview and reads it aloud with the voices of your system, keeps text to speech settings for all of VS Code in the side bar, and shows JSON files formatted.

## Open source

TTS / STT MD Aloud is an open source project under the [MIT license](LICENSE). Its source code is on GitHub: **[github.com/NineBitsLTD/tts-stt-md-aloud](https://github.com/NineBitsLTD/tts-stt-md-aloud)**.

The requirements and how to install the extension or build it from source are described after the features: [Requirements](#requirements), [Getting started (development)](#getting-started-development), [Packaging and installing](#packaging-and-installing).

## Features

- **Markdown preview** — Markdown files open as text as usual; **Open Preview (Translate, Read Aloud)** in the editor title (a sheet with a lens) shows the preview in the same tab, **Open as Raw Markdown** goes back. The preview follows your edits. It renders GitHub flavoured Markdown (tables, task lists, highlighted code, heading anchors, relative images), lists the other Markdown files of the folder, opens a linked Markdown file in its preview, other files in their editor and web addresses in the browser; ↑ goes back to the top.
- **Translation** — **DEF / RU / UA / EN** in the header translates the shown text in place (code is not translated; DEF is the original). It uses a language model of VS Code (from an installed extension such as GitHub Copilot), else the on-device translator of the browser when it has one. Translations are cached while the preview is open.
- **Reading aloud** — the speaker button reads the shown text (the translation when one is shown) phrase by phrase, highlighting the block being read; back / pause / on, the time read, and an estimate of the time it takes before you start. **Auto** reads each phrase in the best voice of its language (an English name in a Russian text in an English voice), the voices checked in the side bar first; pick a voice instead (remembered). It speaks with the driver, volume and speed of the speech settings — the voices of the operating system (`say` on macOS, `System.Speech` on Windows, `spd-say` on Linux) —, with the voices of VS Code's webview only when the driver has none.
- **Speech settings (side bar)** — the speaker in the activity bar opens the settings of text to speech and speech to text for all of VS Code: they are the VS Code settings `ttsSttMdAloud.tts.*` / `ttsSttMdAloud.stt.*`, so other extensions read them too.
  - **TTS** — on / off by the title; **Volume** of the speech, in % of the volume set on the computer (the system volume is not changed); **Speed** (0.5× – 2×, also the speed of the preview); a **level** meter of the sound being spoken; the **driver** — System, and the drivers added with **Add driver**: Piper, Silero, and external servers added with **Add External** (name, address, key — the key is kept in VS Code's secret storage; × removes a server); under Piper, its **voice models** for [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx), the engine Piper is to speak with — **Add voice model** chooses an `.onnx` file on the disk — a model of sherpa-onnx (vits-piper-…, with `tokens.txt` next to it) is used where it is; a Piper model with its `.onnx.json` next to it is copied into the extension's storage and prepared there, the file stays as it is — or downloads a voice from the [Piper voices](https://huggingface.co/rhasspy/piper-voices) into the extension's storage and prepares it for sherpa-onnx (the progress is in a notification, which can cancel it); × removes a model (a downloaded one with its files); the **voices** of the driver with check boxes — the checked ones are picked automatically for reading aloud and offered to other extensions —, the voice chosen in the list is the one **Test voice** speaks with.
  - **STT** — on / off: whether other extensions may use the microphone (the switch does not turn it on); **Mic** gain; a **level** meter of the microphone while it records; the **driver** — System, Whisper, external servers (Add driver / Add External as in TTS); **Test microphone** — waits 5 s for you to speak, records until you pause for 1 s (10 s at most; Stop ends it), plays the recording back and shows the recognized text below (recognition is not connected yet). The recording of the last test is kept until the next one. The microphone is recorded with [SoX](https://sourceforge.net/projects/sox/) or [FFmpeg](https://ffmpeg.org/) — install one of them —, or `arecord` on Linux; macOS asks once whether VS Code may use the microphone.
  - **Piper** speaks, offline, once a voice model is added: its voices are the models. It runs on [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) (a native module built for the machine the VSIX is packed on) with [piper-phonemize](https://github.com/csukuangfj/piper-phonemize) (espeak-ng in WASM) turning the text into phonemes; Russian text is prepared first as in claude-ai — numbers, units, versions, file names and English words (read through [CMUdict](https://github.com/cmusphinx/cmudict) with their stress) become Russian words.
  - Silero, Whisper and external servers can be added and chosen already; speaking and recognizing through them, and recognition (dictation) itself, come in a later version.
  - For other extensions: `const api = await vscode.extensions.getExtension('ninebits.tts-stt-md-aloud').activate()` — `api.tts` has `voices()`, `speak(text, { voice, lang, rate })` and `stop()`; `api.stt` has `record({ waitMs, maxMs, silenceMs })` (the speech as a WAV file; only while STT is on) and `stop()`. Or the commands `tts-stt-md-aloud.speak` (text, options), `tts-stt-md-aloud.stopSpeaking`, `tts-stt-md-aloud.voices`, `tts-stt-md-aloud.record` (limits), `tts-stt-md-aloud.stopRecording`.
- **Formatted JSON** — **Open Formatted JSON** in the editor title of a `.json` / `.jsonc` file shows it indented (JSONC comments and trailing commas are left out); saving it writes the file compact, without line breaks (asked once per file and session). **Open as Raw JSON** goes back to the file as it is written, which saves it unchanged.

## Requirements

- Visual Studio Code `^1.107.0`
- Node.js (with `npm`) to build and package the extension from source

## Getting started (development)

The extension entry point is the **bundled** output in `dist/`, not `src/` — so you must build (or watch) before launching.

```bash
npm install        # install dependencies
npm run watch      # build once, then rebuild on change (esbuild + sass)
```

Then press **F5** in VS Code to launch the "Run Extension" configuration (`.vscode/` is not in the repository; create `.vscode/launch.json` once):

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Run Extension",
      "type": "extensionHost",
      "request": "launch",
      "args": ["--extensionDevelopmentPath=${workspaceFolder}"]
    }
  ]
}
```

For a one-off production build without watchers:

```bash
npm run build      # clean → bundle extension + webview + css → copy codicons into dist/
```

## Packaging and installing

```bash
npm install
npm run pack       # vsce runs npm run build (vscode:prepublish), then packs tts-stt-md-aloud-<platform>-<arch>-<version>.vsix for this machine
```

The package is for the platform of the machine it is packed on (darwin-arm64 / x64, linux-arm64 / x64, win32-arm64 / x64): it holds the native module of sherpa-onnx (Piper) built for it — pack on each platform you install on. Install the package in VS Code with **Extensions: Install from VSIX…** (Command Palette, the `…` menu of the Extensions view, or right-click the `.vsix` in the Explorer → **Install Extension VSIX**), then run **Developer: Reload Window**. Raise `version` in `package.json` before packaging an update.

## Project layout

```
src/
  extension.js              # extension entry point (activate)
  markdown.js               # preview webview entry
  speech.js                 # speech side bar webview entry
  components/               # extension host: MarkdownPreview (custom editor, links, translation through vscode.lm),
                            # JsonFormattedView (json-formatted: file system provider), SpeechPanel (the side bar),
                            # SpeechSettings (ttsSttMdAloud.* settings, server keys), TextToSpeech (the speech of all
                            # callers), SystemSpeech (voices of the OS), PiperSpeech (Piper through sherpa-onnx and
                            # piper-phonemize), AudioPlayer, SpeechToText (the microphone of all callers), MicRecorder
                            # (records speech, SpeechDetector), PiperModels (voice models)
  markdown/                 # preview webview: MarkdownView (marked + DOMPurify + highlight.js), PreviewTranslation, ReadAloud, HostRequests
  speech/                   # side bar webview: SpeechSection, VoicePicker, ServerDialog, ModelDialog, createElement
  utils/                    # createNonce, formatJson (+ minifyJson, stripJsonc), WavAudio, pickVoice,
                            # normalizeRussian and EnglishReading (text for Russian voices, ported from claude-ai)
  scss/                     # markdown.scss, speech.scss → compiled to dist/css/
resources/                  # icon of the "Open Preview" title button (light / dark); speaker.svg, the activity bar icon; icon.png, the extension icon, made by
                            # scripts/make-icon.swift from its source icon-space.svg (the icon of the universe page of gw,
                            # kept in the package too) with the label TTS/STT MD — the picture of the babylon-editor icon;
                            # cmudict/ — CMUdict (English pronunciations, BSD-style license next to it)
scripts/                    # make-icon.swift (swift scripts/make-icon.swift, macOS); copy-runtime.mjs (the runtime of
                            # Piper into dist/); pack.mjs (the VSIX for this machine)
dist/                       # bundled output loaded by VS Code, with the runtime of Piper (native/, piper-phonemize/; git-ignored)
```

## License

MIT © 2026 NineBits LLC — see the `LICENSE` file.
