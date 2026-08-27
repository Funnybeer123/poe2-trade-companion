import type { WorldState } from "../world-state/types.js";

export function summarizeWorld(world: WorldState): string {
  const identity = world.target.value?.identity;
  const targetText = identity === undefined ? "target=none" : `target=${identity}`;
  const processName = world.process.value.name ?? "unknown";
  return `${targetText} process=${processName} ui=${world.ui.value.kind}`;
}

export function isoTimestampFromMs(ms: number): string {
  return new Date(ms).toISOString();
}
