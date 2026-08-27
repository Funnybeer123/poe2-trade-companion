import {
  createEmptyWorldState,
  FrozenClock,
  type LootTarget,
  type TargetCue,
  type WorldState,
} from "@poe2tc/core";

export const TEST_CLOCK_MS = 10_000;

export function createTestWorld(patch?: (world: WorldState) => void): WorldState {
  const world = createEmptyWorldState({
    clock: new FrozenClock(TEST_CLOCK_MS),
    runtimeMode: "authorized-qa",
    activeScenarioId: "test-scenario",
    selectedState: "Idle",
    previousState: "Idle",
    tickId: 1,
  });
  world.process = {
    value: { name: "PathOfExile.exe", title: "Path of Exile 2", allowlisted: true },
    confidence: 1,
    observedAtMs: TEST_CLOCK_MS,
    freshness: "fresh",
  };
  patch?.(world);
  return world;
}

export function freshTarget(identity = "qa-target"): TargetCue {
  return {
    identity,
    screenPoint: { x: 400, y: 300 },
    estimatedDistance: "near",
  };
}

export function observeTarget(world: WorldState, confidence = 0.9, identity = "qa-target"): void {
  world.target = {
    value: freshTarget(identity),
    confidence,
    observedAtMs: TEST_CLOCK_MS,
    freshness: "fresh",
  };
}

export function observeLoot(world: WorldState, items: LootTarget[], confidence = 0.9): void {
  world.loot = {
    value: items,
    confidence,
    observedAtMs: TEST_CLOCK_MS,
    freshness: "fresh",
  };
}

export function openTrade(world: WorldState): void {
  world.trade = {
    value: { open: true, ourSlots: [], theirSlots: [] },
    confidence: 0.95,
    observedAtMs: TEST_CLOCK_MS,
    freshness: "fresh",
  };
}

export function fillInventory(world: WorldState): void {
  world.inventory = {
    value: { occupied: 60, capacity: 60, cells: [], full: true },
    confidence: 0.95,
    observedAtMs: TEST_CLOCK_MS,
    freshness: "fresh",
  };
}
