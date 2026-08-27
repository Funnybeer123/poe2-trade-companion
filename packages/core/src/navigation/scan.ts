import type { PixelPoint } from "../world-state/types.js";
import { DEFAULT_SCREEN_HEIGHT, DEFAULT_SCREEN_WIDTH, screenCenter } from "./direction.js";

export const RECOVERY_SCAN_RADIUS_PX = 220;
export const RECOVERY_SCAN_ANGLES_DEG = [0, 90, 180, 270, 45] as const;

export function recoveryScanPoint(
  attempt: number,
  center: PixelPoint = screenCenter(DEFAULT_SCREEN_WIDTH, DEFAULT_SCREEN_HEIGHT),
  radius = RECOVERY_SCAN_RADIUS_PX,
): PixelPoint {
  const index = Math.max(0, attempt - 1) % RECOVERY_SCAN_ANGLES_DEG.length;
  const deg = RECOVERY_SCAN_ANGLES_DEG[index] ?? 0;
  const rad = (deg * Math.PI) / 180;
  return {
    x: Math.round(center.x + radius * Math.cos(rad)),
    y: Math.round(center.y + radius * Math.sin(rad)),
  };
}
