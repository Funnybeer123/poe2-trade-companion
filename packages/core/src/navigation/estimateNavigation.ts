import { DEFAULT_RECOVERY } from "../recovery/defaultRecovery.js";
import type { Observation, StuckObservationValue, TargetCue } from "../world-state/types.js";
import { DEFAULT_FOLLOW_CONFIG, type FollowConfig } from "./followConfig.js";
import { nextLostTargetTicks } from "./lostTargetTicks.js";
import { detectStuck, stuckRecoveryAttempt } from "./stuckDetector.js";

export const STUCK_EXHAUSTED_REASON = "stuck-exhausted";
export const LOST_TARGET_EXHAUSTED_REASON = "lost-target-exhausted";
export const LOST_TARGET_REASON = "lost-target";
export const NO_PROGRESS_REASON = "no-progress";

export function estimateStuckObservation(
  prevStuck: Observation<StuckObservationValue>,
  prevTarget: Observation<TargetCue | null>,
  currentTarget: Observation<TargetCue | null>,
  config: FollowConfig = DEFAULT_FOLLOW_CONFIG,
): StuckObservationValue {
  const targetPresent = currentTarget.freshness !== "missing" && currentTarget.value !== null;
  const lostTargetTicks = nextLostTargetTicks(prevStuck.value.lostTargetTicks ?? 0, targetPresent);
  const stuckPolicy = DEFAULT_RECOVERY["follow.stuck"];

  if (!targetPresent) {
    return {
      isStuck: false,
      reason:
        lostTargetTicks > config.lostTargetTicks
          ? LOST_TARGET_EXHAUSTED_REASON
          : LOST_TARGET_REASON,
      ticks: 0,
      lostTargetTicks,
    };
  }

  const detected = detectStuck({
    prevPoint: prevTarget.value?.screenPoint,
    currentPoint: currentTarget.value?.screenPoint,
    prevNoProgressTicks: prevStuck.value.ticks ?? 0,
    stuckTicks: config.stuckTicks,
  });
  const attempt = stuckRecoveryAttempt(detected.noProgressTicks, config.stuckTicks);
  let reason: string | undefined;
  if (detected.isStuck) {
    reason =
      attempt > (stuckPolicy?.maxAttempts ?? 3) ? STUCK_EXHAUSTED_REASON : NO_PROGRESS_REASON;
  }

  return {
    isStuck: detected.isStuck,
    reason,
    ticks: detected.noProgressTicks,
    lostTargetTicks,
  };
}

export function isStuckExhausted(stuck: StuckObservationValue): boolean {
  return stuck.reason === STUCK_EXHAUSTED_REASON;
}

export function isLostTargetExhausted(stuck: StuckObservationValue): boolean {
  return stuck.reason === LOST_TARGET_EXHAUSTED_REASON;
}

export function lostTargetScanAttempt(
  lostTargetTicks: number,
  maxAttempts = DEFAULT_RECOVERY["follow.lost-target"]?.maxAttempts ?? 5,
): number {
  if (lostTargetTicks <= 0) {
    return 0;
  }
  return Math.min(lostTargetTicks, maxAttempts);
}
