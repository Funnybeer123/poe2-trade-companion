import type { Clock } from "../clock.js";
import type { PerceptionFrameInput } from "../perception/types.js";
import type { WorldState } from "../world-state/types.js";

/**
 * Phase 04 identity estimator stub. Copies `derived` fields onto the previous
 * WorldState. Real merge/freshness rules land in Phase 05 StateEstimator.
 */
export function identityEstimate(
  prev: WorldState,
  frame: PerceptionFrameInput,
  clock: Clock,
): WorldState {
  const derived = frame.derived ?? {};
  return {
    ...prev,
    ...derived,
    flags: {
      ...prev.flags,
      ...(derived.flags ?? {}),
    },
    tickId: frame.tickId,
    capturedAtMs: frame.capturedAtMs,
    clockMs: clock.nowMs(),
  };
}

export function summarizeWorld(world: WorldState): string {
  const identity = world.target.value?.identity;
  const targetText = identity === undefined ? "target=none" : `target=${identity}`;
  const processName = world.process.value.name ?? "unknown";
  return `${targetText} process=${processName} ui=${world.ui.value.kind}`;
}

export function isoTimestampFromMs(ms: number): string {
  return new Date(ms).toISOString();
}
