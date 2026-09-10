/**
 * Wikilink support: suggestion data source ([[ autocomplete) and target
 * resolution for the column editor webview.
 *
 * VSCode has no native wikilink concept; we treat [[target]] as a
 * workspace-relative markdown path, matching Obsidian's common resolution
 * rules: exact file, file.md, folder/index or folder.
 */
import * as vscode from "vscode";
import {parseWikilinkTarget} from "./core/wikilink";

/** Workspace markdown-file cache keyed by the configured workspace folders. */
let cache: {key: string; files: string[]} | null = null;
let filesPromise: Promise<string[]> | null = null;

/** Invalidate suggestions after workspace files change. */
export function invalidateWikilinkCache(): void {
	cache = null;
	filesPromise = null;
}

function cacheKey(): string {
	const folders = vscode.workspace.workspaceFolders ?? [];
	return folders.map((f) => f.uri.fsPath).join("|");
}

async function findMarkdownFiles(): Promise<string[]> {
	const uris = await vscode.workspace.findFiles("**/*.md", "**/{node_modules,.git}/**");
	return uris.map((uri) => vscode.workspace.asRelativePath(uri, false));
}

/** Refresh the markdown file cache. Cheap: workspace markdown files are
 *  usually a few hundred at most; refresh is debounced by callers. */
export async function refreshWikilinkCache(): Promise<string[]> {
	const key = cacheKey();
	const files = [...new Set(await findMarkdownFiles())].sort((a, b) => a.localeCompare(b));
	cache = {key, files};
	return files;
}

export async function getMarkdownFiles(): Promise<string[]> {
	const key = cacheKey();
	if (cache && cache.key === key) return cache.files;
	if (!filesPromise) filesPromise = refreshWikilinkCache();
	return filesPromise;
}

/** Strip the `.md` extension (Obsidian-style suggestion label). */
export function wikilinkLabel(relativePath: string): string {
	return relativePath.replace(/\.md$/i, "");
}

/** Resolve a [[target]] to a workspace file URI, or null. */
export async function resolveWikilinkTarget(rawTarget: string): Promise<vscode.Uri | null> {
	const {target} = parseWikilinkTarget(rawTarget);
	const normalized = target.replaceAll("\\\\", "/").replace(/^\.\//, "");
	if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) return null;
	const candidates = new Set([normalized, `${normalized}.md`, `${normalized}/index.md`]);
	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		for (const candidate of candidates) {
			const uri = vscode.Uri.joinPath(folder.uri, candidate);
			try {
				const stat = await vscode.workspace.fs.stat(uri);
				if (stat.type === vscode.FileType.File) return uri;
			} catch {
				// Try the next candidate or workspace folder.
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
