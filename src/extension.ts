/**
 * Extension entry point.
 *
 * Enhances the built-in Markdown preview only: column markers render as
 * multi-column layouts via `extendMarkdownIt` (the official mechanism for
 * contributing markdown-it plugins to the preview). Editing stays in
 * VSCode's native Markdown editor — this extension never touches it.
 */
import * as vscode from "vscode";
import type MarkdownIt from "markdown-it";
import {registerCommands} from "./commands";
import {registerWikilinkCompletion} from "./completion";
import {installColumnsMarkdownItPlugin} from "./preview/markdownItPlugin";

export function activate(context: vscode.ExtensionContext): {
	extendMarkdownIt(md: MarkdownIt): MarkdownIt;
} {
	registerCommands(context);
	registerWikilinkCompletion(context);

	// Called by the built-in markdown preview (lazily, on first preview
	// open) with its markdown-it instance. Returns the instance so preview
	// rendering includes column regions.
	return {
		extendMarkdownIt(md: MarkdownIt): MarkdownIt {
			installColumnsMarkdownItPlugin(md);
			return md;
		},
	};
}

export function deactivate(): void {
	// All disposables are registered on context.subscriptions.
}
