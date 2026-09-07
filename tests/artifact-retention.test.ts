import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pruneArtifacts } from "../src/core/artifactRetention.js";

describe("pruneArtifacts", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "artifact-retention-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the newest images, never touches traces, and survives a missing dir", () => {
    for (let i = 0; i < 6; i += 1) {
      const file = path.join(dir, `capture-${i}.png`);
      writeFileSync(file, "x");
      const when = new Date(2026, 0, 1 + i);
      utimesSync(file, when, when);
    }
    writeFileSync(path.join(dir, "qa-action-trace.jsonl"), "{}\n");

    expect(pruneArtifacts(dir, 2)).toBe(4);
    const remaining = readdirSync(dir).sort();
    expect(remaining).toEqual(["capture-4.png", "capture-5.png", "qa-action-trace.jsonl"]);
    expect(pruneArtifacts(path.join(dir, "missing"))).toBe(0);
  });

  it("reports what a dry run would remove, with sizes, without deleting", () => {
    for (let i = 0; i < 3; i += 1) {
      const file = path.join(dir, `capture-${i}.bmp`);
      writeFileSync(file, "x".repeat(10 * (i + 1)));
      const when = new Date(2026, 0, 1 + i);
      utimesSync(file, when, when);
    }
    const seen: Array<[string, number]> = [];
    const report = (file: string, bytes: number) => seen.push([path.basename(file), bytes]);

    expect(pruneArtifacts(dir, 1, { dryRun: true, onRemoved: report })).toBe(2);
    expect(seen).toEqual([
      ["capture-1.bmp", 20],
      ["capture-0.bmp", 10],
    ]);
    expect(readdirSync(dir).sort()).toEqual(["capture-0.bmp", "capture-1.bmp", "capture-2.bmp"]);

    seen.length = 0;
    expect(pruneArtifacts(dir, 1, { onRemoved: report })).toBe(2);
    expect(seen.map(([name]) => name)).toEqual(["capture-1.bmp", "capture-0.bmp"]);
    expect(readdirSync(dir)).toEqual(["capture-2.bmp"]);
  });
});
