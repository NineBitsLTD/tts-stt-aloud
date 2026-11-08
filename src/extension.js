import { Dictation } from './components/Dictation';
import { JsonFormattedView } from './components/JsonFormattedView';
import { migrateOldName } from './components/migrateOldName';
import { PiperModels } from './components/PiperModels';
import { PiperSpeech } from './components/PiperSpeech';
import { SpeechPanel } from './components/SpeechPanel';
import { SpeechSettings } from './components/SpeechSettings';
import { SpeechToText } from './components/SpeechToText';
import { TextPlayer } from './components/TextPlayer';
import { TextToSpeech } from './components/TextToSpeech';
import { WhisperModels } from './components/WhisperModels';
import { WhisperRecognizer } from './components/WhisperRecognizer';

/**
 * @param {import('vscode').ExtensionContext} context
 * @returns {object} the API of the extension for other extensions
 *   (`vscode.extensions.getExtension('ninebits.tts-stt-aloud').activate()`)
 */
export async function activate(context) {
	// Before version 2 it was tts-stt-md-aloud: its settings and models come over once
	await migrateOldName(context);
	// Speech settings of VS Code (ttsSttAloud.*), the text to speech (system voices, Piper through
	// sherpa-onnx with its voice models) and the microphone with Whisper recognizing (sherpa-onnx) that follow them
	const settings = new SpeechSettings(context);
	const piper = new PiperModels(context, settings);
	const tts = new TextToSpeech(settings, new PiperSpeech(context, piper));
	const whisper = new WhisperModels(context, settings);
	const stt = new SpeechToText(context, settings, new WhisperRecognizer(context, whisper));
	context.subscriptions.push(settings, piper, whisper, tts.register(), stt.register());
	// .json files: a formatted view next to the raw text, saved compact
	context.subscriptions.push(new JsonFormattedView().register());
	// Any text editor: read aloud (its selection, else its text; or the clipboard) and dictated into
	const player = new TextPlayer(settings, tts);
	const dictation = new Dictation(settings, tts, stt, player);
	context.subscriptions.push(player.register(), dictation.register());
	// The speaker of the activity bar: the side bar of the speech settings (with the models of Piper and Whisper) and the player
	context.subscriptions.push(new SpeechPanel(context, settings, tts, stt, { piper, whisper }, { player, dictation }).register());
	return {
		tts: {
			/** @returns the voices offered: the checked ones, all of them when none is checked */
			voices: () => tts.offeredVoices(),
			/** @returns true when spoken to the end, false when stopped or the speech is off (options.priority: 0–2 among the windows of VS Code; options.resumeText, resumeLang: what is said first when the speech goes on after another window interrupted it) */
			speak: (text, options) => tts.speak(String(text ?? ''), options ?? {}, 'api'),
			/** Ends the speech asked for through this API. */
			stop: () => tts.stop('api'),
		},
		stt: {
			/**
			 * Records speech from the microphone (only while STT is on, else it rejects): waits for it
			 * to begin (waitMs, 5 s), ends it after a pause (silenceMs, 1 s) or at its longest (maxMs, 10 s),
			 * and recognizes it with the Whisper driver. It waits while the microphone is in use; a person
			 * pressing a record button ends it with what it has (ended: 'interrupted').
			 * @returns {{ wav: Buffer | null, duration: number, ended: string, text: string | null, lang: string, error?: string }}
			 *   wav: null when no speech began; text: null when not recognized (error: why)
			 */
			record: limits => stt.record(limits ?? {}, 'api'),
			/** Ends the recording asked for through this API (the speech recorded so far is kept). */
			stop: () => stt.stop('api'),
		},
		/** @returns the speech settings (`ttsSttAloud.*`, checked) */
		settings: () => settings.get(),
		onDidChangeSettings: settings.onDidChange,
	};
}

export function deactivate() {}
