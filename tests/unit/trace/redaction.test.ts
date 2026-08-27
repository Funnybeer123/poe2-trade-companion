import { redactQaActionTrace, type QaActionTrace } from "@poe2tc/core";
import { describe, expect, it } from "vitest";

function sampleTrace(overrides: Partial<QaActionTrace> = {}): QaActionTrace {
  return {
    id: "follow-only:1",
    timestamp: "1970-01-01T00:00:10.000Z",
    clockMs: 10000,
    tickId: 1,
    scenarioId: "follow-only",
    runtimeMode: "authorized-qa",
    module: "follow",
    selectedState: "Follow",
    previousState: "Idle",
    process: { name: "PathOfExile.exe", title: "Path of Exile 2 - ExileCharacter" },
    observedSummary: "target=ExileCharacter process=PathOfExile.exe ui=gameplay",
    confidence: 0.9,
    decisionReason: "follow-target",
    intendedActions: [{ type: "noop", reason: "idle" }],
    interlockCode: "dry-run",
    executed: false,
    dryRun: true,
    result: "dry-run",
    ...overrides,
  };
}

describe("trace redaction", () => {
  it("always redacts session tokens from QA traces", () => {
    const redacted = redactQaActionTrace(
      sampleTrace({
        observedSummary: "whisper POESESSID=abc123def target=ExileCharacter",
        decisionReason: "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig",
        result: "access_token=secret-token-value",
        followUpSummary: "sessionid=cookie-value",
      }),
      { redactIdentifiers: false },
    );

    expect(redacted.observedSummary).toContain("POESESSID=[redacted-token]");
    expect(redacted.observedSummary).not.toContain("abc123def");
    expect(redacted.decisionReason).toContain("Bearer [redacted-token]");
    expect(redacted.result).toContain("access_token=[redacted-token]");
    expect(redacted.followUpSummary).toContain("sessionid=[redacted-token]");
    expect(redacted.observedSummary).toContain("ExileCharacter");
    expect(redacted.process?.title).toContain("ExileCharacter");
  });

  it("redacts character names when redactIdentifiers is true", () => {
    const redacted = redactQaActionTrace(sampleTrace(), { redactIdentifiers: true });
    expect(redacted.observedSummary).toContain("target=[redacted]");
    expect(redacted.observedSummary).not.toContain("ExileCharacter");
    expect(redacted.process?.title).not.toContain("ExileCharacter");
    expect(redacted.process?.name).toBe("PathOfExile.exe");
  });

  it("keeps character names on explicit QA traces when redaction is off", () => {
    const redacted = redactQaActionTrace(sampleTrace(), { redactIdentifiers: false });
    expect(redacted.observedSummary).toContain("ExileCharacter");
    expect(redacted.process?.title).toContain("ExileCharacter");
  });
});
