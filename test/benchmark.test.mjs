/**
 * Parser performance guards.
 *
 * The cold path (a document the cache has never seen — which is every
 * keystroke inside a column) is the number that matters; measuring the hit
 * path only would hide a parse regression behind the cache. Both are
 * measured, with deliberately loose thresholds so CI noise cannot fail the
 * build, plus exact behavioural assertions (region count) so a silently
 * broken parse is still caught.
 */
import {test} from "node:test";
import assert from "node:assert/strict";
import {execSync} from "node:child_process";
import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const dir = mkdtempSync(join(tmpdir(), "amc-benchmark-"));
execSync(`npx esbuild src/core/parser.ts --bundle --format=esm --outfile=${join(dir, "parser.mjs")}`, {cwd: new URL("..", import.meta.url).pathname, stdio: "pipe"});
const {findColumnRegions, getRegionCacheStats, clearRegionCache} = await import(join(dir, "parser.mjs"));

const block = (i) => `%% col-start %%\n%% col-break %%\nColumn ${i}\n%% col-break %%\nContent\n%% col-end %%`;
const document = Array.from({length: 100}, (_, i) => block(i)).join("\n\n");

const perOp = (iterations, fn) => {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn(i);
  return (performance.now() - start) / iterations;
};

test("parser benchmark: cold parses stay within budget", () => {
  clearRegionCache();
  let count = 0;
  // Unique strings on purpose: this is the path the preview hits on every
  // edit inside a column (cache key is the full document text).
  const cold = perOp(100, (i) => {
    count += findColumnRegions(`${document}\n<!-- ${i} -->`).length;
  });
  assert.equal(count, 10000);
  console.log(`parser-cold: ${cold.toFixed(3)}ms per parse (100 regions, ${(document.length / 1024).toFixed(1)}KB)`);
  assert.ok(cold < 5, `cold parse exceeded 5ms: ${cold.toFixed(3)}ms`);
});

test("parser benchmark: responsive markers stay within the same budget", () => {
  clearRegionCache();
  // The responsive token is one extra string compare per col-start payload;
  // it must not push the cold path over the plain-document budget.
  const responsive = document.replaceAll("%% col-start %%", "%% col-start:responsive %%");
  const t = perOp(100, (i) => findColumnRegions(`${responsive}\n<!-- ${i} -->`).length);
  console.log(`parser-cold-responsive: ${t.toFixed(3)}ms per parse (100 regions)`);
  assert.ok(t < 5, `responsive cold parse exceeded 5ms: ${t.toFixed(3)}ms`);
});

test("parser benchmark: cache hits are much cheaper than a cold parse", () => {
  clearRegionCache();
  findColumnRegions(document); // prime
  const warm = perOp(1000, () => findColumnRegions(document));
  console.log(`parser-warm: ${warm.toFixed(4)}ms per cached parse`);
  assert.ok(warm < 0.5, `cache hit exceeded 0.5ms: ${warm.toFixed(4)}ms`);

  const stats = getRegionCacheStats();
  assert.ok(stats.hits >= 1000, `expected hits to be counted, got ${stats.hits}`);
  assert.ok(stats.misses >= 1, `expected misses to be counted, got ${stats.misses}`);
});

test("parser benchmark: cache reports and bounds its own size", () => {
  clearRegionCache();
  for (let i = 0; i < 40; i++) findColumnRegions(`${document}\n<!-- ${i} -->`);
  const stats = getRegionCacheStats();
  assert.equal(stats.size, stats.limit, "cache stays at its size limit");
  assert.ok(stats.evictions > 0, "evictions are tracked");
});
