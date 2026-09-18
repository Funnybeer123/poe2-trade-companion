import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { readBmpBgr } from "../src/adapters/bmp.js";
import { bagArtMask, bagCursorLook, bagFootprintLook, bagProbeDelta, emptyBagCell, type BagView } from "../src/core/bagFastVision.js";
import type { BagPosition } from "../src/core/bagAssessment.js";
import { readBagJournal } from "../src/main/bagSessionStore.js";

const W = 1600, H = 900, grid = { x: 900, y: 500, w: 600, h: 250, cols: 12, rows: 5 };
const regionA = { x: 900, y: 200, w: 148, h: 248 }, regionB = { x: 1300, y: 200, w: 148, h: 248 };
// Backgrounds measured in the 2026-09-14 live frames (B, G, R).
const EMPTY = [5, 5, 5], NAVY = [27, 4, 4], RED = [3, 3, 41], OLIVE = [4, 55, 56], RED_ARMED = [8, 13, 43];
type Canvas = { data: Buffer };
const canvas = (): Canvas => {
  const data = Buffer.alloc(W * H * 3);
  // Static, textured panel artwork everywhere; bag cells start empty.
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data.fill(40 + (x * 7 + y * 13) % 60, (y * W + x) * 3, (y * W + x) * 3 + 3);
  for (let row = 0; row < 5; row++) for (let col = 0; col < 12; col++) fillCell({ data }, { row, col }, EMPTY);
  return { data };
};
const put = (c: Canvas, x: number, y: number, color: number[]) => { const i = (y * W + x) * 3; c.data[i] = color[0]!; c.data[i + 1] = color[1]!; c.data[i + 2] = color[2]!; };
function fillCell(c: Canvas, cell: BagPosition, color: number[]) {
  for (let y = 0; y < 50; y++) for (let x = 0; x < 50; x++) put(c, grid.x + cell.col * 50 + x, grid.y + cell.row * 50 + y, color);
}
/** Deterministic bright art with hard edges; `seed` changes the picture, `dark` makes a dim object. */
function art(c: Canvas, cells: BagPosition[], background: number[], seed: number, options: { dark?: boolean; count?: number } = {}) {
  for (const cell of cells) {
    fillCell(c, cell, background);
    for (let y = 8; y < 42; y++) for (let x = 8; x < 42; x++) {
      if ((x * 3 + y * 5 + seed * 7) % 11 > 3) continue;
      const level = options.dark ? 70 + (x + y + seed) % 30 : 205 + (x * seed + y) % 45;
      put(c, grid.x + cell.col * 50 + x, grid.y + cell.row * 50 + y, [level, Math.max(0, level - 20), Math.max(0, level - 35)]);
    }
  }
  if (options.count !== undefined) for (let y = 7; y < 17; y++) for (let x = 7; x < 20; x++)
    if ((x * 2 + y * options.count) % 5 === 0) put(c, grid.x + cells[0]!.col * 50 + x, grid.y + cells[0]!.row * 50 + y, [250, 250, 250]);
}
function sprite(c: Canvas, x0: number, y0: number, size = 24, seed = 3) {
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if ((x + y * seed) % 3) put(c, x0 + x, y0 + y, [180, 200, 220]);
}
let serial = 0;
function view(c: Canvas, pointer: { x: number; y: number }): BagView {
  const crop = (box: { x: number; y: number; w: number; h: number }) => {
    const data = Buffer.alloc(box.w * box.h * 3);
    for (let y = 0; y < box.h; y++) c.data.copy(data, y * box.w * 3, ((box.y + y) * W + box.x) * 3, ((box.y + y) * W + box.x + box.w) * 3);
    return { ...box, image: { width: box.w, height: box.h, data } };
  };
  return { at: "2026-09-14T12:00:00Z", evidence: "synthetic:" + serial++, pointer, parts: [crop(regionA), crop(regionB), crop(grid)] };
}
const A = { x: 974, y: 324 }, B = { x: 1374, y: 324 };

describe("fast bag pixel evidence", () => {
  it("separates empty cells from every tinted or occupied cell", () => {
    const c = canvas();
    art(c, [{ row: 0, col: 0 }], NAVY, 1); fillCell(c, { row: 0, col: 1 }, NAVY); fillCell(c, { row: 0, col: 2 }, RED);
    art(c, [{ row: 0, col: 3 }], EMPTY, 2, { dark: true });
    const v = view(c, B);
    expect(emptyBagCell(v, grid, { row: 4, col: 11 })).toBe(true);
    for (const col of [0, 1, 2, 3]) expect(emptyBagCell(v, grid, { row: 0, col })).toBe(false);
  });

  it("keeps item identity through armed-Wisdom and identification tints, and rejects wrong, swapped or departed art", () => {
    const c = canvas(), boots = [{ row: 1, col: 1 }, { row: 1, col: 2 }, { row: 2, col: 1 }, { row: 2, col: 2 }], ring = [{ row: 0, col: 5 }];
    art(c, boots, RED, 4); art(c, ring, RED, 5);
    const before = view(c, B), bootsMask = bagArtMask(before, grid, boots), ringMask = bagArtMask(before, grid, ring);
    expect(bootsMask.weak || ringMask.weak).toBe(false);
    const armed = canvas(); art(armed, boots, RED_ARMED, 4); art(armed, ring, NAVY, 5);
    expect(bagFootprintLook(view(armed, B), grid, bootsMask)).toBe("same");
    expect(bagFootprintLook(view(armed, B), grid, ringMask)).toBe("same");
    const wrong = canvas(); art(wrong, boots, RED, 9); art(wrong, ring, RED, 5);
    expect(bagFootprintLook(view(wrong, B), grid, bootsMask)).toBe("changed");
    const swapped = canvas(); art(swapped, boots, RED, 4); art(swapped, [{ row: 0, col: 5 }], RED, 6);
    expect(bagFootprintLook(view(swapped, B), grid, ringMask)).toBe("changed");
    const gone = canvas(); art(gone, ring, RED, 5);
    expect(bagFootprintLook(view(gone, B), grid, bootsMask)).toBe("empty");
    const partial = canvas(); art(partial, boots.slice(0, 3), RED, 4);
    expect(bagFootprintLook(view(partial, B), grid, bootsMask)).toBe("changed");
  });

  it("treats a changed stack count as a change unless the count corner is excluded for the Wisdom stack", () => {
    const c = canvas(), cell = [{ row: 0, col: 0 }]; art(c, cell, NAVY, 7, { count: 2 });
    const before = view(c, B), strict = bagArtMask(before, grid, cell), wisdom = bagArtMask(before, grid, cell, { excludeCount: true });
    const used = canvas(); art(used, cell, OLIVE, 7, { count: 5 });
    expect(bagFootprintLook(view(used, B), grid, strict)).toBe("changed");
    expect(bagFootprintLook(view(used, B), grid, wisdom)).toBe("same");
  });

  it("lets a dark featureless object prove only that it is still present", () => {
    const c = canvas(), cell = [{ row: 3, col: 3 }]; art(c, cell, NAVY, 2, { dark: true });
    const mask = bagArtMask(view(c, B), grid, cell);
    expect(mask.weak).toBe(true);
    expect(bagFootprintLook(view(c, B), grid, mask)).toBe("same");
    expect(bagFootprintLook(view(canvas(), B), grid, mask)).toBe("empty");
  });

  it("proves a clean cursor only from the run's own baseline with the pointer inside the probe", () => {
    const baseline = view(canvas(), B);
    expect(bagCursorLook(baseline, view(canvas(), A), regionA).look).toBe("clean");
    const held = canvas(); sprite(held, A.x - 12, A.y - 12);
    const occupied = bagCursorLook(baseline, view(held, A), regionA);
    expect(occupied.look).toBe("occupied");
    expect(occupied.delta.changed).toBeGreaterThan(120);
    // The pointer is elsewhere: region A says nothing about the cursor.
    expect(bagCursorLook(baseline, view(canvas(), B), regionA).look).toBe("unknown");
    // A change far from the pointer, or a few stray pixels, is neither clean nor a held payload.
    const stray = canvas(); sprite(stray, regionA.x + 2, regionA.y + 2, 20);
    expect(bagCursorLook(baseline, view(stray, A), regionA).look).toBe("unknown");
    const specks = canvas(); for (let i = 0; i < 30; i++) put(specks, A.x + i, A.y, [255, 255, 255]);
    expect(bagCursorLook(baseline, view(specks, A), regionA).look).toBe("unknown");
    expect(bagProbeDelta(baseline, view(held, A), regionB).changed).toBe(0);
  });

  it("throws rather than guessing when evidence does not cover the requested region", () => {
    const v = view(canvas(), B); v.parts.pop();
    expect(() => emptyBagCell(v, grid, { row: 0, col: 0 })).toThrow("does not cover");
  });
});

// Private 2026-09-14 live frames: before arming (00003) and both armed-Wisdom probe
// frames (00004 pointer at probe A, 00005 at probe B). Never committed; the replay runs
// wherever that evidence exists and documents the measured behaviour it depends on.
const evidence = path.join(process.env.APPDATA ?? "", "poe2-trade-companion", "artifacts", "map-triage", "live-authorized-20260914-08.jsonl.evidence");
const frame = (n: number) => path.join(evidence, `frame-09cb463b-e217-4ad5-a6e3-341a6847f3f4-0000${n}.bmp`);
describe.skipIf(![3, 4, 5].every(n => existsSync(frame(n))))("replay of the real armed-Wisdom frames", { timeout: 60000 }, () => {
  const live = { x: 2530, y: 1173, w: 1289, h: 541, cols: 12, rows: 5 }, probeA = { x: 2578, y: 659, w: 263, h: 481 }, probeB = { x: 3548, y: 659, w: 263, h: 481 };
  const load = (n: number): BagView => {
    const image = readBmpBgr(frame(n)), meta = JSON.parse(readFileSync(frame(n) + ".json", "utf8")) as { at: string; cursor: { clientX: number; clientY: number } };
    return { at: meta.at, evidence: frame(n), pointer: { x: meta.cursor.clientX, y: meta.cursor.clientY }, parts: [{ x: 0, y: 0, w: image.width, h: image.height, image }] };
  };
  it("sees every captured item intact under the pulsing armed tints and the software scroll only under the pointer", () => {
    const before = load(3), armedA = load(4), armedB = load(5);
    const empties: string[] = [];
    for (let row = 0; row < 5; row++) for (let col = 0; col < 12; col++) if (emptyBagCell(before, live, { row, col })) empties.push(row + "," + col);
    expect(empties).toEqual(["3,6", "4,6", "4,7"]);
    // Representative footprints from the verified capture: Wisdom, 1x1 amulet, 2x2 boots, 2x4 shield, 1x4 spear, 2x3 body armour.
    const rect = (row: number, col: number, w: number, h: number) => Array.from({ length: w * h }, (_, i) => ({ row: row + Math.floor(i / w), col: col + i % w }));
    for (const [cells, excludeCount] of [[rect(0, 0, 1, 1), true], [rect(0, 2, 1, 1), false], [rect(0, 5, 2, 2), false], [rect(0, 7, 2, 4), false],
      [rect(0, 9, 1, 4), false], [rect(0, 10, 2, 3), false], [rect(3, 10, 2, 2), false]] as const) {
      const mask = bagArtMask(before, live, cells, { excludeCount });
      expect(mask.weak).toBe(false);
      for (const armed of [armedA, armedB]) expect(bagFootprintLook(armed, live, mask)).toBe("same");
    }
    // Every one of the 30 captured physical items, stack-count corners included, survives both armed frames.
    const rows = readBagJournal(path.join(path.dirname(evidence), "live-authorized-20260914-08.jsonl"))[0]!.session.report.rows;
    expect(rows).toHaveLength(30);
    for (const row of rows) {
      const mask = bagArtMask(before, live, row.cells!, { excludeCount: row.row === 0 && row.col === 0 });
      for (const armed of [armedA, armedB]) expect(bagFootprintLook(armed, live, mask), row.name).toBe("same");
    }
    for (const armed of [armedA, armedB]) for (const key of empties) expect(emptyBagCell(armed, live, { row: Number(key[0]), col: Number(key[2]) })).toBe(true);
    expect(bagCursorLook(before, armedA, probeA).look).toBe("occupied");
    expect(bagCursorLook(before, armedB, probeB).look).toBe("occupied");
    expect(bagProbeDelta(before, armedA, probeB).changed).toBe(0);
    expect(bagProbeDelta(before, armedB, probeA).changed).toBe(0);
    // A mask from a different item never matches this footprint.
    const foreign = bagArtMask(before, live, rect(1, 3, 2, 2));
    foreign.cells = rect(3, 2, 2, 2);
    expect(bagFootprintLook(armedA, live, { ...foreign, count: new Int32Array(0), features: foreign.features.map((v, i) => i % 5 === 0 ? v - Math.round(live.w / 12) : i % 5 === 1 ? v + Math.round(2 * live.h / 5) : v) })).toBe("changed");
  });
});
