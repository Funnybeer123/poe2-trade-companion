import { screenCenter } from "../navigation/direction.js";
import type { LootTarget, PixelPoint } from "../world-state/types.js";

export function lootDistanceToCenter(item: LootTarget, center: PixelPoint): number {
  return Math.hypot(item.screenPoint.x - center.x, item.screenPoint.y - center.y);
}

export function rankLoot(
  items: LootTarget[],
  center: PixelPoint = screenCenter(),
): LootTarget[] {
  return [...items].sort((left, right) => {
    const scoreDelta = (right.score ?? 0) - (left.score ?? 0);
    if (scoreDelta !== 0) {
      return scoreDelta;
    }
    const distanceDelta = lootDistanceToCenter(left, center) - lootDistanceToCenter(right, center);
    if (distanceDelta !== 0) {
      return distanceDelta;
    }
    if (left.id < right.id) {
      return -1;
    }
    if (left.id > right.id) {
      return 1;
    }
    return 0;
  });
}

export function eligibleLoot(items: LootTarget[]): LootTarget[] {
  return items.filter((item) => item.skipReason === undefined);
}
