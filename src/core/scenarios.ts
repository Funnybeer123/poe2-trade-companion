import type { AutomationScenario } from "./types.js";

const defaultRules = {
  keep: "keep",
  sell: "sale",
  vendor: "vendor",
  craft: "craft",
  dump: "dump",
  bulk: "bulk",
} as const;

export function scenario(partial: Partial<AutomationScenario> & Pick<AutomationScenario, "id" | "name">): AutomationScenario {
  return {
    enabledModules: [],
    dryRun: true,
    actionsPerMinute: 30,
    confidenceThreshold: 0.4,
    retryLimit: 3,
    timingProfile: "humanized",
    lootScoreThreshold: 50,
    stashRules: { ...defaultRules },
    ...partial,
  };
}

export const PRESET_SCENARIOS: AutomationScenario[] = [
  scenario({ id: "follow-only", name: "Follow only", enabledModules: ["navigation"] }),
  scenario({ id: "loot-only", name: "Loot only", enabledModules: ["loot"] }),
  scenario({ id: "stash-sort", name: "Stash sort", enabledModules: ["stash"] }),
  scenario({ id: "list-and-reprice", name: "List and reprice", enabledModules: ["listing"] }),
  scenario({ id: "trade-session", name: "Trade session", enabledModules: ["trading"], expectedTradePrice: 10, expectedCurrency: "exalted" }),
  scenario({
    id: "full-loop",
    name: "Full loop",
    enabledModules: ["navigation", "loot", "stash", "listing", "trading"],
    expectedTradePrice: 10,
  }),
  scenario({ id: "adversarial-low-confidence", name: "Adversarial low confidence", confidenceThreshold: 0.95 }),
  scenario({ id: "rate-limit-injection", name: "Rate limit", actionsPerMinute: 1 }),
];
