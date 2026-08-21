/**
 * Wikilink completion for the built-in Markdown editor: typing `[[` offers
 * workspace markdown files (Obsidian-style), inserted as `[[label]]`.
 */
import * as vscode from "vscode";
import {getMarkdownFiles, wikilinkLabel} from "./wikilink";

export function registerWikilinkCompletion(context: vscode.ExtensionContext): void {
	const provider = vscode.languages.registerCompletionItemProvider(
		{language: "markdown"},
		{
			async provideCompletionItems(document, position) {
				const linePrefix = document.lineAt(position).text.slice(0, position.character);
				const openIdx = linePrefix.lastIndexOf("[[");
				if (openIdx < 0) return undefined;
				// Already closed `[[…]]` on this line — no suggestions.
				if (linePrefix.slice(openIdx + 2).includes("]]")) return undefined;

				const files = await getMarkdownFiles();
				const start = new vscode.Position(position.line, openIdx + 2);
				return files.slice(0, 200).map((f) => {
					const label = wikilinkLabel(f);
					const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.File);
					item.insertText = `${label}]]`;
					item.filterText = label;
					item.detail = f;
					item.range = new vscode.Range(start, position);
					return item;
				});
			},
		},
		"[",
	);
	context.subscriptions.push(provider);
}
