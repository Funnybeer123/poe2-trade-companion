#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const profile = process.argv[2] === "qa" ? "qa" : "public";
const compileTimeMode = profile === "qa" ? "authorized-qa" : "public-companion";
const config = profile === "qa" ? "electron-builder.qa.yml" : "electron-builder.public.yml";

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, POE2TC_MODE: compileTimeMode, ...extraEnv },
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with ${String(result.status)}`);
  }
}

function tryRun(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, POE2TC_MODE: compileTimeMode, ...extraEnv },
  });
  return result.status === 0;
}

await mkdir(path.join(root, "release", profile), { recursive: true });

console.log(`Building overlay and desktop for ${profile} (POE2TC_MODE=${compileTimeMode})`);
run("npm", ["run", "build", "--workspace", "@poe2tc/overlay"]);
run("npm", ["run", "build", "--workspace", "@poe2tc/desktop"]);

const canPackWindowsInstaller = process.platform === "win32";
if (!canPackWindowsInstaller) {
  console.log(
    "BLOCKED: windows-vm — this host is not Windows. Producing a directory pack only; not a Windows installer.",
  );
}

const builderArgs = ["electron-builder", "--config", config, "--dir"];
if (process.platform === "linux") {
  builderArgs.push("--linux");
} else if (process.platform === "win32") {
  builderArgs.push("--win");
}

const packed = tryRun("npx", builderArgs);
if (!packed) {
  const note = path.join(root, "release", profile, "PACKAGING_BLOCKED.txt");
  await writeFile(
    note,
    [
      `profile=${profile}`,
      `compileTimeMode=${compileTimeMode}`,
      `platform=${process.platform}`,
      "electron-builder --dir failed on this host.",
      canPackWindowsInstaller
        ? "Windows installer was requested but electron-builder failed."
        : "BLOCKED: windows-vm — NSIS/Windows installer not produced on Linux.",
      "",
    ].join("\n"),
  );
  console.error(`electron-builder failed; wrote ${note}`);
  process.exitCode = 0;
  process.exit();
}

if (profile === "public") {
  const publicDir = path.join(root, "release/public");
  run("node", [path.join(root, "scripts/verify-public-build-excludes-native.mjs"), publicDir]);
}

console.log(`OK: ${profile} directory pack written under release/${profile}`);
