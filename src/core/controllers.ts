import type { AutomationScenario, BotDecision, PerceptionFrame } from "./types.js";

export class FollowController {
  decide(frame: PerceptionFrame, scenario: AutomationScenario): BotDecision {
    const target = frame.navigationTarget;
    if (!target || (scenario.followTargetId && target.id !== scenario.followTargetId)) {
      return {
        module: "navigation",
        rule: "lost-target",
        reason: "no matching navigation target",
        intended: [],
        confidence: frame.confidence,
      };
    }
    if (target.confidence < scenario.confidenceThreshold) {
      return {
        module: "navigation",
        rule: "low-confidence",
        reason: "target confidence below threshold",
        intended: [],
        confidence: target.confidence,
      };
    }
    const dx = target.screenX - 0.5;
    const key = Math.abs(dx) > 0.05 ? (dx < 0 ? "A" : "D") : "W";
    return {
      module: "navigation",
      rule: "follow-move",
      reason: `move toward ${target.id}`,
      intended: [{ kind: "key", key }],
      confidence: target.confidence,
    };
  }
}

export class LootController {
  decide(frame: PerceptionFrame, scenario: AutomationScenario): BotDecision {
    if (frame.inventory && frame.inventory.freeCells <= 0) {
      return {
        module: "loot",
        rule: "inventory-full",
        reason: "inventory full; transition to stash",
        intended: [{ kind: "key", key: "G" }],
        confidence: frame.confidence,
      };
    }
    const eligible = frame.loot.filter((item) => (item.desirability ?? 0) >= scenario.lootScoreThreshold);
    const best = eligible.sort((a, b) => (b.desirability ?? 0) - (a.desirability ?? 0))[0];
    if (!best) {
      return {
        module: "loot",
        rule: "skip-low-value",
        reason: "no loot above threshold",
        intended: [],
        confidence: frame.confidence,
      };
    }
    return {
      module: "loot",
      rule: "pickup",
      reason: `pickup ${best.label}`,
      intended: [{ kind: "click", x: best.screenX, y: best.screenY }],
      confidence: frame.confidence,
    };
  }
}

export class StashController {
  decide(frame: PerceptionFrame, scenario: AutomationScenario, category: keyof AutomationScenario["stashRules"]): BotDecision {
    const tab = scenario.stashRules[category];
    if (!frame.stash) {
      return {
        module: "stash",
        rule: "stash-not-visible",
        reason: "stash UI not observed",
        intended: [],
        confidence: frame.confidence,
      };
    }
    if (frame.stash.activeTab !== tab) {
      return {
        module: "stash",
        rule: "select-tab",
        reason: `select destination tab ${tab}`,
        intended: [{ kind: "click", x: 0.1, y: 0.2 }],
        confidence: frame.confidence,
      };
    }
    const occupied = frame.inventory?.cells.find((cell) => cell.occupied);
    if (!occupied) {
      return {
        module: "stash",
        rule: "nothing-to-move",
        reason: "inventory empty",
        intended: [],
        confidence: frame.confidence,
      };
    }
    return {
      module: "stash",
      rule: "transfer-item",
      reason: `move item to ${tab}`,
      intended: [{ kind: "click", x: 0.3 + occupied.col * 0.02, y: 0.4 + occupied.row * 0.02 }],
      confidence: frame.confidence,
    };
  }
}

export class ListingController {
  decide(recommendedListing: number, currency: string, frame: PerceptionFrame): BotDecision {
    return {
      module: "listing",
      rule: "set-price",
      reason: `list at ${recommendedListing} ${currency}`,
      intended: [{ kind: "type", text: String(recommendedListing) }],
      confidence: frame.confidence,
    };
  }
}

export type TradeOutcome = "accept" | "reject" | "wait";

export class TradeController {
  decide(
    frame: PerceptionFrame,
    scenario: AutomationScenario,
    expectedFingerprint: string,
  ): BotDecision & { outcome: TradeOutcome } {
    if (!frame.tradeWindowOpen) {
      return {
        module: "trading",
        rule: "open-trade",
        reason: "trade window closed",
        intended: [{ kind: "key", key: "T" }],
        confidence: frame.confidence,
        outcome: "wait",
      };
    }
    if (frame.placedItemFingerprint !== expectedFingerprint) {
      return {
        module: "trading",
        rule: "wrong-item",
        reason: "placed item does not match expected fingerprint",
        intended: [{ kind: "click", x: 0.8, y: 0.8 }],
        confidence: frame.confidence,
        outcome: "reject",
      };
    }
    if (
      scenario.expectedTradePrice !== undefined &&
      (frame.offeredCurrencyAmount ?? 0) < scenario.expectedTradePrice
    ) {
      return {
        module: "trading",
        rule: "wrong-currency",
        reason: "offered currency below expected price",
        intended: [{ kind: "click", x: 0.8, y: 0.8 }],
        confidence: frame.confidence,
        outcome: "reject",
      };
    }
    return {
      module: "trading",
      rule: "accept-trade",
      reason: "item and currency match scenario",
      intended: [{ kind: "click", x: 0.7, y: 0.85 }],
      confidence: frame.confidence,
      outcome: "accept",
    };
  }
}
