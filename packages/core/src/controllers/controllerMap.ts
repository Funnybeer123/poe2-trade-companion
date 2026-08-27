import type { AutomationStateId } from "../world-state/types.js";
import { FollowController } from "./followController.js";
import { IdleController } from "./idleController.js";
import type { Controller } from "./types.js";

export function createPhase04ControllerMap(): Map<AutomationStateId, Controller> {
  const idle = new IdleController();
  const follow = new FollowController();
  return new Map<AutomationStateId, Controller>([
    ["Idle", idle],
    ["Follow", follow],
  ]);
}
