/**
 * Wikilink support: suggestion data source ([[ autocomplete) and target
 * resolution for the column editor webview.
 *
 * VSCode has no native wikilink concept; we treat [[target]] as a
 * workspace-relative markdown path, matching Obsidian's common resolution
 * rules: exact file, file.md, folder/index or folder.
 */
import * as path from "path";
import * as vscode from "vscode";

/** Simple cache keyed by workspace folder + file tree mtime. */
let cache: {key: string; files: string[]} | null = null;

function cacheKey(): string {
	const folders = vscode.workspace.workspaceFolders ?? [];
	return folders.map((f) => f.uri.fsPath).join("|");
}

/** Recursively list markdown files (relative paths) under a workspace folder. */
async function listMarkdownFilesInFolder(folder: vscode.WorkspaceFolder): Promise<string[]> {
	const files: string[] = [];
	const walk = async (dirUri: vscode.Uri): Promise<void> => {
		let entries: [string, vscode.FileType][];
		try {
			entries = await vscode.workspace.fs.readDirectory(dirUri);
		} catch {
			return;
		}
		for (const [name, type] of entries) {
			if (name === "node_modules" || name === ".git" || name.startsWith(".")) continue;
			const child = vscode.Uri.joinPath(dirUri, name);
			if (type === vscode.FileType.Directory) {
				await walk(child);
			} else if (type === vscode.FileType.File && name.toLowerCase().endsWith(".md")) {
				files.push(path.relative(folder.uri.fsPath, child.fsPath));
			}
		}
	};
	await walk(folder.uri);
	return files;
}

/** Refresh the markdown file cache. Cheap: workspace markdown files are
 *  usually a few hundred at most; refresh is debounced by callers. */
export async function refreshWikilinkCache(): Promise<string[]> {
	const key = cacheKey();
	const folders = vscode.workspace.workspaceFolders ?? [];
	const all: string[] = [];
	for (const folder of folders) {
		all.push(...(await listMarkdownFilesInFolder(folder)));
	}
	const files = [...new Set(all)].sort((a, b) => a.localeCompare(b));
	cache = {key, files};
	return files;
}

export async function getMarkdownFiles(): Promise<string[]> {
	const key = cacheKey();
	if (cache && cache.key === key) return cache.files;
	return refreshWikilinkCache();
}

/** Strip the `.md` extension (Obsidian-style suggestion label). */
export function wikilinkLabel(relativePath: string): string {
	return relativePath.replace(/\.md$/i, "");
}

/** Resolve a [[target]] to a workspace file URI, or null. */
export async function resolveWikilinkTarget(target: string): Promise<vscode.Uri | null> {
	const folders = vscode.workspace.workspaceFolders ?? [];
	if (folders.length === 0) return null;
	const candidates = [
		target,
		`${target}.md`,
		path.join(target, "index.md"),
		path.join(target, `${path.basename(target)}.md`),
	];
	for (const folder of folders) {
		for (const candidate of candidates) {
			const uri = vscode.Uri.joinPath(folder.uri, candidate);
			try {
				const stat = await vscode.workspace.fs.stat(uri);
				if (stat.type === vscode.FileType.File) return uri;
			} catch {
				// try next candidate
			}
		}
	}
	return null;
}

/** Open a wikilink target in the default editor. */
export async function openWikilink(target: string): Promise<void> {
	const uri = await resolveWikilinkTarget(target);
	if (!uri) {
		void vscode.window.showWarningMessage(`Advanced Multi Column: wikilink target not found: [[${target}]]`);
		return;
	}
	await vscode.window.showTextDocument(uri, {preview: true});
}
