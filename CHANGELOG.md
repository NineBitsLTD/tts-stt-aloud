# Change Log

All notable changes to the "tts-stt-md-aloud" extension are documented in this file.

## [1.1.0]

- Speech settings for all of VS Code in the side bar (a speaker in the activity bar), kept in the VS Code settings `ttsSttMdAloud.tts.*` / `ttsSttMdAloud.stt.*`:
  - TTS: on / off, volume (a share of the computer's volume), speed, a level meter, the driver (System; Piper, Silero and external servers can be added — they speak in a later version), voices with check boxes (picked automatically, offered to other extensions), a voice test
  - STT: on / off, microphone gain, a level meter of the microphone (SoX / FFmpeg / arecord), the driver (System; Whisper and external servers can be added); recognition comes later
  - External servers: name, address and key (kept in VS Code's secret storage)
- An API and commands for other extensions: `tts.voices()`, `tts.speak()`, `tts.stop()`; `tts-stt-md-aloud.speak`, `stopSpeaking`, `voices`
- Reading aloud in the preview speaks with the driver, volume and speed of the settings (system voices rendered and played by the host, the next phrase rendered ahead); Auto picks the checked voices first; hidden while TTS is off; stops when another speech begins
- Fixed: macOS voices whose long names leave one space before their language (e.g. "Milena (Russian (Russia))") were not listed

## [1.0.0]

- Extension icon: the universe icon of gw with the label TTS/STT MD, white on a black square with rounded corners (`scripts/make-icon.swift`, source `resources/icon-space.svg`)

## [0.1.0]

- Markdown preview with translation (RU / UA / EN) and reading aloud with system voices, moved from babylon-editor 1.22.0
- Formatted view of `.json` / `.jsonc` files, saved compact
