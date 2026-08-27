import {
  createEmptyWorldState,
  createFixturePerceptionAdapter,
  createReplayArming,
  createStateEstimator,
  FrozenClock,
  templateMatch,
  type PerceptionFrameInput,
  type RgbaImage,
} from "@poe2tc/core";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/perception");

async function loadPng(rel: string): Promise<RgbaImage> {
  const buffer = readFileSync(join(root, rel));
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, pixels: new Uint8Array(data) };
}

function loadJson(rel: string): {
  derived?: PerceptionFrameInput["derived"];
  box?: { x: number; y: number; w: number; h: number };
} {
  return JSON.parse(readFileSync(join(root, rel), "utf8")) as {
    derived?: PerceptionFrameInput["derived"];
    box?: { x: number; y: number; w: number; h: number };
  };
}

describe("PNG fixture → adapter → estimator", () => {
  it("recovers the labeled target from the target-cue fixture", async () => {
    const label = loadJson("target-cue/frame.json");
    const image = await loadPng("target-cue/frame.png");
    const template = await loadPng("target-cue/template.png");
    const hit = templateMatch(image, template);
    expect(hit.box).toEqual(label.box);

    const clock = new FrozenClock(10_000);
    const adapter = createFixturePerceptionAdapter();
    const perception = await adapter.analyze({
      tickId: 1,
      capturedAtMs: 10_000,
      width: image.width,
      height: image.height,
      pngPath: "fixtures/perception/target-cue/frame.png",
      derived: label.derived,
    });
    const world = createStateEstimator({ clock, arming: createReplayArming() }).estimate(
      createEmptyWorldState({ clock }),
      perception,
    );
    expect(world.target.value?.identity).toBe("qa-target");
    expect(world.target.freshness).toBe("fresh");
  });

  it("recovers loot, inventory occupancy, and stash counts from labeled fixtures", async () => {
    const clock = new FrozenClock(10_000);
    const adapter = createFixturePerceptionAdapter();
    const estimator = createStateEstimator({ clock, arming: createReplayArming() });

    const lootLabel = loadJson("loot-label/frame.json");
    const lootFrame = await adapter.analyze({
      tickId: 1,
      capturedAtMs: 10_000,
      width: 64,
      height: 64,
      derived: lootLabel.derived,
    });
    const afterLoot = estimator.estimate(createEmptyWorldState({ clock }), lootFrame);
    expect(afterLoot.loot.value).toHaveLength(1);

    const inventoryLabel = loadJson("inventory/frame.json");
    const inventoryFrame = await adapter.analyze({
      tickId: 2,
      capturedAtMs: 10_000,
      width: 64,
      height: 64,
      derived: inventoryLabel.derived,
    });
    const afterInventory = estimator.estimate(afterLoot, inventoryFrame);
    expect(afterInventory.inventory.value.occupied).toBe(3);
    expect(afterInventory.inventory.value.capacity).toBe(12);
    expect(afterInventory.ui.value.kind).toBe("inventory");

    const stashLabel = loadJson("stash/frame.json");
    const stashFrame = await adapter.analyze({
      tickId: 3,
      capturedAtMs: 10_000,
      width: 64,
      height: 64,
      derived: stashLabel.derived,
    });
    const afterStash = estimator.estimate(afterInventory, stashFrame);
    expect(afterStash.stash.value.tabName).toBe("Currency");
    expect(afterStash.ui.value.kind).toBe("stash");
  });

  it("fills inventory-grid and stash-tab cells from labeled PNG fixtures", async () => {
    const clock = new FrozenClock(10_000);
    const adapter = createFixturePerceptionAdapter();
    const estimator = createStateEstimator({ clock, arming: createReplayArming() });

    const inventoryGrid = loadJson("inventory-grid/frame.json");
    const inventoryImage = await loadPng("inventory-grid/frame.png");
    const inventoryFrame = await adapter.analyze({
      tickId: 1,
      capturedAtMs: 10_000,
      width: inventoryImage.width,
      height: inventoryImage.height,
      pixels: inventoryImage.pixels,
      pngPath: "fixtures/perception/inventory-grid/frame.png",
      derived: inventoryGrid.derived,
    });
    const afterInventory = estimator.estimate(createEmptyWorldState({ clock }), inventoryFrame);
    expect(afterInventory.inventory.value.cells).toHaveLength(12);
    expect(afterInventory.inventory.value.occupied).toBe(3);
    expect(afterInventory.inventory.value.full).toBe(false);

    const stashGrid = loadJson("stash-tab/frame.json");
    const stashImage = await loadPng("stash-tab/frame.png");
    const stashFrame = await adapter.analyze({
      tickId: 2,
      capturedAtMs: 10_000,
      width: stashImage.width,
      height: stashImage.height,
      pixels: stashImage.pixels,
      pngPath: "fixtures/perception/stash-tab/frame.png",
      derived: stashGrid.derived,
    });
    const afterStash = estimator.estimate(afterInventory, stashFrame);
    expect(afterStash.stash.value.cells).toHaveLength(12);
    expect(afterStash.stash.value.cells.filter((cell) => cell.occupied)).toHaveLength(2);
    expect(afterStash.stash.value.tabName).toBe("Currency");
    expect(afterStash.stash.value.tabFull).toBe(false);
  });
});
