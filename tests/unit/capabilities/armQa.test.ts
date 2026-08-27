import { armQa, createCapabilities, evaluateQaArming } from "@poe2tc/core";
import { describe, expect, it } from "vitest";
import { createTestArming } from "../../helpers/createTestArming.js";

describe("QA arming gate", () => {
  it("cannot arm public-companion", () => {
    const result = evaluateQaArming(
      createCapabilities("public-companion"),
      createTestArming(),
      { hotkeyRegistered: true },
    );
    expect(result.allowArm).toBe(false);
    expect(result.reasons).toContain("public-mode");
  });

  it("cannot arm without acknowledgement", () => {
    const result = evaluateQaArming(
      createCapabilities("authorized-qa"),
      createTestArming({ acknowledged: false }),
      { hotkeyRegistered: true },
    );
    expect(result.allowArm).toBe(false);
    expect(result.reasons).toContain("qa-not-acknowledged");
  });

  it("cannot arm without process and window allowlists", () => {
    const result = evaluateQaArming(
      createCapabilities("authorized-qa"),
      createTestArming({ allowlistedProcessNames: [], allowlistedWindowTitleIncludes: [] }),
      { hotkeyRegistered: true },
    );
    expect(result.allowArm).toBe(false);
    expect(result.reasons).toContain("process-allowlist-empty");
    expect(result.reasons).toContain("window-allowlist-empty");
  });

  it("cannot arm without emergency-stop hotkey registration", () => {
    const result = evaluateQaArming(
      createCapabilities("authorized-qa"),
      createTestArming(),
      { hotkeyRegistered: false },
    );
    expect(result.allowArm).toBe(false);
    expect(result.reasons).toContain("emergency-stop-hotkey-not-registered");
  });

  it("cannot arm while emergency stop is latched", () => {
    const result = evaluateQaArming(
      createCapabilities("authorized-qa"),
      createTestArming({ emergencyStopLatched: true }),
      { hotkeyRegistered: true },
    );
    expect(result.allowArm).toBe(false);
    expect(result.reasons).toContain("emergency-stop");
  });

  it("arms only when acknowledgement, allowlists, and hotkey are present", () => {
    const armed = armQa(createCapabilities("authorized-qa"), createTestArming({ armed: false }), {
      hotkeyRegistered: true,
    });
    expect(armed.armed).toBe(true);
  });

  it("forces armed false when configuration is incomplete", () => {
    const armed = armQa(
      createCapabilities("authorized-qa"),
      createTestArming({ armed: true, acknowledged: false }),
      { hotkeyRegistered: true },
    );
    expect(armed.armed).toBe(false);
  });
});
