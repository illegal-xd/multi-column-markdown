# Dataview subsystem — performance report

**All numbers below are measured, not estimated.** Absolute values are
machine-dependent; the portable parts are the **ratios** (incremental/full,
cacheHit/cacheMiss, post/pre optimization) and the shape (linear vs superlinear).

## 1. How to reproduce

```bash
# Full benchmark suite (9 tests, ~8s; 3000-page tier is env-gated)
NODE_PATH=./test/helpers/node_modules node --test --test-reporter=spec test/dataview-perf.test.mjs

# 3000-page index tier
AMC_PERF_BIG=1 NODE_PATH=./test/helpers/node_modules node --test test/dataview-perf.test.mjs
```

Corpus: deterministic synthetic workspace (`test/dataview-perf.test.mjs`
`makePage(i)`): 1000 files, ~1.19 KB each (frontmatter with tags/status/due, 2
headings, 3 tasks with inline fields, 2 wikilinks, 1 tag) — no RNG, no clock.

Environment for the numbers in this document: **Intel i9-9880H (8C/16T),
Node v25.3.0, macOS**. Baselines fluctuate ~±20% between runs on a loaded
machine, so treat single-run deltas below ~1.3× as noise.

## 2. Index layer

| Metric | Measured | Notes |
|---|---|---|
| Full index, 1000 pages | **126 ms** (7 917 files/s; p50 over 3 rounds; min 120 ms) | `store.upsertFile` incl. parse + reverse indexes |
| Full index, 3000 pages | 317 ms (9 452 files/s) | timeRatio 2.69× for 3.00× pages ⇒ linear |
| `snapshot()` (1000 pages) | **0.0029 ms** | shallow copy of immutable pages — asserts the code never deep-clones |
| Incremental update (1 file) | **0.114 ms** | vs 165 ms full ⇒ **1 445×** cheaper |
| Bootstrap via indexer, concurrency 1 / 8 / 16 | 179 / 157 / 153 ms | in-memory fake FS — see caveat §6 |
| Retained heap per indexed page | **~4.4 KB** | 1000 pages ⇒ +4.2 MB `heapUsed` (forced GC) |

The incremental number is the one that matters at scale: a save re-parses one
file and re-links its targets. The `(mtime, size)` short-circuit means even a
touched-but-unchanged file costs nothing.

## 3. Query engine

1000-page corpus, 50 rounds, p50 / p95:

| Query | Parse (p50) | Execute (p50) | p95 exec |
|---|---|---|---|
| `TABLE … WHERE status == "open" SORT due ASC LIMIT 20` | 0.040 ms | **1.78 ms** | 6.51 ms |
| `TABLE … GROUP BY status` (1000 rows out) | 0.018 ms | 1.85 ms | 3.66 ms |
| `TASKS WHERE status != "x"` (3000 tasks scanned) | 0.006 ms | 2.83 ms | 5.23 ms |

Parsing is 1–2 orders of magnitude below execution, so the engine — not the
parser — is where optimization work pays. (Before the page-object memo of §5
these execution numbers were 4.36 / 4.71 / 2.24 ms.)

## 4. Rendering

| Metric | payload off | payload on (default) |
|---|---|---|
| 1000 rows × 6 cols | **3.41 ms**, 125 KB HTML | **10.99 ms**, 416 KB HTML |
| Overhead of virtualizable payload | — | +222% time, +232% bytes |

Interpretation (deliberate trade-off, not an oversight): the extra pass renders
each cell twice — once into the server HTML (works without JS, survives CSP) and
once into the `data-dv-payload` attribute that the preview script uses for
60-row windowed scrolling. It is +7.6 ms of host time in exchange for a
preview that does not put 1000 rows in the DOM. It only applies to tables ≥100
rows; smaller tables never pay it.

## 5. Sandbox execution

| Metric | Measured | Notes |
|---|---|---|
| `vm` job, warm (p50 over 30) | **3.77 ms** | typical `dv.pages(...).where(...).limit(...).map(...)` + `dv.table` |
| `vm` job, cold (first ever) | 15.9 ms | **upper bound** — includes JIT warm-up of the whole query path |
| `new vm.Script` compile (130 B block) | **0.0037 ms** | — |
| `new vm.Script` compile (3.9 KB block) | 0.0072 ms | — |
| 1e6-iteration JS loop (CPU reference) | 11.2 ms | the sandbox's own CPU ceiling reference |
| Worker round-trip, 1st job | **65.8 ms** | includes thread spawn + `syncIndex` structured clone of 1000 pages |
| Worker round-trip, 2nd/3rd job | **2.82 / 2.46 ms** | same slot, snapshot already in the worker ⇒ **23×** faster than the first |

### Honest correction to an earlier assumption

`workerRuntime.ts` originally claimed the compiled-script cache was the dominant
per-block cost. **Measurement disproved it**: compiling is 3.7 µs against ~1.9 ms
of fixed per-job overhead (vm context + `dv` + `app` shim), i.e. under 0.2%. The
cache is kept (a Map lookup for a ~4 µs win, more for large blocks) but the
source comment was rewritten to say what was measured. `cacheMiss` vs `cacheHit`
is reported as `WITHIN-NOISE` by the benchmark for the same reason.

### Optimization that did pay (measured before/after)

`dv.pages()` on 1000 pages used to rebuild every page object per block
(~2.4 ms). `page.ts` now memoizes them in a `WeakMap` keyed on `PageMeta` —
safe without invalidation bookkeeping because `IndexStore` *replaces* published
pages instead of mutating them. Combined with a snapshot-keyed path lookup in the
worker:

| Job shape | Before | After | Change |
|---|---|---|---|
| `dv.pages()` ×1000 | 4.80 ms | **2.40 ms** | −50% |
| `dv.pages("#note").where(f).limit(50).map(f)` | 5.54 ms | **2.95 ms** | −47% |
| same + `dv.table(...)` (the real-world shape) | 5.56 ms | **2.29 ms** | **−59%** |
| Fixed per-job overhead | 2.43 ms | 1.91 ms | −21% |

Downstream effect in the benchmark suite: DQL exec 4.36 → 1.78 ms, warm vm job
5.53 → 3.77 ms, second worker round-trip 9.88 → 2.82 ms.

## 6. Known limitations of this measurement setup

1. **Bootstrap concurrency (c=8/16 ⇒ ~1.15×) does not extrapolate to disk.**
   The fake FS is an in-memory map: `parsePageFile` is synchronous CPU work and
   lanes only yield at microtasks, so the concurrency knob cannot shorten total
   parse time in this harness. Re-measure on a real workspace with cold page
   cache (multi-root, thousands of files) before quoting a concurrency gain.
2. **`vm` cold (15.9 ms) is an upper bound**, polluted by JIT warm-up. To
   isolate it: run one job per process.
3. **Memory numbers rely on a forced GC** (`v8.setFlagsFromString` +
   `vm.runInNewContext('gc')`) because the test runner cannot be given
   `--expose-gc`. Without a forced GC the noise (±100 MB) exceeds the signal.
4. **No comparison against Obsidian Dataview is claimed.** We have neither their
   dataset nor their runtime, so any "X ms vs their Y ms" would be fabricated.
   The comparable, executable method: export the same 1000-page corpus from
   `makePage(i)`, run the same three DQL texts in Obsidian + Dataview on the same
   machine, and compare end-to-end wall clock only (their internal phase
   boundaries are not observable). Absolute values must then be compared as
   ratios on the same machine, not across machines.
5. **Single-run absolute values move ±20%** under machine load (e.g. `index.full1000`
   was observed at 107–152 ms across runs). The guard assertions in the benchmark
   are set from these measurements with ~16× headroom, so they catch shape
   regressions (O(n²), accidental deep clones) rather than small drifts.

## 7. What is guarded by assertions (regression护栏)

| Assertion | Bound | Measured | What it protects against |
|---|---|---|---|
| Full index 1000 pages | < 2000 ms | 126 ms | accidentally re-parsing in a loop |
| `snapshot()` p50 | < 5 ms | 0.003 ms | deep-cloning immutable pages |
| Incremental vs full | ≥ 20× | 1 445× | losing the incremental path |
| DQL exec p50 | < 100 ms | 1.8–2.8 ms | per-row full-index rescans |
| DQL parse p50 | < 5 ms | 0.006–0.04 ms | parser regressions |
| Render (payload on) | < 150 ms | 11 ms | dropping the row/cell budget |
| Warm vm job p50 | < 100 ms | 3.8 ms | deep-cloning the snapshot per job |
| Worker 2nd job vs 1st | ≥ 1.5× | 23× | losing the warm-slot snapshot / version-gated sync |
| Heap after indexing 1000 pages | < 200 MB | 4.2 MB | retaining the raw corpus |
