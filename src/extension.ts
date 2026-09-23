/**
 * Extension entry point.
 *
 * Enhances the built-in Markdown preview only: column markers render as
 * multi-column layouts via `extendMarkdownIt` (the official mechanism for
 * contributing markdown-it plugins to the preview), and ```dataview /
 * ```dataviewjs fences render through the Dataview subsystem
 * (index → worker sandbox → render cache → preview refresh). Editing stays in
 * VSCode's native Markdown editor — this extension never touches it.
 *
 * Activation cost: `activate()` only registers commands/plugins. The dataview
 * index, file watcher and worker pool start lazily on the first dataview block
 * (see dataview/host/runtime.ts), so non-dataview users pay nothing.
 */
import * as vscode from "vscode";
import type MarkdownIt from "markdown-it";
import {registerCommands, setDataviewStatsHandler} from "./commands";
import {registerWikilinkCompletion} from "./completion";
import {installColumnsMarkdownItPlugin} from "./preview/markdownItPlugin";
import {createDataviewRuntime, readDataviewSettings, type DataviewRuntime} from "./dataview/host/runtime";
import {installDataviewFences, installDataviewInlines} from "./dataview/preview/fencePlugin";

let dataviewRuntime: DataviewRuntime | undefined;

export function activate(context: vscode.ExtensionContext): {
	extendMarkdownIt(md: MarkdownIt): MarkdownIt;
} {
	registerCommands(context);
	registerWikilinkCompletion(context);

	dataviewRuntime = createDataviewRuntime(context);
	// The command itself is registered in commands.ts (command ids have a single
	// source of truth there); the runtime only contributes the handler.
	setDataviewStatsHandler(() => dataviewRuntime?.showStats());

	// Called by the built-in markdown preview (lazily, on first preview
	// open) with its markdown-it instance. Returns the instance so preview
	// rendering includes column regions and dataview blocks.
	return {
		extendMarkdownIt(md: MarkdownIt): MarkdownIt {
			installColumnsMarkdownItPlugin(md);
			// The service renders cell text with the preview's own markdown
			// renderer, so wikilinks/emphasis inside dataview cells behave exactly
			// like they do in the document body.
			dataviewRuntime?.attachMarkdownIt(md);
			installDataviewFences(md, {
				provider: dataviewRuntime!.provider,
				// Read per fence: toggling the setting applies on the next render,
				// without reloading the preview or the extension host.
				isEnabled: () => readDataviewSettings().enabled,
			});
			// Inline `` `= …` `` / `` `$= …` `` spans: same provider, same gates —
			// including the index-ready hold, so an inline query in the first paint
			// shows the same placeholder a block would.
			installDataviewInlines(md, {
				provider: dataviewRuntime!.provider,
				isEnabled: () => readDataviewSettings().enabled && readDataviewSettings().inlineQueries,
				inlinePrefix: () => readDataviewSettings().inlinePrefix,
				jsInlinePrefix: () => readDataviewSettings().jsInlinePrefix,
			});
			return md;
		},
	};
}

export function deactivate(): Thenable<void> {
	// Returned promise matters: worker threads are terminated here.
	const runtime = dataviewRuntime;
	dataviewRuntime = undefined;
	return runtime ? runtime.dispose() : Promise.resolve();
}
