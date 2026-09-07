import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { localTsxEntry, resolveTsxLaunch } from "../src/core/tsxLauncher.js";
import { REPO_ROOT } from "./liveFixtures.js";

const root = path.resolve("fake root with space");
const entry = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const onlyEntry = (file: string) => file === entry;
const nothing = () => false;

describe("tsx launcher", () => {
  it("runs the local tsx CLI entry with the given node executable when tsx is installed", () => {
    const launch = resolveTsxLaunch(root, ["scripts/map-triage.ts", "--run"], {
      platform: "win32",
      node: "C:\\nodejs\\node.exe",
      exists: onlyEntry,
    });
    expect(launch).toEqual({
      command: "C:\\nodejs\\node.exe",
      args: [entry, "scripts/map-triage.ts", "--run"],
      shell: false,
      source: "local",
    });
  });

  it("defaults the node executable to the current process", () => {
    const launch = resolveTsxLaunch(root, ["scripts/x.ts"], { exists: onlyEntry });
    expect(launch.command).toBe(process.execPath);
    expect(launch.source).toBe("local");
  });

  it("prefers the local entry on every platform", () => {
    expect(resolveTsxLaunch(root, [], { platform: "linux", exists: onlyEntry }).source).toBe("local");
    expect(resolveTsxLaunch(root, [], { platform: "darwin", exists: onlyEntry }).shell).toBe(false);
  });

  it("falls back to npx.cmd through a shell on Windows when tsx is absent", () => {
    expect(resolveTsxLaunch(root, ["scripts/x.ts", "--live"], { platform: "win32", exists: nothing })).toEqual({
      command: "npx.cmd",
      args: ["--yes", "tsx", "scripts/x.ts", "--live"],
      shell: true,
      source: "npx",
    });
  });

  it("falls back to plain npx without a shell elsewhere", () => {
    expect(resolveTsxLaunch(root, ["scripts/x.ts"], { platform: "linux", exists: nothing })).toEqual({
      command: "npx",
      args: ["--yes", "tsx", "scripts/x.ts"],
      shell: false,
      source: "npx",
    });
  });

  it("looks for the entry under the given root only", () => {
    expect(localTsxEntry(root, onlyEntry)).toBe(entry);
    expect(localTsxEntry(path.join(root, "elsewhere"), onlyEntry)).toBeUndefined();
  });

  it("finds the tsx devDependency of this checkout", () => {
    const launch = resolveTsxLaunch(REPO_ROOT, ["scripts/action-daemon.ts"]);
    expect(launch.source).toBe("local");
    expect(existsSync(launch.args[0])).toBe(true);
  });
});
