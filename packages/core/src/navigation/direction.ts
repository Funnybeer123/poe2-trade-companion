import type { InputAction } from "../input/types.js";
import type { PixelPoint } from "../world-state/types.js";
import { DEFAULT_FOLLOW_CONFIG } from "./followConfig.js";

export const DEFAULT_SCREEN_WIDTH = 1920;
export const DEFAULT_SCREEN_HEIGHT = 1080;

export interface FollowDirectionInput {
  target: PixelPoint;
  screenWidth?: number;
  screenHeight?: number;
  maxFollowDistancePx?: number;
  clickMove?: boolean;
}

export interface FollowDirectionResult {
  dx: number;
  dy: number;
  distance: number;
  center: PixelPoint;
  actions: InputAction[];
}

export function screenCenter(
  width = DEFAULT_SCREEN_WIDTH,
  height = DEFAULT_SCREEN_HEIGHT,
): PixelPoint {
  return { x: width / 2, y: height / 2 };
}

export function vectorToTarget(center: PixelPoint, target: PixelPoint): {
  dx: number;
  dy: number;
  distance: number;
} {
  const dx = target.x - center.x;
  const dy = target.y - center.y;
  return { dx, dy, distance: Math.hypot(dx, dy) };
}

export function followDirection(input: FollowDirectionInput): FollowDirectionResult {
  const width = input.screenWidth ?? DEFAULT_SCREEN_WIDTH;
  const height = input.screenHeight ?? DEFAULT_SCREEN_HEIGHT;
  const maxFollowDistancePx = input.maxFollowDistancePx ?? DEFAULT_FOLLOW_CONFIG.maxFollowDistancePx;
  const clickMove = input.clickMove ?? DEFAULT_FOLLOW_CONFIG.clickMove;
  const center = screenCenter(width, height);
  const { dx, dy, distance } = vectorToTarget(center, input.target);

  if (distance <= maxFollowDistancePx) {
    return {
      dx,
      dy,
      distance,
      center,
      actions: [{ type: "noop", reason: "inside-follow-band" }],
    };
  }

  if (!clickMove) {
    return {
      dx,
      dy,
      distance,
      center,
      actions: [{ type: "noop", reason: "click-move-disabled" }],
    };
  }

  return {
    dx,
    dy,
    distance,
    center,
    actions: [{ type: "mouse-click", x: input.target.x, y: input.target.y, button: "left" }],
  };
}
