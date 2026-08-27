import type { BotDecision, InputAction } from "../input/types.js";
import type { AutomationScenario } from "../scheduler/types.js";
import type { WorldState } from "../world-state/types.js";
import type { Controller } from "./types.js";

/**
 * Phase 04 placeholder. Real follow navigation (distance band, stuck, lost-target)
 * is Phase 06. When Follow is selected with a derived screen point, record a
 * mouse-click so replay can assert intended input. Without a point, return noop.
 */
export class FollowController implements Controller {
  readonly module = "follow" as const;

  decide(world: WorldState, scenario: AutomationScenario): BotDecision {
    const target = world.target.value;
    const point = target?.screenPoint;
    const acquired =
      target !== null && world.target.confidence >= scenario.confidenceThreshold;
    const intendedActions: InputAction[] = point
      ? [{ type: "mouse-click", x: point.x, y: point.y, button: "left" }]
      : [{ type: "noop", reason: "follow-placeholder-no-point" }];

    return {
      module: this.module,
      state: "Follow",
      reason: acquired ? "follow-target" : "follow-placeholder",
      confidence: world.target.confidence,
      intendedActions,
      evidenceIds: world.target.evidenceId ? [world.target.evidenceId] : [],
    };
  }
}
