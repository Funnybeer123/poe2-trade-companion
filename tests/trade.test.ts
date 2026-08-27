import { describe, expect, it } from "vitest";
import { TradeController } from "../src/core/controllers.js";
import { PRESET_SCENARIOS } from "../src/core/scenarios.js";
import type { PerceptionFrame } from "../src/core/types.js";

function frame(over: Partial<PerceptionFrame>): PerceptionFrame {
  return {
    timestamp: "t",
    windowTitle: "Path of Exile 2",
    processName: "PathOfExile.exe",
    loot: [],
    evidenceHash: "h",
    confidence: 0.9,
    ...over,
  };
}

describe("trade edge cases", () => {
  const scenario = PRESET_SCENARIOS.find((entry) => entry.id === "trade-session")!;

  it("accepts matching trades", () => {
    const decision = new TradeController().decide(
      frame({
        tradeWindowOpen: true,
        offeredCurrencyAmount: 10,
        placedItemFingerprint: "abc",
      }),
      scenario,
      "abc",
    );
    expect(decision.outcome).toBe("accept");
  });

  it("rejects missing item", () => {
    const decision = new TradeController().decide(
      frame({ tradeWindowOpen: true, offeredCurrencyAmount: 10, placedItemFingerprint: "zzz" }),
      scenario,
      "abc",
    );
    expect(decision.outcome).toBe("reject");
  });
});
