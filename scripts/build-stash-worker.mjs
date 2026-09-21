import { build } from "esbuild";

for (const name of ["assistive-sort-tabs", "sort-gear", "craft-gear", "juice-maps", "shop", "shop-buckets", "stash-tab-admin", "vendor-cycle"]) {
  await build({ entryPoints: [`scripts/${name}.ts`], outfile: `dist-electron/${name}.mjs`, bundle: true, platform: "node", target: "node22", format: "esm",
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' }, logLevel: "info" });
}

// The packaged app has no checkout, tsx, npx, or external Node installation.
// Bundle all TypeScript dependencies and run this with Electron's Node mode.
await build({
  entryPoints: ["scripts/value-dump.ts"],
  outfile: "dist-electron/value-dump.cjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  define: { "import.meta.url": "__stashWorkerModuleUrl" },
  banner: { js: 'const __stashWorkerModuleUrl = require("node:url").pathToFileURL(__filename).href;' },
  logLevel: "info",
});

await build({
  entryPoints: ["scripts/map-triage.ts"],
  outfile: "dist-electron/map-triage.cjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  define: { "import.meta.url": "__bagWorkerModuleUrl" },
  banner: { js: 'const __bagWorkerModuleUrl = require("node:url").pathToFileURL(__filename).href;' },
  logLevel: "info",
});

await build({
  entryPoints: ["scripts/ring-gamble.ts"], outfile: "dist-electron/ring-gamble.cjs",
  bundle: true, platform: "node", target: "node22", format: "cjs",
  define: { "import.meta.url": "__ringWorkerModuleUrl" },
  banner: { js: 'const __ringWorkerModuleUrl = require("node:url").pathToFileURL(__filename).href;' },
  logLevel: "info",
});
