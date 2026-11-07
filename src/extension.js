import { JsonFormattedView } from './components/JsonFormattedView';
import { MarkdownPreview } from './components/MarkdownPreview';
import { SpeechPanel } from './components/SpeechPanel';
import { SpeechSettings } from './components/SpeechSettings';
import { TextToSpeech } from './components/TextToSpeech';

/**
 * @param {import('vscode').ExtensionContext} context
 * @returns {object} the API of the extension for other extensions
 *   (`vscode.extensions.getExtension('ninebits.tts-stt-md-aloud').activate()`)
 */
export function activate(context) {
	// Speech settings of VS Code (ttsSttMdAloud.*) and the text to speech that follows them
	const settings = new SpeechSettings(context);
	const tts = new TextToSpeech(settings);
	context.subscriptions.push(settings, tts.register());
	// Markdown files: a preview next to the text, translated and read aloud
	context.subscriptions.push(new MarkdownPreview(context, settings, tts).register());
	// .json files: a formatted view next to the raw text, saved compact
	context.subscriptions.push(new JsonFormattedView().register());
	// The speaker of the activity bar: the side bar of the speech settings
	context.subscriptions.push(new SpeechPanel(context, settings, tts).register());
	return {
		tts: {
			/** @returns the voices offered: the checked ones, all of them when none is checked */
			voices: () => tts.offeredVoices(),
			/** @returns true when spoken to the end, false when stopped or the speech is off */
			speak: (text, options) => tts.speak(String(text ?? ''), options ?? {}, 'api'),
			/** Ends the speech asked for through this API. */
			stop: () => tts.stop('api'),
		},
		/** @returns the speech settings (`ttsSttMdAloud.*`, checked) */
		settings: () => settings.get(),
		onDidChangeSettings: settings.onDidChange,
	};
}

export function deactivate() {}
