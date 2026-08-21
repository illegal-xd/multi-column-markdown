/**
 * Command registrations. All insert commands behave like the reference
 * plugin's editorCallback: insert at the current cursor in the active
 * Markdown editor (VSCode's built-in editor).
 */
import * as vscode from "vscode";
import {getSettings} from "./settings";
import {
	buildColumnsTemplate,
	buildTemplateInsertion,
	CORNELL_TEMPLATE,
	INFO_CARD_TEMPLATE,
	KANBAN_TEMPLATE,
	NESTED_TEMPLATE,
	SIDEBAR_TEMPLATE,
	STACKED_TEMPLATE,
} from "./core/templates";

export function registerCommands(context: vscode.ExtensionContext): void {
	const insert = (template: () => string) => () => {
		void insertTemplateAtActiveEditor(template());
	};

	context.subscriptions.push(
		vscode.commands.registerCommand("multiColumnMarkdown.insert2", insert(() => buildColumnsTemplate(2))),
		vscode.commands.registerCommand("multiColumnMarkdown.insert3", insert(() => buildColumnsTemplate(3))),
		vscode.commands.registerCommand("multiColumnMarkdown.insert4", insert(() => buildColumnsTemplate(4))),
		vscode.commands.registerCommand("multiColumnMarkdown.insertLayout", insert(() => buildColumnsTemplate(getSettings().defaultColumnCount))),
		vscode.commands.registerCommand("multiColumnMarkdown.insertNested", insert(() => NESTED_TEMPLATE)),
		vscode.commands.registerCommand("multiColumnMarkdown.insertSidebar", insert(() => SIDEBAR_TEMPLATE)),
		vscode.commands.registerCommand("multiColumnMarkdown.insertStacked", insert(() => STACKED_TEMPLATE)),
		vscode.commands.registerCommand("multiColumnMarkdown.insertCornell", insert(() => CORNELL_TEMPLATE)),
		vscode.commands.registerCommand("multiColumnMarkdown.insertKanban", insert(() => KANBAN_TEMPLATE)),
		vscode.commands.registerCommand("multiColumnMarkdown.insertInfoCard", insert(() => INFO_CARD_TEMPLATE)),
		vscode.commands.registerCommand("multiColumnMarkdown.openPreview", () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor || editor.document.languageId !== "markdown") {
				void vscode.window.showInformationMessage(
					"Advanced Multi Column: open a Markdown file first, then run this command.",
				);
				return;
			}
			void vscode.commands.executeCommand("markdown.showPreviewToSide", editor.document.uri);
		}),
	);
}

/** Insert a template at the current cursor of the active Markdown editor. */
async function insertTemplateAtActiveEditor(block: string): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor || editor.document.languageId !== "markdown") {
		void vscode.window.showInformationMessage(
			"Advanced Multi Column: open a Markdown file to insert a column layout.",
		);
		return;
	}

	const doc = editor.document;
	const position = editor.selection.active;
	const offset = doc.offsetAt(position);
	const insertion = buildTemplateInsertion(doc.getText(), offset, block);
	const startPos = doc.positionAt(offset);
	const endPos = doc.positionAt(offset);

	await editor.edit((editBuilder) => {
		editBuilder.replace(new vscode.Range(startPos, endPos), insertion);
	});
}
