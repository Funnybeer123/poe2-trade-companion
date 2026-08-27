import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const builderArgs = process.argv.slice(2);
const consumeFlag = (flag) => {
  const index = builderArgs.indexOf(flag);
  if (index < 0) return false;
  builderArgs.splice(index, 1);
  return true;
};
const consumeValue = (prefix) => {
  const index = builderArgs.findIndex((argument) =>
    argument.startsWith(prefix),
  );
  if (index < 0) return undefined;
  return builderArgs.splice(index, 1)[0].slice(prefix.length);
};

const retryOnce = consumeFlag("--retry-once");
const uniqueOutput = consumeFlag("--unique-output");
const manifestMode = consumeValue("--manifest-mode=");
const outputPrefix = "--config.directories.output=";
const outputIndex = builderArgs.findIndex((argument) =>
  argument.startsWith(outputPrefix),
);
const configuredOutput =
  outputIndex >= 0 ? builderArgs[outputIndex].slice(outputPrefix.length) : "";

const builderCli = path.resolve(
  "node_modules",
  "electron-builder",
  "out",
  "cli",
  "cli.js",
);
const rebuildCli = [
  path.resolve(
    "node_modules",
    "@electron",
    "rebuild",
    "lib",
    "cli.js",
  ),
  path.resolve(
    "node_modules",
    "app-builder-lib",
    "node_modules",
    "@electron",
    "rebuild",
    "lib",
    "cli.js",
  ),
].find((candidate) => existsSync(candidate));
const npmCli = process.env.npm_execpath;

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(result.error);
    return 1;
  }
  return result.status ?? 1;
}

function selectUniqueOutput(attempt) {
  if (!uniqueOutput || outputIndex < 0 || !configuredOutput) return;
  builderArgs[outputIndex] =
    `${outputPrefix}${configuredOutput}-${Date.now()}-${process.pid}-${attempt}`;
}

function recordPackagedExecutable() {
  if (!manifestMode || outputIndex < 0) return;
  const productNames = {
    "public-companion": "PoE2 Trade Companion.exe",
    "authorized-qa": "PoE2 QA Trade Bot.exe",
  };
  const productName = productNames[manifestMode];
  if (!productName) {
    throw new Error(`Unknown packaged build manifest mode: ${manifestMode}`);
  }
  const output = builderArgs[outputIndex].slice(outputPrefix.length);
  const executable = path.resolve(output, "win-unpacked", productName);
  if (!existsSync(executable)) {
    throw new Error(`Packaged executable was not created: ${executable}`);
  }

  const manifestPath = path.resolve(
    "artifacts",
    "playwright",
    "electron-builds.json",
  );
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  let manifest = {};
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    // A missing or stale local smoke manifest is replaced below.
  }
  manifest[manifestMode] = executable;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function preservePackagedNative() {
  if (!manifestMode || outputIndex < 0) return undefined;
  const output = builderArgs[outputIndex].slice(outputPrefix.length);
  const nativePath = path.resolve(
    output,
    "win-unpacked",
    "resources",
    "app.asar.unpacked",
    "node_modules",
    "better-sqlite3",
    "build",
    "Release",
    "better_sqlite3.node",
  );
  if (!existsSync(nativePath)) return undefined;
  const backupPath = path.join(
    os.tmpdir(),
    `poe2-better-sqlite3-electron-${process.pid}-${Date.now()}.node`,
  );
  copyFileSync(nativePath, backupPath);
  return { backupPath, nativePath };
}

function restorePackagedNative(preserved) {
  if (!preserved) return 0;
  try {
    // npm rebuild may update a linked package copy in place. Recreate the
    // packaged file so the app keeps Electron's ABI while node_modules is
    // restored for the host Node runtime.
    rmSync(preserved.nativePath, { force: true });
    copyFileSync(preserved.backupPath, preserved.nativePath);
    return 0;
  } catch (error) {
    console.error(error);
    return 1;
  } finally {
    rmSync(preserved.backupPath, { force: true });
  }
}

let builderStatus = 1;
let hostStatus = 0;
let preservedNative;
let nativeReady = false;
try {
  builderStatus = rebuildCli
    ? run(process.execPath, [
        rebuildCli,
        "--force",
        "--which-module",
        "better-sqlite3",
      ])
    : 1;
  nativeReady = builderStatus === 0;
  if (!rebuildCli) {
    console.error("Could not locate electron-builder's native rebuild tool.");
  }
  if (builderStatus === 0) {
    selectUniqueOutput(1);
    builderStatus = run(process.execPath, [builderCli, ...builderArgs]);
  }
  if (nativeReady && builderStatus !== 0 && retryOnce) {
    console.warn("electron-builder failed; retrying once after a short delay.");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_500);
    selectUniqueOutput(2);
    builderStatus = run(process.execPath, [builderCli, ...builderArgs]);
  }
  if (builderStatus === 0) {
    recordPackagedExecutable();
    preservedNative = preservePackagedNative();
  }
} finally {
  // electron-builder recompiles native modules for Electron in-place. Always
  // restore the host Node ABI, including after an interrupted/failed package.
  hostStatus = npmCli
    ? run(process.execPath, [npmCli, "rebuild", "better-sqlite3"])
    : run(
        process.platform === "win32"
          ? (process.env.ComSpec ?? "cmd.exe")
          : "npm",
        process.platform === "win32"
          ? ["/d", "/s", "/c", "npm rebuild better-sqlite3"]
          : ["rebuild", "better-sqlite3"],
      );
  const packageRestoreStatus = restorePackagedNative(preservedNative);
  if (hostStatus === 0) hostStatus = packageRestoreStatus;
}

process.exitCode = builderStatus === 0 ? hostStatus : builderStatus;
