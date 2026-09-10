/**
 * Cross-file consistency guards.
 *
 * Two kinds of duplication cannot be removed, only policed:
 *   1. flex-basis math in TypeScript needs the pixel sizes the CSS applies
 *      (`gap`, separator widths) — the browser cannot hand them back at
 *      parse time;
 *   2. the color vocabulary appears in `package.json` enums (the settings
 *      UI contract) and in the palette module (the token validator).
 *
 * These tests fail the moment one side drifts, which is what makes the
 * duplication safe.
 */
import {test} from "node:test";
import assert from "node:assert/strict";
import {execSync} from "node:child_process";
import {mkdtempSync, readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const root = new URL("..", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "amc-constants-"));
execSync(
  "npx esbuild src/preview/layoutMath.ts --bundle --format=esm --outfile=" + join(dir, "layout.mjs") +
  " && npx esbuild src/core/palette.ts --bundle --format=esm --outfile=" + join(dir, "palette.mjs"),
  {cwd: root, stdio: "pipe"},
);

const layout = await import(join(dir, "layout.mjs"));
const palette = await import(join(dir, "palette.mjs"));
const css = readFileSync(join(root, "media/previewStyle.css"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const props = pkg.contributes.configuration.properties;

test("CSS container gap fallback matches DEFAULT_GAP_PX", () => {
  const m = /gap:\s*var\(--columns-block-gap,\s*(\d+)px\)/.exec(css);
  assert.ok(m, "container gap declaration not found in previewStyle.css");
  assert.equal(Number(m[1]), layout.DEFAULT_GAP_PX);
  assert.equal(layout.gapPx(undefined), layout.DEFAULT_GAP_PX);
});

test("CSS visual separator width matches the flex-basis math", () => {
  const rule = /\.column-separator-visual\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, ".column-separator-visual rule not found");
  const width = /width:\s*(\d+)px/.exec(rule[1]);
  assert.ok(width, "separator width not found");
  assert.equal(Number(width[1]), layout.SEPARATOR_VISUAL_PX);
  assert.equal(layout.separatorWidthPx({separator: true}), layout.SEPARATOR_VISUAL_PX);
});

test("CSS custom separator default matches the --sep-size formula", () => {
  const rule = /\.column-separator-custom\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, ".column-separator-custom rule not found");
  const fallback = /var\(--sep-size,\s*(\d+)px\)/.exec(rule[1]);
  assert.ok(fallback, "--sep-size fallback not found");
  assert.equal(Number(fallback[1]), layout.SEPARATOR_CUSTOM_BASE_PX * 2);
  assert.equal(
    layout.separatorWidthPx({separator: true, separatorStyle: "custom"}),
    layout.SEPARATOR_CUSTOM_BASE_PX * 2,
  );
  assert.equal(
    layout.separatorWidthPx({separator: true, separatorStyle: "custom", separatorWidth: 3}),
    3 * layout.SEPARATOR_CUSTOM_UNIT_PX + layout.SEPARATOR_CUSTOM_BASE_PX,
  );
});

test("package.json color enums match the palette vocabulary", () => {
  assert.deepEqual(
    props["multiColumnMarkdown.containerBackground"].enum,
    palette.BACKGROUND_OPTION_VALUES,
    "containerBackground enum drifted from palette.ts",
  );
  for (const key of ["containerBorderColor", "containerTextColor", "verticalDividerColor"]) {
    assert.deepEqual(
      props[`multiColumnMarkdown.${key}`].enum,
      palette.CONFIG_COLOR_OPTION_VALUES,
      `${key} enum drifted from palette.ts`,
    );
  }
  assert.ok(!palette.CONFIG_COLOR_OPTION_VALUES.includes("transparent"));
  assert.ok(palette.BACKGROUND_OPTION_VALUES.includes("transparent"));
});

test("palette vocabulary is complete and free of duplicates", () => {
  assert.equal(new Set(palette.BACKGROUND_OPTION_VALUES).size, palette.BACKGROUND_OPTION_VALUES.length);
  assert.equal(new Set(palette.STYLE_COLOR_OPTION_VALUES).size, palette.STYLE_COLOR_OPTION_VALUES.length);
  for (const value of palette.BACKGROUND_OPTION_VALUES) {
    assert.equal(typeof palette.BACKGROUND_CSS[value], "string");
    assert.ok(palette.BACKGROUND_CSS[value].length > 0);
  }
  for (const value of palette.STYLE_COLOR_OPTION_VALUES) {
    assert.equal(typeof palette.COLOR_CSS[value], "string");
    assert.ok(palette.COLOR_CSS[value].length > 0);
  }
});
