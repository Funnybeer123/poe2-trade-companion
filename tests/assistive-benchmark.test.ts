import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendBenchmark,
  assistiveBenchmarkPath,
  depositComplete,
  fillComplete,
  skillComplete,
  summarizeBenchmark,
  type AssistiveBenchmark,
} from "../src/core/assistiveBenchmark.js";

function sample(over: Partial<AssistiveBenchmark> = {}): AssistiveBenchmark {
  return {
    id: "deposit-1",
    skill: "deposit-bag-to-stash",
    startedAt: "2026-08-25T22:00:00.000Z",
    elapsedMs: 4200,
    identifyMs: 0,
    actMs: 3900,
    bagBefore: 42,
    bagAfter: 0,
    stashBefore: 10,
    stashAfter: 30,
    actions: 12,
    result: "bag-empty",
    complete: true,
    ...over,
  };
}

describe("assistive benchmarks", () => {
  it("treats an empty bag as a complete deposit and a full bag as a complete fill", () => {
    expect(depositComplete(0)).toBe(true);
    expect(depositComplete(3)).toBe(false);
    expect(fillComplete(60)).toBe(true);
    expect(fillComplete(42)).toBe(false);
    expect(skillComplete("deposit-bag-to-stash", 0)).toBe(true);
    expect(skillComplete("fill-bag-from-stash", 59)).toBe(false);
  });

  it("appends a jsonl row and reports time vs the previous same-skill run", () => {
    const root = mkdtempSync(path.join(tmpdir(), "assistive-bench-"));
    const first = sample();
    const second = sample({ id: "deposit-2", elapsedMs: 2800, complete: true });
    appendBenchmark(root, first);
    appendBenchmark(root, second);
    const lines = readFileSync(assistiveBenchmarkPath(root), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(summarizeBenchmark(second, first)).toContain("complete 2800ms");
    expect(summarizeBenchmark(second, first)).toContain("-1400ms");
    expect(summarizeBenchmark(sample({ cycle: 2, skill: "fill-bag-from-stash" }))).toContain("c2");
  });
});
