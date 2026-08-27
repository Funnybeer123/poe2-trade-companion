import { FileTraceSink, type QaActionTrace } from "@poe2tc/core";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function sample(id: string): QaActionTrace {
  return {
    id,
    timestamp: "1970-01-01T00:00:00.000Z",
    clockMs: 0,
    tickId: 1,
    scenarioId: "follow-only",
    runtimeMode: "authorized-qa",
    module: "follow",
    selectedState: "Follow",
    previousState: "Idle",
    observedSummary: "target=none",
    confidence: 0.9,
    decisionReason: "follow-target",
    intendedActions: [{ type: "noop", reason: "idle" }],
    interlockCode: "dry-run",
    executed: false,
    dryRun: true,
    result: "dry-run",
  };
}

describe("FileTraceSink", () => {
  it("appends JSON lines and never truncates", () => {
    const dir = mkdtempSync(join(tmpdir(), "poe2tc-traces-"));
    const filePath = join(dir, "qa-traces.jsonl");
    const sink = new FileTraceSink(filePath, { fsync: true });
    sink.append(sample("a"));
    sink.append(sample("b"));
    const lines = readFileSync(filePath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "{}").id).toBe("a");
    expect(JSON.parse(lines[1] ?? "{}").id).toBe("b");
  });
});
