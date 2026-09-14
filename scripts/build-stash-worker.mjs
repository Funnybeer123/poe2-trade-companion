import { build } from "esbuild";

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
