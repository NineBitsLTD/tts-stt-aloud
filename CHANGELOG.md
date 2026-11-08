# Change Log

All notable changes to the "tts-stt-aloud" extension are documented in this file.

## [2.1.0]

- Russian and Ukrainian localization of the whole interface, by the display language of VS Code: the side bar, commands, settings, notifications and messages, with the names of languages and decimal marks of the language
- The license of a voice and the warnings in the list of models wrap instead of being cut off

## [2.0.0]

- The extension is now **TTS / STT Aloud** (`ninebits.tts-stt-aloud`, settings `ttsSttAloud.*`, repository `tts-stt-aloud`), with the label TTS/STT on its icon. It is a new extension for VS Code: uninstall the old one (`ninebits.tts-stt-md-aloud`) after installing it. On the first start its models and user settings are brought over; the keys of external servers have to be entered again
- The Markdown preview is gone, with its translation (DEF / RU / UA / EN) and reading aloud: Markdown files are read by the player of the editor, as plain text. The API (`getExtension`, commands, settings) has the new name

## [1.6.1]

- The buttons of the player come first in the editor title, in one block: the toolbar shows 9 actions at most, and in a Markdown file Stop went to the `…` menu. Record is next to Play / Stop, in the editor title and in the side bar

## [1.6.0]

- The package (VSIX) is distributed under the GNU GPL, version 3 or later, because it holds piper-phonemize and espeak-ng (`COPYING`); the source code of the repository stays under the MIT license. `THIRD-PARTY-NOTICES.md` lists the components of the package with their licenses (`npm run notices`)
- Reading a file or the clipboard (the player, the preview) has the lowest priority for the speaker: the speech of other extensions interrupts it, and it goes on afterwards
- The license of a Piper voice is shown: in the dialog when a voice of the catalog is chosen, with a warning when it is non-commercial, copyleft, has its own terms or is not stated, and in the list of voices (its `MODEL_CARD` is kept next to the model)

## [1.5.0]

- The time of the player is shown only in the Player section: no status bar item, and the extension no longer activates at the startup of VS Code
- The language of a text is told for other alphabets and languages: by the script (Chinese, Japanese, Korean, Arabic, Persian, Urdu, Hebrew, Greek, Hindi, Thai and others), the letters of Cyrillic languages (also Serbian, Macedonian, Kazakh, Belarusian, Bulgarian, Mongolian) and, in Latin letters, the common words and letters of 21 languages; a short phrase with too little to tell takes the language of the text around it. It serves the voices of the player and the preview, and the source of translation
- The speaker and the microphone are shared by the windows of VS Code through a file of the temporary folder: a speech or a recording waits for its turn; a higher priority (the test buttons, then reading and dictation, then other extensions, which may give `priority`) pauses the speech being played, which says that it goes on (`player.resume.*` of the locales, or the `resumeText` another extension gives to `speak`) and says its phrase again when the speaker is free; the microphone: a person (Dictate, Test microphone) stops the recording going on, which ends with what it has (`ended: 'interrupted'`), an application waits for it to be free, also within one window (`record` is no longer rejected while the microphone is busy)
- Phrases end at the marks of other scripts (。!? ؟ ۔ । and others), and the time of reading counts their letters and ideographs

## [1.4.0]

- A player in the title of any text editor and in a new **Player** section of the side bar
  - Read Aloud reads the selection, else the whole text, phrase by phrase: a phrase back, pause, a phrase on, stop; the phrase read is highlighted in the editor and scrolled to; Markdown and HTML are read as plain text
  - It says first what it reads, in the language of the text (else that of VS Code, else English); the texts are in `src/locales/`
  - The time it takes: in the status bar and next to Play in the side bar, with how far it is while reading
  - The source in the side bar: the file or the clipboard
  - Dictate writes speech at the cursor until pressed again (or into the clipboard), recognized by Whisper
  - The buttons of reading go with TTS, those of dictation with STT
- The extension activates when VS Code has started (for the status bar)

## [1.3.3]

- The models of Piper and Whisper in the side bar show their buttons only while hovered (or focused): a new folder button shows the file of the model in Finder / File Explorer, × removes it

## [1.3.2]

- The dialog adding a Whisper model says "Loading the list of models…" and "No model matches" (it said voices, as for Piper)
- A model being downloaded or prepared (Piper voices, Whisper models) shows a spinner and how much is written of how much in the list ("12.3 of 60.3 MB", "0.45 of 1.70 GB") instead of "downloading…"

## [1.3.1]

- Whisper: distil-large-v3 is English only (Distil-Whisper is distilled on English speech), no longer listed as multilingual; a Distil-Whisper model offers English only in Language whatever its metadata says. The note under the catalog says that all the models without .en are multilingual (99 languages)
- README: How to use — reading aloud, system voices, Piper voices, speech recognition with Whisper step by step, what the messages of the side bar mean; the requirements of the microphone and the models

## [1.3.0]

- Speech recognition: the Whisper driver recognizes speech offline through sherpa-onnx (the native module of Piper)
  - Whisper models under the Whisper driver (Add model): a Whisper model of sherpa-onnx chosen on the disk (its encoder or decoder, the other and its tokens next to it), or one downloaded from the int8 models of the author of sherpa-onnx (tiny … large-v3, turbo, distil, English-only .en), kept in `ttsSttMdAloud.stt.models`
  - The model and the language of recognition in the STT section (`ttsSttMdAloud.stt.model`, `ttsSttMdAloud.stt.language`): Auto, as VS Code, or a language the model knows
  - The microphone test shows the recognized text and its language (recognized while the recording plays); `stt.record()` for extensions returns the text too
- The models of Piper and Whisper share one store (the list, the dialog, the install with progress and cancel, the removal)
- Several TTS drivers at once: **Drivers** is a drop-down with check boxes (`ttsSttMdAloud.tts.activeDrivers`, replacing `tts.driver`, which is read until it is set); the voices of the checked drivers are in one list with their drivers, Auto takes a checked voice first, then the best by quality (Enhanced / Premium system voices, Piper, other system voices), each phrase is spoken by the driver of its voice; voices are keyed `<driver>:<name>` (the voice tested, the voice of the preview, the API)
- STT has no System driver any more (it recognized nothing: VS Code may not use the speech recognition of macOS); Whisper is offered from the start (`ttsSttMdAloud.stt.drivers` defaults to it), the driver in use is the one chosen, else the first offered

## [1.2.0]

- Piper speaks, offline: its voices are the voice models added in the side bar (picked by Auto, checked, tested, used by the preview and other extensions like system voices)
  - Engine: sherpa-onnx 2.x (`sherpa-onnx-node`, a native module) with piper-phonemize (espeak-ng in WASM) turning the text into phonemes; the audio is made asynchronously and played by the host (volume, level meter, the next phrase rendered ahead)
  - Russian text is prepared as in claude-ai (a port of its normalize.py and en2ru.py): numbers, units, versions, file names and symbols become words, English words are read through CMUdict with their stress, which is put into the phonemes (espeak-ng takes no stress mark in the text)
  - Downloads of Piper voices no longer bring espeak-ng-data: piper-phonemize has its own
- `npm run pack` packs the VSIX for the platform of the machine it runs on (`--target <platform>-<arch>`): it holds the native module of sherpa-onnx built for it
- Fixed: in VS Code (Electron) Piper failed with "TTS settlement failed": the audio is taken without external buffers, which Electron forbids

## [1.1.0]

- Speech settings for all of VS Code in the side bar (a speaker in the activity bar), kept in the VS Code settings `ttsSttMdAloud.tts.*` / `ttsSttMdAloud.stt.*`:
  - TTS: on / off, volume (a share of the computer's volume), speed, a level meter, the driver (System; Piper, Silero and external servers can be added — they speak in a later version), voices with check boxes (picked automatically, offered to other extensions), a voice test
  - STT: on / off — whether other extensions may record the microphone —, microphone gain, a level meter of the microphone while it records, the driver (System; Whisper and external servers can be added), a microphone test: waits 5 s for speech, records it until 1 s of silence (10 s at most), plays it back and shows the recognized text (recognition comes later); the recording is kept until the next test; recorded with SoX / FFmpeg / arecord
  - External servers: name, address and key (kept in VS Code's secret storage)
  - Piper voice models for sherpa-onnx (while Piper is offered): `.onnx` files chosen on the disk (models of sherpa-onnx are used where they are, Piper models with their `.onnx.json` are copied into the extension's storage and prepared there) or voices of the Piper catalog downloaded into the extension's storage and prepared there; kept in `ttsSttMdAloud.tts.models`
- An API and commands for other extensions: `tts.voices()`, `tts.speak()`, `tts.stop()`, `stt.record()`, `stt.stop()`; `tts-stt-md-aloud.speak`, `stopSpeaking`, `voices`, `record`, `stopRecording`
- Reading aloud in the preview speaks with the driver, volume and speed of the settings (system voices rendered and played by the host, the next phrase rendered ahead); Auto picks the checked voices first; hidden while TTS is off; stops when another speech begins
- With Remote (SSH, WSL, containers) the extension runs on the local machine (`extensionKind`: ui, workspace): speech and the microphone are the user's
- Fixed: macOS voices whose long names leave one space before their language (e.g. "Milena (Russian (Russia))") were not listed

## [1.0.0]

- Extension icon: the universe icon of gw with the label TTS/STT MD, white on a black square with rounded corners (`scripts/make-icon.swift`, source `resources/icon-space.svg`)

## [0.1.0]

- Markdown preview with translation (RU / UA / EN) and reading aloud with system voices, moved from babylon-editor 1.22.0
- Formatted view of `.json` / `.jsonc` files, saved compact
