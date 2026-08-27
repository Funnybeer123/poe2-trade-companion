import type { AutomationStateId } from "../world-state/types.js";
import { FollowController } from "./followController.js";
import { IdleController } from "./idleController.js";
import { InventoryController } from "./inventoryController.js";
import { LootController } from "./lootController.js";
import { RecoveryController } from "./recoveryController.js";
import type { Controller } from "./types.js";

export function createControllerMap(): Map<AutomationStateId, Controller> {
  const idle = new IdleController();
  const follow = new FollowController();
  const recovery = new RecoveryController();
  const loot = new LootController();
  const inventory = new InventoryController();
  return new Map<AutomationStateId, Controller>([
    ["Idle", idle],
    ["Follow", follow],
    ["RecoverTarget", recovery],
    ["SafetyHold", recovery],
    ["EmergencyStop", recovery],
    ["HighValueLoot", loot],
    ["LootPickup", loot],
    ["InventoryFull", inventory],
  ]);
}
