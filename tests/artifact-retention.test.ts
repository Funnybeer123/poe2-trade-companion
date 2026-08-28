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
});
