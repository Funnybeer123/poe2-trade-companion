import type { AutomationStateId } from "../world-state/types.js";
import { FollowController } from "./followController.js";
import { IdleController } from "./idleController.js";
import { RecoveryController } from "./recoveryController.js";
import type { Controller } from "./types.js";

export function createControllerMap(): Map<AutomationStateId, Controller> {
  const idle = new IdleController();
  const follow = new FollowController();
  const recovery = new RecoveryController();
  return new Map<AutomationStateId, Controller>([
    ["Idle", idle],
    ["Follow", follow],
    ["RecoverTarget", recovery],
    ["SafetyHold", recovery],
    ["EmergencyStop", recovery],
  ]);
}
