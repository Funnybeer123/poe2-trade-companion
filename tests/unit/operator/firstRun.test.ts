import { evaluateFirstRun, QA_FIRST_RUN_PHRASE } from "@poe2tc/core";
import { describe, expect, it } from "vitest";

describe("first-run wizard", () => {
  it("completes public companion without the QA phrase", () => {
    const result = evaluateFirstRun(
      { selectedMode: "public-companion", acknowledged: false },
      "public-companion",
    );
    expect(result.ok).toBe(true);
    expect(result.settings.firstRunCompleted).toBe(true);
    expect(result.settings.selectedMode).toBe("public-companion");
    expect(result.settings.qaAcknowledged).toBe(false);
  });

  it("rejects authorized-qa on a public compile-time build", () => {
    const result = evaluateFirstRun(
      {
        selectedMode: "authorized-qa",
        confirmationText: QA_FIRST_RUN_PHRASE,
        acknowledged: true,
      },
      "public-companion",
    );
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("compile-time-public");
    expect(result.settings.firstRunCompleted).toBe(false);
  });

  it("requires AUTHORIZED QA plus acknowledgement on a QA build", () => {
    const missing = evaluateFirstRun(
      { selectedMode: "authorized-qa", confirmationText: "nope", acknowledged: false },
      "authorized-qa",
    );
    expect(missing.ok).toBe(false);
    expect(missing.reasons).toContain("qa-confirmation-mismatch");
    expect(missing.reasons).toContain("qa-not-acknowledged");

    const ok = evaluateFirstRun(
      {
        selectedMode: "authorized-qa",
        confirmationText: QA_FIRST_RUN_PHRASE,
        acknowledged: true,
      },
      "authorized-qa",
    );
    expect(ok.ok).toBe(true);
    expect(ok.settings.qaAcknowledged).toBe(true);
    expect(ok.settings.selectedMode).toBe("authorized-qa");
  });
});
