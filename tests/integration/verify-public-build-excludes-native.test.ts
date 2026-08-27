import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = join(process.cwd(), "scripts/verify-public-build-excludes-native.mjs");
const publicList = join(process.cwd(), "fixtures/packaging/public-file-list.txt");

describe("verify-public-build-excludes-native", () => {
  it("accepts a simulated public pack file list", () => {
    const result = spawnSync(process.execPath, [script, "--files-from", publicList], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/excludes packages\/native-input/);
  });

  it("rejects a file list that includes native-input", () => {
    const dir = mkdtempSync(join(tmpdir(), "poe2tc-pack-"));
    const list = join(dir, "bad-list.txt");
    writeFileSync(
      list,
      ["apps/desktop/dist/electron-main.js", "packages/native-input/src/nativeInputSink.ts"].join("\n"),
    );
    const result = spawnSync(process.execPath, [script, "--files-from", list], {
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/native-input/);
  });
});
