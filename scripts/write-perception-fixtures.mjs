#!/usr/bin/env node
import { Buffer } from "node:buffer";
import { deflateSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const payload = Buffer.concat([typeBytes, Buffer.from(data)]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(payload));
  return Buffer.concat([length, payload, crc]);
}

function encodeRgbaPng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const dest = y * (width * 4 + 1);
    raw[dest] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), dest + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array()),
  ]);
}

function fill(pixels, width, x, y, w, h, rgba) {
  for (let row = y; row < y + h; row += 1) {
    for (let col = x; col < x + w; col += 1) {
      const offset = (row * width + col) * 4;
      pixels[offset] = rgba[0];
      pixels[offset + 1] = rgba[1];
      pixels[offset + 2] = rgba[2];
      pixels[offset + 3] = rgba[3];
    }
  }
}

function createRgba(width, height, color) {
  const pixels = new Uint8Array(width * height * 4);
  fill(pixels, width, 0, 0, width, height, color);
  return pixels;
}

function crop(pixels, width, x, y, w, h) {
  const out = new Uint8Array(w * h * 4);
  for (let row = 0; row < h; row += 1) {
    const src = ((y + row) * width + x) * 4;
    out.set(pixels.subarray(src, src + w * 4), row * w * 4);
  }
  return out;
}

const BG = [16, 16, 20, 255];
const CYAN = [0, 220, 220, 255];
const GOLD = [220, 180, 40, 255];
const MAGENTA = [200, 40, 200, 255];
const BLUE = [40, 80, 200, 255];
const EMPTY = [40, 40, 50, 255];
const ORANGE = [220, 100, 20, 255];

const root = path.join(process.cwd(), "fixtures/perception");

async function writePair(dir, name, width, height, pixels, meta) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${name}.png`), encodeRgbaPng(width, height, pixels));
  await writeFile(path.join(dir, `${name}.json`), `${JSON.stringify(meta, null, 2)}\n`);
}

const targetBox = { x: 20, y: 16, w: 24, h: 24 };
const target = createRgba(64, 64, BG);
fill(target, 64, targetBox.x, targetBox.y, targetBox.w, targetBox.h, CYAN);
await writePair(path.join(root, "target-cue"), "frame", 64, 64, target, {
  kind: "target-cue",
  box: targetBox,
  expectedTargetCount: 1,
  derived: {
    target: {
      value: { identity: "qa-target", screenPoint: { x: 32, y: 28 }, boundingBox: targetBox },
      confidence: 0.94,
      observedAtMs: 10_000,
      freshness: "fresh",
    },
    ui: {
      value: { kind: "gameplay" },
      confidence: 0.8,
      observedAtMs: 10_000,
      freshness: "fresh",
    },
  },
});
await writePair(
  path.join(root, "target-cue"),
  "template",
  targetBox.w,
  targetBox.h,
  crop(target, 64, targetBox.x, targetBox.y, targetBox.w, targetBox.h),
  { kind: "template", of: "target-cue" },
);

const lootBox = { x: 10, y: 44, w: 36, h: 12 };
const loot = createRgba(64, 64, BG);
fill(loot, 64, lootBox.x, lootBox.y, lootBox.w, lootBox.h, GOLD);
await writePair(path.join(root, "loot-label"), "frame", 64, 64, loot, {
  kind: "loot-label",
  box: lootBox,
  expectedLootCount: 1,
  derived: {
    loot: {
      value: [
        {
          id: "loot-1",
          labelText: "Exalted Orb",
          screenPoint: { x: 28, y: 50 },
          boundingBox: lootBox,
          score: 70,
        },
      ],
      confidence: 0.88,
      observedAtMs: 10_000,
      freshness: "fresh",
    },
  },
});
await writePair(
  path.join(root, "loot-label"),
  "template",
  lootBox.w,
  lootBox.h,
  crop(loot, 64, lootBox.x, lootBox.y, lootBox.w, lootBox.h),
  { kind: "template", of: "loot-label" },
);

const inventory = createRgba(64, 64, BG);
const occupiedCells = [
  [0, 0],
  [1, 1],
  [3, 2],
];
for (let gy = 0; gy < 3; gy += 1) {
  for (let gx = 0; gx < 4; gx += 1) {
    const x = 8 + gx * 14;
    const y = 8 + gy * 14;
    const occupied = occupiedCells.some(([cx, cy]) => cx === gx && cy === gy);
    fill(inventory, 64, x, y, 12, 12, occupied ? MAGENTA : EMPTY);
  }
}
await writePair(path.join(root, "inventory"), "frame", 64, 64, inventory, {
  kind: "inventory",
  expectedOccupied: 3,
  expectedCapacity: 12,
  derived: {
    inventory: {
      value: { occupied: 3, capacity: 12, cells: [], full: false },
      confidence: 0.9,
      observedAtMs: 10_000,
      freshness: "fresh",
    },
    ui: {
      value: { kind: "inventory" },
      confidence: 0.85,
      observedAtMs: 10_000,
      freshness: "fresh",
    },
  },
});

const stash = createRgba(64, 64, BG);
const stashOccupied = [
  [0, 0],
  [2, 1],
];
for (let gy = 0; gy < 3; gy += 1) {
  for (let gx = 0; gx < 4; gx += 1) {
    const x = 8 + gx * 14;
    const y = 8 + gy * 14;
    const occupied = stashOccupied.some(([cx, cy]) => cx === gx && cy === gy);
    fill(stash, 64, x, y, 12, 12, occupied ? BLUE : EMPTY);
  }
}
await writePair(path.join(root, "stash"), "frame", 64, 64, stash, {
  kind: "stash",
  expectedOccupied: 2,
  derived: {
    stash: {
      value: { tabId: "1", tabName: "Currency", cells: [], tabFull: false },
      confidence: 0.87,
      observedAtMs: 10_000,
      freshness: "fresh",
    },
    ui: {
      value: { kind: "stash" },
      confidence: 0.85,
      observedAtMs: 10_000,
      freshness: "fresh",
    },
  },
});

const inventoryUi = createRgba(64, 64, BG);
fill(inventoryUi, 64, 0, 0, 64, 8, ORANGE);
await writePair(path.join(root, "ui-mode"), "inventory", 64, 64, inventoryUi, {
  kind: "ui-mode",
  expectedKind: "inventory",
  header: { x: 0, y: 0, w: 64, h: 8 },
  derived: {
    ui: {
      value: { kind: "inventory" },
      confidence: 0.91,
      observedAtMs: 10_000,
      freshness: "fresh",
    },
  },
});
await writePair(path.join(root, "ui-mode"), "gameplay", 64, 64, createRgba(64, 64, BG), {
  kind: "ui-mode",
  expectedKind: "gameplay",
  derived: {
    ui: {
      value: { kind: "gameplay" },
      confidence: 0.8,
      observedAtMs: 10_000,
      freshness: "fresh",
    },
  },
});
await writePair(
  path.join(root, "ui-mode"),
  "header-template",
  64,
  8,
  crop(inventoryUi, 64, 0, 0, 64, 8),
  { kind: "template", of: "ui-mode-inventory-header" },
);

console.log("Wrote fixtures/perception/* PNG + JSON labels");
