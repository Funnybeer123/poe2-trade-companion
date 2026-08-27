import {
  FrozenClock,
  InMemoryTraceSink,
  QaTraceWriter,
  isoTimestampFromMs,
  type QaActionTrace,
} from "@poe2tc/core";
import { describe, expect, it } from "vitest";

function sampleTrace(clock: FrozenClock, tickId: number): QaActionTrace {
  return {
    id: `follow-only:${String(tickId)}`,
    timestamp: isoTimestampFromMs(clock.nowMs()),
    clockMs: clock.nowMs(),
    tickId,
    scenarioId: "follow-only",
    runtimeMode: "authorized-qa",
    module: "follow",
    selectedState: "Follow",
    previousState: "Idle",
    observedSummary: "target=qa-target process=PathOfExile.exe ui=gameplay",
    confidence: 0.9,
    decisionReason: "follow-target",
    intendedActions: [{ type: "mouse-click", x: 640, y: 360, button: "left" }],
    interlockCode: "dry-run",
    executed: false,
    dryRun: true,
    result: "dry-run",
  };
}

describe("QaTraceWriter", () => {
  it("is append-only and preserves FrozenClock timestamps", () => {
    const clock = new FrozenClock(10_000);
    const sink = new InMemoryTraceSink();
    const writer = new QaTraceWriter(sink);

    writer.write(sampleTrace(clock, 1));
    clock.advance(200);
    writer.write(sampleTrace(clock, 2));

    expect(sink.traces).toHaveLength(2);
    expect(sink.traces[0]?.id).toBe("follow-only:1");
    expect(sink.traces[1]?.id).toBe("follow-only:2");
    expect(sink.traces[0]?.clockMs).toBe(10_000);
    expect(sink.traces[0]?.timestamp).toBe(new Date(10_000).toISOString());
    expect(sink.traces[1]?.clockMs).toBe(10_200);
    expect(sink.traces[1]?.timestamp).toBe(new Date(10_200).toISOString());
    expect(sink.traces[0]?.id).not.toBe(sink.traces[1]?.id);
  });
});
