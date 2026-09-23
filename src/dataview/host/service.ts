/**
 * Dataview host service (Step C) — the single place that ties the index, the
 * sandbox pool, the render cache and the preview refresh loop together.
 *
 * Data flow for one ```dataviewjs block:
 *
 *   markdown-it render (sync)
 *     └─ fencePlugin → service.getBlock(env, kind, code)
 *          ├─ render cache hit  → {status:"ready",   html}   ← zero work
 *          ├─ in-flight         → {status:"pending", html}   ← dedup, no 2nd job
 *          └─ miss              → enqueue worker job, return {status:"pending"}
 *                                   ↓ (worker thread: vm + dv API)
 *                                 ExecResult{ops}
 *                                   ↓ host render (renderOpsToHtml) + cache
 *                                 throttled markdown.preview.refresh
 *                                   → next render is a cache hit
 *
 * Design constraints that shape the code:
 *   - `getBlock` MUST stay synchronous and MUST NOT throw (markdown-it render).
 *     Every failure path returns a placeholder or an error block.
 *   - `markdown.preview.refresh` is the only public API an extension has into the
 *     built-in preview, and it re-renders the whole document. Therefore refreshes
 *     are (a) coalesced by a debounce and (b) fired only when the current wave of
 *     blocks has fully settled, plus a stuck-wave safety net. A 20-block document
 *     costs 1 refresh, not 20.
 *   - Cache keys embed the index version, so file edits invalidate stale results
 *     without any explicit invalidation protocol; the LRU bound caps memory.
 *
 * No `vscode` import — editor specifics arrive through `DataviewServiceDeps`.
 */
import {LruCache} from "../cache/lru";
import {hashKey} from "../cache/hash";
import {createExecService} from "../exec/service";
import {recordMetric, increment} from "../perf/metrics";
import {renderErrorHtml, renderOpsToHtml, renderPlaceholderHtml} from "../render/html";
import {DV_BLOCK_LINE_ENV_KEY} from "../preview/fencePlugin";
import type {
	BlockResultProvider,
	BlockState,
	DataviewRenderEnv,
	ExecJob,
	ExecService,
	ExecStats,
	HostIo,
	IndexStore,
	RenderOp,
} from "../types";

/**
 * Fence languages this service handles. Note the mapping to the job protocol:
 * `dataview` (DQL) becomes `ExecJob.kind = "dql"`; `dataviewjs` stays as-is.
 */
export type DataviewBlockKind = "dataview" | "dataviewjs";

export interface DataviewServiceDeps {
	/** Absolute path of the bundled worker (`dist/dataviewWorker.js`). */
	workerPath: string;
	/** Index shared with the indexer. */
	store: IndexStore;
	/**
	 * Absolute fs path (from markdown-it env.currentDocument.fsPath) → workspace
	 * relative posix path. Return undefined when the document is outside the
	 * workspace (then blocks run with an empty page path).
	 */
	toRelativePath(fsPath: string | undefined): string | undefined;
	/** `markdown.preview.refresh` — injected so this module stays vscode-free. */
	refresh(): void;
	/** Host markdown renderer for cell text; usually `md.renderInline`. */
	renderInline?: (text: string) => string;
	/** Host BLOCK markdown renderer (`md.render`) for `dv.markdown` / block `dv.el`. */
	renderMarkdownBlock?: (text: string) => string;
	/** Render-behaviour settings (mirrors the Dataview settings that affect HTML). */
	renderSettings?: {
		renderNullAs?: string;
		dateFormat?: string;
		maxRenderDepth?: number;
		displayResultCount?: boolean;
	};
	/**
	 * Gate for block execution while the workspace index is still building.
	 * While this returns false, blocks return a pending placeholder WITHOUT
	 * running a job: a block executed against an empty index would produce a
	 * wrong ("No results") answer that the render cache would then keep serving.
	 */
	isIndexReady?: () => boolean;
	hostIo?: HostIo;
	log?: (level: "info" | "warn" | "error", message: string) => void;
	/** Default 5000. */
	timeoutMs?: number;
	/** DQL row cap + server-side table render cap. Default 1000. */
	maxRows?: number;
	/** Worker threads. Default 2 (preview blocks are bursty, not sustained). */
	poolSize?: number;
	/** Rendered block cache entries. Default 500. */
	cacheSize?: number;
	/** Coalescing window before a refresh may run. Default 120ms. */
	refreshDebounceMs?: number;
	/** Minimum spacing between two refreshes. Default 400ms. */
	refreshMinIntervalMs?: number;
	/** Blocks settled per progressive refresh while a wave is still running. Default 3. */
	refreshBatchSize?: number;
}

export interface DataviewServiceStats {
	indexVersion: number;
	cacheSize: number;
	cacheCapacity: number;
	cacheHitRate: number;
	inFlight: number;
	refreshes: number;
	skippedRefreshes: number;
	jobFailures: number;
	exec: ExecStats;
	avgJobMs: number;
	avgHostRenderMs: number;
}

export interface DataviewService extends BlockResultProvider {
	readonly indexVersion: number;
	/** Drops every cached block (setting changes, forced re-run). */
	invalidateAll(): void;
	/** Ask for a preview refresh (e.g. after the index finished bootstrapping). */
	requestRefresh(): void;
	stats(): DataviewServiceStats;
	dispose(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_ROWS = 1000;
/**
 * Worker threads. Also the batch size for blocks of one page: the exec scheduler
 * runs up to `min(poolSize, 3)` blocks of a document at once (see exec/service.ts).
 */
const DEFAULT_POOL_SIZE = 3;
const DEFAULT_CACHE_SIZE = 500;
const DEFAULT_REFRESH_DEBOUNCE_MS = 120;
const DEFAULT_REFRESH_MIN_INTERVAL_MS = 400;
/**
 * Refresh after this many blocks of the current wave settled, instead of waiting
 * for the slowest one: a document with many blocks shows results in batches.
 * The debounce/min-interval throttle still caps how often the preview re-renders.
 */
const DEFAULT_REFRESH_BATCH_SIZE = 3;
/** Safety net: refresh anyway if a wave stays unsettled this long (stuck worker). */
const STUCK_WAVE_MS = 3000;

interface PendingWave {
	/** jobId → cache key, so a settled job can be matched back. */
	jobs: Map<string, string>;
	since: number;
	/** Jobs settled since the last batch refresh was scheduled. */
	settledSinceRefresh: number;
}

export function createDataviewService(deps: DataviewServiceDeps): DataviewService {
	const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxRows = deps.maxRows ?? DEFAULT_MAX_ROWS;
	const cache = new LruCache<string, BlockState>(deps.cacheSize ?? DEFAULT_CACHE_SIZE);
	const log = deps.log ?? ((level, message) => {
		if (level === "error") console.error("[dataview]", message);
		else if (level === "warn") console.warn("[dataview]", message);
		else console.log("[dataview]", message);
	});

	const exec: ExecService = createExecService({
		workerPath: deps.workerPath,
		poolSize: deps.poolSize ?? DEFAULT_POOL_SIZE,
		defaultTimeoutMs: timeoutMs,
		hostIo: deps.hostIo,
	});

	let disposed = false;
	/** key → jobId; also the "this block is already running" set. */
	const inFlight = new Map<string, string>();
	let wave: PendingWave | null = null;
	let refreshTimer: ReturnType<typeof setTimeout> | null = null;
	let stuckTimer: ReturnType<typeof setTimeout> | null = null;
	let lastRefreshAt = 0;
	let refreshes = 0;
	let skippedRefreshes = 0;
	let jobFailures = 0;
	let hostRenderMsTotal = 0;
	let hostRenderCount = 0;
	let jobMsTotal = 0;
	let jobCount = 0;

	/** Snapshot cache: `store.snapshot()` is O(pages); never call it per block. */
	let snapshotVersion = -1;
	let snapshot: ReturnType<IndexStore["snapshot"]> | null = null;

	function currentSnapshot() {
		if (snapshot === null || snapshotVersion !== deps.store.version) {
			snapshot = deps.store.snapshot();
			snapshotVersion = snapshot.version;
			// Push to the pool once per version; the service caches the reference
			// so workers only receive a structured clone on version change.
			exec.ensureIndex(snapshot);
		}
		return snapshot;
	}

	function renderOptions(basePath: string) {
		return {
			basePath,
			maxRows,
			renderInline: deps.renderInline,
			renderMarkdownBlock: deps.renderMarkdownBlock,
			// Dataview render settings (defaults mirror upstream DEFAULT_SETTINGS).
			renderNullAs: deps.renderSettings?.renderNullAs ?? "-",
			dateFormat: deps.renderSettings?.dateFormat ?? "yyyy-MM-dd",
			maxRenderDepth: deps.renderSettings?.maxRenderDepth ?? 3,
		};
	}

	/**
	 * UX: optional "N results" badge (upstream `displayResultCount`). Counted from
	 * the ops we are about to render — no second pass over the data.
	 */
	function appendResultBadge(ops: RenderOp[]): RenderOp[] {
		if (deps.renderSettings?.displayResultCount !== true) return ops;
		let rows = 0;
		for (const op of ops) {
			if (op.kind === "table") rows += op.rows.filter((row) => row.group === undefined).length;
			else if (op.kind === "taskList") rows += op.tasks.length;
			else if (op.kind === "list") rows += op.items.length;
		}
		return [...ops, {kind: "badge", text: `${rows} result${rows === 1 ? "" : "s"}`}];
	}

	// --- refresh scheduling ---------------------------------------------------

	function clearRefreshTimers(): void {
		if (refreshTimer !== null) {
			clearTimeout(refreshTimer);
			refreshTimer = null;
		}
		if (stuckTimer !== null) {
			clearTimeout(stuckTimer);
			stuckTimer = null;
		}
	}

	function runRefresh(): void {
		clearRefreshTimers();
		if (disposed) return;
		const now = Date.now();
		const sinceLast = now - lastRefreshAt;
		const minInterval = deps.refreshMinIntervalMs ?? DEFAULT_REFRESH_MIN_INTERVAL_MS;
		if (sinceLast < minInterval) {
			// Throttled: keep the request pending, retry when the window opens.
			skippedRefreshes++;
			refreshTimer = setTimeout(runRefresh, minInterval - sinceLast);
			return;
		}
		lastRefreshAt = now;
		refreshes++;
		increment("dataview.refresh.count");
		try {
			deps.refresh();
		} catch (e) {
			log("error", `markdown.preview.refresh failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	/**
	 * Called when the last in-flight job of a wave settled: coalesce a beat so a
	 * document whose blocks finish close together (the common case) refreshes
	 * exactly once.
	 */
	function scheduleRefresh(): void {
		if (disposed || refreshTimer !== null) return;
		refreshTimer = setTimeout(runRefresh, deps.refreshDebounceMs ?? DEFAULT_REFRESH_DEBOUNCE_MS);
	}

	function startWave(jobId: string, key: string): void {
		if (wave === null) {
			wave = {jobs: new Map(), since: Date.now(), settledSinceRefresh: 0};
			// Safety net: a worker that never answers (host terminate races,
			// unexpected hangs) must not leave the preview spinning forever.
			stuckTimer = setTimeout(() => {
				stuckTimer = null;
				if (wave !== null && wave.jobs.size > 0) {
					log("warn", `dataview wave unsettled after ${STUCK_WAVE_MS}ms — refreshing with partial results`);
					wave = null;
					scheduleRefresh();
				}
			}, STUCK_WAVE_MS);
		}
		wave.jobs.set(jobId, key);
	}

	function settleWave(jobId: string): void {
		if (wave === null) return;
		wave.jobs.delete(jobId);
		if (wave.jobs.size === 0) {
			wave = null;
			clearRefreshTimers();
			scheduleRefresh();
			return;
		}
		// Progressive feedback: a finished batch refreshes right away (throttled)
		// instead of leaving the reader at placeholders until the slowest block of
		// the document is done. The final refresh still happens when the wave empties.
		wave.settledSinceRefresh += 1;
		if (wave.settledSinceRefresh >= (deps.refreshBatchSize ?? DEFAULT_REFRESH_BATCH_SIZE)) {
			wave.settledSinceRefresh = 0;
			scheduleRefresh();
		}
	}

	// --- block lookup ---------------------------------------------------------

	function enqueue(
		kind: DataviewBlockKind,
		code: string,
		basePath: string,
		blockLine: number,
		version: number,
		key: string,
		inline: boolean,
	): void {
		const snapshotRef = currentSnapshot();
		invokeJob({kind, code, basePath, blockLine, version, key, snapshotRef, inline});
	}

	function invokeJob(ctx: {
		kind: DataviewBlockKind;
		code: string;
		basePath: string;
		blockLine: number;
		version: number;
		key: string;
		snapshotRef: ReturnType<IndexStore["snapshot"]>;
		inline: boolean;
	}): void {
		const jobId = ctx.key;
		const job: ExecJob = {
			id: jobId,
			// Fence language → protocol kind: "dataview" blocks are DQL queries.
			// Inline spans reuse the same vocabulary but get their own kinds so the
			// worker can run them as expressions instead of op-emitting scripts.
			kind: ctx.inline
				? (ctx.kind === "dataview" ? "inline-dql" : "inline-js")
				: (ctx.kind === "dataview" ? "dql" : "dataviewjs"),
			code: ctx.code,
			pagePath: ctx.basePath,
			indexVersion: ctx.version,
			blockIndex: ctx.blockLine,
			timeoutMs,
		};
		inFlight.set(ctx.key, jobId);
		startWave(jobId, ctx.key);
		increment("dataview.job.count");

		exec.run(job).then(
			(result) => {
				inFlight.delete(ctx.key);
				jobCount++;
				jobMsTotal += result.durationMs;
				recordMetric("dataview.job.ms", result.durationMs);

				let state: BlockState;
				if (result.ok) {
					const t0 = performance.now();
					// Inline spans render the value only: a "(N results)" badge inside a
					// sentence is noise (upstream does the same).
					const html = renderOpsToHtml(
						ctx.inline ? result.ops : appendResultBadge(result.ops),
						renderOptions(ctx.basePath),
					);
					const renderMs = performance.now() - t0;
					hostRenderMsTotal += renderMs;
					hostRenderCount++;
					recordMetric("dataview.render.ms", renderMs);
					state = {status: "ready", html};
				} else {
					jobFailures++;
					increment("dataview.job.failure");
					const message = result.error?.message ?? "Dataview block failed";
					log("warn", `block ${ctx.basePath || "<untitled>"} @line ${ctx.blockLine}: ${message}`);
					state = {status: "error", html: renderErrorHtml(message, result.error?.detail)};
				}
				// Cache successes AND errors: an error block must not re-run on
				// every refresh (that would livelock the preview).
				cache.set(ctx.key, state);
				settleWave(jobId);
			},
			(e: unknown) => {
				// exec.run() never rejects, but this module must not depend on that
				// contract to stay alive: isolate and refresh instead.
				inFlight.delete(ctx.key);
				jobFailures++;
				log("error", `dataview job rejected unexpectedly: ${e instanceof Error ? e.message : String(e)}`);
				cache.set(ctx.key, {status: "error", html: renderErrorHtml("Dataview block failed unexpectedly")});
				settleWave(jobId);
			},
		);
	}

	/**
	 * Shared lookup for blocks and inline spans. `inline` only changes the cache
	 * namespace, the ops post-processing and the protocol job kind — everything
	 * else (index gating, dedup, wave accounting, error isolation) is identical,
	 * so an inline failure can never take down a code block and vice versa.
	 */
	function resolve(env: DataviewRenderEnv, kind: DataviewBlockKind, code: string, inline: boolean): BlockState {
		const basePath = deps.toRelativePath(env?.currentDocument?.fsPath) ?? "";
		// Inline spans have no source line; a constant block index is correct because
		// the cache key already carries the code itself (identical inline queries in
		// one document ARE the same job — dedup is desirable).
		const raw = env?.[DV_BLOCK_LINE_ENV_KEY];
		const blockLine = inline ? 0 : (typeof raw === "number" && Number.isFinite(raw) ? raw : 0);
		if (disposed) {
			return {status: "error", html: renderErrorHtml("Dataview service is disposed")};
		}

		// Index not ready yet: hold the block (placeholder, no job). Running it
		// against a half-built index would cache a wrong result — see
		// DataviewServiceDeps.isIndexReady.
		if (deps.isIndexReady && !deps.isIndexReady()) {
			increment("dataview.block.deferred");
			// A refresh when the index lands re-renders this block for real.
			scheduleRefresh();
			return {status: "pending", html: renderPlaceholderHtml(kind, "indexing")};
		}

		const version = deps.store.version;
		// Normalize before hashing so the cache key and the worker's source always
		// agree (markdown-it keeps the fence's trailing newline; inline code spans
		// are already trimmed by the renderer).
		const source = normalizeBlockCode(code);
		const key = hashKey(inline ? "dvi" : "dv", kind, basePath, String(version), source);
		const cached = cache.get(key);
		if (cached) {
			increment("dataview.cache.hit");
			return cached;
		}
		increment("dataview.cache.miss");
		if (inFlight.has(key)) {
			increment("dataview.cache.dedup");
			return {status: "pending", html: renderPlaceholderHtml(kind, key.slice(0, 12))};
		}

		try {
			enqueue(kind, source, basePath, blockLine, version, key, inline);
		} catch (e) {
			// Enqueue failures (bad worker path, config) must surface in the
			// document, not as a broken preview.
			const message = e instanceof Error ? e.message : String(e);
			const state: BlockState = {status: "error", html: renderErrorHtml(message)};
			cache.set(key, state);
			return state;
		}
		return {status: "pending", html: renderPlaceholderHtml(kind, key.slice(0, 12))};
	}

	return {
		/**
		 * Synchronous block entry point used by the markdown-it fence renderer.
		 * Never throws, never blocks: worst case it returns a pending placeholder.
		 */
		/**
		 * Synchronous block entry point used by the markdown-it fence renderer.
		 * Never throws, never blocks: worst case it returns a pending placeholder.
		 */
		getBlock(env: DataviewRenderEnv, kind: DataviewBlockKind, code: string): BlockState {
			return resolve(env, kind, code, false);
		},

		/**
		 * Inline form (`` `= expr` `` / `` `$= expr` ``). Same cache/dedup/wave
		 * machinery as blocks, separate key namespace so an inline query and a
		 * block with identical source never share a result.
		 */
		getInline(env: DataviewRenderEnv, kind: DataviewBlockKind, code: string): BlockState {
			return resolve(env, kind, code, true);
		},

		get indexVersion(): number {
			return deps.store.version;
		},

		invalidateAll(): void {
			cache.clear();
			snapshot = null;
			snapshotVersion = -1;
			increment("dataview.cache.invalidate");
		},

		requestRefresh(): void {
			scheduleRefresh();
		},

		stats(): DataviewServiceStats {
			const hits = cache.hitStats();
			return {
				indexVersion: deps.store.version,
				cacheSize: hits.size,
				cacheCapacity: hits.capacity,
				cacheHitRate: hits.hitRate,
				inFlight: inFlight.size,
				refreshes,
				skippedRefreshes,
				jobFailures,
				exec: exec.stats(),
				avgJobMs: jobCount === 0 ? 0 : jobMsTotal / jobCount,
				avgHostRenderMs: hostRenderCount === 0 ? 0 : hostRenderMsTotal / hostRenderCount,
			};
		},

		dispose(): Promise<void> {
			disposed = true;
			clearRefreshTimers();
			inFlight.clear();
			wave = null;
			// ExecService.dispose() resolves queued/in-flight jobs with an error
			// result and terminates the threads — no dangling worker processes.
			return exec.dispose();
		},
	};
}

/** Trim the trailing newline markdown-it keeps on fence content. */
export function normalizeBlockCode(code: string): string {
	return code.endsWith("\n") ? code.slice(0, -1) : code;
}
