/**
 * VSCode adapters for the (vscode-free) dataview host layer.
 *
 * Everything editor-specific lives here:
 *   - `WorkspaceFileSystem` over `workspace.findFiles` / `workspace.fs` /
 *     FileSystemWatcher (works for remote + virtual file systems, unlike
 *     node:fs, which the worker's `HostIo` cannot avoid — see the difference
 *     docs for the remote-workspace caveat).
 *   - fsPath → workspace-relative posix path (the canonical page key used by
 *     the index, the cache and page lookups).
 *   - `dist/dataviewWorker.js` resolution.
 *
 * Only this file (and extension.ts) may import `vscode`; keeping it thin is what
 * makes indexer/service/worker unit-testable under `node --test`.
 */
import * as vscode from "vscode";
import type {HostIo} from "../types";
import type {WorkspaceFileEntry, WorkspaceFileSystem, WorkspaceStat, WorkspaceWatchEvent} from "./indexer";

/** Bundled worker entry (esbuild output, sibling of extension.js). */
export const DATAVIEW_WORKER_FILE = "dataviewWorker.js";

export function resolveWorkerPath(context: vscode.ExtensionContext): string {
	return vscode.Uri.joinPath(context.extensionUri, "dist", DATAVIEW_WORKER_FILE).fsPath;
}

/** Normalizes to posix and strips the leading "./" so keys compare reliably. */
function normalizeRel(p: string): string {
	return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Absolute fs path → workspace-relative posix path.
 * Returns undefined when the document is not inside any workspace folder
 * (untitled buffers, files opened from outside) — callers then run the block
 * with an empty page path instead of inventing one.
 */
export function toRelativeDocPath(fsPath: string | undefined): string | undefined {
	if (!fsPath) return undefined;
	const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(fsPath));
	if (!folder) return undefined;
	const rel = vscode.workspace.asRelativePath(vscode.Uri.file(fsPath), false);
	return normalizeRel(rel);
}

/** Workspace-relative posix path → Uri (multi-root aware, first folder as base). */
function resolveWorkspaceUri(relPath: string): vscode.Uri {
	const folders = vscode.workspace.workspaceFolders;
	const rel = normalizeRel(relPath);
	if (!folders || folders.length === 0) {
		return vscode.Uri.file(rel);
	}
	if (folders.length > 1) {
		const head = rel.split("/")[0] ?? "";
		const match = folders.find((f) => f.name === head);
		if (match) {
			const rest = rel.slice(head.length + 1);
			return rest === "" ? match.uri : vscode.Uri.joinPath(match.uri, ...rest.split("/"));
		}
	}
	return vscode.Uri.joinPath(folders[0]!.uri, ...rel.split("/").filter((s) => s !== ""));
}

export function createVscodeWorkspaceFs(options: {
	/** Exclude glob (setting-driven, read per call so toggling needs no reload). */
	exclude: () => string;
	maxFiles?: number;
}): WorkspaceFileSystem {
	const maxFiles = options.maxFiles ?? 50000;
	return {
		async listMarkdownFiles(): Promise<WorkspaceFileEntry[]> {
			// findFiles already skips the default excludes (node_modules/.git) unless
			// configured otherwise; the extra exclude comes from settings.
			const uris = await vscode.workspace.findFiles("**/*.md", options.exclude(), maxFiles);
			return uris.map((uri) => ({path: normalizeRel(vscode.workspace.asRelativePath(uri, false))}));
		},
		async readFile(path: string): Promise<string> {
			const bytes = await vscode.workspace.fs.readFile(resolveWorkspaceUri(path));
			return new TextDecoder().decode(bytes);
		},
		async stat(path: string): Promise<WorkspaceStat> {
			const stat = await vscode.workspace.fs.stat(resolveWorkspaceUri(path));
			return {mtimeMs: stat.mtime, size: stat.size};
		},
		createWatcher(onEvent: (event: WorkspaceWatchEvent) => void): {dispose(): void} {
			const watcher = vscode.workspace.createFileSystemWatcher("**/*.md");
			const subs: vscode.Disposable[] = [
				watcher.onDidCreate((uri) => onEvent({kind: "create", path: normalizeRel(vscode.workspace.asRelativePath(uri, false))})),
				watcher.onDidChange((uri) => onEvent({kind: "change", path: normalizeRel(vscode.workspace.asRelativePath(uri, false))})),
				watcher.onDidDelete((uri) => onEvent({kind: "delete", path: normalizeRel(vscode.workspace.asRelativePath(uri, false))})),
			];
			return {
				dispose() {
					for (const sub of subs) sub.dispose();
					watcher.dispose();
				},
			};
		},
	};
}

/**
 * `dv.io.load/read` + `app.vault.read` implementation.
 * Async by contract (the worker awaits a host round-trip), so no sync IO ever
 * happens on the extension host thread.
 */
export function createVscodeHostIo(): HostIo {
	return {
		async read(path: string): Promise<string> {
			const bytes = await vscode.workspace.fs.readFile(resolveWorkspaceUri(path));
			return new TextDecoder().decode(bytes);
		},
		async exists(path: string): Promise<boolean> {
			try {
				await vscode.workspace.fs.stat(resolveWorkspaceUri(path));
				return true;
			} catch {
				return false;
			}
		},
	};
}
