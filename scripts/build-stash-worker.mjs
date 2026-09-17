import { build } from "esbuild";

// The packaged app has no checkout, tsx, npx, or external Node installation.
// Bundle all TypeScript dependencies and run this with Electron's Node mode.
await build({
  entryPoints: ["scripts/bag-triage.ts"],
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
