/**
 * Worker-side dataviewjs / DQL runtime (Step C integration).
 *
 * Owns ONLY business execution — the message plumbing lives in
 * `workerBridge.ts` (which calls `runJob` with a frozen index snapshot and an
 * async IO bridge). This file imports no `vscode`, so the whole dataview stack
 * stays bundleable into a standalone worker script
 * (`src/dataview/exec/workerEntry.ts` → `dist/dataviewWorker.js`).
 *
 * Execution model / isolation boundary (READ BEFORE TRUSTING THIS):
 *   - User code runs inside a fresh `node:vm` context per job. That is a
 *     *correctness* boundary (no `require`/`process`/`module` leak, per-job
 *     global isolation), NOT a hostile-code sandbox: `vm` is documented as
 *     "not a security mechanism". The real availability boundary is the
 *     worker thread + host-side `terminate()` on timeout (see exec/service.ts).
 *   - `codeGeneration: {strings:false, wasm:false}` blocks `eval`/`new
 *     Function`/wasm compilation inside the context, which also closes the
 *     classic host-function-constructor escape (`this.constructor.constructor`).
 *   - Dynamic `import()` is denied (no module loader reaches the host FS).
 *   - Sync runaway (`while(true){}`) is caught by the *host*: the worker is
 *     terminated and respawned; a `vm` timeout is additionally passed so the
 *     pre-first-await portion fails fast without burning a thread respawn when
 *     possible.
 *
 * Performance notes (measured by test/dataview-perf.test.mjs on a 1000-page
 * synthetic workspace — numbers are from that run, not estimates):
 *   - A page-object memo lives in `page.ts`: it removed ~2.4ms per
 *     `dv.pages()` scan (~50% of a typical job) by not rebuilding every page
 *     object per block.
 *   - The snapshot→path lookup is memoized per snapshot object, so `dv.current()`
 *     no longer walks all 1000 pages per job.
 *   - The compiled-script cache below is a MICRO-optimization: `new vm.Script`
 *     of a ~130B block measures ~3.3µs, vs ~1.9ms of fixed per-job cost (vm
 *     context + dv API + shim). It is kept because it costs one Map lookup and
 *     scales with block size (`payloadMaxBytes`-sized blocks compile ~4µs), but
 *     it is NOT the main cost — do not cite it as such.
 *   - Timers created by user code are tracked per job and cleared on settle, so
 *     a fire-and-forget `setTimeout` cannot keep running after the block's
 *     result was already delivered (resource release).
 *   - Emitted ops are capped (MAX_OPS) so a runaway loop producing blocks
 *     cannot flood the postMessage channel / host memory.
 */
import {createContext, Script} from "node:vm";
import {createAppShim} from "../adapter/shim";
import {LruCache} from "../cache/lru";
import {hashKey} from "../cache/hash";
import {createDvApi} from "../dv/createDvApi";
import {buildHeatmapOp} from "../dv/heatmapCalendar";
import {createMomentGlobal} from "../dv/moment";
import {DvFunctions} from "../query/functions";
import {evaluateExpression, executeDql, parseDql} from "../query";
import {buildPageScope} from "../page";
import {formatDurationMs, isDataArray, isDvDate, isDuration, isLink} from "../values";
import {startWorker} from "./workerBridge";
import type {
	DvHostConfig,
	ExecJob,
	DvValue,
	ExecResult,
	IndexSnapshot,
	IoBridge,
	OpSink,
	PageMeta,
	RenderOp,
	WorkerRuntimeDeps,
} from "../types";

/** Hard cap on emitted RenderOps per job (flood guard). */
export const MAX_OPS = 4096;
/** DQL row cap used when the host does not override it. */
export const DEFAULT_MAX_ROWS = 1000;
/**
 * Inline scripts are wrapped so the LAST EXPRESSION value is returned — that is
 * what `eval()`-based upstream evaluation yields for `` `$= expr ` ``.
 * Statement-only inlines (e.g. `let x = 1; ...`) fall back to the block wrapper
 * and render nothing, matching "the result should be something which evaluates
 * to a JavaScript value".
 */
const INLINE_EXPR_HEAD = '(async () => {\n"use strict";\nreturn (';
const INLINE_EXPR_TAIL = '\n);})()';

/** Compiled-script cache size (blocks are re-executed on every refresh). */
const SCRIPT_CACHE_SIZE = 64;
/** Wrapper prefix: `"use strict"` mirrors Obsidian's module-level strictness. */
const WRAP_HEAD = '(async () => {\n"use strict";\n';
const WRAP_TAIL = "\n})()";
/** Lines added before user code by WRAP_HEAD — stack line numbers are shifted by this. */
const WRAP_LINE_OFFSET = 2;

function pathKey(p: string): string {
	const s = p.replace(/\\/g, "/").replace(/^\.\//, "");
	return /\.md$/i.test(s) ? s.slice(0, -3) : s;
}

/** O(1) page lookup: raw path + extension-less key both resolve. */
function findCurrentPage(snapshot: IndexSnapshot, pagePath: string): PageMeta | undefined {
	if (!pagePath) return undefined;
	// Perf: the lookup map is memoized per snapshot object. A linear scan here
	// ran on EVERY job (1000 path comparisons per block); the snapshot object is
	// stable for a given index version, so a WeakMap keys the cache lifetime to
	// exactly that version (no invalidation bookkeeping, no leak).
	let lookup = snapshotLookup.get(snapshot);
	if (!lookup) {
		lookup = new Map<string, PageMeta>();
		for (const page of snapshot.pages) {
			lookup.set(page.path, page);
			lookup.set(pathKey(page.path), page);
		}
		snapshotLookup.set(snapshot, lookup);
	}
	return lookup.get(pagePath) ?? lookup.get(pathKey(pagePath));
}

/** WeakMap<snapshot, path→PageMeta> — lives as long as the snapshot does. */
const snapshotLookup = new WeakMap<IndexSnapshot, Map<string, PageMeta>>();

/**
 * Moment-compatible `moment` global. Obsidian ships Moment and exposes it
 * app-wide, so dataviewjs snippets call `moment("2024-01-15").format(...)`
 * directly; the facade is stateless (one instance serves every block).
 */
const momentGlobal = createMomentGlobal();

/**
 * Re-maps synthetic-file stack lines back to user code lines.
 * The wrapper adds WRAP_LINE_OFFSET lines, so `file:12:3` → `file:10:3`.
 * Only lines referring to this job's synthetic filename are touched.
 */
export function adjustStackLines(stack: string, fileLabel: string): string {
	// V8 may report a script filename with a `.js` suffix appended, so both the
	// bare and the suffixed form are matched; a miss silently leaves the WRAPPED
	// line number in the user-facing stack, which points 2 lines too far down.
	const needles = [fileLabel + ".js:", fileLabel + ":"];
	return stack
		.split("\n")
		.map((line) => {
			let at = -1;
			let needleLen = 0;
			for (const needle of needles) {
				const i = line.indexOf(needle);
				if (i >= 0) {
					at = i;
					needleLen = needle.length;
					break;
				}
			}
			if (at < 0) return line;
			const rest = line.slice(at + needleLen);
			const m = /^(\d+)(:\d+)/.exec(rest);
			if (!m) return line;
			const lineNo = Number(m[1]) - WRAP_LINE_OFFSET;
			if (lineNo < 1) return line; // wrapper frame itself → leave as-is
			return line.slice(0, at + needleLen) + String(lineNo) + rest.slice(m[1].length);
		})
		.join("\n");
}

/**
 * Cross-realm accessor: an `Error` constructed inside the `vm` context is NOT
 * `instanceof` this realm's `Error`, so `instanceof` degraded every user-thrown
 * error to `String(err)` ("Error: boom") and dropped its stack entirely.
 * Reading `message`/`stack` by shape works for both realms.
 */
function errorShape(err: unknown): {message: string; stack?: string} {
	const e = err as {message?: unknown; stack?: unknown} | null;
	const hasMessage = e !== null && typeof e === "object" && typeof e.message === "string";
	const message = hasMessage ? (e!.message as string) : String(err);
	const stack = e !== null && typeof e === "object" && typeof e.stack === "string" ? e.stack : undefined;
	return stack === undefined ? {message} : {message, stack};
}

function errorResult(job: ExecJob, err: unknown, startedAt: number, fileLabel: string): ExecResult {
	const {message, stack} = errorShape(err);
	return {
		id: job.id,
		ok: false,
		ops: [],
		error: stack === undefined ? {message} : {message, detail: adjustStackLines(stack, fileLabel)},
		durationMs: Date.now() - startedAt,
		indexVersion: job.indexVersion,
	};
}

/** Per-job timer registry: every handle is released when the job settles. */
function createTimers() {
	const handles = new Set<ReturnType<typeof setTimeout>>();
	const intervals = new Set<ReturnType<typeof setInterval>>();
	return {
		setTimeout: (fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
			const h = setTimeout(() => {
				handles.delete(h);
				try {
					fn(...args);
				} catch (e) {
					console.error("[dataview/worker] user setTimeout callback threw:", e);
				}
			}, ms);
			handles.add(h);
			return h;
		},
		clearTimeout: (h: ReturnType<typeof setTimeout>) => {
			handles.delete(h);
			clearTimeout(h);
		},
		setInterval: (fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
			const h = setInterval(() => {
				try {
					fn(...args);
				} catch (e) {
					console.error("[dataview/worker] user setInterval callback threw:", e);
				}
			}, ms);
			intervals.add(h);
			return h;
		},
		clearInterval: (h: ReturnType<typeof setInterval>) => {
			intervals.delete(h);
			clearInterval(h);
		},
		/** Release everything — a detached `setInterval` must not outlive its block. */
		releaseAll: () => {
			for (const h of handles) clearTimeout(h);
			for (const h of intervals) clearInterval(h);
			handles.clear();
			intervals.clear();
		},
	};
}

function compileScript(code: string, fileLabel: string, cache: LruCache<string, Script>): Script {
	const key = hashKey(fileLabel, code);
	const hit = cache.get(key);
	if (hit) return hit;
	const script = new Script(WRAP_HEAD + code + WRAP_TAIL, {
		filename: fileLabel,
		// Deny dynamic import(): no module loader may reach the host FS.
		importModuleDynamically: () => {
			throw new Error("Dynamic import() is not available inside dataviewjs blocks.");
		},
	});
	cache.set(key, script);
	return script;
}

interface DataviewJsDeps {
	scriptCache: LruCache<string, Script>;
	maxRows: number;
	/** Render-default snapshot exposed as `dv.settings` (see createRunJob opts). */
	settings?: {
		renderNullAs?: string;
		dateFormat?: string;
		maxRenderDepth?: number;
		displayResultCount?: boolean;
	};
}

/**
 * Inline DQL (`` `= expr ` ``): evaluate ONE expression against the current page
 * and render its value as a single span (upstream `executeInline`).
 */
function runInlineDql(job: ExecJob, snapshot: IndexSnapshot, sink: OpSink): void {
	const meta = findCurrentPage(snapshot, job.pagePath);
	const scope: Record<string, unknown> = meta ? buildPageScope(meta) : Object.create(null);
	const value = evaluateExpression(job.code, scope);
	sink.push({kind: "span", text: valueToInlineText(value)});
}

/** Value → the text of an inline span (links/dates/durations use display forms). */
export function valueToInlineText(value: DvValue): string {
	if (value === null || value === undefined) return "";
	if (isLink(value)) {
		// Inline expressions show the target the way Obsidian does: display name or
		// path, WITHOUT brackets (upstream renderValue for a Link inside inline JS
		// delegates to markdown, but a span keeps the display text here).
		return value.display ?? value.path;
	}
	if (isDuration(value)) return formatDurationMs(value.ms);
	if (isDvDate(value)) return value.toFormat("yyyy-MM-dd");
	if (Array.isArray(value)) return value.map((v) => valueToInlineText(v as DvValue)).join(", ");
	if (isDataArray(value)) return (value as {array(): DvValue[]}).array().map((v) => valueToInlineText(v)).join(", ");
	if (typeof value === "object") {
		return Object.entries(value as Record<string, DvValue>)
			.map(([k, v]) => `${k}: ${valueToInlineText(v)}`)
			.join(", ");
	}
	return String(value);
}

/**
 * Inline JS (`` `$= expr ` ``): run in the same sandbox as a block, but return
 * the expression's value. A syntax error on the expression wrapper means the
 * source is a statement list → run it as a block and render nothing.
 */
async function runInlineJs(
	job: ExecJob,
	snapshot: IndexSnapshot,
	io: IoBridge,
	sink: OpSink,
	deps: DataviewJsDeps,
): Promise<void> {
	const fileLabel = `${job.pagePath || "<untitled>"}#inline-js-${job.blockIndex}`;
	const cacheKey = hashKey("inlineJs", fileLabel, job.code);
	const cached = deps.scriptCache.get(cacheKey);
	let script: Script;
	let asExpression: boolean;
	if (cached) {
		script = cached;
		asExpression = true;
	} else {
		try {
			// Expression wrapper first: eval() semantics return the LAST value, which
			// is what an inline `` `$= expr ` `` displays.
			script = new Script(INLINE_EXPR_HEAD + job.code + INLINE_EXPR_TAIL, {filename: fileLabel});
			asExpression = true;
		} catch {
			// Statement list (e.g. `let x = 1; dv.span(x)`): run it as a block; there is
			// no expression value to render, exactly like upstream returning undefined.
			script = new Script(WRAP_HEAD + job.code + WRAP_TAIL, {filename: fileLabel});
			asExpression = false;
		}
		deps.scriptCache.set(cacheKey, script);
	}

	const sandbox = createSandbox(job, snapshot, io, deps, fileLabel, sink);
	try {
		const value = await sandbox.run(script, job.timeoutMs);
		if (asExpression && value !== undefined) {
			sink.push({kind: "span", text: valueToInlineText(value as DvValue)});
		}
	} finally {
		sandbox.release();
	}
}

/**
 * Builds the per-job sandbox: a fresh vm context holding `dv`/`app`/`input`, the
 * nested-script runner (dv.view / dv.executeJs) and the job's timer registry.
 * Shared by code blocks and inline JS so both get identical isolation, timeout
 * semantics and resource release.
 */
interface JobSandbox {
	dv: unknown;
	/** Runs a compiled script inside the context and returns its awaited value. */
	run(script: Script, timeoutMs: number): Promise<unknown>;
	/** Releases user-created timers (called in a `finally`). */
	release(): void;
}

function createSandbox(
	job: ExecJob,
	snapshot: IndexSnapshot,
	io: IoBridge,
	deps: DataviewJsDeps,
	fileLabel: string,
	sink: OpSink,
): JobSandbox {
	const timers = createTimers();
	const config: DvHostConfig = {
		index: snapshot,
		current: findCurrentPage(snapshot, job.pagePath),
		input: job.code,
		filePath: job.pagePath,
		io,
		funcs: DvFunctions as DvHostConfig["funcs"],
		// Worker-side `dv.settings` snapshot. Rendering happens on the HOST (which
		// uses the real extension settings): these are upstream defaults, kept so
		// `dv.settings.renderNullAs` reads sensibly inside user code.
		settings: {
			renderNullAs: deps.settings?.renderNullAs ?? "-",
			dateFormat: deps.settings?.dateFormat ?? "yyyy-MM-dd",
			maxRenderDepth: deps.settings?.maxRenderDepth ?? 3,
			displayResultCount: deps.settings?.displayResultCount ?? false,
		},
	};
	const dv = createDvApi(config, sink);

	const context = createContext(
		{
			dv,
			dataview: dv,
			app: createAppShim(config),
			input: job.code,
			// The Heatmap Calendar plugin (Obsidian) publishes this as a *global*, so
			// vault snippets call `renderHeatmapCalendar(this.container, data)`. The
			// container is ignored: the sandbox has no DOM, the emitted op renders
			// into the block (same contract as `dv.container`).
			renderHeatmapCalendar: (_container: unknown, data: unknown): void => {
				sink.push(buildHeatmapOp(data));
			},
			// Obsidian exposes Moment app-wide (`obsidian.d.ts`), so `moment(...)`
			// works in dataviewjs blocks and inline `$=` queries alike.
			moment: momentGlobal,
			console,
			setTimeout: timers.setTimeout,
			clearTimeout: timers.clearTimeout,
			setInterval: timers.setInterval,
			clearInterval: timers.clearInterval,
		},
		{name: fileLabel, codeGeneration: {strings: false, wasm: false}},
	);

	/*
	 * Nested script execution (upstream `dv.view` / `dv.executeJs`).
	 * Runs INSIDE the same vm context so it shares the sandbox boundary, and is
	 * handed the same `dv` instance (createDvApi tracks view depth on it, which is
	 * what stops `view → view → …` at its documented depth limit).
	 */
	config.runNested = async (code: string, input: DvValue, depth: number): Promise<DvValue | undefined> => {
		const nestedLabel = `${fileLabel}#nested-${depth}`;
		const source = '(async (dv, input) => {\n"use strict";\n' + code + "\n})";
		const script = new Script(source, {
			filename: nestedLabel,
			importModuleDynamically: () => {
				throw new Error("Dynamic import() is not available inside dataviewjs blocks.");
			},
		});
		const factory = script.runInContext(context, {
			timeout: job.timeoutMs > 0 ? job.timeoutMs : undefined,
			displayErrors: false,
		}) as (a: unknown, b: unknown) => Promise<unknown>;
		return (await factory(dv, input)) as DvValue | undefined;
	};

	return {
		dv,
		async run(script: Script, timeoutMs: number): Promise<unknown> {
			// The async IIFE is *invoked inside the vm*, so `timeout` covers the sync
			// pre-await section. Everything after the first await is bounded by the
			// host's timeout → terminate() (a vm timeout cannot interrupt a suspended
			// promise); see exec/service.ts onTimeout.
			return (await script.runInContext(context, {
				timeout: timeoutMs > 0 ? timeoutMs : undefined,
				displayErrors: false,
			})) as Promise<unknown>;
		},
		release(): void {
			timers.releaseAll();
		},
	};
}

async function runDataviewJs(
	job: ExecJob,
	snapshot: IndexSnapshot,
	io: IoBridge,
	sink: OpSink,
	deps: DataviewJsDeps,
): Promise<void> {
	const fileLabel = `${job.pagePath || "<untitled>"}#dataviewjs-${job.blockIndex}`;
	const sandbox = createSandbox(job, snapshot, io, deps, fileLabel, sink);
	try {
		await sandbox.run(compileScript(job.code, fileLabel, deps.scriptCache), job.timeoutMs);
	} finally {
		sandbox.release();
	}
}

/**
 * Builds the `runJob` implementation injected into `startWorker`.
 * The script cache is shared across jobs of the same worker thread — that is
 * exactly what makes repeated preview refreshes cheap.
 */
export function createRunJob(opts: {
	maxRows?: number;
	settings?: DataviewJsDeps["settings"];
} = {}): WorkerRuntimeDeps["runJob"] {
	const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
	const settings = opts.settings;
	const scriptCache = new LruCache<string, Script>(SCRIPT_CACHE_SIZE);

	return async function runJob(job: ExecJob, snapshot: IndexSnapshot, io: IoBridge): Promise<ExecResult> {
		const startedAt = Date.now();
		const fileLabel = job.kind === "dataviewjs"
			? `${job.pagePath || "<untitled>"}#dataviewjs-${job.blockIndex}`
			: job.kind === "inline-js"
				? `${job.pagePath || "<untitled>"}#inline-js-${job.blockIndex}`
				: job.kind === "inline-dql"
					? `${job.pagePath || "<untitled>"}#inline-dql-${job.blockIndex}`
					: `${job.pagePath || "<untitled>"}#dataview-${job.blockIndex}`;
		const ops: RenderOp[] = [];
		let overflowed = false;
		const sink: OpSink = {
			push(op: RenderOp) {
				if (ops.length >= MAX_OPS) {
					overflowed = true;
					return;
				}
				ops.push(op);
			},
		};

		try {
			if (job.kind === "inline-dql") {
				runInlineDql(job, snapshot, sink);
			} else if (job.kind === "inline-js") {
				await runInlineJs(job, snapshot, io, sink, {scriptCache, maxRows, settings});
			} else if (job.kind === "dql") {
				const query = parseDql(job.code);
				// currentPath powers `incoming()`/`outgoing()` sources (they resolve
				// link sets relative to the block's own file, upstream behaviour).
				for (const op of executeDql(query, snapshot, {maxRows, currentPath: job.pagePath})) sink.push(op);
			} else {
				await runDataviewJs(job, snapshot, io, sink, {scriptCache, maxRows, settings});
			}
		} catch (e) {
			return errorResult(job, e, startedAt, fileLabel);
		}

		if (overflowed) {
			ops.push({kind: "notice", level: "warn", message: `Output truncated at ${MAX_OPS} blocks.`});
		}
		return {
			id: job.id,
			ok: true,
			ops,
			durationMs: Date.now() - startedAt,
			indexVersion: snapshot.version,
		};
	};
}

/**
 * Worker entry bootstrap (called by `workerEntry.ts`, never by tests).
 * `onLog` is optional: the bridge already fans console output out as `log`
 * messages, so the extra sink exists only for debugger-side mirroring.
 */
export function bootstrap(opts: {
	maxRows?: number;
	settings?: DataviewJsDeps["settings"];
	onLog?: WorkerRuntimeDeps["onLog"];
} = {}): void {
	startWorker({runJob: createRunJob({maxRows: opts.maxRows, settings: opts.settings}), onLog: opts.onLog});
}
