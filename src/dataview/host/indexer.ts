/**
 * Workspace indexer (Step C): full bootstrap + incremental updates.
 *
 * Layering: this file depends on the `WorkspaceFileSystem` port, never on
 * `vscode`. `host/vscodeFs.ts` supplies the VSCode implementation (workspace
 * findFiles + `workspace.fs` + FileSystemWatcher); tests supply a fake, which
 * is what makes the real indexer under test instead of a mock of it.
 *
 * Incremental strategy (the whole point):
 *   - Bootstrap parses every markdown file once, N-way concurrent (default 8).
 *   - Watcher events are coalesced per path (last event wins) and flushed after
 *     a debounce window, so a save-storm on one file costs exactly one parse.
 *   - Parse results feed `IndexStore.upsertFile`, which itself short-circuits on
 *     unchanged (mtime, size) and only re-links affected inlinks — so a one-file
 *     change stays O(1 file + its links), not O(repo).
 *   - Deletions go through `removeFile`, which also detaches the page from the
 *     tag/folder/outlink reverse indexes.
 *
 * Everything is cancellation-safe via `dispose()`: pending debounce timers are
 * cleared and the watcher is closed, so a deactivating extension cannot wake up
 * to mutate a disposed store.
 */
import {recordMetric} from "../perf/metrics";
import type {IndexStore, IndexStats} from "../types";

export interface WorkspaceFileEntry {
	/** Workspace-relative posix path, e.g. "notes/a.md". */
	path: string;
}

export interface WorkspaceStat {
	mtimeMs: number;
	size: number;
}

export type WorkspaceWatchEvent = {kind: "create" | "change" | "delete"; path: string};

/**
 * Port over the editor's file system. Implementations MUST:
 *   - return workspace-relative posix paths ("" for the workspace root),
 *   - reject on read failures (the indexer isolates per-file errors).
 */
export interface WorkspaceFileSystem {
	listMarkdownFiles(): Promise<WorkspaceFileEntry[]>;
	readFile(path: string): Promise<string>;
	stat(path: string): Promise<WorkspaceStat>;
	createWatcher(onEvent: (event: WorkspaceWatchEvent) => void): {dispose(): void};
}

export interface IndexerStats extends IndexStats {
	files: number;
	bootstrapped: boolean;
	bootstrapMs: number;
	/** Files parsed by the last incremental flush. */
	lastFlushPaths: number;
	lastFlushMs: number;
	watcherActive: boolean;
}

export interface IndexerOptions {
	/** Parallel file reads during bootstrap. Default 8. */
	concurrency?: number;
	/** Watcher coalescing window. Default 150ms. */
	debounceMs?: number;
	/** Called once per flush with the resulting store version. */
	onIndexChanged?: (info: {version: number; paths: string[]}) => void;
	onError?: (error: unknown) => void;
}

export interface WorkspaceIndexer {
	readonly store: IndexStore;
	/** Bootstrap (idempotent) + start watching. Resolves when the index is ready. */
	start(): Promise<void>;
	/** Bootstrap without watching — used by tests and by lazy activation. */
	bootstrap(): Promise<void>;
	/** Force re-read of a single path (used when a preview opens). */
	refresh(path: string): Promise<void>;
	stats(): IndexerStats;
	dispose(): void;
}

const DEFAULT_CONCURRENCY = 8;
const DEFAULT_DEBOUNCE_MS = 150;

/** Runs `worker` over `items` with a bounded number of in-flight promises. */
async function forEachConcurrent<T>(
	items: readonly T[],
	concurrency: number,
	worker: (item: T) => Promise<void>,
): Promise<void> {
	if (items.length === 0) return;
	let next = 0;
	const runners: Promise<void>[] = [];
	const lanes = Math.max(1, Math.min(concurrency, items.length));
	for (let lane = 0; lane < lanes; lane++) {
		runners.push((async () => {
			for (;;) {
				const i = next++;
				if (i >= items.length) return;
				await worker(items[i]!);
			}
		})());
	}
	await Promise.all(runners);
}

export function createWorkspaceIndexer(
	fs: WorkspaceFileSystem,
	store: IndexStore,
	options: IndexerOptions = {},
): WorkspaceIndexer {
	const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
	const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;

	let watcher: {dispose(): void} | null = null;
	let disposed = false;
	let bootstrapped = false;
	let bootstrapMs = 0;
	let bootstrapPromise: Promise<void> | null = null;

	/** Coalesced watcher events: path → latest kind (a delete after a write wins). */
	const dirty = new Map<string, WorkspaceWatchEvent["kind"]>();
	let flushTimer: ReturnType<typeof setTimeout> | null = null;
	let lastFlushPaths = 0;
	let lastFlushMs = 0;

	const report = (error: unknown): void => {
		if (options.onError) {
			options.onError(error);
			return;
		}
		console.error("[dataview/indexer]", error);
	};

	/** Read one file into the store; a vanished file is treated as a delete. */
	async function readInto(path: string): Promise<void> {
		try {
			const [content, stat] = await Promise.all([fs.readFile(path), fs.stat(path)]);
			store.upsertFile(path, content, stat.mtimeMs, stat.size);
		} catch (e) {
			// Deleted between event and read (common on rename): drop it from the
			// index instead of failing the whole flush.
			if (disposed) return;
			if (store.getPage(path)) {
				store.removeFile(path);
			} else {
				report(e);
			}
		}
	}

	async function flush(): Promise<void> {
		if (disposed) return;
		const t0 = performance.now();
		const entries = [...dirty.entries()];
		dirty.clear();

		const upserts: string[] = [];
		const deletes: string[] = [];
		for (const [path, kind] of entries) {
			if (kind === "delete") deletes.push(path);
			else upserts.push(path);
		}
		// Deletes first: a rename shows up as delete+create, and removing first
		// keeps the reverse indexes clean before the new page links in.
		for (const path of deletes) store.removeFile(path);
		await forEachConcurrent(upserts, concurrency, readInto);
		if (disposed) return;

		lastFlushPaths = entries.length;
		lastFlushMs = performance.now() - t0;
		recordMetric("dataview.index.incremental", lastFlushMs);
		options.onIndexChanged?.({version: store.version, paths: entries.map(([p]) => p)});
	}

	function scheduleFlush(): void {
		if (disposed || flushTimer !== null) return;
		flushTimer = setTimeout(() => {
			flushTimer = null;
			void flush().catch(report);
		}, debounceMs);
	}

	async function bootstrap(): Promise<void> {
		if (bootstrapped) return;
		if (bootstrapPromise) return bootstrapPromise;
		bootstrapPromise = (async () => {
			const t0 = performance.now();
			const files = await fs.listMarkdownFiles();
			if (disposed) return;
			let failures = 0;
			await forEachConcurrent(files, concurrency, async (file) => {
				try {
					const [content, stat] = await Promise.all([fs.readFile(file.path), fs.stat(file.path)]);
					store.upsertFile(file.path, content, stat.mtimeMs, stat.size);
				} catch (e) {
					failures++;
					report(e);
				}
			});
			if (disposed) return;
			bootstrapMs = performance.now() - t0;
			bootstrapped = true;
			recordMetric("dataview.index.bootstrap", bootstrapMs);
			if (failures > 0) {
				console.warn(`[dataview/indexer] bootstrap skipped ${failures} unreadable file(s)`);
			}
			options.onIndexChanged?.({version: store.version, paths: files.map((f) => f.path)});
		})();
		return bootstrapPromise;
	}

	return {
		store,
		bootstrap,
		async start(): Promise<void> {
			if (disposed) return;
			await bootstrap();
			if (disposed || watcher) return;
			watcher = fs.createWatcher((event) => {
				if (disposed) return;
				// Last event wins (a saved file that was then deleted shouldn't be read).
				dirty.set(event.path, event.kind);
				scheduleFlush();
			});
		},
		async refresh(path: string): Promise<void> {
			if (disposed) return;
			dirty.set(path, "change");
			await flush();
		},
		stats(): IndexerStats {
			return {
				...store.stats(),
				bootstrapped,
				bootstrapMs,
				lastFlushPaths,
				lastFlushMs,
				watcherActive: watcher !== null,
			};
		},
		dispose(): void {
			disposed = true;
			if (flushTimer !== null) {
				clearTimeout(flushTimer);
				flushTimer = null;
			}
			dirty.clear();
			watcher?.dispose();
			watcher = null;
		},
	};
}
