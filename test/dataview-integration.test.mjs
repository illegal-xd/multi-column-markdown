/**
 * Dataview host integration layer (Step C wiring) — end-to-end tests.
 *
 * Scope: the three host-side seams that are only correct when wired together:
 *   1. preview/fencePlugin  — markdown-it fence interception (real markdown-it)
 *   2. host/indexer         — bootstrap/incremental flush/dispose over a fake
 *                             WorkspaceFileSystem port (no vscode)
 *   3. host/service         — render cache, in-flight dedup, refresh throttle,
 *                             timeout + error isolation, driven by a REAL
 *                             worker thread (bundled exec/workerEntry.ts).
 *
 * The ExecService is deliberately NOT mocked: the point of these tests is the
 * real接线 (service → exec pool → worker → dv/DQL → RenderOp → host HTML).
 */
import {test, after} from "node:test";
import assert from "node:assert/strict";
import {execSync} from "node:child_process";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, dirname} from "node:path";
import {fileURLToPath} from "node:url";
import MarkdownIt from "markdown-it";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "amc-dv-host-"));

const bundles = {
  service: join(dir, "host-service.mjs"),
  indexer: join(dir, "host-indexer.mjs"),
  fence: join(dir, "fence-plugin.mjs"),
  index: join(dir, "dv-index.mjs"),
  worker: join(dir, "dataviewWorker.mjs"),
};

try {
  execSync(
    [
      `npx esbuild src/dataview/host/service.ts --bundle --format=esm --platform=node --outfile="${bundles.service}"`,
      `npx esbuild src/dataview/host/indexer.ts --bundle --format=esm --platform=node --outfile="${bundles.indexer}"`,
      `npx esbuild src/dataview/preview/fencePlugin.ts --bundle --format=esm --platform=node --outfile="${bundles.fence}"`,
      `npx esbuild src/dataview/index/index.ts --bundle --format=esm --platform=node --outfile="${bundles.index}"`,
      `npx esbuild src/dataview/exec/workerEntry.ts --bundle --format=esm --platform=node --outfile="${bundles.worker}"`,
    ].join(" && "),
    {cwd: repoRoot, stdio: "pipe"},
  );
} catch (e) {
  console.error(String(e.stdout ?? e));
  process.exit(1);
}

const {createDataviewService} = await import(bundles.service);
const {createWorkspaceIndexer} = await import(bundles.indexer);
const {installDataviewFences, DV_BLOCK_LINE_ENV_KEY} = await import(bundles.fence);
const {createIndexStore} = await import(bundles.index);

after(() => {
  rmSync(dir, {recursive: true, force: true});
});

// ── shared helpers ───────────────────────────────────────────────────────────

const FENCE = "```";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `check` (sync) until true; on timeout fail with the last observed state. */
async function waitFor(check, {label = "condition", timeoutMs = 5000, intervalMs = 20, state} = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) {
      const snapshot = typeof state === "function" ? state() : state;
      assert.fail(`waitFor(${label}) timed out after ${timeoutMs}ms; last state: ${JSON.stringify(snapshot)}`);
    }
    await sleep(intervalMs);
  }
}

/** Inverse of src/preview/htmlEscape.escapeHtml (no single-quote escaping there). */
function unescapeHtml(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// ═════════════════════════════════════════════════════════════════════════════
// A. fencePlugin (real markdown-it)
// ═════════════════════════════════════════════════════════════════════════════

const NO_DV_DOC = [
  "# Title",
  "",
  FENCE + "js",
  "const a = 1;",
  FENCE,
  "",
  FENCE + "python",
  "x = 1",
  FENCE,
  "",
  FENCE,
  "plain text",
  FENCE,
  "",
  // Near-miss language: must NOT be intercepted (exact match on first word).
  FENCE + "dataviews",
  "not intercepted",
  FENCE,
  "",
].join("\n");

test("fence A1: dataviewjs/dataview are wrapped in dataview-block with data-dv-lang/state", () => {
  const provider = {
    getBlock(_env, kind, code) {
      if (code.includes("still-running")) return {status: "pending", html: "<i>wait</i>"};
      return {status: "ready", html: `<span>${kind}-ok</span>`};
    },
  };
  const md = new MarkdownIt();
  installDataviewFences(md, {provider});

  const jsOut = md.render([FENCE + "dataviewjs", "ready", FENCE, ""].join("\n"));
  assert.equal(
    jsOut,
    `<div class="dataview-block" data-dv-lang="dataviewjs" data-dv-state="ready"><span>dataviewjs-ok</span></div>\n`,
  );

  const dqlOut = md.render([FENCE + "dataview", "still-running", FENCE, ""].join("\n"));
  assert.equal(
    dqlOut,
    `<div class="dataview-block" data-dv-lang="dataview" data-dv-state="pending"><i>wait</i></div>\n`,
  );
});

test("fence A2: js/python/unlabeled/near-miss fences are byte-identical to the no-plugin baseline", () => {
  const baseline = new MarkdownIt().render(NO_DV_DOC);
  // Sanity: the baseline really does contain native fences (not an empty doc).
  assert.ok(baseline.includes('<code class="language-js">'));
  assert.ok(baseline.includes('<code class="language-python">'));

  let providerCalls = 0;
  const md = new MarkdownIt();
  installDataviewFences(md, {
    provider: {
      getBlock() {
        providerCalls++;
        return {status: "ready", html: "<b>nope</b>"};
      },
    },
  });
  const out = md.render(NO_DV_DOC);
  assert.equal(out, baseline);
  assert.equal(providerCalls, 0);
});

test("fence A3: isEnabled:false sends both dataview fences down the native renderer", () => {
  const doc = [FENCE + "dataviewjs", "x", FENCE, "", FENCE + "dataview", "TABLE a", FENCE, ""].join("\n");
  const baseline = new MarkdownIt().render(doc);
  assert.ok(baseline.includes('<code class="language-dataviewjs">'));
  assert.ok(baseline.includes('<code class="language-dataview">'));

  let providerCalls = 0;
  const md = new MarkdownIt();
  installDataviewFences(md, {
    provider: {
      getBlock() {
        providerCalls++;
        return {status: "ready", html: "<b>nope</b>"};
      },
    },
    isEnabled: () => false,
  });
  assert.equal(md.render(doc), baseline);
  assert.equal(providerCalls, 0);
});

test("fence A4: a throwing provider renders an error block and never throws", () => {
  const md = new MarkdownIt();
  installDataviewFences(md, {
    provider: {
      getBlock() {
        throw new Error("provider <boom>");
      },
    },
  });

  let out = "";
  assert.doesNotThrow(() => {
    out = md.render([FENCE + "dataviewjs", "x", FENCE, ""].join("\n"));
  });
  assert.ok(out.includes('<div class="dataview-block" data-dv-lang="dataviewjs" data-dv-state="error">'));
  assert.ok(out.includes("provider &lt;boom&gt;"), out);
});

test("fence A5: provider receives the 0-based fence start line and the raw fence code", () => {
  const calls = [];
  const provider = {
    getBlock(env, kind, code) {
      calls.push({kind, code, line: env[DV_BLOCK_LINE_ENV_KEY]});
      return {status: "ready", html: "<b>1</b>"};
    },
  };
  const md = new MarkdownIt();
  installDataviewFences(md, {provider});

  const src = ["intro", "", FENCE + "dataviewjs", 'dv.paragraph("x")', FENCE, ""].join("\n");
  const env = {};
  md.render(src, env);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, "dataviewjs");
  assert.equal(calls[0].code, 'dv.paragraph("x")\n'); // fence原文 incl. trailing newline
  assert.equal(calls[0].line, 2); // "```dataviewjs" is line index 2
  assert.equal(env[DV_BLOCK_LINE_ENV_KEY], 2); // env is mutated in place
});

test("fence A6: installDataviewFences is idempotent per markdown-it instance", () => {
  let calls = 0;
  const md = new MarkdownIt();
  installDataviewFences(md, {
    provider: {
      getBlock() {
        calls++;
        return {status: "ready", html: "<b>once</b>"};
      },
    },
  });
  // Second install must be a no-op — this provider would blow up if it were used.
  installDataviewFences(md, {
    provider: {
      getBlock() {
        throw new Error("second provider must never be installed");
      },
    },
  });

  const out = md.render([FENCE + "dataviewjs", "x", FENCE, ""].join("\n"));
  assert.equal(calls, 1);
  assert.equal((out.match(/dataview-block/g) ?? []).length, 1);
  assert.equal(out, `<div class="dataview-block" data-dv-lang="dataviewjs" data-dv-state="ready"><b>once</b></div>\n`);
});

// ═════════════════════════════════════════════════════════════════════════════
// B. host/indexer (fake WorkspaceFileSystem port, no vscode)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Port fake. `readFile` yields one macrotask before resolving so overlapping
 * reads are observable (concurrency proof); failing entries throw from both
 * readFile and stat (the indexer isolates the pair).
 */
function createFakeFs(entries) {
  const files = new Map();
  entries.forEach((e, i) => {
    files.set(e.path, {content: e.content, mtime: e.mtime ?? 1000 + i * 7, fail: e.fail === true});
  });

  let inFlight = 0;
  let peak = 0;
  let watchCb = null;
  let watchDisposed = false;

  return {
    files,
    get peak() {
      return peak;
    },
    get watchDisposed() {
      return watchDisposed;
    },
    setContent(path, content, mtime) {
      const f = files.get(path);
      if (!f) throw new Error(`fake fs: unknown path ${path}`);
      f.content = content;
      f.mtime = mtime ?? f.mtime + 1;
    },
    addFile(path, content, mtime = 999999) {
      files.set(path, {content, mtime, fail: false});
    },
    removeFile(path) {
      files.delete(path);
    },
    emit(event) {
      // Deliberately independent of dispose(): simulates a racing watcher event.
      if (watchCb) watchCb(event);
    },
    port: {
      async listMarkdownFiles() {
        return [...files.keys()].sort().map((path) => ({path}));
      },
      async readFile(path) {
        inFlight++;
        if (inFlight > peak) peak = inFlight;
        try {
          await new Promise((r) => setImmediate(r)); // allow lane overlap
          const f = files.get(path);
          if (!f || f.fail) throw new Error(`EACCES: cannot read ${path}`);
          return f.content;
        } finally {
          inFlight--;
        }
      },
      async stat(path) {
        const f = files.get(path);
        if (!f || f.fail) throw new Error(`EACCES: cannot stat ${path}`);
        return {mtimeMs: f.mtime, size: f.content.length};
      },
      createWatcher(onEvent) {
        watchCb = onEvent;
        return {
          dispose() {
            watchDisposed = true;
            watchCb = null;
          },
        };
      },
    },
  };
}

function fortyPages() {
  return Array.from({length: 40}, (_, i) => {
    const n = String(i).padStart(2, "0");
    return {path: `notes/f${n}.md`, content: `---\ntags: [t${i}]\n---\n# Doc ${i}\n\nbody ${i}\n`};
  });
}

test("indexer B7: bootstrap indexes 40 files and reports bootstrapped/bootstrapMs", async () => {
  const fs = createFakeFs(fortyPages());
  const store = createIndexStore();
  const indexer = createWorkspaceIndexer(fs.port, store, {concurrency: 8, debounceMs: 150});
  await indexer.bootstrap();

  const stats = indexer.stats();
  assert.equal(stats.files, 40);
  assert.equal(stats.bootstrapped, true);
  assert.equal(typeof stats.bootstrapMs, "number");
  assert.ok(stats.bootstrapMs >= 0, `bootstrapMs=${stats.bootstrapMs}`);
  assert.equal(store.stats().files, 40);
  assert.ok(store.getPage("notes/f00.md"));

  indexer.dispose();
});

test("indexer B8: bootstrap reads files concurrently (peak in-flight > 1)", async () => {
  const fs = createFakeFs(fortyPages());
  const store = createIndexStore();
  const indexer = createWorkspaceIndexer(fs.port, store, {concurrency: 8, debounceMs: 150});
  await indexer.bootstrap();

  assert.ok(fs.peak > 1, `expected concurrent reads, peak in-flight = ${fs.peak}`);
  assert.ok(fs.peak <= 8, `concurrency must be bounded, peak in-flight = ${fs.peak}`);
  console.log(`[B8] peak concurrent readFile = ${fs.peak}`);

  indexer.dispose();
});

test("indexer B9: one changed file → version+1, parseCalls+1, untouched PageMeta keeps identity", async () => {
  const fs = createFakeFs(fortyPages());
  const store = createIndexStore();
  const indexer = createWorkspaceIndexer(fs.port, store, {debounceMs: 20});
  await indexer.start();

  const untouchedRef = store.getPage("notes/f01.md");
  const versionBefore = store.version;
  const parseBefore = store.stats().parseCalls;

  fs.setContent("notes/f00.md", "---\ntags: [t0]\n---\n# Doc 0 EDITED\n\nchanged body\n", 555555);
  fs.emit({kind: "change", path: "notes/f00.md"});
  await waitFor(() => store.version > versionBefore, {
    label: "incremental flush",
    state: () => ({version: store.version, parseCalls: store.stats().parseCalls}),
  });

  assert.equal(store.version, versionBefore + 1);
  assert.equal(store.stats().parseCalls, parseBefore + 1);
  assert.equal(store.getPage("notes/f00.md").headings[0].text, "Doc 0 EDITED");
  // Incremental, not a rebuild: the untouched page object is the same reference.
  assert.equal(store.getPage("notes/f01.md"), untouchedRef);
  assert.ok(store.allPages().includes(untouchedRef));

  indexer.dispose();
});

test("indexer B10: 5 rapid change events on one path coalesce into exactly 1 parse", async () => {
  const fs = createFakeFs(fortyPages());
  const store = createIndexStore();
  const indexer = createWorkspaceIndexer(fs.port, store, {debounceMs: 20});
  await indexer.start();

  const versionBefore = store.version;
  const parseBefore = store.stats().parseCalls;

  fs.setContent("notes/f00.md", "# burst\n\nedited once\n", 666666);
  for (let i = 0; i < 5; i++) fs.emit({kind: "change", path: "notes/f00.md"});

  await waitFor(() => store.version > versionBefore, {
    label: "coalesced flush",
    state: () => ({version: store.version, parseCalls: store.stats().parseCalls}),
  });
  await sleep(60); // give any (buggy) extra flush a chance to show up

  assert.equal(store.stats().parseCalls, parseBefore + 1);
  assert.equal(indexer.stats().lastFlushPaths, 1);

  indexer.dispose();
});

test("indexer B11: watcher delete removes the page from the store and its tag bucket", async () => {
  const fs = createFakeFs(fortyPages());
  const store = createIndexStore();
  const indexer = createWorkspaceIndexer(fs.port, store, {debounceMs: 20});
  await indexer.start();

  assert.ok(store.byTag("#t1").includes("notes/f01.md"));
  const versionBefore = store.version;

  fs.removeFile("notes/f01.md");
  fs.emit({kind: "delete", path: "notes/f01.md"});
  await waitFor(() => store.getPage("notes/f01.md") === undefined, {
    label: "delete flush",
    state: () => ({version: store.version, stillThere: store.getPage("notes/f01.md") !== undefined}),
  });

  assert.equal(store.getPage("notes/f01.md"), undefined);
  assert.equal(store.byTag("#t1").includes("notes/f01.md"), false);
  assert.equal(store.stats().files, 39);
  assert.equal(store.version, versionBefore + 1);

  indexer.dispose();
});

test("indexer B12: an unreadable file does not fail bootstrap and stays out of the store", async () => {
  const entries = fortyPages();
  entries.push({path: "notes/broken.md", content: "never read", fail: true});
  const fs = createFakeFs(entries);
  const store = createIndexStore();
  const errors = [];
  const indexer = createWorkspaceIndexer(fs.port, store, {debounceMs: 20, onError: (e) => errors.push(e)});

  await indexer.bootstrap();

  const stats = indexer.stats();
  assert.equal(stats.bootstrapped, true);
  assert.equal(stats.files, 40); // 41 listed, 1 unreadable
  assert.equal(store.getPage("notes/broken.md"), undefined);
  assert.ok(store.getPage("notes/f00.md"), "healthy files must survive");
  assert.ok(errors.length >= 1, "the read failure must be reported through onError");

  indexer.dispose();
});

test("indexer B13: lastFlushPaths/lastFlushMs are recorded after a two-path flush", async () => {
  const fs = createFakeFs(fortyPages());
  const store = createIndexStore();
  const indexer = createWorkspaceIndexer(fs.port, store, {debounceMs: 20});
  await indexer.start();

  assert.equal(indexer.stats().lastFlushPaths, 0); // bootstrap is not a flush
  const versionBefore = store.version;

  fs.setContent("notes/f02.md", "# two\n\nedited a\n", 777002);
  fs.setContent("notes/f03.md", "# three\n\nedited b\n", 777003);
  fs.emit({kind: "change", path: "notes/f02.md"});
  fs.emit({kind: "change", path: "notes/f03.md"});

  await waitFor(() => store.version > versionBefore && indexer.stats().lastFlushPaths === 2, {
    label: "two-path flush",
    state: () => ({version: store.version, lastFlushPaths: indexer.stats().lastFlushPaths}),
  });

  const stats = indexer.stats();
  assert.equal(stats.lastFlushPaths, 2);
  assert.equal(typeof stats.lastFlushMs, "number");
  assert.ok(Number.isFinite(stats.lastFlushMs) && stats.lastFlushMs >= 0, `lastFlushMs=${stats.lastFlushMs}`);
  assert.equal(store.stats().parseCalls, 40 + 2);

  indexer.dispose();
});

test("indexer B14: dispose() cancels a pending flush and ignores later watcher events", async () => {
  const fs = createFakeFs(fortyPages());
  const store = createIndexStore();
  const indexer = createWorkspaceIndexer(fs.port, store, {debounceMs: 20});
  await indexer.start();

  const versionBefore = store.version;
  const filesBefore = store.stats().files;

  // Arm a debounced flush, then dispose before the timer can fire.
  fs.setContent("notes/f00.md", "# disposed\n\nmust not land\n", 888000);
  fs.emit({kind: "change", path: "notes/f00.md"});
  indexer.dispose();
  assert.equal(fs.watchDisposed, true);

  // Stale event from a racing watcher (emit is dispose-independent by design).
  fs.emit({kind: "change", path: "notes/f00.md"});
  fs.emit({kind: "delete", path: "notes/f02.md"});
  await sleep(200); // >> debounceMs

  assert.equal(store.version, versionBefore);
  assert.equal(store.stats().files, filesBefore);
  assert.equal(store.getPage("notes/f00.md").headings[0].text, "Doc 0");

  indexer.dispose(); // idempotent
});

// ═════════════════════════════════════════════════════════════════════════════
// C. host/service (REAL bundled worker — ExecService is never mocked)
// ═════════════════════════════════════════════════════════════════════════════

const PAGE_ENV = () => ({currentDocument: {fsPath: "/ws/page.md", toString: () => "/ws/page.md"}});

function seedStore(pages) {
  const store = createIndexStore();
  pages.forEach(([path, content], i) => store.upsertFile(path, content, 1000 + i * 7, content.length));
  return store;
}

function createHarness({store, deps} = {}) {
  const realStore = store ?? seedStore([["page.md", "# Page\n\n#proj\n"]]);
  // completedAtRefresh: exec.completed at each refresh — lets a test prove the
  // preview updates WHILE a wave is still running (progressive batches).
  const counters = {refreshes: 0, completedAtRefresh: []};
  let serviceRef = null;
  const service = createDataviewService({
    workerPath: bundles.worker,
    store: realStore,
    toRelativePath: (p) => (p === undefined ? undefined : p.split("/").slice(-1)[0]),
    refresh: () => {
      counters.refreshes++;
      counters.completedAtRefresh.push(serviceRef ? serviceRef.stats().exec.completed : -1);
    },
    isIndexReady: () => true,
    hostIo: {read: async () => "io-content", exists: async () => true},
    refreshDebounceMs: 10,
    refreshMinIntervalMs: 20,
    poolSize: 2,
    ...(deps ?? {}),
  });
  serviceRef = service;
  return {store: realStore, service, counters, dispose: () => service.dispose()};
}

/** Enqueue (if needed) and wait until the block reaches `wantStatus`. */
async function settle(h, env, kind, code, wantStatus, label, timeoutMs = 10000) {
  const first = h.service.getBlock(env, kind, code);
  if (first.status === wantStatus) return first;
  let last = first;
  await waitFor(
    () => {
      last = h.service.getBlock(env, kind, code);
      return last.status === wantStatus;
    },
    {
      label,
      timeoutMs,
      state: () => ({status: last.status, html: last.html.slice(0, 200), exec: h.service.stats().exec}),
    },
  );
  return last;
}

test("service C15: first getBlock is pending, then ready with the expected HTML", async () => {
  const h = createHarness();
  try {
    const env = PAGE_ENV();
    const code = 'dv.paragraph("hello")';

    const first = h.service.getBlock(env, "dataviewjs", code);
    assert.equal(first.status, "pending");
    assert.ok(first.html.includes("dataview-pending"), first.html);

    const ready = await settle(h, env, "dataviewjs", code, "ready", "paragraph block ready");
    assert.equal(ready.status, "ready");
    assert.equal(ready.html, '<div class="dataview-container" data-dv-kind="paragraph"><p>hello</p></div>');
  } finally {
    await h.dispose();
  }
});

test("service C16: second getBlock is a cache hit — no extra worker execution, hitRate > 0", async () => {
  const h = createHarness();
  try {
    const env = PAGE_ENV();
    const code = 'dv.paragraph("cache me")';
    await settle(h, env, "dataviewjs", code, "ready", "first run");

    const completedAfterFirst = h.service.stats().exec.completed;
    assert.equal(completedAfterFirst, 1);

    const again = h.service.getBlock(env, "dataviewjs", code);
    assert.equal(again.status, "ready");
    assert.ok(again.html.includes("cache me"));

    await sleep(150);
    assert.equal(h.service.stats().exec.completed, completedAfterFirst);
    const stats = h.service.stats();
    assert.ok(stats.cacheHitRate > 0, `cacheHitRate=${stats.cacheHitRate}`);
  } finally {
    await h.dispose();
  }
});

test("service C17: in-flight dedup — two rapid getBlock calls cost one worker execution", async () => {
  const h = createHarness();
  try {
    const env = PAGE_ENV();
    const code = 'dv.paragraph("dedup")';

    const a = h.service.getBlock(env, "dataviewjs", code);
    const b = h.service.getBlock(env, "dataviewjs", code);
    assert.equal(a.status, "pending");
    assert.equal(b.status, "pending");
    assert.equal(b.html.includes("dataview-pending"), true);

    await settle(h, env, "dataviewjs", code, "ready", "deduped block ready", 10000);
    await sleep(150);
    assert.equal(h.service.stats().exec.completed, 1, "a second job must not have been dispatched");
  } finally {
    await h.dispose();
  }
});

test("service C18: 5 blocks in one document coalesce into at most 2 preview refreshes", async () => {
  const h = createHarness();
  try {
    const env = PAGE_ENV();
    const codes = ["alpha", "beta", "gamma", "delta", "epsilon"].map((w) => `dv.paragraph("${w}")`);

    const firstPass = codes.map((c) => h.service.getBlock(env, "dataviewjs", c));
    assert.equal(firstPass.filter((s) => s.status === "pending").length, 5);

    await waitFor(() => codes.every((c) => h.service.getBlock(env, "dataviewjs", c).status === "ready"), {
      label: "all 5 blocks ready",
      timeoutMs: 20000,
      state: () => ({
        exec: h.service.stats().exec,
        refreshes: h.service.stats().refreshes,
        blocks: codes.map((c) => h.service.getBlock(env, "dataviewjs", c).status),
      }),
    });
    await sleep(250); // let debounce + min-interval windows close

    const stats = h.service.stats();
    console.log(`[C18] refreshes=${stats.refreshes} skipped=${stats.skippedRefreshes} injectedRefreshCalls=${h.counters.refreshes}`);
    assert.ok(stats.refreshes <= 2, `refreshes=${stats.refreshes}`);
    assert.equal(stats.refreshes, h.counters.refreshes, "stats.refreshes must match the injected refresh() calls");
    assert.equal(stats.exec.completed, 5);
  } finally {
    await h.dispose();
  }
});

test("service C18b: slow blocks refresh progressively (after each batch), not only at the end", async () => {
  const h = createHarness({deps: {poolSize: 3}});
  try {
    const env = PAGE_ENV();
    // 7 blocks that each keep their worker busy for 150ms: with the per-page cap
    // of 3 the document drains in 3 batches, so the preview must already show
    // the first results while the last blocks are still running.
    const codes = Array.from({length: 7}, (_, i) => `await new Promise((r) => setTimeout(r, 150)); dv.paragraph("b${i}")`);

    const firstPass = codes.map((c) => h.service.getBlock(env, "dataviewjs", c));
    assert.equal(firstPass.filter((s) => s.status === "pending").length, 7);

    await waitFor(() => codes.every((c) => h.service.getBlock(env, "dataviewjs", c).status === "ready"), {
      label: "all 7 slow blocks ready",
      timeoutMs: 20000,
      state: () => ({exec: h.service.stats().exec, refreshes: h.service.stats().refreshes}),
    });
    await sleep(250); // let debounce + min-interval windows close

    const stats = h.service.stats();
    console.log(`[C18b] refreshes=${stats.refreshes} completedAtRefresh=${JSON.stringify(h.counters.completedAtRefresh)}`);
    assert.equal(stats.exec.completed, 7);
    assert.ok(stats.refreshes >= 2, `expected progressive refreshes, got ${stats.refreshes}`);
    assert.ok(
      h.counters.completedAtRefresh.some((n) => n > 0 && n < 7),
      `at least one refresh must land while blocks are still running, got ${JSON.stringify(h.counters.completedAtRefresh)}`,
    );
  } finally {
    await h.dispose();
  }
});

test("service C19: error isolation — a throwing block errors while its sibling still renders", async () => {
  const h = createHarness();
  try {
    const env = PAGE_ENV();
    const bad = 'throw new Error("boom")';
    const good = 'dv.paragraph("sibling-ok")';

    assert.equal(h.service.getBlock(env, "dataviewjs", bad).status, "pending");
    assert.equal(h.service.getBlock(env, "dataviewjs", good).status, "pending");

    const errState = await settle(h, env, "dataviewjs", bad, "error", "throwing block -> error");
    assert.equal(errState.status, "error");
    assert.ok(errState.html.includes("boom"), errState.html);
    assert.ok(errState.html.includes("dataview-error"), errState.html);

    const okState = await settle(h, env, "dataviewjs", good, "ready", "sibling block -> ready");
    assert.ok(okState.html.includes("sibling-ok"), okState.html);
    assert.equal(h.service.stats().jobFailures, 1);
  } finally {
    await h.dispose();
  }
});

test("service C20: an error block is cached — it is not re-executed on the next getBlock", async () => {
  const h = createHarness();
  try {
    const env = PAGE_ENV();
    const bad = 'throw new Error("boom-once")';
    const errState = await settle(h, env, "dataviewjs", bad, "error", "throwing block -> error");
    assert.ok(errState.html.includes("boom-once"));

    const completed = h.service.stats().exec.completed;
    assert.equal(completed, 1);

    const cached = h.service.getBlock(env, "dataviewjs", bad);
    assert.equal(cached.status, "error");
    assert.equal(cached.html, errState.html);

    await sleep(150);
    assert.equal(h.service.stats().exec.completed, completed, "cached error must not re-run");
    assert.equal(h.service.stats().jobFailures, 1);
  } finally {
    await h.dispose();
  }
});

test("service C21: timeoutMs:300 turns an infinite loop into an error and the service stays usable", async () => {
  const h = createHarness({deps: {timeoutMs: 300}});
  try {
    const env = PAGE_ENV();
    const hung = "while(true){}";

    assert.equal(h.service.getBlock(env, "dataviewjs", hung).status, "pending");
    const errState = await settle(h, env, "dataviewjs", hung, "error", "hung block -> error", 10000);
    assert.equal(errState.status, "error");
    assert.ok(errState.html.includes("timed out"), errState.html.slice(0, 300));

    // The pool must recover (respawned worker) for unrelated blocks.
    const ok = await settle(h, env, "dataviewjs", 'dv.paragraph("after-timeout")', "ready", "post-timeout block", 10000);
    assert.ok(ok.html.includes("after-timeout"), ok.html);
    console.log(`[C21] exec after timeout: ${JSON.stringify(h.service.stats().exec)}`);
  } finally {
    await h.dispose();
  }
});

test("service C22: isIndexReady:false gates execution — blocks stay pending, worker untouched", async () => {
  const h = createHarness({deps: {isIndexReady: () => false}});
  try {
    const env = PAGE_ENV();
    const code = 'dv.paragraph("gated")';

    const first = h.service.getBlock(env, "dataviewjs", code);
    assert.equal(first.status, "pending");
    assert.ok(first.html.includes("dataview-pending"), first.html);
    assert.ok(first.html.includes('data-dv-kind="dataviewjs"'), first.html);

    await sleep(200);

    const second = h.service.getBlock(env, "dataviewjs", code);
    assert.equal(second.status, "pending");
    const stats = h.service.stats();
    assert.equal(stats.exec.completed, 0);
    assert.equal(stats.exec.running, 0);
    assert.equal(stats.exec.queued, 0);
    assert.equal(stats.inFlight, 0);
  } finally {
    await h.dispose();
  }
});

test("service C23: dispose() resolves (no hang) and blocks afterwards return a disposed error", async () => {
  const h = createHarness();
  const env = PAGE_ENV();
  h.service.getBlock(env, "dataviewjs", 'dv.paragraph("x")');

  const outcome = await Promise.race([
    h.service.dispose().then(() => "disposed"),
    sleep(5000).then(() => "timeout"),
  ]);
  assert.equal(outcome, "disposed", "dispose() must not hang");

  const after = h.service.getBlock(env, "dataviewjs", 'dv.paragraph("y")');
  assert.equal(after.status, "error");
  assert.ok(after.html.includes("disposed"), after.html);
});

test("service C24: 150-row dv.table embeds data-dv-payload (kind=table, 150 rows)", async () => {
  const h = createHarness();
  try {
    const env = PAGE_ENV();
    const rows = Array.from({length: 150}, (_, i) => [i]);
    const code = `dv.table(["n"], ${JSON.stringify(rows)})`;

    const state = await settle(h, env, "dataviewjs", code, "ready", "150-row table", 15000);
    assert.ok(
      state.html.startsWith('<div class="dataview-container" data-dv-kind="table" data-dv-total-rows="150"'),
      state.html.slice(0, 160),
    );

    const m = /data-dv-payload="([^"]*)"/.exec(state.html);
    assert.ok(m, "data-dv-payload attribute missing");
    const payload = JSON.parse(unescapeHtml(m[1]));
    assert.equal(payload.kind, "table");
    assert.equal(payload.v, 1);
    assert.equal(payload.total, 150);
    assert.equal(payload.rows.length, 150);
    assert.deepEqual(payload.headers, ["<th>n</th>"]);
    assert.deepEqual(payload.rows[0].cells, ["<td>0</td>"]);
    assert.deepEqual(payload.rows[149].cells, ["<td>149</td>"]);
  } finally {
    await h.dispose();
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// D. end-to-end consistency (service path vs DQL fence path)
// ═════════════════════════════════════════════════════════════════════════════

test("e2e D25: dataviewjs and ```dataview paths render the same page names without undefined", async () => {
  const store = seedStore([
    ["page.md", "# Page\n"],
    ["alpha.md", "# Alpha\n"],
    ["beta.md", "# Beta\n"],
  ]);
  const h = createHarness({store});
  try {
    const env = PAGE_ENV();

    // (a) dataviewjs through the service directly.
    const jsState = await settle(h, env, "dataviewjs", "dv.list(dv.pages().map((p) => p.file.name))", "ready", "dataviewjs list", 15000);

    // (b) same data through a real ```dataview DQL fence + real markdown-it.
    const md = new MarkdownIt();
    installDataviewFences(md, {provider: h.service});
    const dqlDoc = [FENCE + "dataview", "LIST file.name", FENCE, ""].join("\n");
    const dqlEnv = PAGE_ENV();

    const firstRender = md.render(dqlDoc, dqlEnv);
    assert.ok(firstRender.includes('data-dv-state="pending"'), firstRender);

    let dqlHtml = firstRender;
    await waitFor(
      () => {
        dqlHtml = md.render(dqlDoc, dqlEnv);
        return dqlHtml.includes('data-dv-state="ready"');
      },
      {label: "DQL fence ready", timeoutMs: 15000, state: () => ({snippet: dqlHtml.slice(0, 240)})},
    );

    const listItems = (html) => [...html.matchAll(/<li>([^<]+)<\/li>/g)].map((m) => m[1]).sort();
    assert.deepEqual(listItems(jsState.html), ["alpha", "beta", "page"]);
    assert.deepEqual(listItems(dqlHtml), ["alpha", "beta", "page"]);
    assert.ok(jsState.html.includes('data-dv-kind="list"'));

    for (const out of [jsState.html, dqlHtml]) {
      assert.ok(!out.includes("undefined"), `unexpected "undefined": ${out.slice(0, 240)}`);
      assert.ok(!out.includes("[object Object]"), `unexpected "[object Object]": ${out.slice(0, 240)}`);
    }
  } finally {
    await h.dispose();
  }
});
