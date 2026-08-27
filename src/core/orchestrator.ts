import { FollowController, ListingController, LootController, StashController, TradeController } from "./controllers.js";
import type { AutomationScenario, BotDecision, PerceptionFrame } from "./types.js";

export class Orchestrator {
  constructor(
    private readonly follow = new FollowController(),
    private readonly loot = new LootController(),
    private readonly stash = new StashController(),
    private readonly listing = new ListingController(),
    private readonly trade = new TradeController(),
  ) {}

  choose(frame: PerceptionFrame, scenario: AutomationScenario, expectedTradeItem?: string): BotDecision {
    if (scenario.enabledModules.includes("trading") && (frame.tradeWindowOpen || expectedTradeItem)) {
      return this.trade.decide(frame, scenario, expectedTradeItem ?? "");
    }
    if (scenario.enabledModules.includes("loot") && frame.loot.length > 0) {
      const decision = this.loot.decide(frame, scenario);
      if (decision.rule === "inventory-full" && scenario.enabledModules.includes("stash")) {
        return this.stash.decide(frame, scenario, "sell");
      }
      return decision;
    }
    if (scenario.enabledModules.includes("stash") && frame.stash) {
      return this.stash.decide(frame, scenario, "sell");
    }
    if (scenario.enabledModules.includes("listing")) {
      return this.listing.decide(1, "exalted", frame);
    }
    if (scenario.enabledModules.includes("navigation")) {
      return this.follow.decide(frame, scenario);
    }
    return {
      module: "orchestrator",
      rule: "idle",
      reason: "no eligible module",
      intended: [],
      confidence: frame.confidence,
    };
  }
}
