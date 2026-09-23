/**
 * Dataview performance benchmark — deterministic synthetic corpus, raw numbers.
 *
 * Run:
 *   NODE_PATH=./test/helpers/node_modules node --test --test-reporter=spec test/dataview-perf.test.mjs
 *   NODE_PATH=./test/helpers/node_modules node --test test/dataview-perf.test.mjs
 *   (npm run benchmark runs the pre-existing parser baseline in
 *    test/benchmark.test.mjs; this file is intentionally NOT wired into
 *    package.json — package.json is out of scope for this change.)
 *
 * Optional: AMC_PERF_BIG=1 also runs the 3000-page index-throughput case.
 * It is off by default because that case alone roughly doubles runtime and the
 * 1000-page case already covers the incremental/throughput claims.
 *
 * Why this file exists: the dataview stack ships several explicit perf claims
 * (O(1)-ish incremental upsert, N-way bootstrap concurrency, script-compile
 * cache, sticky worker slots, opt-in payload embedding). Each claim is turned
 * into a number on a fixed corpus, so a regression shows up as a changed number
 * instead of a silent slowdown.
 *
 * Reproducibility rules:
 *   - makePage(i) is a pure function of i: no RNG, no clock, no disk. Two runs
 *     index byte-identical input, so the numbers are comparable across runs.
 *   - Benchmark setup (esbuild bundling, corpus construction, store warm-up)
 *     happens before the first sample and is never charged to a measured op.
 *   - All sampling rounds of one metric reuse the SAME corpus / store /
 *     snapshot object.
 *   - Absolute milliseconds are machine-dependent (CPU, Node version, GC); the
 *     portable outputs are the ratios (incremental/full, cold/hot, concurrency
 *     speedup, payload overhead %). Re-measure absolute bounds per machine.
 *
 * Every measured metric prints one `[perf] …` line with the raw numbers
 * (p50/p95 over >= 20 samples where sampling is meaningful). Assertions are
 * loose regression fences; each comment states the basis of its bound.
 */
import {test, after} from "node:test";
import assert from "node:assert/strict";
import {execSync} from "node:child_process";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, dirname} from "node:path";
import {fileURLToPath} from "node:url";
import v8 from "node:v8";
import vm from "node:vm";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "amc-dv-perf-"));

// ── 1. Bundle the TS modules under test to ESM (never touches src/**) ─────────
const bundleCmd = (entry, out) =>
	`npx esbuild ${entry} --bundle --format=esm --platform=node --outfile="${join(dir, out)}"`;
try {
	execSync(
		[
			bundleCmd("src/dataview/index/index.ts", "index.mjs"),
			bundleCmd("src/dataview/host/indexer.ts", "indexer.mjs"),
			bundleCmd("src/dataview/query/index.ts", "query.mjs"),
			bundleCmd("src/dataview/render/html.ts", "html.mjs"),
			bundleCmd("src/dataview/exec/workerRuntime.ts", "runtime.mjs"),
			bundleCmd("src/dataview/exec/service.ts", "service.mjs"),
			bundleCmd("src/dataview/exec/workerEntry.ts", "worker.mjs"),
		].join(" && "),
		{cwd: repoRoot, stdio: "pipe"},
	);
} catch (e) {
	console.error(String(e.stdout ?? e));
	process.exit(1);
}

const {createIndexStore} = await import(join(dir, "index.mjs"));
const {createWorkspaceIndexer} = await import(join(dir, "indexer.mjs"));
const {parseDql, executeDql} = await import(join(dir, "query.mjs"));
const {renderOpsToHtml} = await import(join(dir, "html.mjs"));
const {createRunJob} = await import(join(dir, "runtime.mjs"));
const {createExecService} = await import(join(dir, "service.mjs"));
const workerBundle = join(dir, "worker.mjs");

// ── 2. Deterministic synthetic corpus ────────────────────────────────────────
const PAGE_COUNT = 1000;
const BIG_PAGE_COUNT = 3000;
const BASE_MTIME = 1_700_000_000_000;

/**
 * Pure function of i: ~1.2KB of markdown with frontmatter, 3 headings, 3 tasks
 * (2 open / 1 done + `[due:: …]` inline fields), 2 wikilink outlinks and one
 * body tag. No randomness, so the corpus hash is stable run to run.
 */
function makePage(i) {
	const id = String(i).padStart(4, "0");
	const due = `2024-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`;
	const status = i % 3 === 0 ? "open" : "done";
	const priority = (i % 5) + 1;
	const filler = `Padding sentence for note ${id} keeps the payload size realistic. `;
	return [
		"---",
		`title: Note ${id}`,
		`tags: [note, bucket-${i % 10}]`,
		`status: ${status}`,
		`priority: ${priority}`,
		`due: ${due}`,
		"---",
		"",
		`# Note ${id} — overview`,
		"",
		filler.repeat(5).trim(),
		"",
		`## Note ${id} — details`,
		"",
		`- [ ] Task A for note ${id} [due:: ${due}]`,
		`- [x] Task B for note ${id} [due:: ${due}]`,
		`- [ ] Task C for note ${id} with #tag/${i % 20}`,
		"",
		`Links: [[link-${id}]] and [[link-${id}-b]]`,
		"",
		filler.repeat(4).trim(),
		"",
		`### Note ${id} — notes`,
		"",
		filler.repeat(4).trim(),
		"",
	].join("\n");
}

const corpusFor = (count) =>
	Array.from({length: count}, (_, i) => {
		const path = `notes/note-${String(i).padStart(4, "0")}.md`;
		const content = makePage(i);
		return {path, content, size: Buffer.byteLength(content, "utf8"), mtime: BASE_MTIME + i * 1000};
	});

// Built once, before any measurement.
const CORPUS = corpusFor(PAGE_COUNT);
const CORPUS_BYTES = CORPUS.reduce((n, f) => n + f.size, 0);
console.log(
	`[perf] corpus pages=${CORPUS.length} avgBytes=${Math.round(CORPUS_BYTES / CORPUS.length)} ` +
		`totalKB=${(CORPUS_BYTES / 1024).toFixed(1)} generated=deterministic(no-rng)`,
);

// ── helpers ──────────────────────────────────────────────────────────────────
/** Nearest-rank percentile; clamped, so p95 of a 20-sample run is the 19th. */
function percentile(samples, p) {
	const s = [...samples].sort((a, b) => a - b);
	const idx = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1));
	return s[idx];
}
const p50 = (a) => percentile(a, 0.5);
const p95 = (a) => percentile(a, 0.95);
const ms = (n) => Number(n.toFixed(4));

function timeOnce(fn) {
	const t0 = performance.now();
	fn();
	return performance.now() - t0;
}
async function timeAsync(fn) {
	const t0 = performance.now();
	await fn();
	return performance.now() - t0;
}
const heapMB = () => process.memoryUsage().heapUsed / 1024 / 1024;

/**
 * Returns a GC-forcing function, or null when one cannot be acquired.
 * Why: raw `heapUsed` deltas without a forced collection are dominated by V8's
 * own GC timing — an unforced run of this very test showed a "queries" delta of
 * -107MB, i.e. noise larger than the quantity being measured. `--expose-gc` is
 * not part of the repo test command (and package.json is out of scope here), so
 * it is enabled in-process for the measurement and then restored.
 */
function acquireGc() {
	if (typeof globalThis.gc === "function") return globalThis.gc;
	try {
		v8.setFlagsFromString("--expose-gc");
		const g = vm.runInNewContext("gc");
		v8.setFlagsFromString("--no-expose-gc");
		return typeof g === "function" ? g : null;
	} catch {
		return null;
	}
}

/** In-memory WorkspaceFileSystem port implementation (no real IO). */
function makeFakeFs(entries) {
	const contents = new Map(entries.map((e) => [e.path, e.content]));
	const stats = new Map(entries.map((e) => [e.path, {mtimeMs: e.mtime, size: e.size}]));
	return {
		async listMarkdownFiles() {
			return entries.map((e) => ({path: e.path}));
		},
		async readFile(path) {
			const c = contents.get(path);
			if (c === undefined) throw new Error(`ENOENT ${path}`);
			return c;
		},
		async stat(path) {
			const s = stats.get(path);
			if (!s) throw new Error(`ENOENT ${path}`);
			return {mtimeMs: s.mtimeMs, size: s.size};
		},
		createWatcher() {
			return {dispose() {}};
		},
	};
}

/** Shared state: the indexed corpus reused by every later metric. */
const S = {store: null, snapshot: null};

// ── 3. Metrics ───────────────────────────────────────────────────────────────

test("perf: full index of 1000 pages + snapshot cost", () => {
	const rounds = 3;
	const totals = [];
	const snapshots = [];
	for (let r = 0; r < rounds; r++) {
		const store = createIndexStore();
		const total = timeOnce(() => {
			for (const f of CORPUS) store.upsertFile(f.path, f.content, f.mtime, f.size);
		});
		totals.push(total);
		if (r === 0) S.store = store;
		// snapshot() is measured separately: it is an O(n) shallow array copy that
		// callers pay per worker sync, so it must not be hidden inside the index.
		const snapSamples = [];
		for (let k = 0; k < 20; k++) snapSamples.push(timeOnce(() => S.store.snapshot()));
		snapshots.push(...snapSamples);
	}
	S.snapshot = S.store.snapshot();
	const st = S.store.stats();
	assert.equal(st.files, PAGE_COUNT, "all pages indexed");
	const total = p50(totals);
	S.full1000Ms = total;
	const snapP50 = p50(snapshots);
	console.log(
		`[perf] index.full1000 total=${ms(total)}ms filesPerSec=${((PAGE_COUNT / total) * 1000).toFixed(1)} ` +
			`p50=${ms(total)}ms min=${ms(Math.min(...totals))}ms rounds=${rounds} parsed=${st.parseCalls}`,
	);
	console.log(
		`[perf] snapshot.1000p p50=${ms(snapP50)}ms p95=${ms(p95(snapshots))} n=${snapshots.length} ` +
			`pagesPerSnapshot=${PAGE_COUNT}`,
	);
	// Basis: measured ~120ms here. 2000ms tolerates ~16x slower hardware while
	// still failing hard on an accidentally quadratic index (O(n^2) at this
	// corpus size would take minutes, not seconds).
	assert.ok(total < 2000, `full 1000-page index took ${ms(total)}ms (regression fence 2000ms)`);
	// Basis: measured ~3 microseconds (slice() of 1000 refs). A deep clone of
	// these pages costs single-digit ms, so a 5ms fence still catches exactly the
	// regression the design note warns about, with ~1500x headroom for slow hosts.
	assert.ok(snapP50 < 5, `snapshot p50 ${ms(snapP50)}ms (regression fence 5ms — bounds a deep-clone regression)`);
});

test("perf: incremental upsert vs full index", () => {
	assert.ok(S.store, "store built by the previous test");
	const samples = [];
	for (let k = 0; k < 20; k++) {
		const f = CORPUS[k % CORPUS.length];
		// New mtime ⇒ the (mtime,size) short-circuit must NOT trigger, so this
		// really is a re-parse + relink of one file, not a no-op.
		const mtime = f.mtime + 10_000_000 + k;
		samples.push(timeOnce(() => S.store.upsertFile(f.path, f.content, mtime, f.size)));
	}
	const inc = p50(samples);
	// Re-derive the full-index baseline from the same corpus (same warm JIT state)
	// so the ratio compares like with like instead of against a stale constant.
	const store = createIndexStore();
	const full = timeOnce(() => {
		for (const f of CORPUS) store.upsertFile(f.path, f.content, f.mtime, f.size);
	});
	const ratio = full / inc;
	console.log(
		`[perf] index.incremental1 upsertP50=${ms(inc)}ms p95=${ms(p95(samples))} n=${samples.length} ` +
			`| full1000=${ms(full)}ms ratio=${ratio.toFixed(1)}x`,
	);
	// Mandated fence: a one-file change must be >= 20x cheaper than a full
	// re-index. Design target is ~n-fold; 20x is the floor that still proves
	// the reverse-index path is O(1 file + links) rather than O(repo).
	assert.ok(ratio >= 20, `incremental/full speedup ${ratio.toFixed(1)}x < 20x`);
});

test("perf: indexer.bootstrap at concurrency 1 / 8 / 16 (in-memory fake fs)", async () => {
	const results = [];
	for (const concurrency of [1, 8, 16]) {
		const samples = [];
		for (let r = 0; r < 3; r++) {
			const fs = makeFakeFs(CORPUS);
			const store = createIndexStore();
			const indexer = createWorkspaceIndexer(fs, store, {concurrency});
			samples.push(await timeAsync(() => indexer.bootstrap()));
			indexer.dispose();
			if (r === 0) {
				assert.equal(store.stats().files, PAGE_COUNT, `bootstrap indexed all pages (c=${concurrency})`);
				assert.equal(indexer.stats().bootstrapped, true, `bootstrap flag set (c=${concurrency})`);
			}
		}
		results.push({concurrency, p50: p50(samples)});
	}
	const byC = Object.fromEntries(results.map((r) => [r.concurrency, r.p50]));
	console.log(
		`[perf] indexer.bootstrap c1=${ms(byC[1])}ms c8=${ms(byC[8])}ms c16=${ms(byC[16])}ms ` +
			`speedup8x=${(byC[1] / byC[8]).toFixed(2)}x speedup16x=${(byC[1] / byC[16]).toFixed(2)}x ` +
			`pages=${PAGE_COUNT} fs=in-memory-fake`,
	);
	console.log(
		"[perf] indexer.bootstrap note=in-memory fake fs has no IO latency; parsePageFile is synchronous CPU " +
			"work, so lanes only yield at microtasks and the concurrency knob cannot shorten total parse time here. " +
			"Real-disk gains must be re-measured on a real workspace (see report).",
	);
	// Basis: the fake fs resolves immediately, so this only fences against an
	// accidental serialization/await regression — not against disk behaviour.
	assert.ok(byC[8] < 2000, `bootstrap c=8 took ${ms(byC[8])}ms (regression fence 2000ms; measured ~130ms)`);
});

// DQL — parse and execute are timed separately so a slowdown can be localised.
// NOTE: the spec's literal `WHERE status = "open"` (single `=`) is REJECTED by
// this engine: expression.ts accepts only `==` (Obsidian Dataview also accepts
// bare `=` as an alias — documented deviation, not fixed here). `==` is used so
// the benchmark times a query that actually parses.
const DQL_QUERIES = {
	filter: ["TABLE file.name, status", "FROM #note", 'WHERE status == "open"', "SORT due ASC", "LIMIT 20"].join("\n"),
	group: ["TABLE file.name, status", "FROM #note", "GROUP BY status"].join("\n"),
	tasks: ["TASKS", "WHERE !completed"].join("\n"),
};

test("perf: DQL parse vs execute over 1000 pages (50 rounds)", () => {
	assert.ok(S.snapshot, "snapshot built by the first test");
	const ROUNDS = 50;
	for (const [name, src] of Object.entries(DQL_QUERIES)) {
		const parseSamples = [];
		const execSamples = [];
		// Parse is timed on a cold call each round (parseDql is not memoized).
		for (let k = 0; k < ROUNDS; k++) {
			parseSamples.push(timeOnce(() => parseDql(src)));
		}
		const query = parseDql(src);
		let rows = 0;
		for (let k = 0; k < ROUNDS; k++) {
			execSamples.push(timeOnce(() => {
				const ops = executeDql(query, S.snapshot, {maxRows: 1000});
				const op0 = ops[0];
				rows = op0.kind === "table" ? op0.rows.length : op0.kind === "taskList" ? op0.tasks.length : op0.items.length;
			}));
		}
		// Timed with maxRows=1000 (the service default); also report the
		// untruncated output size so a clipped result is not mistaken for a small one.
		const full = executeDql(query, S.snapshot, {maxRows: Number.MAX_SAFE_INTEGER})[0];
		const fullSize = full.kind === "table" ? full.rows.length : full.kind === "taskList" ? full.tasks.length : full.items.length;
		console.log(
			`[perf] dql.${name} parse p50=${ms(p50(parseSamples))}ms p95=${ms(p95(parseSamples))} | ` +
				`exec p50=${ms(p50(execSamples))}ms p95=${ms(p95(execSamples))} | outputSize=${rows} ` +
				`untruncatedOutputSize=${fullSize} maxRows=1000 rounds=${ROUNDS} pages=${PAGE_COUNT}`,
		);
		// Basis: exec scans 1000 pages; measured 2-5ms. 100ms tolerates ~20x slower
		// hardware and still fails on an accidental per-row rescan of the corpus.
		assert.ok(p50(execSamples) < 100, `dql.${name} exec p50 ${ms(p50(execSamples))}ms (fence 100ms)`);
		// Basis: parse is a 5-line query; measured tens of microseconds in-process.
		assert.ok(p50(parseSamples) < 5, `dql.${name} parse p50 ${ms(p50(parseSamples))}ms (fence 5ms)`);
	}
});

test("perf: renderOpsToHtml — 1000 rows x 6 cols, payload off vs on", () => {
	const ROWS = 1000;
	const COLS = 6;
	const cell = (i, c) => {
		if (c === 0) return {t: "str", v: `note-${String(i).padStart(4, "0")}`};
		if (c === 1) return {t: "str", v: i % 3 === 0 ? "open" : "done"};
		if (c === 2) return {t: "num", v: (i % 5) + 1};
		if (c === 3) return {t: "str", v: `2024-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`};
		if (c === 4) return {t: "str", v: `bucket-${i % 10}`};
		return {t: "str", v: `link-${String(i).padStart(4, "0")}`};
	};
	const op = {
		kind: "table",
		headers: ["file.name", "status", "priority", "due", "bucket", "link"],
		rows: Array.from({length: ROWS}, (_, i) => ({cells: Array.from({length: COLS}, (_, c) => cell(i, c))})),
	};
	const base = {basePath: "notes/note-0001.md"};
	const ROUNDS = 20;

	// payloadThreshold: 0 → payload embedding disabled (pure server-side HTML).
	const offSamples = [];
	let offHtml = "";
	for (let k = 0; k < ROUNDS; k++) {
		offSamples.push(timeOnce(() => {
			offHtml = renderOpsToHtml([op], {...base, payloadThreshold: 0});
		}));
	}
	// default → payload embedded when rows >= 100 (table payload for webview windowing).
	const onSamples = [];
	let onHtml = "";
	for (let k = 0; k < ROUNDS; k++) {
		onSamples.push(timeOnce(() => {
			onHtml = renderOpsToHtml([op], base);
		}));
	}
	const offBytes = Buffer.byteLength(offHtml, "utf8");
	const onBytes = Buffer.byteLength(onHtml, "utf8");
	const timeOverhead = ((p50(onSamples) - p50(offSamples)) / p50(offSamples)) * 100;
	const byteOverhead = ((onBytes - offBytes) / offBytes) * 100;
	console.log(
		`[perf] render.table1000x6 payloadOff p50=${ms(p50(offSamples))}ms bytes=${offBytes} | ` +
			`payloadOn p50=${ms(p50(onSamples))}ms bytes=${onBytes} | timeOverhead=${timeOverhead.toFixed(1)}% ` +
			`bytesOverhead=${byteOverhead.toFixed(1)}% rounds=${ROUNDS}`,
	);
	// Basis: measured ~10ms for 1000x6 with payload embedded. 150ms tolerates
	// ~15x slower hardware; a quadratic renderer blows past it immediately.
	assert.ok(p50(onSamples) < 150, `payload render p50 ${ms(p50(onSamples))}ms (fence 150ms)`);
	// Meaningful check: the payload path must actually be exercised, otherwise
	// the "overhead %" above would be a comparison of two identical code paths.
	assert.ok(onBytes > offBytes, "default render must embed the data-dv-payload attribute (1000 rows >= threshold 100)");
	assert.ok(onHtml.includes("data-dv-payload="), "payload attribute present in default render");
});

test("perf: vm execution — script compile (cache miss) vs cached script, + CPU baseline", async () => {
	assert.ok(S.snapshot, "snapshot built by the first test");
	const ioStub = {
		async read() {
			return "";
		},
		async exists() {
			return false;
		},
	};
	const runJob = createRunJob({maxRows: 1000});
	const job = (code, id, blockIndex) => ({
		id,
		kind: "dataviewjs",
		code,
		pagePath: "notes/note-0001.md",
		indexVersion: S.snapshot.version,
		blockIndex,
		timeoutMs: 20_000,
	});
	const TABLE_CODE =
		'dv.table(["file","status"], dv.pages("#note").where(p=>p.status==="open").limit(50).map(p=>[p.file.name,p.status]))';
	const CPU_CODE = "let s=0; for(let i=0;i<1e6;i++) s+=i; dv.paragraph(String(s))";

	let result = null;
	let allOk = true;
	const run = async (code, id, blockIndex) => {
		const t = await timeAsync(async () => {
			result = await runJob(job(code, id, blockIndex), S.snapshot, ioStub);
		});
		if (!result.ok) allOk = false;
		return t;
	};

	// True first call on a cold process. Reported separately and treated as an
	// UPPER BOUND only: it mixes vm.Script compile with JIT compilation of the
	// whole dv.pages/where/map path, so it is not a compile-cost estimate.
	const trueFirst = await run(TABLE_CODE, "true-first", 0);

	// Warm execution with DISTINCT blockIndex values. The script-cache key is
	// hashKey(fileLabel, code) and fileLabel embeds blockIndex, so these warm the
	// JIT WITHOUT pre-filling the cache entry (blockIndex 200) measured below.
	for (let k = 0; k < 12; k++) await run(TABLE_CODE, `warm${k}`, 100 + k);

	// Cache MISS: a fresh blockIndex per sample ⇒ new key ⇒ vm.Script compiled.
	// blockIndex 200 is the first miss sample, so it is also the HIT key below.
	const missSamples = [];
	for (let k = 0; k < 30; k++) missSamples.push(await run(TABLE_CODE, `miss${k}`, 200 + k));

	// Cache HIT: same code + same blockIndex ⇒ hashKey hits ⇒ compiled Script
	// reused. Still pays a fresh vm context + createDvApi per job, because the
	// runtime rebuilds both per job for per-block global isolation.
	const hitSamples = [];
	for (let k = 0; k < 30; k++) hitSamples.push(await run(TABLE_CODE, `hit${k}`, 200));

	// CPU reference point: a pure 1e6-iteration loop inside the same sandbox.
	const cpuSamples = [];
	for (let k = 0; k < 5; k++) cpuSamples.push(await run(CPU_CODE, `cpu${k}`, 300));

	// Direct measurement of the ONE operation the cache avoids: the worker's
	// compileScript() does `new Script(WRAP_HEAD + code + WRAP_TAIL)`. Measured
	// here directly, because inside a job its cost is swamped by the ~5ms of
	// context/dv-API construction and is therefore invisible in miss-vs-hit.
	const wrap = (src) => `(async () => {\n"use strict";\n${src}\n})()`;
	const compileSamples = [];
	for (let k = 0; k < 30; k++) {
		const src = wrap(TABLE_CODE);
		compileSamples.push(timeOnce(() => new vm.Script(src, {filename: "notes/note-0001.md#dataviewjs-1"})));
	}
	// Same operation on a ~10KB block, to show how compile cost scales.
	const bigBlock = `dv.table(["a"], [${Array.from({length: 400}, (_, i) => `"row-${i}"`).join(",")}])`;
	const bigCompile = [];
	for (let k = 0; k < 10; k++) {
		const src = wrap(bigBlock);
		bigCompile.push(timeOnce(() => new vm.Script(src)));
	}

	const missP50 = p50(missSamples);
	const hitP50 = p50(hitSamples);
	const delta = missP50 - hitP50;
	const hitNoise = p95(hitSamples) - hitP50;
	const compileP50 = p50(compileSamples);
	console.log(
		`[perf] vm.cacheMiss p50=${ms(missP50)}ms min=${ms(Math.min(...missSamples))}ms ` +
			`p95=${ms(p95(missSamples))}ms n=${missSamples.length}`,
	);
	console.log(
		`[perf] vm.cacheHit p50=${ms(hitP50)}ms min=${ms(Math.min(...hitSamples))}ms ` +
			`p95=${ms(p95(hitSamples))}ms n=${hitSamples.length} ops=${result.ok ? result.ops.length : -1}`,
	);
	console.log(
		`[perf] vm.cacheDelta missMinusHit=${ms(delta)}ms missOverHit=${(missP50 / hitP50).toFixed(2)}x ` +
			`hitP95MinusP50=${ms(hitNoise)}ms verdict=${delta > hitNoise ? "diff-exceeds-noise" : "WITHIN-NOISE"}`,
	);
	console.log(
		`[perf] vm.coldOverHot trueFirst/cacheHitP50=${(trueFirst / hitP50).toFixed(2)}x ` +
			`(coldStart=${ms(trueFirst)}ms hotP50=${ms(hitP50)}ms; the cold number is an upper bound — see caveat above)`,
	);
	console.log(
		`[perf] vm.scriptCompile p50=${ms(compileP50)}ms n=${compileSamples.length} ` +
			`(direct: new vm.Script(<same 130B block, same wrapper>) = exactly what compileScript() skips on a hit)`,
	);
	console.log(
		`[perf] vm.scriptCompileLarge p50=${ms(p50(bigCompile))}ms srcBytes=${Buffer.byteLength(wrap(bigBlock), "utf8")} ` +
			`n=${bigCompile.length} (compile cost scales with source size; the cache matters proportionally more for big blocks)`,
	);
	console.log(
		`[perf] vm.trueFirstCallOnColdProcess=${ms(trueFirst)}ms (UPPER BOUND only: includes JIT warm-up of the whole query path)`,
	);
	console.log(
		`[perf] vm.cpu1e6 p50=${ms(p50(cpuSamples))}ms p95=${ms(p95(cpuSamples))} n=${cpuSamples.length} ` +
			`(1e6-iteration JS loop in the same sandbox = CPU reference point)`,
	);
	assert.ok(allOk, `vm job failed: ${JSON.stringify(result.error)}`);
	// Basis: measured ~5ms; the block reads 1000 pages and emits 50 rows. 100ms
	// tolerates ~20x slower hardware and still catches an accidental full-snapshot
	// deep-clone or a per-row page rebuild inside the job.
	assert.ok(hitP50 < 100, `vm cache-hit p50 ${ms(hitP50)}ms (regression fence 100ms)`);
	// The cache can only save the compile step, so it must be cheaper than the
	// job it is part of; this holds regardless of the miss/hit verdict above.
	assert.ok(compileP50 < hitP50, `compile ${ms(compileP50)}ms not cheaper than a cached job ${ms(hitP50)}ms`);
	assert.ok(cpuSamples.length === 5 && p50(cpuSamples) > 0, "cpu baseline sampled");
});

test("perf: heap growth — index / queries / render (forced GC)", () => {
	const gc = acquireGc();
	// Every reading is taken right after a forced full collection, so the deltas
	// approximate RETAINED growth instead of V8's collection timing.
	const reading = () => {
		if (gc) gc();
		return heapMB();
	};
	const base = reading();
	const store = createIndexStore();
	for (const f of CORPUS) store.upsertFile(f.path, f.content, f.mtime, f.size);
	const snapshot = store.snapshot();
	const afterIndex = reading();
	const query = parseDql(DQL_QUERIES.filter);
	for (let k = 0; k < 100; k++) executeDql(query, snapshot, {maxRows: 1000});
	const afterQueries = reading();
	const op = {
		kind: "table",
		headers: ["a", "b"],
		rows: Array.from({length: 1000}, (_, i) => ({cells: [{t: "str", v: `r${i}`}, {t: "num", v: i}]})),
	};
	for (let k = 0; k < 50; k++) renderOpsToHtml([op], {basePath: "notes/note-0001.md"});
	const afterRender = reading();
	const dIndex = afterIndex - base;
	const dQueries = afterQueries - afterIndex;
	const dRender = afterRender - afterQueries;
	console.log(
		`[perf] memory.heap base=${base.toFixed(1)}MB afterIndex=${afterIndex.toFixed(1)}MB ` +
			`after100Queries=${afterQueries.toFixed(1)}MB after50Renders=${afterRender.toFixed(1)}MB | ` +
			`deltaIndex=${dIndex.toFixed(1)}MB deltaQueries=${dQueries.toFixed(1)}MB deltaRender=${dRender.toFixed(1)}MB ` +
			`retainedBytesPerPage=${Math.round((dIndex * 1048576) / PAGE_COUNT)}B gc=${gc ? "forced" : "UNAVAILABLE"}`,
	);
	if (!gc) {
		// Without a forced collection these deltas are GC-timing noise, so the
		// mandated fence would assert on noise. Report loudly instead of faking it.
		console.log("[perf] memory.heap GUARD-SKIPPED reason=no-forced-gc (deltas above are GC-timing noise)");
	} else {
		// Mandated loose guard: 1000 x ~1.2KB pages must not cost 200MB of heap
		// (measured 2 orders of magnitude below this fence).
		assert.ok(dIndex < 200, `index heap delta ${dIndex.toFixed(1)}MB (fence 200MB)`);
	}
});

test("perf: end-to-end worker round trip (sticky slot + versioned sync)", async () => {
	assert.ok(S.snapshot, "snapshot built by the first test");
	const service = createExecService({workerPath: workerBundle, poolSize: 1, defaultTimeoutMs: 30_000});
	try {
		service.ensureIndex(S.snapshot);
		const code =
			'dv.table(["file","status"], dv.pages("#note").where(p=>p.status==="open").limit(50).map(p=>[p.file.name,p.status]))';
		const makeJob = (id) => ({
			id,
			kind: "dataviewjs",
			code,
			pagePath: "notes/note-0001.md",
			indexVersion: S.snapshot.version,
			blockIndex: 0,
			timeoutMs: 30_000,
		});
		let first = 0;
		let firstResult = null;
		first = await timeAsync(async () => {
			firstResult = await service.run(makeJob("e2e-1"));
		});
		// Same page ⇒ same sticky slot, and the slot already holds this index
		// version ⇒ no syncIndex clone on the second call.
		const second = await timeAsync(async () => {
			await service.run(makeJob("e2e-2"));
		});
		const third = await timeAsync(async () => {
			await service.run(makeJob("e2e-3"));
		});
		console.log(
			`[perf] e2e.worker first=${ms(first)}ms second=${ms(second)}ms third=${ms(third)}ms ` +
				`ratio=${(first / second).toFixed(2)}x poolSize=1 pages=${PAGE_COUNT} ` +
				`ok=${firstResult.ok} ops=${firstResult.ok ? firstResult.ops.length : -1} ` +
				`(first includes worker spawn + syncIndex structured clone; second/third reuse both)`,
		);
		assert.ok(firstResult.ok, `e2e job failed: ${JSON.stringify(firstResult.error)}`);
		assert.ok(second > 0 && third > 0, "worker round trips completed");
		// Basis: measured first ~90ms vs second ~10ms (worker spawn + full-snapshot
		// structured clone happen once per slot/version). Requiring a real margin,
		// not a lucky sample, is what makes this a meaningful fence.
		assert.ok(first / second >= 1.5, `second job (${ms(second)}ms) not >=1.5x cheaper than first (${ms(first)}ms) — sticky-slot/versioned-sync optimization regressed`);
	} finally {
		await service.dispose();
	}
});

// ── 4. Optional large-corpus throughput ceiling (opt-in) ─────────────────────
const bigTest = process.env.AMC_PERF_BIG ? test : test.skip;
bigTest("perf: 3000-page index throughput ceiling (AMC_PERF_BIG=1)", () => {
	const corpus = corpusFor(BIG_PAGE_COUNT);
	const store = createIndexStore();
	const total = timeOnce(() => {
		for (const f of corpus) store.upsertFile(f.path, f.content, f.mtime, f.size);
	});
	assert.equal(store.stats().files, BIG_PAGE_COUNT, "all big-corpus pages indexed");
	console.log(
		`[perf] index.full3000 total=${ms(total)}ms filesPerSec=${((BIG_PAGE_COUNT / total) * 1000).toFixed(1)} pages=${BIG_PAGE_COUNT}`,
	);
	const base1000 = S.full1000Ms;
	console.log(
		`[perf] index.scaling pagesRatio=${(BIG_PAGE_COUNT / PAGE_COUNT).toFixed(2)} ` +
			`timeRatio=${base1000 ? (total / base1000).toFixed(2) : "n/a(1000-case not run in this process)"} ` +
			"(timeRatio ~ pagesRatio ⇒ linear, the expected O(n) full-index shape)",
	);
});

after(() => {
	rmSync(dir, {recursive: true, force: true});
});
