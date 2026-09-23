import {build, context} from "esbuild";
import {rmSync} from "node:fs";

const watch = process.argv.includes("--watch");

/** Shared options for the host-side bundle. */
const shared = {
  bundle: true,
  sourcemap: false,
  minify: !watch,
  logLevel: "info",
  target: "es2022",
};

async function main() {
  // Best-effort clean: a stale/undeletable dist (e.g. files created by another
  // user, or a Windows file lock) must not abort the build — esbuild overwrites
  // every output it emits anyway.
  try {
    rmSync("dist", {recursive: true, force: true});
  } catch (err) {
    console.warn(`[esbuild] could not clean dist (${err.code ?? err.message}); building over it`);
  }

  const configs = [
    // Extension host bundle (Node). vscode is external; the markdown-it
    // preview plugin is bundled in (it operates on the instance provided
    // by the preview via extendMarkdownIt, so no runtime markdown-it
    // dependency is needed).
    {
      ...shared,
      entryPoints: ["src/extension.ts"],
      outfile: "dist/extension.js",
      platform: "node",
      format: "cjs",
      external: ["vscode"],
      mainFields: ["module", "main"],
    },
    // Dataview sandbox worker. MUST be a separate file: a worker thread that
    // loaded dist/extension.js would re-run activate(). Bundled for node so the
    // vm/worker_threads imports resolve at runtime.
    {
      ...shared,
      entryPoints: ["src/dataview/exec/workerEntry.ts"],
      outfile: "dist/dataviewWorker.js",
      platform: "node",
      format: "cjs",
      mainFields: ["module", "main"],
    },
    // Preview webview enhancement (windowed tables, paged task lists). Loaded
    // by the built-in preview through contributes."markdown.previewScripts";
    // browser platform, IIFE (the webview has no module loader).
    {
      ...shared,
      entryPoints: ["src/dataview/webview/main.ts"],
      outfile: "dist/dataviewWebview.js",
      platform: "browser",
      format: "iife",
    },
  ];

  if (watch) {
    const ctxs = await Promise.all(configs.map((cfg) => context(cfg)));
    await Promise.all(ctxs.map((c) => c.watch()));
    console.log("[esbuild] watching…");
    return;
  }

  await Promise.all(configs.map((cfg) => build(cfg)));
  console.log("[esbuild] build complete");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
