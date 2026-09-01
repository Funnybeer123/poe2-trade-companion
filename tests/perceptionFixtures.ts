import { crop, createGray, downsample, fillRect, type GrayImage } from "../src/core/grayImage.js";
import type { ScreenRect } from "../src/core/screenLayout.js";
import type { PerceptionTemplates } from "../src/core/uiPerception.js";

export const TEST_CLIENT: ScreenRect = { left: 0, top: 0, width: 1600, height: 900 };

export function checker(image: GrayImage, x: number, y: number, w: number, h: number, a = 30, b = 90): void {
  const cell = 40;
  for (let yy = 0; yy < h; yy += cell) {
    for (let xx = 0; xx < w; xx += cell) {
      fillRect(image, x + xx, y + yy, cell, cell, ((xx + yy) / cell) % 2 === 0 ? a : b);
    }
  }
}

export function optionsFrame(): GrayImage {
  const image = createGray(1600, 900, 12);
  checker(image, 620, 180, 360, 480, 40, 160);
  fillRect(image, 680, 200, 240, 80, 200);
  return image;
}

export function worldChestFrame(): GrayImage {
  const image = createGray(1600, 900, 8);
  fillRect(image, 740, 480, 120, 90, 170);
  return image;
}

/** Hideout-like scenery: busy left and right, no UI chrome. Must never look like stash/bag. */
export function busyWorldFrame(): GrayImage {
  const image = createGray(1600, 900, 22);
  const blobs = [
    [40, 80, 220, 160, 70],
    [310, 40, 180, 240, 110],
    [520, 200, 260, 90, 55],
    [90, 400, 140, 300, 95],
    [400, 520, 300, 180, 40],
    [980, 60, 240, 200, 80],
    [1280, 180, 200, 140, 130],
    [1100, 420, 180, 260, 48],
    [1400, 500, 150, 220, 88],
    [860, 300, 90, 400, 35],
  ] as const;
  for (const [x, y, w, h, value] of blobs) fillRect(image, x, y, w, h, value);
  return image;
}

export function hudTemplates(): PerceptionTemplates {
  const view = downsample(stashAndBagFrame([]), 160, 90);
  const empty = crop(view, 112, 38, 8, 8);
  return {
    sceneOpen: view,
    stashPanel: crop(view, 6, 14, 46, 64),
    inventoryPanel: crop(view, 102, 30, 50, 50),
    emptyCell: empty,
  };
}

export function chestTemplates(): PerceptionTemplates {
  const view = downsample(worldChestFrame(), 160, 90);
  return { chest: crop(view, 70, 45, 24, 18), sceneClosed: view };
}

export function stashAndBagFrame(
  occupied: Array<{ row: number; col: number }> = [],
  stashOccupied: Array<{ row: number; col: number }> = [],
): GrayImage {
  const image = createGray(1600, 900, 10);
  const stashX = 80;
  const stashY = 144;
  const stashW = 736;
  const stashH = 630;
  checker(image, stashX, stashY, stashW, stashH, 25, 110);
  const stashCellW = stashW / 12;
  const stashCellH = stashH / 12;
  for (let row = 0; row < 12; row += 1) {
    for (let col = 0; col < 12; col += 1) {
      fillRect(
        image,
        stashX + col * stashCellW + 3,
        stashY + row * stashCellH + 3,
        stashCellW - 6,
        stashCellH - 6,
        16,
      );
    }
  }
  for (const cell of stashOccupied) {
    fillRect(
      image,
      stashX + cell.col * stashCellW + 6,
      stashY + cell.row * stashCellH + 6,
      stashCellW - 12,
      stashCellH - 12,
      210,
    );
  }
  const invX = 1048;
  const invY = 324;
  const invW = 480;
  const invH = 450;
  checker(image, invX, invY, invW, invH, 20, 70);
  const cellW = invW / 12;
  const cellH = invH / 5;
  for (let row = 0; row < 5; row += 1) {
    for (let col = 0; col < 12; col += 1) {
      fillRect(image, invX + col * cellW + 4, invY + row * cellH + 4, cellW - 8, cellH - 8, 14);
    }
  }
  for (const cell of occupied) {
    fillRect(
      image,
      invX + cell.col * cellW + 6,
      invY + cell.row * cellH + 6,
      cellW - 12,
      cellH - 12,
      210,
    );
  }
  return image;
}

export function quadStashAndBagFrame(
  occupied: Array<{ row: number; col: number }> = [],
  stashOccupied: Array<{ row: number; col: number }> = [],
): GrayImage {
  const image = createGray(1600, 900, 10);
  const stashX = 80;
  const stashY = 144;
  const stashW = 736;
  const stashH = 630;
  checker(image, stashX, stashY, stashW, stashH, 25, 110);
  const stashCellW = stashW / 24;
  const stashCellH = stashH / 24;
  for (let row = 0; row < 24; row += 1) {
    for (let col = 0; col < 24; col += 1) {
      fillRect(
        image,
        stashX + col * stashCellW + 1,
        stashY + row * stashCellH + 1,
        stashCellW - 2,
        stashCellH - 2,
        16,
      );
    }
  }
  for (const cell of stashOccupied) {
    fillRect(
      image,
      stashX + cell.col * stashCellW + 2,
      stashY + cell.row * stashCellH + 2,
      stashCellW - 4,
      stashCellH - 4,
      210,
    );
  }
  const invX = 1048;
  const invY = 324;
  const invW = 480;
  const invH = 450;
  checker(image, invX, invY, invW, invH, 20, 70);
  const cellW = invW / 12;
  const cellH = invH / 5;
  for (let row = 0; row < 5; row += 1) {
    for (let col = 0; col < 12; col += 1) {
      fillRect(image, invX + col * cellW + 4, invY + row * cellH + 4, cellW - 8, cellH - 8, 14);
    }
  }
  for (const cell of occupied) {
    fillRect(
      image,
      invX + cell.col * cellW + 6,
      invY + cell.row * cellH + 6,
      cellW - 12,
      cellH - 12,
      210,
    );
  }
  return image;
}

export function paintGridSprite(
  image: GrayImage,
  box: { x: number; y: number; w: number; h: number },
  cols: number,
  rows: number,
  row: number,
  col: number,
  w: number,
  h: number,
  value = 210,
): void {
  const cellW = box.w / cols;
  const cellH = box.h / rows;
  fillRect(image, box.x + col * cellW + 5, box.y + row * cellH + 5, cellW * w - 10, cellH * h - 10, value);
}
