import type { AutomationStateId } from "../world-state/types.js";

export const STATE_PRIORITY: Record<AutomationStateId, number> = {
  EmergencyStop: 0,
  SafetyHold: 1,
  TradeSession: 2,
  InventoryFull: 3,
  HighValueLoot: 4,
  Listing: 5,
  StashSort: 6,
  LootPickup: 7,
  Follow: 8,
  RecoverTarget: 9,
  Idle: 10,
};

export const AUTOMATION_STATE_IDS = Object.keys(STATE_PRIORITY) as AutomationStateId[];
