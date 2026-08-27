import type { WorldState } from "../world-state/types.js";

export function summarizeLoot(world: WorldState): string {
  if (world.loot.value.length === 0) {
    return "loot=0";
  }
  return `loot=${world.loot.value
    .map((item) => {
      const verdict = item.skipReason === undefined ? "pickable" : `skip:${item.skipReason}`;
      return `${item.id}:${verdict}:${item.score ?? "?"}`;
    })
    .join(",")}`;
}

export function summarizeWorld(world: WorldState): string {
  const identity = world.target.value?.identity;
  const targetText = identity === undefined ? "target=none" : `target=${identity}`;
  const processName = world.process.value.name ?? "unknown";
  return `${targetText} process=${processName} ui=${world.ui.value.kind} ${summarizeLoot(world)}`;
}

export function isoTimestampFromMs(ms: number): string {
  return new Date(ms).toISOString();
}
