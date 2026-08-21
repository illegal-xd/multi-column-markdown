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
  rmSync("dist", {recursive: true, force: true});

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
