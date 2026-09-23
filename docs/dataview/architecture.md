# Dataview subsystem — architecture

Companion documents: [usage / API / differences](./README.md) ·
[performance report](./performance.md)

## 1. Layers and files

```
src/
├─ extension.ts                     # activate: registerCommands + extendMarkdownIt(md)
├─ dataview/
│  ├─ types.ts                      # ALL cross-layer contracts (frozen in Step A)
│  ├─ values.ts  page.ts            # value mapping, page object builder (WeakMap memo)
│  ├─ index/                        # ── index layer ──────────────────────────
│  │   parse.ts yaml.ts yaml-flow.ts text.ts   # single-file parser (pure)
│  │   store.ts                     # incremental IndexStore + reverse indexes
│  ├─ query/                        # ── query layer ──────────────────────────
│  │   parseDql.ts expression.ts functions.ts  # DQL parser + expression engine
│  │   executeDql.ts source.ts dataArray.ts datetime.ts semantics.ts
│  ├─ dv/createDvApi.ts             # ── dv API (worker-side) ─────────────────
│  ├─ adapter/shim.ts               # `app` shim over the snapshot
│  ├─ exec/                         # ── sandbox layer ────────────────────────
│  │   workerRuntime.ts             # vm + dv/DQL execution (no vscode, no bridge)
│  │   workerEntry.ts               # dist/dataviewWorker.js entry
│  │   workerBridge.ts              # worker-side protocol plumbing
│  │   service.ts                   # host pool: sticky slots, timeout, cancel, IO
│  ├─ render/html.ts                # RenderOp → HTML (+ payload embedding)
│  ├─ preview/fencePlugin.ts        # markdown-it fence interception (no vscode)
│  ├─ host/                         # ── VSCode integration ───────────────────
│  │   indexer.ts                   # bootstrap + incremental flush (no vscode)
│  │   service.ts                   # block cache, dedup, refresh scheduling
│  │   vscodeFs.ts                  # workspace.fs / findFiles / watcher / paths
│  │   runtime.ts                   # composition root + lifecycle + stats command
│  ├─ webview/main.ts               # dist/dataviewWebview.js (windowed tables)
│  ├─ cache/{hash,lru}.ts           # keying + LRU
│  └─ perf/metrics.ts               # counters + timing series (p50 sliding window)
└─ media/dataview.css               # preview styles (theme variables)
```

Layering rule: **only `extension.ts`, `host/vscodeFs.ts`, `host/runtime.ts` and
the two entry points may import `vscode`.** Everything else is plain TS, which is
why the whole dataview stack runs under `node --test` (see `test/dataview-*.test.mjs`).

## 2. Data flow

```
 markdown file  ──scanner──▶  PageMeta  ──▶ IndexStore ──snapshot()──┐
 (workspace.fs)               (parse.ts)   (incremental)            │
                                                                    ▼
 preview render (markdown-it, SYNC)                          ExecService.ensureIndex
   fencePlugin ────▶ DataviewService.getBlock(env, kind, code) ───┐    │
   inlinePlugin ───▶ DataviewService.getInline(env, kind, code) ──┤    │
                       │ (one shared resolver: index gate/cache/    │    │
                       │  dedup/wave — only the key namespace,      │    │
                       │  ops post-processing and job kind differ)  │    │
                       │ cache hit ────────────▶ ready HTML         │    │
                       │ in flight ────────────▶ pending placeholder│    │
                       └ miss ──▶ enqueue ExecJob ─────────────────┴────┤
                                                     postMessage(worker_threads)
                                                                     ▼
                                              workerRuntime: vm context + dv + DQL
                                                                     │
                                            ExecResult{ops} ◀── workerBridge
                                                     │
                       renderOpsToHtml(ops)  ◀────────┘   (host render + cache set)
                                                     │
                       coalesced markdown.preview.refresh ──▶ next render = cache hit
```

Two design consequences worth stating explicitly:

* **`getBlock` is synchronous and never throws.** markdown-it's render phase
  cannot await, so a cache miss can only return a placeholder. The result is
  delivered by refreshing the preview — the only public API an extension has into
  the built-in preview's DOM. Refreshes are therefore batched, never per block.
* **The render cache is the refresh engine.** Keys include the index version, so a
  file edit invalidates stale results without any explicit invalidation protocol,
  and a refresh after the first wave costs zero worker round-trips.
* **Blocks and inline spans share one pipeline, one cache, two namespaces.** The
  cache key is `hash(namespace, kind, path, indexVersion, source)` with namespace
  `dv` for fences and `dvi` for inline spans, so identical sources in the two
  forms never share a result (a fence emits ops, an inline span emits a value).
  Everything else — the index-ready hold, in-flight dedup, wave accounting, the
  timeout path and the error isolation — is literally the same code
  (`DataviewService.resolve`), so an inline failure cannot affect a block and vice
  versa.
* **Two syntax surfaces, one worker protocol.** Fences become `dql`/`dataviewjs`
  jobs, inline spans become `inline-dql`/`inline-js` jobs; the worker dispatches
  to the DQL executor, the op-emitting script runner, or the expression runners
  (`runInlineDql` evaluates a DQL expression, `runInlineJs` compiles the span as
  `return (expr)` first and falls back to a statement list). All four kinds share
  the same sandbox factory (`createSandbox` → fresh `vm` context, `dv`/`app`/
  `input`, timer registry, nested-script runner with its depth limit).

## 3. Sequence: first render of a document with 3 blocks

```
Preview          FencePlugin        DataviewService     ExecService    Worker      Webview
  │  render md ──▶│                                                                     │
  │               │ getBlock #1 ────▶│ (cache miss, index ready)                        │
  │               │                 │ jobs=1, wave.open ──▶│ run ──▶│ exec dv/DQL       │
  │               │  pending html ◀─│                      │        │                   │
  │               │ getBlock #2,3 ──▶│ (dedup per key)      │        │                   │
  │  ◀── html (3 skeletons) ─────────│                      │        │                   │
  │               │                 │ ◀── done{ops} ───────│◀───────┘                   │
  │               │                 │ render+cache; wave empty ⇒ debounce 120ms          │
  │  ◀── markdown.preview.refresh ──│                                                   │
  │  render md ──▶│ getBlock ×3 ────▶│ all cache hits                                   │
  │  ◀── ready HTML (1 refresh, 3 jobs, ≤1 worker spawn per slot) ──▶│ windowing ──────▶│
```

Timeout path: `ExecService.onTimeout` resolves the job as an error **and** calls
`worker.terminate()`, because `while(true){}` never yields to the worker's message
loop. The slot then respawns (max 3 consecutive spawn failures per slot before it
is marked broken) and the block renders an error while the rest of the document
keeps working.

## 3b. Render boundaries the host owns (not the worker)

The worker only produces `RenderOp`s; everything that needs the preview's own
markdown-it happens on the host, so the markup matches the document body:

| Seam | Host renderer | Why |
|---|---|---|
| Table/list cell text | `md.renderInline` | A cell is inside `<td>`/`<li>`; block constructs would be invalid. |
| `dv.markdown(text)`, `dv.el(blockTag, text)` | `md.render` | Block content by contract (upstream renders it as a markdown document). |
| `dv.el(inlineTag, text)`, `dv.span/paragraph/header` | `md.renderInline` | Inline content model; keeps `<b>`/`<p>`/`<h1>` valid. |

Both renderers are injected (`renderInline`, `renderMarkdownBlock` in
`DataviewServiceDeps`) and optional: with neither, text degrades to escaped
literal, which is what the unit tests without a host renderer assert.

## 4. Key interfaces

```ts
// index layer (host, pure)
interface IndexStore {                    // index/store.ts
  readonly version: number;
  upsertFile(path: string, content: string, mtime: number, size: number): void;
  removeFile(path: string): void;
  snapshot(): IndexSnapshot;              // O(n) shallow copy of immutable pages
  byTag(tag: string): readonly string[];
}

// file-system port: vscodeFs.ts implements it, tests inject a fake
interface WorkspaceFileSystem {           // host/indexer.ts
  listMarkdownFiles(): Promise<{path: string}[]>;
  readFile(path: string): Promise<string>;
  stat(path: string): Promise<{mtimeMs: number; size: number}>;
  createWatcher(onEvent: (e: {kind: "create"|"change"|"delete"; path: string}) => void): {dispose(): void};
}

// preview ↔ service (frozen, sync)
interface BlockResultProvider {           // types.ts
  getBlock(env: DataviewRenderEnv, kind: "dataview" | "dataviewjs", code: string): BlockState;
}
type BlockState = {status: "ready"|"pending"|"error"; html: string};

// host ⇄ worker protocol (frozen)
type HostToWorker = {t:"syncIndex"; version:number; snapshot:IndexSnapshot}
                  | {t:"run"; job:ExecJob} | {t:"cancel"; id:string}
                  | {t:"ioResult"; …} | {t:"shutdown"};
type WorkerToHost = {t:"ready"; indexVersion:number} | {t:"done"; result:ExecResult}
                  | {t:"io"; …} | {t:"log"; level:…; message:string};

// worker-side injection point (keeps exec/ independent of dv/DQL)
interface WorkerRuntimeDeps {
  runJob(job: ExecJob, snapshot: IndexSnapshot, io: IoBridge): Promise<ExecResult>;
}
```

## 5. Concurrency & resource ownership

| Resource | Owner | Release |
|---|---|---|
| Worker threads | `exec/service.ts` (pool of N, sticky by page hash) | timeout/cancel → `terminate()` + respawn; `dispose()` awaited from `deactivate()` |
| Per-job timers created by user code | `workerRuntime.createTimers()` | released in a `finally` when the job settles |
| `vm` context + `dv`/`app` | per job (isolation) | GC'd with the job; page-object memo is `WeakMap`-keyed on immutable `PageMeta` |
| File watcher + debounce timers | `host/indexer.ts` | `dispose()` clears timers and closes the watcher (no post-dispose mutations) |
| Render cache / snapshot ref | `host/service.ts` | LRU bound; `invalidateAll()` on dataview setting change |
| preview refresh timer | `host/service.ts` | coalescing debounce + 400 ms throttle + 3 s stuck-wave safety net |

## 6. Where the cost is (measured, see performance.md)

| Stage | Cost | Mitigation in code |
|---|---|---|
| Full index of 1000 pages | ~113 ms | one parse per file, per-file concurrency 8 |
| Single-file update | ~0.12 ms (≈830× cheaper) | mtime+size short-circuit, reverse-index cascade |
| DQL query (filter, 1000 pages) | parse 0.04 ms + exec ~4.4 ms | parse is negligible → optimize execution (page-object memo cut it further) |
| `dv.pages()` scan (1000 pages) | 2.4 ms → **0.5 ms** after memo | `WeakMap<PageMeta, PageObject>` in `page.ts` |
| Per-job fixed cost | ~1.9 ms | snapshot-keyed path lookup map; the vm context (isolation) is the irreducible part |
| Render 1000×6 table | 3.1 ms (no payload) / 10.0 ms (payload) | server-side row/cell caps; webview windowing only for ≥100 rows |
| Worker round-trip | 97 ms first (spawn + snapshot clone), 9.9 ms after | sticky slot + `syncIndex` only on index version change |
