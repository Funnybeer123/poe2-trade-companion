import type { BotDecision, InputAction } from "../input/types.js";
import { followDirection } from "../navigation/direction.js";
import { resolveFollowConfig, type FollowConfig } from "../navigation/followConfig.js";
import { stuckRecoveryAttempt } from "../navigation/stuckDetector.js";
import { recoveryScanPoint } from "../navigation/scan.js";
import { STUCK_EXHAUSTED_REASON } from "../navigation/estimateNavigation.js";
import { DEFAULT_RECOVERY } from "../recovery/defaultRecovery.js";
import type { AutomationScenario } from "../scheduler/types.js";
import type { WorldState } from "../world-state/types.js";
import type { Controller } from "./types.js";

function evidenceIds(world: WorldState): string[] {
  return world.target.evidenceId ? [world.target.evidenceId] : [];
}

function emergencyStopDecision(world: WorldState): BotDecision {
  return {
    module: "follow",
    state: "EmergencyStop",
    reason: "emergency-stop",
    confidence: 1,
    intendedActions: [{ type: "noop", reason: "emergency-stop" }],
    evidenceIds: evidenceIds(world),
  };
}

export class FollowController implements Controller {
  readonly module = "follow" as const;
  readonly config: FollowConfig;

  constructor(config: Partial<FollowConfig> = {}) {
    this.config = resolveFollowConfig(config);
  }

  decide(world: WorldState, scenario: AutomationScenario): BotDecision {
    if (world.flags.emergencyStopLatched) {
      return emergencyStopDecision(world);
    }

    const stuck = world.stuck.value;
    if (stuck.reason === STUCK_EXHAUSTED_REASON) {
      return {
        module: this.module,
        state: "SafetyHold",
        reason: STUCK_EXHAUSTED_REASON,
        confidence: world.target.confidence,
        intendedActions: [{ type: "noop", reason: STUCK_EXHAUSTED_REASON }],
        evidenceIds: evidenceIds(world),
        recoveryOf: "follow.stuck",
        retryIndex: DEFAULT_RECOVERY["follow.stuck"]?.maxAttempts,
      };
    }

    if (stuck.isStuck) {
      const attempt = stuckRecoveryAttempt(stuck.ticks ?? 0, this.config.stuckTicks);
      const point = recoveryScanPoint(Math.max(1, attempt));
      const intendedActions: InputAction[] = [
        { type: "mouse-click", x: point.x, y: point.y, button: "left" },
      ];
      return {
        module: this.module,
        state: "Follow",
        reason: "stuck-recovery",
        confidence: world.target.confidence,
        intendedActions,
        evidenceIds: evidenceIds(world),
        recoveryOf: "follow.stuck",
        retryIndex: attempt,
      };
    }

    const point = world.target.value?.screenPoint;
    if (point === undefined) {
      return {
        module: this.module,
        state: "Follow",
        reason: "follow-no-point",
        confidence: world.target.confidence,
        intendedActions: [{ type: "noop", reason: "follow-no-point" }],
        evidenceIds: evidenceIds(world),
      };
    }

    const directed = followDirection({
      target: point,
      maxFollowDistancePx: this.config.maxFollowDistancePx,
      clickMove: this.config.clickMove,
    });
    const acquired = world.target.confidence >= scenario.confidenceThreshold;
    return {
      module: this.module,
      state: "Follow",
      reason: acquired ? "follow-target" : "follow-low-confidence",
      confidence: world.target.confidence,
      intendedActions: directed.actions,
      evidenceIds: evidenceIds(world),
    };
  }
}
