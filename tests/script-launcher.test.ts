import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveScriptLaunch } from "../src/core/scriptLauncher.js";

const roots: string[] = [];
function project(files: Record<string, number>) {
  const root = mkdtempSync(path.join(os.tmpdir(), "script-launcher-")); roots.push(root);
  for (const [file, age] of Object.entries(files)) {
    const target = path.join(root, file); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, "");
    const at = new Date(Date.now() - age * 1000); utimesSync(target, at, at);
  }
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const args = ["scripts/map-triage.ts", "--stage=workflow", "--run"];
const bundle = { bundle: "dist-electron/map-triage.cjs", bundleSources: ["scripts/map-triage.ts", "src/core"], node: "node.exe" };

describe("hotkey script launcher", () => {
  it("runs the prebuilt worker with node itself when it is at least as new as its sources", () => {
    const root = project({ "dist-electron/map-triage.cjs": 10, "scripts/map-triage.ts": 50, "src/core/a.ts": 20 });
    expect(resolveScriptLaunch(root, args, bundle)).toEqual({ command: "node.exe", args: [path.join(root, "dist-electron", "map-triage.cjs"), "--stage=workflow", "--run"], shell: false, source: "bundle" });
  });
  it("never runs a stale or missing worker", () => {
    const stale = project({ "dist-electron/map-triage.cjs": 60, "scripts/map-triage.ts": 90, "src/core/deep/b.ts": 5, "node_modules/tsx/dist/cli.mjs": 1 });
    expect(resolveScriptLaunch(stale, args, bundle)).toMatchObject({ source: "local-tsx", shell: false, command: "node.exe", args: [path.join(stale, "node_modules", "tsx", "dist", "cli.mjs"), ...args] });
    expect(resolveScriptLaunch(project({ "scripts/map-triage.ts": 1 }), args, { ...bundle, platform: "linux" })).toEqual({ command: "npx", args: ["--yes", "tsx", ...args], shell: false, source: "npx" });
  });
  it("uses a shell only for the Windows npx batch file and quotes arguments that need it", () => {
    const launch = resolveScriptLaunch(project({}), [...args, "--journal=C:\\Users\\Some One\\bag.jsonl"], { platform: "win32" });
    expect(launch).toMatchObject({ command: "npx.cmd", shell: true, source: "npx" });
    expect(launch.args.at(-1)).toBe('"--journal=C:\\Users\\Some One\\bag.jsonl"');
    expect(launch.args.slice(0, 5)).toEqual(["--yes", "tsx", ...args]);
  });
});
