# Change Log

All notable changes to the "tts-stt-md-aloud" extension are documented in this file.

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
