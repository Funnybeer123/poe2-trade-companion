import { makeGridCells, type GridCell, type ShadowItem, type StashItemMeta, type WorldState } from "@poe2tc/core";
import { createTestWorld } from "./createTestWorld.js";

export const DIVINE_META: StashItemMeta = {
  class: "Currency",
  rarity: "currency",
  category: "HighValueSell",
  score: 95,
};

export const CHAOS_META: StashItemMeta = {
  class: "Currency",
  rarity: "currency",
  category: "BulkCommodity",
  score: 50,
};

export const RUSTED_META: StashItemMeta = {
  class: "Waystone",
  rarity: "normal",
  category: "Dump",
  score: 8,
};

export function shadowAt(
  fingerprint: string,
  location: ShadowItem["location"],
): ShadowItem {
  return {
    fingerprint,
    location,
    lastConfirmedMs: 10_000,
    stale: false,
    mismatch: false,
  };
}

export function inventoryCells(
  occupied: Array<{ x: number; y: number; fingerprint: string }>,
  columns = 2,
  rows = 2,
): GridCell[] {
  return makeGridCells({
    columns,
    rows,
    cellWidth: 50,
    cellHeight: 50,
    occupied: occupied.map((entry) => ({ x: entry.x, y: entry.y, fingerprint: entry.fingerprint })),
  });
}

export function stashCells(
  tabId: string,
  occupied: Array<{ x: number; y: number; fingerprint?: string }> = [],
  columns = 2,
  rows = 2,
): GridCell[] {
  return makeGridCells({
    columns,
    rows,
    tabId,
    cellWidth: 50,
    cellHeight: 50,
    occupied: occupied.map((entry) =>
      entry.fingerprint === undefined ? ([entry.x, entry.y] as const) : { x: entry.x, y: entry.y, fingerprint: entry.fingerprint },
    ),
  });
}

export function createStashWorld(patch?: (world: WorldState) => void): WorldState {
  return createTestWorld((world) => {
    world.selectedState = "StashSort";
    world.ui = {
      value: { kind: "stash" },
      confidence: 0.9,
      observedAtMs: 10_000,
      freshness: "fresh",
    };
    world.flags.stashSessionActive = true;
    world.flags.stashItemCatalog = {
      "divine-1": DIVINE_META,
      "chaos-1": CHAOS_META,
      "rusted-1": RUSTED_META,
      "exalted-1": { class: "Currency", rarity: "currency", category: "HighValueSell", score: 80 },
    };
    patch?.(world);
  });
}
