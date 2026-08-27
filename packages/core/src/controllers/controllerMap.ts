import type { DesirabilityPort } from "../items/desirabilityPort.js";
import type { AutomationStateId } from "../world-state/types.js";
import { FollowController } from "./followController.js";
import { IdleController } from "./idleController.js";
import { ListingController } from "./listingController.js";
import { LootController } from "./lootController.js";
import { RecoveryController } from "./recoveryController.js";
import { StashController } from "./stashController.js";
import { TradeController } from "./tradeController.js";
import type { Controller } from "./types.js";

export function createControllerMap(
  options: { desirability?: DesirabilityPort } = {},
): Map<AutomationStateId, Controller> {
  const idle = new IdleController();
  const follow = new FollowController();
  const recovery = new RecoveryController();
  const loot = new LootController(options.desirability);
  const stash = new StashController();
  const listing = new ListingController();
  const trade = new TradeController();
  return new Map<AutomationStateId, Controller>([
    ["Idle", idle],
    ["Follow", follow],
    ["RecoverTarget", recovery],
    ["SafetyHold", recovery],
    ["EmergencyStop", recovery],
    ["HighValueLoot", loot],
    ["LootPickup", loot],
    ["InventoryFull", stash],
    ["StashSort", stash],
    ["Listing", listing],
    ["TradeSession", trade],
  ]);
}
