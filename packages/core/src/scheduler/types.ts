import type {
  AutomationStateId,
  Confidence,
  LowConfidencePolicy,
  ModuleId,
  ScenarioId,
  WorldState,
} from "../world-state/types.js";

export interface SchedulerSelection {
  state: AutomationStateId;
  reason: string;
  interrupt: boolean;
}

export interface ScenarioScheduler {
  select(world: WorldState, scenario: AutomationScenario): SchedulerSelection;
}

export interface AutomationScenario {
  id: ScenarioId;
  title: string;
  enabled: boolean;
  executionMode: "dry-run" | "live";
  enabledModules: ModuleId[];
  actionsPerMinute: number;
  confidenceThreshold: Confidence;
  lowConfidencePolicy: LowConfidencePolicy;
  timingProfileId: string;
  retryLimits: Partial<Record<ModuleId, number>>;
  interruptRules: InterruptRule[];
  marketProviderId: string;
  lootMinScore?: number;
  tradeWaitTimeoutMs?: number;
  tradeAmountTolerance?: number;
  failureInjection?: FailureInjection;
}

export interface FailureInjection {
  id: string;
  detail?: string;
}

export interface InterruptRule {
  higher: AutomationStateId;
  lower: AutomationStateId;
  when: string; // documented predicate name, implemented in scheduler
}

export const DEFAULT_INTERRUPT_RULES: InterruptRule[] = [
  { higher: "EmergencyStop", lower: "Follow", when: "always" },
  { higher: "EmergencyStop", lower: "LootPickup", when: "always" },
  { higher: "EmergencyStop", lower: "StashSort", when: "always" },
  { higher: "EmergencyStop", lower: "Listing", when: "always" },
  { higher: "EmergencyStop", lower: "TradeSession", when: "always" },
  { higher: "TradeSession", lower: "Follow", when: "trade-active" },
  { higher: "TradeSession", lower: "LootPickup", when: "trade-active" },
  { higher: "InventoryFull", lower: "LootPickup", when: "inventory-full" },
  { higher: "InventoryFull", lower: "Follow", when: "inventory-full" },
  { higher: "HighValueLoot", lower: "Follow", when: "loot-above-interrupt-threshold" },
  { higher: "StashSort", lower: "Follow", when: "stash-session-active" },
  { higher: "Listing", lower: "Follow", when: "listing-session-active" },
];
