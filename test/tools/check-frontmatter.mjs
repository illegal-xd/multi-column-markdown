/**
 * Optional tool — is a Markdown file's frontmatter valid YAML?
 *
 *   node test/tools/check-frontmatter.mjs .state.md [more.md ...]
 *
 * Two checks, no dependencies (the project's own subset parser is bundled):
 *
 *   1. **Strict subset parse** — `parseYamlValue` must read the block as a
 *      mapping. This is what the index uses before falling back to line-wise
 *      recovery.
 *   2. **Plain scalars must not contain `": "`.** Real YAML reads that as an
 *      implicit nested key, so an editor's YAML checker reports
 *      "nested mappings are not allowed in compact mappings". Values that need a
 *      colon-space must be quoted (`'a: b'`) or written as a block scalar.
 *
 * Not part of the test suite: it validates *documents*, not code. Use it after
 * editing a checkpoint or any long frontmatter by hand.
 */
import {execSync} from "node:child_process";
import {mkdtempSync, readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: node test/tools/check-frontmatter.mjs <file.md> [...]");
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), "amc-fm-check-"));
execSync(`npx esbuild src/dataview/index/yaml.ts --bundle --format=esm --outfile=${join(dir, "yaml.mjs")}`, {
  cwd: new URL("../..", import.meta.url).pathname,
  stdio: "pipe",
});
const {parseYamlValue} = await import(join(dir, "yaml.mjs"));

/** Frontmatter text and the file line it starts on (1-based), or null. */
function frontmatterOf(text) {
  const lines = text.split(/\r?\n/);
  if (!/^---\s*$/.test(lines[0] ?? "")) return null;
  for (let i = 1; i < lines.length; i++) {
    if (/^---\s*$/.test(lines[i])) return {lines: lines.slice(1, i), startLine: 2};
  }
  return null;
}

/**
 * Lines whose plain scalar contains ": " (quoted / block / flow values exempt).
 *
 * Heuristic, not a YAML parser: `- key: value` and `{a: 1}` are valid and
 * skipped, quoted/block scalars are skipped. What it catches is the shape real
 * checkers reject — prose written as a plain scalar with a colon-space in it.
 */
function colonSpaceProblems(lines) {
  const problems = [];
  const suspect = (value) => /^[{[|>'"*&!]/.test(value) === false && value.includes(": ");
  lines.forEach((line, i) => {
    if (line.trim() === "" || /^\s*#/.test(line)) return;
    const seq = /^\s*-\s+(.*)$/.exec(line);
    if (seq) {
      const content = seq[1];
      if (/^[\w.-]+\s*:(\s|$)/.test(content)) return; // `- key: value` — valid compact mapping
      if (suspect(content)) problems.push({line: i + 1, value: content.slice(0, 80)});
      return;
    }
    const kv = /^\s*[\w.-]+:\s+(.*)$/.exec(line);
    if (!kv) return;
    if (suspect(kv[1])) problems.push({line: i + 1, value: kv[1].slice(0, 80)});
  });
  return problems;
}

let failed = 0;
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const fm = frontmatterOf(text);
  if (!fm) {
    console.log(`${file}: no frontmatter`);
    continue;
  }
  const strict = parseYamlValue(fm.lines.join("\n"));
  const colon = colonSpaceProblems(fm.lines);
  const ok = strict.error === undefined && colon.length === 0;
  if (ok) {
    console.log(`${file}: OK (${fm.lines.length} frontmatter lines)`);
    continue;
  }
  failed += 1;
  console.log(`${file}: INVALID`);
  if (strict.error) console.log(`  parse error: ${strict.error}`);
  for (const p of colon) {
    console.log(`  line ${p.line} (file line ${p.line + fm.startLine - 1}): plain scalar contains ": " → quote it`);
    console.log(`    ${p.value}`);
  }
}
process.exit(failed === 0 ? 0 : 1);
