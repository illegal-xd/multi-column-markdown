/**
 * B4: sandbox exec service + LRU/hash cache + perf metrics.
 *
 * Bundles service/workerBridge/lru/hash/metrics via esbuild, generates a
 * fake worker entry (startWorker({runJob}) with scripted behaviors), then
 * drives the real worker_threads pool through timeout/cancel/crash/IO paths.
 */
import {test, after} from "node:test";
import assert from "node:assert/strict";
import {execSync} from "node:child_process";
import {mkdtempSync, writeFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, dirname} from "node:path";
import {fileURLToPath} from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "amc-exec-"));
const workerEntry = join(dir, "fakeWorker.ts");
const workerBundle = join(dir, "fakeWorker.mjs");
const bridgePath = join(repoRoot, "src/dataview/exec/workerBridge.ts");

writeFileSync(workerEntry, `
import {threadId} from "node:worker_threads";
import {startWorker} from ${JSON.stringify(bridgePath)};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

startWorker({
  async runJob(job, snapshot, io) {
    const started = Date.now();
    const done = (ops, extra) => Object.assign(
      {id: job.id, ok: true, ops, durationMs: Date.now() - started, indexVersion: snapshot.version},
      extra || {},
    );
    const code = job.code;
    if (code === "ok") return done([{kind: "paragraph", text: "hello"}]);
    if (code === "throw") throw new Error("boom from deps");
    if (code === "crash") process.exit(7);
    if (code === "hang") { for (;;) { /* spin: only host terminate can interrupt */ } }
    if (code === "never") return new Promise(() => {});
    if (code.indexOf("sleep:") === 0) { await sleep(Number(code.slice(6))); return done([{kind: "span", text: "slept"}]); }
    if (code.indexOf("probe:") === 0) { await sleep(Number(code.slice(6))); return done([{kind: "span", text: "tid=" + threadId + " start=" + started + " end=" + Date.now()}]); }
    if (code.indexOf("io:") === 0) { const c = await io.read(code.slice(3)); return done([{kind: "span", text: "io=" + c}]); }
    if (code.indexOf("ioexists:") === 0) { const e = await io.exists(code.slice(9)); return done([{kind: "span", text: "exists=" + e}]); }
    if (code === "tid") return done([{kind: "span", text: "tid=" + threadId}]);
    if (code === "snap") return done([{kind: "span", text: "snap=" + snapshot.version + " pages=" + snapshot.pages.length}]);
    return done([{kind: "span", text: "unhandled:" + code}]);
  },
});
`);

try {
  execSync(
    [
      `npx esbuild src/dataview/exec/service.ts --bundle --format=esm --platform=node --outfile="${join(dir, "service.mjs")}"`,
      `npx esbuild "${workerEntry}" --bundle --format=esm --platform=node --outfile="${workerBundle}"`,
      `npx esbuild src/dataview/cache/lru.ts --bundle --format=esm --outfile="${join(dir, "lru.mjs")}"`,
      `npx esbuild src/dataview/cache/hash.ts --bundle --format=esm --platform=node --outfile="${join(dir, "hash.mjs")}"`,
      `npx esbuild src/dataview/perf/metrics.ts --bundle --format=esm --outfile="${join(dir, "metrics.mjs")}"`,
    ].join(" && "),
    {cwd: repoRoot, stdio: "pipe"},
  );
} catch (e) {
  console.error(String(e.stdout ?? e));
  process.exit(1);
}

const {createExecService} = await import(join(dir, "service.mjs"));
const {LruCache} = await import(join(dir, "lru.mjs"));
const {hashKey} = await import(join(dir, "hash.mjs"));
const {Metrics, recordMetric, increment, getMetrics, resetMetrics, time, timeAsync} = await import(join(dir, "metrics.mjs"));

after(() => rmSync(dir, {recursive: true, force: true}));

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let jobSeq = 0;
function job(code, over = {}) {
  return {
    id: "j" + ++jobSeq,
    kind: "dataviewjs",
    code,
    pagePath: "notes/page-a.md",
    indexVersion: 0,
    blockIndex: 0,
    timeoutMs: 5000,
    ...over,
  };
}
function makeSnapshot(version, pageCount) {
  const pages = [];
  for (let i = 0; i < pageCount; i++) {
    pages.push({
      path: "notes/p" + i + ".md", name: "p" + i, folder: "notes", ext: "md",
      ctime: 0, mtime: 0, size: 0, frontmatter: {}, inlineFields: {}, fields: {},
      tags: [], etags: [], aliases: [], headings: [], sections: [], lists: [],
      tasks: [], inlinks: [], outlinks: [],
    });
  }
  return {version, pages, generatedAt: 1234};
}

// ── 1. normal round-trip ──────────────────────────────────────────────────

test("normal job round-trip returns ops", {timeout: 20000}, async () => {
  const svc = createExecService({workerPath: workerBundle, poolSize: 2});
  try {
    const r = await svc.run(job("ok"));
    assert.equal(r.ok, true);
    assert.equal(r.ops.length, 1);
    assert.deepEqual(r.ops[0], {kind: "paragraph", text: "hello"});
    assert.ok(r.durationMs >= 0);
    const s = svc.stats();
    assert.equal(s.poolSize, 2);
    assert.equal(s.completed, 1);
    assert.equal(s.queued, 0);
    assert.equal(s.running, 0);
    assert.equal(s.timeouts, 0);
    assert.equal(s.cancelled, 0);
  } finally {
    await svc.dispose();
  }
});

// ── 1b. batching: many blocks of ONE page ─────────────────────────────────

test("blocks of one page run in batches: ≤3 at once, the rest queue", {timeout: 40000}, async () => {
  // poolSize 4 so the cap — not the pool — is what limits concurrency.
  const svc = createExecService({workerPath: workerBundle, poolSize: 4});
  try {
    const MS = 250;
    const jobs = Array.from({length: 8}, (_, i) => job(`probe:${MS}`, {blockIndex: i}));
    const t0 = Date.now();
    const results = await Promise.all(jobs.map((j) => svc.run(j)));
    const elapsed = Date.now() - t0;
    assert.equal(results.every((r) => r.ok), true, "queued jobs must all run (nothing dropped)");
    assert.equal(svc.stats().completed, 8);
    // Every job reports when its worker started and finished, and which thread
    // ran it. Overlapping [start, end] windows measure REAL concurrency; thread
    // ids alone would over-count (8 queued jobs legitimately touch more than 3
    // threads over successive batches).
    const spans = results.map((r) => /tid=(\d+) start=(\d+) end=(\d+)/.exec(r.ops[0].text))
      .map((m) => ({tid: m[1], start: Number(m[2]), end: Number(m[3])}));
    assert.equal(spans.length, 8);
    // Concurrency at an instant: how many jobs were alive at each job's start
    // (the count only grows at starts, so the maximum is attained at one).
    // Counting pairwise intersections instead would over-count tail slivers.
    const concurrency = Math.max(...spans.map((s) => spans.filter((o) => o.start <= s.start && s.start < o.end).length));
    assert.ok(concurrency <= 3, `at most 3 blocks of one page at once (saw ${concurrency} of 8, elapsed ${elapsed}ms)`);
    assert.ok(concurrency >= 2, "blocks of one page must run in parallel, not one by one");
    // 8 jobs / 3 per batch ⇒ at least ceil(8/3)=3 batches ⇒ the last job cannot
    // start before 2 × MS (one batch would mean no cap at all).
    assert.ok(elapsed >= MS * 2, `jobs must queue in batches (8 × ${MS}ms finished in ${elapsed}ms)`);
  } finally {
    await svc.dispose();
  }
});

// ── 2. timeout: while(true) and never-resolving deps ──────────────────────
test("timeout kills a spinning worker, respawns, and the pool recovers", {timeout: 20000}, async () => {
  const svc = createExecService({workerPath: workerBundle, poolSize: 1});
  try {
    const t0 = Date.now();
    const r = await svc.run(job("hang", {timeoutMs: 300}));
    const elapsed = Date.now() - t0;
    assert.equal(r.ok, false);
    assert.match(r.error.message, /Dataview job timed out after 300ms/);
    assert.ok(elapsed >= 250, "must not fire before timeoutMs: " + elapsed + "ms");
    assert.ok(elapsed <= 1300, "must resolve within timeoutMs + margin: " + elapsed + "ms");
    assert.equal(r.indexVersion, 0);
    let s = svc.stats();
    assert.equal(s.timeouts, 1);
    assert.equal(s.running, 0);
    // respawns is incremented only after terminate() settles — the waits below
    // gate on respawn completion (the slot refuses jobs while retiring).

    // never-resolving promise is equally interruptible (no worker-side reject needed)
    const r2 = await svc.run(job("never", {timeoutMs: 200}));
    assert.equal(r2.ok, false);
    assert.match(r2.error.message, /Dataview job timed out after 200ms/);
    s = svc.stats();
    assert.equal(s.timeouts, 2);
    assert.ok(s.respawns >= 1, "first respawn finished before `never` was dispatched: " + JSON.stringify(s));

    // service still usable after two forced respawns
    const r3 = await svc.run(job("ok"));
    assert.equal(r3.ok, true);
    assert.equal(svc.stats().completed, 1); // only the ok job completed
    assert.ok(svc.stats().respawns >= 2, "second respawn finished before the recovery run: " + JSON.stringify(svc.stats()));
  } finally {
    await svc.dispose();
  }
});

// ── 3. cancel: queued (immediate) + running (terminate/respawn) ───────────

test("cancel resolves queued jobs immediately and running jobs via terminate", {timeout: 20000}, async () => {
  const svc = createExecService({workerPath: workerBundle, poolSize: 1});
  try {
    const slow = job("sleep:800", {timeoutMs: 10000});
    const queued = job("ok", {timeoutMs: 10000});
    const pSlow = svc.run(slow);
    const pQueued = svc.run(queued);
    assert.equal(svc.stats().queued, 1, "second job must sit in the queue");
    svc.cancel(queued.id);
    const winner = await Promise.race([pQueued.then(() => "queued"), delay(300).then(() => "slow")]);
    assert.equal(winner, "queued", "queued cancel must resolve without waiting for the running job");
    const qRes = await pQueued;
    assert.equal(qRes.ok, false);
    assert.match(qRes.error.message, /Dataview job cancelled/);
    assert.equal(svc.stats().cancelled, 1);
    assert.equal(svc.stats().running, 1, "the slow job is still running");
    const sRes = await pSlow;
    assert.equal(sRes.ok, true);

    // running cancel: terminate + respawn, then the pool keeps serving
    const run1 = job("sleep:5000", {timeoutMs: 30000});
    const pRun = svc.run(run1);
    assert.equal(svc.stats().running, 1);
    svc.cancel(run1.id);
    const cRes = await pRun;
    assert.equal(cRes.ok, false);
    assert.match(cRes.error.message, /Dataview job cancelled/);
    assert.equal(svc.stats().cancelled, 2);
    const after = await svc.run(job("ok"));
    assert.equal(after.ok, true, "pool must serve the next job after a cancel respawn");
    assert.ok(svc.stats().respawns >= 1, "respawn finished before the recovery job ran: " + JSON.stringify(svc.stats()));
    assert.equal(svc.stats().completed, 2); // sleep:800 + final ok
  } finally {
    await svc.dispose();
  }
});

// ── 4. error isolation: deps throw + hard worker crash ────────────────────

test("deps throw and worker crash stay isolated to their jobs", {timeout: 20000}, async () => {
  const svc = createExecService({workerPath: workerBundle, poolSize: 2});
  try {
    const bad = await svc.run(job("throw"));
    assert.equal(bad.ok, false);
    assert.match(bad.error.message, /boom from deps/);
    assert.ok(typeof bad.error.detail === "string" && bad.error.detail.includes("boom from deps"), "stack detail must be carried");

    const good = await svc.run(job("ok"));
    assert.equal(good.ok, true);
    assert.equal(svc.stats().completed, 2);

    // hard process-level crash (exit without done)
    const crashed = await svc.run(job("crash", {pagePath: "notes/crash.md"}));
    assert.equal(crashed.ok, false);
    assert.match(crashed.error.message, /Dataview worker crashed: worker exited with code 7/);

    // recovery on the SAME sticky slot: dispatch is gated on the respawn
    const good2 = await svc.run(job("ok", {pagePath: "notes/crash.md"}));
    assert.equal(good2.ok, true, "service must survive a worker crash");
    assert.ok(svc.stats().respawns >= 1, "respawn finished before the recovery run: " + JSON.stringify(svc.stats()));
    assert.equal(svc.stats().completed, 3); // crash is NOT a completion
  } finally {
    await svc.dispose();
  }
});

// ── 5. sticky worker + index sync across version bumps ────────────────────

test("ensureIndex bumps re-sync the pinned worker; same page stays sticky", {timeout: 20000}, async () => {
  const svc = createExecService({workerPath: workerBundle, poolSize: 4});
  try {
    svc.ensureIndex(makeSnapshot(1, 1));
    const r1 = await svc.run(job("snap", {indexVersion: 1, pagePath: "notes/a.md"}));
    assert.equal(r1.ops[0].text, "snap=1 pages=1");
    assert.equal(r1.indexVersion, 1, "result reports the snapshot version it ran against");

    svc.ensureIndex(makeSnapshot(2, 2));
    const r2 = await svc.run(job("snap", {indexVersion: 2, pagePath: "notes/a.md"}));
    assert.equal(r2.ops[0].text, "snap=2 pages=2", "worker must have received syncIndex before run");
    assert.equal(r2.indexVersion, 2);

    // same version re-ensured (different object) — worker keeps v2, job still normal
    svc.ensureIndex(makeSnapshot(2, 2));
    const r3 = await svc.run(job("snap", {indexVersion: 2, pagePath: "notes/a.md"}));
    assert.equal(r3.ops[0].text, "snap=2 pages=2");

    // two ensureIndex calls with different versions, then a job → latest wins
    svc.ensureIndex(makeSnapshot(3, 3));
    svc.ensureIndex(makeSnapshot(4, 4));
    const r4 = await svc.run(job("snap", {indexVersion: 4, pagePath: "notes/a.md"}));
    assert.equal(r4.ops[0].text, "snap=4 pages=4");

    // stickiness: both jobs run on the same worker thread
    const t1 = await svc.run(job("tid", {pagePath: "notes/a.md"}));
    const t2 = await svc.run(job("tid", {pagePath: "notes/a.md"}));
    assert.match(t1.ops[0].text, /^tid=\d+$/);
    assert.equal(t1.ops[0].text, t2.ops[0].text, "same page must pin to the same worker thread");
  } finally {
    await svc.dispose();
  }
});

test("job demanding a newer index than the host has fails fast", {timeout: 20000}, async () => {
  const svc = createExecService({workerPath: workerBundle, poolSize: 1});
  try {
    const r = await svc.run(job("snap", {indexVersion: 9}));
    assert.equal(r.ok, false);
    assert.match(r.error.message, /index not ready \(wanted v9, have v0\)/);
    assert.equal(svc.stats().running, 0);
  } finally {
    await svc.dispose();
  }
});

// ── 6. IO bridge ──────────────────────────────────────────────────────────

test("io bridge round-trips read/exists; pending io dies with the timeout", {timeout: 20000}, async () => {
  const reads = [];
  const svc = createExecService({
    workerPath: workerBundle,
    poolSize: 1,
    hostIo: {
      async read(p) {
        reads.push(p);
        if (p === "blocked.md") {
          return new Promise(() => {}); // never settles — only worker terminate frees the job
        }
        return "content:" + p;
      },
      async exists(p) {
        return p === "yes.md";
      },
    },
  });
  try {
    const r = await svc.run(job("io:notes/x.md"));
    assert.equal(r.ok, true);
    assert.equal(r.ops[0].text, "io=content:notes/x.md");
    assert.deepEqual(reads, ["notes/x.md"], "hostIo.read must see the worker-requested path");

    const r2 = await svc.run(job("ioexists:yes.md"));
    assert.equal(r2.ops[0].text, "exists=true");
    const r3 = await svc.run(job("ioexists:no.md"));
    assert.equal(r3.ops[0].text, "exists=false");

    // blocked IO + timeout: worker killed while awaiting hostIo; service recovers
    const blocked = await svc.run(job("io:blocked.md", {timeoutMs: 250}));
    assert.equal(blocked.ok, false);
    assert.match(blocked.error.message, /Dataview job timed out after 250ms/);
    assert.ok(svc.stats().timeouts >= 1);
    const r4 = await svc.run(job("ok"));
    assert.equal(r4.ok, true, "pool must recover after an IO-blocked timeout");
  } finally {
    await svc.dispose();
  }
});

// ── 7. LRU + hashKey ──────────────────────────────────────────────────────

test("lru: recency refresh, eviction order, hitStats", () => {
  const c = new LruCache(2);
  c.set("a", 1);
  c.set("b", 2);
  assert.equal(c.get("a"), 1); // hit → a becomes MRU
  c.set("c", 3); // evicts b (eldest)
  assert.equal(c.size, 2);
  assert.equal(c.get("b"), undefined); // miss
  assert.equal(c.get("a"), 1);
  assert.equal(c.get("c"), 3);
  let s = c.hitStats();
  assert.equal(s.hits, 3);
  assert.equal(s.misses, 1);
  assert.equal(s.hitRate, 0.75);
  assert.equal(s.size, 2);
  assert.equal(s.capacity, 2);

  c.set("a", 10); // in-place update must not evict
  assert.equal(c.size, 2);
  assert.equal(c.get("a"), 10); // hit #4
  assert.equal(c.delete("c"), true);
  assert.equal(c.size, 1);
  c.clear();
  assert.equal(c.size, 0);
  s = c.hitStats();
  assert.equal(s.hits, 4, "counters stay cumulative across clear");
  assert.equal(s.misses, 1);
  assert.throws(() => new LruCache(0), /capacity/);
  assert.throws(() => new LruCache(1.5), /capacity/);
});

test("hashKey: stable, 16 hex chars, part-boundary safe", () => {
  const a = hashKey("notes/a.md", 12);
  assert.equal(a, hashKey("notes/a.md", 12));
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.notEqual(hashKey("a", "bc"), hashKey("ab", "c"), "NUL separator keeps parts apart");
  assert.notEqual(hashKey("a"), hashKey("b"));
  assert.notEqual(hashKey("x", 1), hashKey("x", 2));
});

// ── 8. metrics ────────────────────────────────────────────────────────────

test("metrics: percentiles, sliding window, counters, time helpers", async () => {
  const m = new Metrics();
  for (let i = 1; i <= 100; i++) {
    m.recordMetric("lat", i);
  }
  assert.deepEqual(m.getMetrics().timings.lat, {count: 100, totalMs: 5050, minMs: 1, maxMs: 100, p50Ms: 50});

  // sliding window: only the last 512 of 600 samples (89..600) feed p50
  const m2 = new Metrics();
  for (let i = 1; i <= 600; i++) {
    m2.recordMetric("w", i);
  }
  const w = m2.getMetrics().timings.w;
  assert.equal(w.count, 600, "count is cumulative beyond the window");
  assert.equal(w.totalMs, 180300);
  assert.equal(w.minMs, 1);
  assert.equal(w.maxMs, 600);
  assert.equal(w.p50Ms, 344, "nearest-rank p50 over samples 89..600");

  m.increment("hits");
  m.increment("hits", 4);
  assert.equal(m.getMetrics().counters.hits, 5);

  assert.equal(m.time("t", () => 42), 42);
  assert.equal(await m.timeAsync("ta", async () => 7), 7);
  assert.equal(m.getMetrics().timings.t.count, 1);
  assert.equal(m.getMetrics().timings.ta.count, 1);

  assert.throws(() => m.time("boom", () => {
    throw new Error("x");
  }), /x/);
  assert.equal(m.getMetrics().timings.boom.count, 1, "time() records even when fn throws");

  assert.throws(() => m.recordMetric("", 1), /name/);
  assert.throws(() => m.recordMetric("x", NaN), /finite/);

  m.resetMetrics();
  assert.deepEqual(m.getMetrics(), {counters: {}, timings: {}});

  // module-level singleton free functions
  resetMetrics();
  recordMetric("solo", 5);
  increment("c");
  assert.equal(getMetrics().timings.solo.p50Ms, 5);
  assert.equal(getMetrics().counters.c, 1);
  assert.equal(typeof time, "function");
  assert.equal(typeof timeAsync, "function");
  resetMetrics();
});

// ── 9. backpressure, code size, construction, dispose ─────────────────────

test("queue full rejects immediately without counting completions", {timeout: 20000}, async () => {
  const svc = createExecService({workerPath: workerBundle, poolSize: 1, maxQueue: 1});
  try {
    const p1 = svc.run(job("sleep:300", {timeoutMs: 5000}));
    const p2 = svc.run(job("ok", {timeoutMs: 5000}));
    const p3 = svc.run(job("ok", {timeoutMs: 5000}));
    assert.equal(svc.stats().queued, 1, "queue holds exactly maxQueue jobs");
    const r3 = await p3;
    assert.equal(r3.ok, false);
    assert.match(r3.error.message, /^queue full$/);
    assert.equal(svc.stats().queued, 1, "rejected job never entered the queue");
    const [a, b] = await Promise.all([p1, p2]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(svc.stats().completed, 2, "queue-full rejection is not a completion");
  } finally {
    await svc.dispose();
  }
});

test("oversized code is rejected before any worker is touched", {timeout: 20000}, async () => {
  const svc = createExecService({workerPath: workerBundle, maxCodeBytes: 5});
  try {
    const r = await svc.run(job("123456"));
    assert.equal(r.ok, false);
    assert.match(r.error.message, /Dataview job code too large \(6 > 5 bytes\)/);
    const s = svc.stats();
    assert.equal(s.running, 0);
    assert.equal(s.queued, 0);
    assert.equal(s.completed, 0);
    assert.equal(s.respawns, 0);
  } finally {
    await svc.dispose();
  }
});

test("construction validates workerPath", () => {
  assert.throws(() => createExecService({workerPath: ""}), /workerPath/);
  assert.throws(() => createExecService({workerPath: join(dir, "definitely-missing.mjs")}), /not found/);
});

test("dispose is idempotent and drains queued + in-flight jobs", {timeout: 20000}, async () => {
  const svc = createExecService({workerPath: workerBundle, poolSize: 1});
  const inflight = svc.run(job("sleep:5000", {timeoutMs: 30000}));
  const queued = svc.run(job("ok", {timeoutMs: 30000}));
  assert.equal(svc.stats().running, 1);
  assert.equal(svc.stats().queued, 1);
  await svc.dispose();
  await svc.dispose(); // idempotent: second call resolves, no throw
  const [a, b] = await Promise.all([inflight, queued]);
  assert.equal(a.ok, false);
  assert.match(a.error.message, /Dataview exec service disposed/);
  assert.equal(b.ok, false);
  assert.match(b.error.message, /Dataview exec service disposed/);
  const c = await svc.run(job("ok"));
  assert.equal(c.ok, false);
  assert.match(c.error.message, /Dataview exec service disposed/);
  const s = svc.stats();
  assert.equal(s.queued, 0);
  assert.equal(s.running, 0);
  assert.equal(s.completed, 0, "no job completed before dispose");
});
