import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bgrToGray } from "../src/adapters/bmp.js";
import { BaselineRuntime } from "../src/core/baselineRuntime.js";
import type { BgrImage } from "../src/core/cellOccupancy.js";
import { lookCalibrated, type UiFacts } from "../src/core/uiPerception.js";
import type { ScreenRect } from "../src/core/screenLayout.js";
import { fillRectBgr } from "../src/core/perceptionProbe.js";
import { busyWorldFrame, stashAndBagFrame, TEST_CLIENT } from "./perceptionFixtures.js";

const CLIENT: ScreenRect = { left: 0, top: 0, width: 480, height: 320 };
const BAG_REGION = { x: 120, y: 40, w: 240, h: 100 };
const COLS = 12;
const ROWS = 5;

function makeBgr(fill: [number, number, number] = [20, 20, 20]): BgrImage {
  const data = Buffer.alloc(CLIENT.width * CLIENT.height * 3);
  for (let i = 0; i < CLIENT.width * CLIENT.height; i += 1) {
    data[i * 3] = fill[0];
    data[i * 3 + 1] = fill[1];
    data[i * 3 + 2] = fill[2];
  }
  return { width: CLIENT.width, height: CLIENT.height, data };
}

function paintCell(image: BgrImage, row: number, col: number, bgr: [number, number, number]): void {
  const cellW = BAG_REGION.w / COLS;
  const cellH = BAG_REGION.h / ROWS;
  fillRectBgr(image, BAG_REGION.x + col * cellW, BAG_REGION.y + row * cellH, cellW, cellH, {
    b: bgr[0],
    g: bgr[1],
    r: bgr[2],
  });
}

function bagFacts(occupied: Array<{ row: number; col: number }>): UiFacts {
  return {
    optionsOpen: false,
    loading: false,
    stashPanelOpen: false,
    inventoryPanelOpen: true,
    vendorPanelOpen: false,
    stashChestVisible: false,
    inventoryRegion: { ...BAG_REGION },
    occupiedBag: occupied.map((cell) => ({ ...cell, x: 0, y: 0 })),
    occupiedStash: [],
    stashItems: [],
    bagEmpty: occupied.length === 0,
    confidence: 0.95,
    reason: "bag-open-stash-closed",
    scores: {
      sceneOpen: -1,
      sceneClosed: -1,
      stashPanel: 0,
      inventoryPanel: 1,
      chest: -1,
      options: -1,
      stashGrid: false,
      inventoryGrid: true,
    },
  };
}

describe("BaselineRuntime", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "baseline-runtime-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("learns agreed-empty cells and does not override before enough observations", () => {
    const runtime = new BaselineRuntime(dir);
    const empty = makeBgr();
    const frame = bgrToGray(empty);
    const first = runtime.refine(bagFacts([]), frame, empty, CLIENT);
    expect(first.adjustments[0]!.learned).toBe(COLS * ROWS);
    expect(first.adjustments[0]!.removed).toHaveLength(0);
    expect(first.adjustments[0]!.added).toHaveLength(0);
  });

  it("vetoes a false-occupied cell once its empty reference is established", () => {
    const runtime = new BaselineRuntime(dir);
    const empty = makeBgr();
    const frame = bgrToGray(empty);
    runtime.refine(bagFacts([]), frame, empty, CLIENT);
    runtime.refine(bagFacts([]), frame, empty, CLIENT);
    // Same pixels, but the primary classifier now claims (2,3) holds an item.
    const result = runtime.refine(bagFacts([{ row: 2, col: 3 }]), frame, empty, CLIENT);
    expect(result.adjustments[0]!.removed).toEqual([{ row: 2, col: 3 }]);
    expect(result.facts.occupiedBag).toHaveLength(0);
    expect(result.facts.bagEmpty).toBe(true);
  });

  it("flags a clearly changed cell the primary classifier missed", () => {
    const runtime = new BaselineRuntime(dir);
    const empty = makeBgr();
    const emptyFrame = bgrToGray(empty);
    runtime.refine(bagFacts([]), emptyFrame, empty, CLIENT);
    runtime.refine(bagFacts([]), emptyFrame, empty, CLIENT);
    const withItem = makeBgr();
    paintCell(withItem, 1, 4, [80, 80, 100]);
    const result = runtime.refine(bagFacts([]), bgrToGray(withItem), withItem, CLIENT);
    expect(result.adjustments[0]!.added).toEqual([{ row: 1, col: 4 }]);
    expect(result.facts.occupiedBag).toHaveLength(1);
    expect(result.facts.occupiedBag[0]).toMatchObject({ row: 1, col: 4 });
    expect(result.facts.bagEmpty).toBe(false);
  });

  it("persists learned models across runtime instances", () => {
    const empty = makeBgr();
    const frame = bgrToGray(empty);
    new BaselineRuntime(dir).refine(bagFacts([]), frame, empty, CLIENT);
    const second = new BaselineRuntime(dir);
    const result = second.refine(bagFacts([]), frame, empty, CLIENT);
    // Reloaded model plus this pass reaches the two-observation override bar.
    const third = second.refine(bagFacts([{ row: 0, col: 0 }]), frame, empty, CLIENT);
    expect(result.adjustments[0]!.learned).toBe(COLS * ROWS);
    expect(third.adjustments[0]!.removed).toEqual([{ row: 0, col: 0 }]);
  });

  it("returns facts unchanged when no color frame is available", () => {
    const runtime = new BaselineRuntime(dir);
    const facts = bagFacts([{ row: 0, col: 0 }]);
    const result = runtime.refine(facts, bgrToGray(makeBgr()), undefined, CLIENT);
    expect(result.facts).toBe(facts);
    expect(result.adjustments).toHaveLength(0);
  });
});

describe("gridLooksOpen overlay resilience", () => {
  const mismatchedPatch = { width: 24, height: 16, pixels: Array.from({ length: 24 * 16 }, (_, i) => (i * 37) % 251) };
  const profile = {
    version: 1 as const,
    client: { width: TEST_CLIENT.width, height: TEST_CLIENT.height },
    stashGrid: { x: 80, y: 144, w: 736, h: 630, cols: 12, rows: 12, patch: mismatchedPatch },
    npcs: [],
    updatedAt: new Date().toISOString(),
  };

  it("still detects a visible grid when the chrome patch no longer matches", () => {
    const facts = lookCalibrated(stashAndBagFrame([], []), TEST_CLIENT, profile);
    expect(facts.stashPanelOpen).toBe(true);
  });

  it("does not hallucinate a grid in a busy world scene", () => {
    const facts = lookCalibrated(busyWorldFrame(), TEST_CLIENT, profile);
    expect(facts.stashPanelOpen).toBe(false);
  });
});
