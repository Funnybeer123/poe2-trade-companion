#!/usr/bin/env node
/**
 * Rebuild (or fetch the prebuilt) better-sqlite3 for the Electron ABI the app
 * runs on. npm fetches native prebuilds for the HOST Node (ABI 137 on Node 24)
 * on every install, which Electron 34 (ABI 132) cannot load — the tests run
 * under Electron-as-Node and the packaged app would break the same way.
 *
 * Runs as `postinstall`; also usable directly: `node scripts/rebuild-native-electron.mjs`.
 * Skips quietly when Electron is not installed (e.g. `npm ci --omit=dev`).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electronPackage = path.join(root, "node_modules", "electron", "package.json");
if (!existsSync(electronPackage)) {
  console.log("[rebuild-native-electron] electron is not installed — nothing to align");
  process.exit(0);
}
const electronVersion = JSON.parse(readFileSync(electronPackage, "utf8")).version;
const arch = process.env.npm_config_arch ?? process.arch;
console.log(`[rebuild-native-electron] better-sqlite3 → electron ${electronVersion} (${arch})`);
const result = spawnSync(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["rebuild", "better-sqlite3"],
  {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      // prebuild-install (better-sqlite3's install script) honours these.
      npm_config_runtime: "electron",
      npm_config_target: electronVersion,
      npm_config_arch: arch,
      npm_config_disturl: "https://electronjs.org/headers",
    },
  },
);
process.exit(result.status ?? 1);
