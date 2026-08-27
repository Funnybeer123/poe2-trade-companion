import { ShadowState, applyStaleSnapshots, createEmptyWorldState, FrozenClock } from "@poe2tc/core";
import { describe, expect, it } from "vitest";

describe("ShadowState", () => {
  it("seeds snapshot items as stale and never stores empty fingerprints", () => {
    const shadow = new ShadowState();
    shadow.seedFromSnapshots({
      inventory: {
        id: "inv-1",
        capturedAtMs: 5_000,
        payload: {
          occupied: 1,
          capacity: 12,
          full: false,
          cells: [
            { x: 0, y: 0, w: 1, h: 1, occupied: true, itemFingerprint: "orb-a" },
            { x: 1, y: 0, w: 1, h: 1, occupied: true },
          ],
        },
      },
    });
    expect(shadow.items).toEqual([
      {
        fingerprint: "orb-a",
        location: { kind: "inventory", x: 0, y: 0 },
        lastConfirmedMs: 5_000,
        stale: true,
        mismatch: false,
      },
    ]);
  });

  it("drops missing items after reconcile and keeps unexpected observed identities", () => {
    const shadow = new ShadowState();
    shadow.seed([
      {
        fingerprint: "orb-a",
        location: { kind: "inventory", x: 0, y: 0 },
        lastConfirmedMs: 1_000,
        stale: false,
        mismatch: false,
      },
    ]);
    const result = shadow.reconcile({
      inventoryCells: [{ x: 1, y: 0, w: 1, h: 1, occupied: true, itemFingerprint: "orb-b" }],
      stashCells: [],
      nowMs: 10_000,
      inventoryFreshness: "fresh",
      stashFreshness: "missing",
    });
    expect(result.missing[0]?.fingerprint).toBe("orb-a");
    expect(result.unexpected[0]?.fingerprint).toBe("orb-b");
    expect(shadow.get({ kind: "inventory", x: 0, y: 0 })).toBeUndefined();
    expect(shadow.get({ kind: "inventory", x: 1, y: 0 })?.fingerprint).toBe("orb-b");
  });

  it("applyStaleSnapshots marks loaded grids stale", () => {
    const world = applyStaleSnapshots(createEmptyWorldState({ clock: new FrozenClock(20_000) }), {
      inventory: {
        id: "inv-1",
        capturedAtMs: 5_000,
        payload: { occupied: 12, capacity: 12, full: true, cells: [] },
      },
    });
    expect(world.inventory.freshness).toBe("stale");
    expect(world.inventory.value.full).toBe(true);
    expect(world.inventory.observedAtMs).toBe(5_000);
  });
});
