/**
 * `app` shim for dataviewjs (B3 adapter).
 *
 * Obsidian app API 的部分适配，非 1:1：only the AppShim surface in types.ts is
 * implemented (vault / metadataCache / workspace / meta). Everything resolves
 * against the index snapshot + config.io — no vscode import, no TFolder tree,
 * no resolve-cached links, no attachment/media handling. The integrator owns
 * the consolidated difference doc; this report lists what exists here.
 */
import type {AppShim, DvHostConfig, HeadingMeta, JsonValue, PageMeta} from "../types";

/** Page lookup key: posix slashes, "./" stripped, case-insensitive ".md" removed. */
function pathKey(p: string): string {
	const s = p.replace(/\\/g, "/").replace(/^\.\//, "");
	return /\.md$/i.test(s) ? s.slice(0, -3) : s;
}

function basenameOf(path: string): string {
	const base = path.substring(path.lastIndexOf("/") + 1);
	const dot = base.lastIndexOf(".");
	return dot > 0 ? base.slice(0, dot) : base;
}

export function createAppShim(config: DvHostConfig): AppShim {
	// 性能点：snapshot 的 path → PageMeta O(1) 查找表，shim 创建时构建一次。
	const byPath = new Map<string, PageMeta>();
	for (const meta of config.index.pages) byPath.set(pathKey(meta.path), meta);

	const find = (path: string): PageMeta | undefined => byPath.get(pathKey(path));

	return {
		vault: {
			getAbstractFileByPath(path: string): {path: string; name: string; basename?: string} | null {
				const meta = find(path);
				if (meta === undefined) return null;
				return {path: meta.path, name: meta.name, basename: basenameOf(meta.path)};
			},
			read(path: string): Promise<string> {
				return config.io.read(path.replace(/\\/g, "/").replace(/^\.\//, ""));
			},
			getFiles(): {path: string; name: string; basename?: string}[] {
				return config.index.pages.map((meta) => ({
					path: meta.path,
					name: meta.name,
					basename: basenameOf(meta.path),
				}));
			},
		},
		metadataCache: {
			getFileCache(path: string): {frontmatter?: Record<string, JsonValue>; headings?: HeadingMeta[]} | null {
				const meta = find(path);
				if (meta === undefined) return null;
				return {frontmatter: meta.frontmatter, headings: meta.headings};
			},
		},
		workspace: {
			getActiveFile(): {path: string} | null {
				return config.filePath ? {path: config.filePath} : null;
			},
		},
		meta: {adapter: "vscode", version: 1},
	};
}
