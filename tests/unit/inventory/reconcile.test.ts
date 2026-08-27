import {
  occupancyFromCells,
  reconcile,
  type ShadowItem,
} from "@poe2tc/core";
import { describe, expect, it } from "vitest";
import { fullInventoryCells, inventoryCellsWithDrop } from "../../helpers/gridCells.js";

function item(fingerprint: string, x: number, y: number, lastConfirmedMs = 0): ShadowItem {
  return {
    fingerprint,
    location: { kind: "inventory", x, y },
    lastConfirmedMs,
    stale: false,
    mismatch: false,
  };
}

describe("reconcile", () => {
  it("match: observed fingerprint at the same cell is confirmed", () => {
    const result = reconcile({
      shadow: [item("orb-a", 0, 0, 1_000)],
      inventoryCells: fullInventoryCells({ "0:0": "orb-a" }).map((cell) =>
        cell.x === 0 && cell.y === 0 ? { ...cell, occupied: true, itemFingerprint: "orb-a" } : { ...cell, occupied: false },
      ),
      stashCells: [],
      nowMs: 10_000,
      inventoryFreshness: "fresh",
      stashFreshness: "missing",
    });
    expect(result.confirmed).toEqual([
      {
        fingerprint: "orb-a",
        location: { kind: "inventory", x: 0, y: 0 },
        lastConfirmedMs: 10_000,
        stale: false,
        mismatch: false,
      },
    ]);
    expect(result.missing).toEqual([]);
    expect(result.unexpected).toEqual([]);
    expect(result.stale).toEqual([]);
  });

  it("missing: shadow item whose cell is empty is mismatch and not invented back", () => {
    const result = reconcile({
      shadow: [item("orb-a", 0, 0, 1_000)],
      inventoryCells: inventoryCellsWithDrop({ x: 0, y: 0 }),
      stashCells: [],
      nowMs: 10_000,
      inventoryFreshness: "fresh",
      stashFreshness: "missing",
    });
    expect(result.missing).toEqual([
      {
        fingerprint: "orb-a",
        location: { kind: "inventory", x: 0, y: 0 },
        lastConfirmedMs: 1_000,
        stale: false,
        mismatch: true,
      },
    ]);
    expect(result.confirmed).toEqual([]);
    expect(result.unexpected).toEqual([]);
  });

  it("unexpected: a new observed fingerprint is mismatch and uses the observed identity", () => {
    const result = reconcile({
      shadow: [item("orb-a", 0, 0, 1_000)],
      inventoryCells: [
        { x: 0, y: 0, w: 1, h: 1, occupied: true, itemFingerprint: "orb-a" },
        { x: 1, y: 0, w: 1, h: 1, occupied: true, itemFingerprint: "orb-b" },
      ],
      stashCells: [],
      nowMs: 10_000,
      inventoryFreshness: "fresh",
      stashFreshness: "missing",
    });
    expect(result.confirmed.map((entry) => entry.fingerprint)).toEqual(["orb-a"]);
    expect(result.unexpected).toEqual([
      {
        fingerprint: "orb-b",
        location: { kind: "inventory", x: 1, y: 0 },
        lastConfirmedMs: 10_000,
        stale: false,
        mismatch: true,
      },
    ]);
  });

  it("stale: matching cells loaded with stale freshness stay present and are not mismatch", () => {
    const result = reconcile({
      shadow: [item("orb-a", 0, 0, 1_000)],
      inventoryCells: [{ x: 0, y: 0, w: 1, h: 1, occupied: true, itemFingerprint: "orb-a" }],
      stashCells: [],
      nowMs: 20_000,
      inventoryFreshness: "stale",
      stashFreshness: "missing",
    });
    expect(result.stale).toEqual([
      {
        fingerprint: "orb-a",
        location: { kind: "inventory", x: 0, y: 0 },
        lastConfirmedMs: 1_000,
        stale: true,
        mismatch: false,
      },
    ]);
    expect(result.confirmed).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.unexpected).toEqual([]);
  });

  it("uses fallback capacity when the observed cell list is sparse", () => {
    const occupancy = occupancyFromCells([{ x: 0, y: 0, w: 1, h: 1, occupied: true }], {
      capacity: 12,
    });
    expect(occupancy.occupied).toBe(1);
    expect(occupancy.capacity).toBe(12);
    expect(occupancy.full).toBe(false);
  });

  it("full: twelve occupied cells are capacity-full", () => {
    const cells = fullInventoryCells();
    const occupancy = occupancyFromCells(cells);
    expect(occupancy.occupied).toBe(12);
    expect(occupancy.capacity).toBe(12);
    expect(occupancy.full).toBe(true);
    expect(occupancyFromCells(inventoryCellsWithDrop({ x: 3, y: 2 })).full).toBe(false);
  });

  it("does not invent items for occupied cells that lack fingerprints", () => {
    const result = reconcile({
      shadow: [],
      inventoryCells: fullInventoryCells(),
      stashCells: [],
      nowMs: 10_000,
      inventoryFreshness: "fresh",
      stashFreshness: "missing",
      seedIfEmpty: true,
    });
    expect(result.confirmed).toEqual([]);
    expect(result.unexpected).toEqual([]);
    expect(result.missing).toEqual([]);
  });

  it("does not invent a replacement when a fingerprint changes", () => {
    const result = reconcile({
      shadow: [item("orb-a", 0, 0, 1_000)],
      inventoryCells: [{ x: 0, y: 0, w: 1, h: 1, occupied: true, itemFingerprint: "orb-b" }],
      stashCells: [],
      nowMs: 10_000,
      inventoryFreshness: "fresh",
      stashFreshness: "missing",
    });
    expect(result.missing.map((entry) => entry.fingerprint)).toEqual(["orb-a"]);
    expect(result.unexpected.map((entry) => entry.fingerprint)).toEqual(["orb-b"]);
    expect(result.missing[0]?.mismatch).toBe(true);
    expect(result.unexpected[0]?.mismatch).toBe(true);
  });
});
