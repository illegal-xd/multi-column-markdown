import {test} from "node:test";
import assert from "node:assert/strict";
import {execSync} from "node:child_process";
import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const dir = mkdtempSync(join(tmpdir(), "amc-benchmark-"));
execSync(`npx esbuild src/core/parser.ts --bundle --format=esm --outfile=${join(dir, "parser.mjs")}`, {cwd: new URL("..", import.meta.url).pathname, stdio: "pipe"});
const {findColumnRegions} = await import(join(dir, "parser.mjs"));
const document = Array.from({length: 100}, (_, i) => `%% col-start %%\n%% col-break %%\nColumn ${i}\n%% col-break %%\nContent\n%% col-end %%`).join("\n\n");

test("parser benchmark: repeated preview parses stay within baseline", () => {
  const start = performance.now();
  let count = 0;
  for (let i = 0; i < 100; i++) count += findColumnRegions(document).length;
  const elapsed = performance.now() - start;
  assert.equal(count, 10000);
  console.log(`parser-cache: ${elapsed.toFixed(2)}ms for 100 cached parses`);
  assert.ok(elapsed < 1000, `parser cache benchmark exceeded 1000ms: ${elapsed.toFixed(2)}ms`);
});
