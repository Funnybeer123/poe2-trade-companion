import type { BotDecision } from "@poe2tc/core";

export function createTestDecision(overrides: Partial<BotDecision> = {}): BotDecision {
  return {
    module: "follow",
    state: "Follow",
    reason: "follow-target",
    confidence: 0.9,
    intendedActions: [{ type: "mouse-click", x: 400, y: 300, button: "left" }],
    evidenceIds: ["test-evidence"],
    ...overrides,
  };
}
