import { JsonFormattedView } from './components/JsonFormattedView';
import { MarkdownPreview } from './components/MarkdownPreview';
import { PiperModels } from './components/PiperModels';
import { PiperSpeech } from './components/PiperSpeech';
import { SpeechPanel } from './components/SpeechPanel';
import { SpeechSettings } from './components/SpeechSettings';
import { SpeechToText } from './components/SpeechToText';
import { TextToSpeech } from './components/TextToSpeech';

/**
 * @param {import('vscode').ExtensionContext} context
 * @returns {object} the API of the extension for other extensions
 *   (`vscode.extensions.getExtension('ninebits.tts-stt-md-aloud').activate()`)
 */
export function activate(context) {
	// Speech settings of VS Code (ttsSttMdAloud.*), the text to speech (system voices, Piper through
	// sherpa-onnx with its voice models) and the microphone that follow them
	const settings = new SpeechSettings(context);
	const piper = new PiperModels(context, settings);
	const tts = new TextToSpeech(settings, new PiperSpeech(context, piper));
	const stt = new SpeechToText(context, settings);
	context.subscriptions.push(settings, piper, tts.register(), stt.register());
	// Markdown files: a preview next to the text, translated and read aloud
	context.subscriptions.push(new MarkdownPreview(context, settings, tts).register());
	// .json files: a formatted view next to the raw text, saved compact
	context.subscriptions.push(new JsonFormattedView().register());
	// The speaker of the activity bar: the side bar of the speech settings (with the voice models of Piper)
	context.subscriptions.push(new SpeechPanel(context, settings, tts, stt, piper).register());
	return {
		tts: {
			/** @returns the voices offered: the checked ones, all of them when none is checked */
			voices: () => tts.offeredVoices(),
			/** @returns true when spoken to the end, false when stopped or the speech is off */
			speak: (text, options) => tts.speak(String(text ?? ''), options ?? {}, 'api'),
			/** Ends the speech asked for through this API. */
			stop: () => tts.stop('api'),
		},
		stt: {
			/**
			 * Records speech from the microphone (only while STT is on, else it rejects): waits for it
			 * to begin (waitMs, 5 s), ends it after a pause (silenceMs, 1 s) or at its longest (maxMs, 10 s).
			 * @returns {{ wav: Buffer | null, duration: number, ended: string }} wav: null when no speech began
			 */
			record: limits => stt.record(limits ?? {}, 'api'),
			/** Ends the recording asked for through this API (the speech recorded so far is kept). */
			stop: () => stt.stop('api'),
		},
		/** @returns the speech settings (`ttsSttMdAloud.*`, checked) */
		settings: () => settings.get(),
		onDidChangeSettings: settings.onDidChange,
	};
}

export function deactivate() {}
