import { describe, expect, it } from "vitest";
import { decodeFlatRuns, DEFAULT_LOOT_CONFIG, findLootLabels, lootArea, LootPlanner, type FlatRun, type LootLabel } from "../src/core/followerLoot.js";

// SYNTHETIC runs. The label geometry and colours below were measured on two real 2560x1440 frames
// (an opaque orange label and a translucent dark-blue one), but these tests prove the rules, not game accuracy.
const VIEW = { width: 2560, height: 1440 }, CENTRE = { x: 1280, y: 700 };
const ORANGE = { r: 238, g: 180, b: 97 }, BLUE = { r: 45, g: 39, b: 71 }, BLACK = { r: 12, g: 8, b: 5 };
/** A filled label: `padding` flat rows, text rows with no full-width run, then `padding` flat rows. */
function label(x0: number, y: number, width: number, height: number, colour: { r: number; g: number; b: number }, padding = 10, jitter = 0): FlatRun[] {
  const runs: FlatRun[] = [];
  for (let row = 0; row < height; row++) {
    const wobble = jitter ? (row * 7) % (jitter + 1) : 0;
    if (row < padding || row >= height - padding) runs.push({ y: y + row, x0: x0 + wobble, x1: x0 + width - 1 - wobble, ...colour });
    // Text rows: only the short side paddings are flat, and they are too short to be reported at all.
  }
  return runs;
}
const solidBar = (x0: number, y: number, width: number, height: number, colour = ORANGE): FlatRun[] => Array.from({ length: height }, (_, row) => ({ y: y + row, x0, x1: x0 + width - 1, ...colour }));

describe("loot label detection (synthetic flat runs)", () => {
  it("finds an opaque label and a translucent one whose flat rows are clipped unevenly, nearest first", () => {
    const found = findLootLabels([...label(610, 156, 358, 59, ORANGE), ...label(1046, 634, 162, 51, BLUE, 5, 7)], VIEW, CENTRE);
    expect(found.map(l => l.centre)).toEqual([{ x: 1127, y: 659 }, { x: 789, y: 185 }]);
    expect(found[1]).toMatchObject({ rect: { x: 610, y: 156, width: 358, height: 59 }, colour: ORANGE, confidence: 1 });
    expect(found[0].confidence).toBeGreaterThanOrEqual(.92);
  });
  it("never reports dark labels: doors, area transitions, NPCs and unfiltered items all look like that", () => {
    expect(findLootLabels(label(1869, 437, 215, 52, BLACK), VIEW, CENTRE)).toEqual([]);
    expect(findLootLabels(label(1869, 437, 215, 52, { r: 44, g: 30, b: 20 }), VIEW, CENTRE)).toEqual([]);
  });
  it("rejects shapes that are not labels: solid bars, thin strips, tall blocks, squares, screen-wide bands, and bands without both paddings", () => {
    for (const runs of [solidBar(600, 300, 300, 60), label(600, 300, 300, 20, ORANGE, 4), label(600, 300, 300, 140, ORANGE), label(600, 300, 50, 60, ORANGE), label(300, 300, 1400, 60, ORANGE),
      label(600, 300, 300, 60, ORANGE).filter(r => r.y < 330), label(600, 300, 300, 60, ORANGE, 2)]) expect(findLootLabels(runs, VIEW, CENTRE)).toEqual([]);
  });
  it("does not join rows of different colours or different edges into one label", () => {
    const top = label(600, 300, 300, 60, ORANGE).filter(r => r.y < 310), bottomOtherColour = label(600, 300, 300, 60, { r: 120, g: 200, b: 90 }).filter(r => r.y >= 350), bottomShifted = label(640, 300, 300, 60, ORANGE).filter(r => r.y >= 350);
    expect(findLootLabels([...top, ...bottomOtherColour], VIEW, CENTRE)).toEqual([]);
    expect(findLootLabels([...top, ...bottomShifted], VIEW, CENTRE)).toEqual([]);
  });
  it("reports one label for overlapping bands of the same box, and keeps separate labels separate", () => {
    const outer = label(1046, 634, 162, 51, BLUE, 5), inner = label(1065, 639, 136, 42, { r: 44, g: 37, b: 71 }, 4);
    expect(findLootLabels([...outer, ...inner], VIEW, CENTRE)).toHaveLength(1);
    expect(findLootLabels([...label(600, 300, 300, 60, ORANGE), ...label(600, 380, 300, 60, ORANGE), ...label(1000, 300, 300, 60, ORANGE)], VIEW, CENTRE)).toHaveLength(3);
  });
  it("scales its size limits with the view", () => {
    const small = { width: 1920, height: 1080 };
    expect(findLootLabels(label(500, 200, 270, 46, ORANGE, 8), small, { x: 960, y: 525 })).toHaveLength(1);
    expect(findLootLabels(label(500, 200, 270, 90, ORANGE, 8), small, { x: 960, y: 525 })).toEqual([]);
  });
  it("keeps the loot area clear of the HUD, party frames and quest tracker, matching the input worker's rectangle", () => {
    expect(lootArea(VIEW)).toEqual({ x: 256, y: 72, width: 1792, height: 1080 });
    expect(lootArea({ width: 1920, height: 1080 })).toEqual({ x: 192, y: 54, width: 1344, height: 810 });
  });
  it("decodes the capture worker's 9-byte runs and rejects malformed data", () => {
    const bytes = Buffer.alloc(18); bytes.writeUInt16LE(505, 0); bytes.writeUInt16LE(1020, 2); bytes.writeUInt16LE(1119, 4); bytes.set([238, 180, 97], 6); bytes.writeUInt16LE(506, 9); bytes.writeUInt16LE(7, 11); bytes.writeUInt16LE(99, 13); bytes.set([1, 2, 3], 15);
    expect(decodeFlatRuns(bytes.toString("base64"))).toEqual([{ y: 505, x0: 1020, x1: 1119, r: 238, g: 180, b: 97 }, { y: 506, x0: 7, x1: 99, r: 1, g: 2, b: 3 }]);
    expect(decodeFlatRuns("")).toEqual([]);
    expect(() => decodeFlatRuns(Buffer.alloc(10).toString("base64"))).toThrow("malformed");
    expect(() => decodeFlatRuns(undefined)).toThrow("no label runs");
  });
});

describe("loot planner (synthetic labels)", () => {
  const one = (x = 900, y = 500): LootLabel => ({ rect: { x: x - 100, y: y - 30, width: 200, height: 60 }, centre: { x, y }, colour: ORANGE, confidence: 1 });
  it("clicks the nearest label at once, then leaves the character alone to walk there", () => {
    const planner = new LootPlanner(), labels = [one(900, 500), one(1500, 300)];
    expect(planner.decide(labels, 1000)).toMatchObject({ kind: "loot", label: { centre: { x: 900, y: 500 } } });
    expect(planner.busy(1000)).toBe(false);
    planner.committed(labels.length, 1000);
    expect(planner.busy(1000 + DEFAULT_LOOT_CONFIG.clickIntervalMs - 1)).toBe(true);
    expect(planner.decide(labels, 1200)).toMatchObject({ kind: "idle", reason: "Walking to the last loot click." });
    expect(planner.decide(labels, 1000 + DEFAULT_LOOT_CONFIG.clickIntervalMs).kind).toBe("loot");
  });
  it("does not count a click that was refused: only committed clicks pace or back off", () => {
    const planner = new LootPlanner(), labels = [one()];
    for (let i = 0; i < 20; i++) expect(planner.decide(labels, i * 10).kind).toBe("loot");
  });
  it("backs off after clicks that never reduce the labels, and tries again later", () => {
    const planner = new LootPlanner({ clickIntervalMs: 100, maxAttempts: 3, backoffMs: 5000 }), labels = [one(), one(1400, 600)];
    let now = 0;
    for (let i = 0; i < 3; i++) { expect(planner.decide(labels, now).kind).toBe("loot"); planner.committed(labels.length, now); now += 100; }
    expect(planner.decide(labels, now)).toMatchObject({ kind: "backoff", reason: expect.stringContaining("inventory full or out of reach") });
    expect(planner.decide(labels, now + 4999).kind).toBe("backoff");
    expect(planner.decide(labels, now + 5000).kind).toBe("loot");
  });
  it("keeps going while pickups succeed: fewer labels after a click resets the count", () => {
    const planner = new LootPlanner({ clickIntervalMs: 100, maxAttempts: 2, backoffMs: 5000 });
    let labels = [one(900, 500), one(1000, 520), one(1100, 540), one(1200, 560)], now = 0;
    for (let picked = 0; picked < 4; picked++) {
      expect(planner.decide(labels, now).kind).toBe("loot");
      planner.committed(labels.length, now); now += 100; labels = labels.slice(1);
    }
    expect(planner.decide(labels, now)).toMatchObject({ kind: "idle", reason: "No loot labels in view." });
  });
});
