import {
  DEFAULT_INTERRUPT_RULES,
  type AutomationScenario,
  type ModuleId,
} from "@poe2tc/core";

export const ALL_MODULES: ModuleId[] = [
  "follow",
  "loot",
  "inventory",
  "stash",
  "listing",
  "trade",
  "recovery",
  "orchestrator",
  "perception",
  "input",
];

export function createTestScenario(overrides: Partial<AutomationScenario> = {}): AutomationScenario {
  return {
    id: "test-scenario",
    title: "Test scenario",
    enabled: true,
    executionMode: "dry-run",
    enabledModules: [...ALL_MODULES],
    actionsPerMinute: 30,
    confidenceThreshold: 0.6,
    lowConfidencePolicy: "skip",
    timingProfileId: "default",
    retryLimits: {},
    interruptRules: DEFAULT_INTERRUPT_RULES,
    marketProviderId: "fixture",
    ...overrides,
  };
}
