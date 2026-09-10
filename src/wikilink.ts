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

/** Simple cache keyed by workspace folder + file tree mtime. */
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
	const folders = vscode.workspace.workspaceFolders ?? [];
	return uris.map((uri) => {
		const folder = vscode.workspace.getWorkspaceFolder?.(uri);
		return folder ? vscode.workspace.asRelativePath(uri, false) : uri.path;
	}).filter((file) => folders.length === 0 || file.toLowerCase().endsWith(".md"));
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
	if (!target || target.startsWith("/") || target.includes("..")) return null;
	const files = await getMarkdownFiles();
	const normalized = target.replaceAll("\\\\", "/").replace(/^\.\//, "");
	const candidates = new Set([normalized, `${normalized}.md`, `${normalized}/index.md`]);
	const match = files.find((file) => candidates.has(file) || file.replace(/\.md$/i, "") === normalized);
	if (!match) return null;
	const folder = vscode.workspace.workspaceFolders?.[0];
	return folder ? vscode.Uri.joinPath(folder.uri, match) : null;
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
