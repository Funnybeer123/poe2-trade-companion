import {
  FrozenClock,
  createEmptyWorldState,
  createFixturePerceptionAdapter,
  createReplayArming,
  createStateEstimator,
  detectGrids,
} from "@poe2tc/core";
import { describe, expect, it } from "vitest";
import { createRgba, fillRect } from "../../helpers/encodePng.js";

const GEOMETRY = {
  originX: 0,
  originY: 0,
  cellWidth: 16,
  cellHeight: 16,
  columns: 4,
  rows: 3,
};

describe("StateEstimator grid cells", () => {
  it("fills inventory grid cells from the detector", async () => {
    const pixels = createRgba(64, 48, [28, 28, 36, 255]);
    fillRect(pixels, 64, 0, 0, 16, 16, [200, 160, 50, 255]);
    fillRect(pixels, 64, 16, 0, 16, 16, [200, 160, 50, 255]);
    fillRect(pixels, 64, 32, 0, 16, 16, [200, 160, 50, 255]);

    const frame = {
      tickId: 1,
      capturedAtMs: 10_000,
      width: 64,
      height: 48,
      pixels,
      derived: {
        inventoryGrid: GEOMETRY,
        process: {
          value: { name: "PathOfExile.exe", title: "Path of Exile 2", allowlisted: true },
          confidence: 1,
          observedAtMs: 10_000,
          freshness: "fresh" as const,
        },
        ui: {
          value: { kind: "inventory" as const },
          confidence: 0.9,
          observedAtMs: 10_000,
          freshness: "fresh" as const,
        },
      },
    };
    const detected = detectGrids(frame, { inventoryGrid: GEOMETRY });
    expect(detected.inventory?.cells).toHaveLength(12);

    const adapter = createFixturePerceptionAdapter();
    const perception = await adapter.analyze(frame);
    expect(perception.inventory?.value.cells).toHaveLength(12);

    const clock = new FrozenClock(10_000);
    const world = createStateEstimator({ clock, arming: createReplayArming() }).estimate(
      createEmptyWorldState({ clock }),
      perception,
    );
    expect(world.inventory.value.cells).toHaveLength(12);
    expect(world.inventory.value.occupied).toBe(3);
    expect(world.inventory.value.capacity).toBe(12);
    expect(world.inventory.value.full).toBe(false);
    expect(world.ui.value.kind).toBe("inventory");
  });

  it("recomputes full from cells even when derived occupancy is stale or wrong", () => {
    const clock = new FrozenClock(10_000);
    const estimator = createStateEstimator({ clock, arming: createReplayArming() });
    const cells = Array.from({ length: 12 }, (_, index) => ({
      x: index % 4,
      y: Math.floor(index / 4),
      w: 1,
      h: 1,
      occupied: index < 11,
    }));
    const world = estimator.estimate(createEmptyWorldState({ clock }), {
      tickId: 1,
      capturedAtMs: 10_000,
      evidenceId: "grid-test",
      inventory: {
        value: { occupied: 12, capacity: 12, cells, full: true },
        confidence: 1,
        observedAtMs: 10_000,
        freshness: "fresh",
      },
    });
    expect(world.inventory.value.occupied).toBe(11);
    expect(world.inventory.value.full).toBe(false);
    expect(world.inventory.value.cells).toHaveLength(12);
  });
});
