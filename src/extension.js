import { JsonFormattedView } from './components/JsonFormattedView';
import { MarkdownPreview } from './components/MarkdownPreview';

/**
 * @param {import('vscode').ExtensionContext} context
 */
export function activate(context) {
	// Markdown files: a preview next to the text, translated and read aloud
	context.subscriptions.push(new MarkdownPreview(context).register());
	// .json files: a formatted view next to the raw text, saved compact
	context.subscriptions.push(new JsonFormattedView().register());
}

export function deactivate() {}
