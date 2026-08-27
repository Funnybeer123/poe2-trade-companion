import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { bmpToGray } from "../src/adapters/bmp.js";
import { planFillMoves } from "../src/core/bagPack.js";
import { loadProfile } from "../src/core/calibrationStore.js";
import { diagnoseFillRun } from "../src/core/fillDiagnose.js";
import {
  cellLooksOccupied,
  cellLooksSearchLit,
  detectSpriteItems,
  occupiedFromScores,
  scoreGridCells,
  searchMatchedCells,
} from "../src/core/itemSprites.js";
import { fillRect } from "../src/core/grayImage.js";
import { perceiveUi } from "../src/core/uiPerception.js";
import { paintGridSprite, stashAndBagFrame, TEST_CLIENT } from "./perceptionFixtures.js";

const STASH = { x: 80, y: 144, w: 736, h: 630 };

describe("sprite item sizing", () => {
  it("reads each painted stash sprite as its own bag size", () => {
    const frame = stashAndBagFrame();
    paintGridSprite(frame, STASH, 12, 12, 0, 0, 2, 4);
    paintGridSprite(frame, STASH, 12, 12, 0, 3, 1, 3);
    paintGridSprite(frame, STASH, 12, 12, 0, 5, 2, 2);
    paintGridSprite(frame, STASH, 12, 12, 0, 8, 1, 1);
    paintGridSprite(frame, STASH, 12, 12, 0, 10, 1, 1);
    const items = detectSpriteItems(frame, TEST_CLIENT, STASH, 12, 12);
    const sizes = items.map((item) => `${item.w}x${item.h}`).sort();
    expect(sizes).toEqual(["1x1", "1x1", "1x3", "2x2", "2x4"]);
  });

  it("reads quad-stash sprites in inventory cells, not half-size 12x12 blocks", () => {
    const frame = stashAndBagFrame();
    const quad = { x: 80, y: 144, w: 736, h: 630 };
    paintGridSprite(frame, quad, 24, 24, 0, 0, 2, 4);
    paintGridSprite(frame, quad, 24, 24, 0, 3, 1, 1);
    paintGridSprite(frame, quad, 24, 24, 2, 3, 1, 1);
    const items = detectSpriteItems(frame, TEST_CLIENT, quad, 24, 24);
    const sizes = items.map((item) => `${item.w}x${item.h}`).sort();
    expect(sizes).toEqual(["1x1", "1x1", "2x4"]);
  });

  it("does not merge two 1x1 sprites that have an empty cell between them", () => {
    const frame = stashAndBagFrame();
    paintGridSprite(frame, STASH, 12, 12, 2, 0, 1, 1);
    paintGridSprite(frame, STASH, 12, 12, 2, 2, 1, 1);
    const items = detectSpriteItems(frame, TEST_CLIENT, STASH, 12, 12);
    expect(items.every((item) => item.w === 1 && item.h === 1)).toBe(true);
    expect(items.length).toBe(2);
  });

  it("records a failed fill so the next run must size items before dragging", () => {
    const frame = stashAndBagFrame();
    paintGridSprite(frame, STASH, 12, 12, 0, 0, 2, 4);
    const items = detectSpriteItems(frame, TEST_CLIENT, STASH, 12, 12);
    expect(items[0]).toMatchObject({ w: 2, h: 4 });
    const planned = planFillMoves([], [], { x: 1048, y: 324, w: 480, h: 450 }, 12, items);
    const diagnosis = diagnoseFillRun([], planned, [{ row: 0, col: 0, x: 0, y: 0 }]);
    expect(diagnosis.failures.some((failure) => failure.reason === "item-did-not-land")).toBe(true);
    expect(diagnosis.failures.some((failure) => failure.detail === "2x4@0,0")).toBe(true);
  });

  it("detects a thin 1x3 wand in the last bag column", () => {
    const bag = { x: 1048, y: 324, w: 480, h: 450 };
    const frame = stashAndBagFrame();
    const cellW = bag.w / 12;
    const cellH = bag.h / 5;
    for (let row = 0; row < 3; row += 1) {
      fillRect(
        frame,
        bag.x + 11 * cellW + cellW * 0.42,
        bag.y + row * cellH + 4,
        Math.max(3, cellW * 0.12),
        cellH - 8,
        160,
      );
    }
    const occupied = occupiedFromScores(scoreGridCells(frame, TEST_CLIENT, bag, 12, 5));
    expect(occupied.some((cell) => cell.col === 11 && cell.row <= 2)).toBe(true);
    expect(occupied.every((cell) => cell.col === 11)).toBe(true);
  });

  it("sees the leftover wand on the live empty-looking bag dump", () => {
    const bmp = path.resolve("fixtures/perception/live/deposit-1787705758242.bmp");
    if (!existsSync(bmp)) return;
    const facts = perceiveUi(
      bmpToGray(bmp),
      { left: 0, top: 0, width: 3840, height: 2160 },
      {},
      loadProfile(path.resolve("fixtures/perception/templates")),
    );
    expect(facts.occupiedBag.some((cell) => cell.col === 11 && cell.row <= 2)).toBe(true);
  });
});

describe("stash search highlight scores", () => {
  it("keeps bright leftovers and rejects dim leftovers", () => {
    expect(cellLooksSearchLit({ row: 0, col: 0, x: 0, y: 0, mean: 52, variance: 140, itemFrac: 0.42 })).toBe(true);
    expect(cellLooksOccupied({ row: 0, col: 0, x: 0, y: 0, mean: 24, variance: 80, itemFrac: 0.22 })).toBe(true);
    expect(cellLooksSearchLit({ row: 0, col: 0, x: 0, y: 0, mean: 24, variance: 80, itemFrac: 0.22 })).toBe(false);
  });

  it("uses before/after deltas to reject items dimmed by search", () => {
    const before = { width: 100, height: 20, pixels: new Uint8Array(100 * 20).fill(10) };
    fillRect(before, 2, 2, 16, 16, 120);
    fillRect(before, 42, 2, 16, 16, 120);
    const after = { ...before, pixels: new Uint8Array(before.pixels) };
    fillRect(after, 42, 2, 16, 16, 20);

    const matched = searchMatchedCells(
      before,
      after,
      { left: 0, top: 0, width: 100, height: 20 },
      { x: 0, y: 0, w: 100, h: 20 },
      5,
      1,
    );

    expect(matched.map((cell) => `${cell.row},${cell.col}`)).toEqual(["0,0"]);
  });
});
