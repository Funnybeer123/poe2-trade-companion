import type { PixelPoint } from "../world-state/types.js";
import { DEFAULT_FOLLOW_CONFIG } from "./followConfig.js";

export const DEFAULT_MIN_PROGRESS_PX = 4;

export interface StuckDetectorInput {
  prevPoint?: PixelPoint;
  currentPoint?: PixelPoint;
  prevNoProgressTicks: number;
  stuckTicks?: number;
  minProgressPx?: number;
}

export interface StuckDetectorResult {
  noProgressTicks: number;
  isStuck: boolean;
  progressed: boolean;
}

export function pointDistance(a: PixelPoint, b: PixelPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function detectStuck(input: StuckDetectorInput): StuckDetectorResult {
  const stuckTicks = input.stuckTicks ?? DEFAULT_FOLLOW_CONFIG.stuckTicks;
  const minProgressPx = input.minProgressPx ?? DEFAULT_MIN_PROGRESS_PX;
  const current = input.currentPoint;
  const previous = input.prevPoint;

  if (current === undefined) {
    return { noProgressTicks: 0, isStuck: false, progressed: false };
  }
  if (previous === undefined) {
    return { noProgressTicks: 0, isStuck: false, progressed: false };
  }

  const moved = pointDistance(previous, current);
  const progressed = moved >= minProgressPx;
  const noProgressTicks = progressed ? 0 : input.prevNoProgressTicks + 1;
  return {
    noProgressTicks,
    isStuck: noProgressTicks >= stuckTicks,
    progressed,
  };
}

export function stuckRecoveryAttempt(noProgressTicks: number, stuckTicks = DEFAULT_FOLLOW_CONFIG.stuckTicks): number {
  if (noProgressTicks < stuckTicks) {
    return 0;
  }
  return noProgressTicks - stuckTicks + 1;
}
