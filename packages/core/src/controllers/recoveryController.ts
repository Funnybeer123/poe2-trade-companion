import type { BotDecision, InputAction } from "../input/types.js";
import {
  LOST_TARGET_EXHAUSTED_REASON,
  STUCK_EXHAUSTED_REASON,
} from "../navigation/estimateNavigation.js";
import { resolveFollowConfig, type FollowConfig } from "../navigation/followConfig.js";
import { recoveryScanPoint } from "../navigation/scan.js";
import { DEFAULT_RECOVERY } from "../recovery/defaultRecovery.js";
import { eligibilityReason } from "../scheduler/predicates.js";
import type { AutomationScenario } from "../scheduler/types.js";
import type { WorldState } from "../world-state/types.js";
import type { Controller } from "./types.js";

function evidenceIds(world: WorldState): string[] {
  return world.target.evidenceId ? [world.target.evidenceId] : [];
}

export class RecoveryController implements Controller {
  readonly module = "recovery" as const;
  readonly config: FollowConfig;

  constructor(config: Partial<FollowConfig> = {}) {
    this.config = resolveFollowConfig(config);
  }

  decide(world: WorldState, _scenario: AutomationScenario): BotDecision {
    if (world.flags.emergencyStopLatched || world.selectedState === "EmergencyStop") {
      return {
        module: this.module,
        state: "EmergencyStop",
        reason: "emergency-stop",
        confidence: 1,
        intendedActions: [{ type: "noop", reason: "emergency-stop" }],
        evidenceIds: evidenceIds(world),
      };
    }

    if (world.selectedState === "SafetyHold" || world.stuck.value.reason === STUCK_EXHAUSTED_REASON) {
      const reason =
        world.stuck.value.reason === STUCK_EXHAUSTED_REASON
          ? STUCK_EXHAUSTED_REASON
          : eligibilityReason("SafetyHold", world);
      return {
        module: this.module,
        state: "SafetyHold",
        reason,
        confidence: world.target.confidence,
        intendedActions: [{ type: "noop", reason }],
        evidenceIds: evidenceIds(world),
        recoveryOf: world.stuck.value.reason === STUCK_EXHAUSTED_REASON ? "follow.stuck" : undefined,
        retryIndex:
          world.stuck.value.reason === STUCK_EXHAUSTED_REASON
            ? DEFAULT_RECOVERY["follow.stuck"]?.maxAttempts
            : undefined,
      };
    }

    return this.recoverTarget(world);
  }

  private recoverTarget(world: WorldState): BotDecision {
    const lostTicks = world.stuck.value.lostTargetTicks ?? 0;
    const policy = DEFAULT_RECOVERY["follow.lost-target"];
    const maxAttempts = policy?.maxAttempts ?? 5;

    if (
      world.stuck.value.reason === LOST_TARGET_EXHAUSTED_REASON ||
      lostTicks > this.config.lostTargetTicks
    ) {
      return {
        module: this.module,
        state: "Idle",
        reason: LOST_TARGET_EXHAUSTED_REASON,
        confidence: world.target.confidence,
        intendedActions: [{ type: "noop", reason: LOST_TARGET_EXHAUSTED_REASON }],
        evidenceIds: evidenceIds(world),
        recoveryOf: "follow.lost-target",
        retryIndex: maxAttempts,
      };
    }

    if (lostTicks > maxAttempts) {
      return {
        module: this.module,
        state: "RecoverTarget",
        reason: "lost-target",
        confidence: world.target.confidence,
        intendedActions: [{ type: "noop", reason: "lost-target-scan-exhausted" }],
        evidenceIds: evidenceIds(world),
        recoveryOf: "follow.lost-target",
        retryIndex: maxAttempts,
      };
    }

    const attempt = Math.max(1, lostTicks);
    const point = recoveryScanPoint(attempt);
    const intendedActions: InputAction[] = [
      { type: "mouse-click", x: point.x, y: point.y, button: "left" },
    ];
    return {
      module: this.module,
      state: "RecoverTarget",
      reason: "lost-target",
      confidence: world.target.confidence,
      intendedActions,
      evidenceIds: evidenceIds(world),
      recoveryOf: "follow.lost-target",
      retryIndex: attempt,
    };
  }
}
