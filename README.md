# TTS / STT MD Aloud

A Visual Studio Code extension that previews Markdown files, translates the preview and reads it aloud with the voices of your system, and shows JSON files formatted.

## Open source

TTS / STT MD Aloud is an open source project under the [MIT license](LICENSE). Its source code is on GitHub: **[github.com/NineBitsLTD/tts-stt-md-aloud](https://github.com/NineBitsLTD/tts-stt-md-aloud)**.

The requirements and how to install the extension or build it from source are described after the features: [Requirements](#requirements), [Getting started (development)](#getting-started-development), [Packaging and installing](#packaging-and-installing).

## Features

- **Markdown preview** — Markdown files open as text as usual; **Open Preview (Translate, Read Aloud)** in the editor title (a sheet with a lens) shows the preview in the same tab, **Open as Raw Markdown** goes back. The preview follows your edits. It renders GitHub flavoured Markdown (tables, task lists, highlighted code, heading anchors, relative images), lists the other Markdown files of the folder, opens a linked Markdown file in its preview, other files in their editor and web addresses in the browser; ↑ goes back to the top.
- **Translation** — **DEF / RU / UA / EN** in the header translates the shown text in place (code is not translated; DEF is the original). It uses a language model of VS Code (from an installed extension such as GitHub Copilot), else the on-device translator of the browser when it has one. Translations are cached while the preview is open.
- **Reading aloud** — the speaker button reads the shown text (the translation when one is shown) phrase by phrase, highlighting the block being read; back / pause / on, the time read, and an estimate of the time it takes before you start. **Auto** reads each phrase in the best system voice of its language (an English name in a Russian text in an English voice); pick a voice and a speed (0.75× – 2×) instead — both are remembered. The voices of VS Code's webview are used (the system voices on macOS); without them the voice of the operating system speaks (`say` on macOS, `System.Speech` on Windows, `spd-say` on Linux).
- **Formatted JSON** — **Open Formatted JSON** in the editor title of a `.json` / `.jsonc` file shows it indented (JSONC comments and trailing commas are left out); saving it writes the file compact, without line breaks (asked once per file and session). **Open as Raw JSON** goes back to the file as it is written, which saves it unchanged.
- **STT** (speech to text) — planned.

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
npm run pack       # vsce runs npm run build (vscode:prepublish), then packs tts-stt-md-aloud-<version>.vsix into the project folder
```

Install the package in VS Code with **Extensions: Install from VSIX…** (Command Palette, the `…` menu of the Extensions view, or right-click the `.vsix` in the Explorer → **Install Extension VSIX**), then run **Developer: Reload Window**. Raise `version` in `package.json` before packaging an update.

## Project layout

```
src/
  extension.js              # extension entry point (activate)
  markdown.js               # preview webview entry
  components/               # extension host: MarkdownPreview (custom editor, links, translation through vscode.lm),
                            # SystemSpeech (voice of the OS), JsonFormattedView (json-formatted: file system provider)
  markdown/                 # webview: MarkdownView (marked + DOMPurify + highlight.js), PreviewTranslation, ReadAloud, HostRequests
  utils/                    # createNonce, formatJson (+ minifyJson, stripJsonc)
  scss/                     # markdown.scss → compiled to dist/css/
resources/                  # icon of the "Open Preview" title button (light / dark)
dist/                       # bundled output loaded by VS Code (git-ignored)
```

## License

MIT © 2026 NineBits LLC — see the `LICENSE` file.
