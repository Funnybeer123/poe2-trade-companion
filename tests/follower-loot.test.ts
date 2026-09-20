import { describe, expect, it } from "vitest";
import { decodeFlatRuns, decodeHueRuns, DEFAULT_LOOT_CONFIG, findLootLabels, hueClass, LOOT_MIN_CONFIDENCE, lootArea, LootPlanner, type FlatRun, type HueRun, type LootLabel } from "../src/core/followerLoot.js";

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
  it("rejects a dark label lifted by a bright neutral backdrop, but keeps dim coloured fills and bright neutral ones", () => {
    for (const grey of [{ r: 50, g: 46, b: 42 }, { r: 60, g: 58, b: 55 }, { r: 109, g: 100, b: 95 }]) expect(findLootLabels(label(1869, 437, 215, 52, grey), VIEW, CENTRE)).toEqual([]);
    for (const fill of [BLUE, { r: 70, g: 30, b: 28 }, { r: 250, g: 250, b: 250 }, { r: 110, g: 104, b: 100 }]) expect(findLootLabels(label(1869, 437, 215, 52, fill), VIEW, CENTRE)).toHaveLength(1);
  });
  it("clicks a real label, not the gap, when two neighbouring labels are joined into one", () => {
    const inside = (x: number, spans: Array<[number, number]>) => spans.some(([x0, x1]) => x >= x0 && x <= x1);
    const equal = findLootLabels([...label(600, 300, 300, 59, ORANGE), ...label(905, 300, 300, 59, ORANGE)], VIEW, CENTRE);
    expect(equal).toHaveLength(1);
    expect(equal[0].centre).toEqual({ x: 750, y: 329 });
    const nearEqual = findLootLabels([...label(600, 300, 300, 59, ORANGE), ...label(930, 300, 320, 59, ORANGE)], VIEW, CENTRE);
    expect(nearEqual).toHaveLength(1);
    expect(inside(nearEqual[0].centre.x, [[600, 899], [930, 1249]])).toBe(true);
  });
  it("keeps the midpoint of a label a beam cuts on a few rows, and moves onto a real piece when every row is cut there", () => {
    const cut = (rows: (y: number) => boolean) => label(600, 300, 300, 59, ORANGE).flatMap(r => rows(r.y) ? [{ ...r, x1: 740 }, { ...r, x0: 760 }] : [r]);
    expect(findLootLabels(cut(y => y > 350), VIEW, CENTRE)[0].centre.x).toBe(750);
    expect(findLootLabels(cut(() => true), VIEW, CENTRE)[0]).toMatchObject({ rect: { x: 600, width: 300 }, centre: { x: 670 } });
  });
  it("returns only labels that pass the loot confidence gate, whatever the leader-label preference is", () => {
    expect(LOOT_MIN_CONFIDENCE).toBe(.85);
    const weakest = [...findLootLabels(label(600, 300, 300, 60, ORANGE, 3), VIEW, CENTRE), ...findLootLabels([], VIEW, CENTRE, hueBlock(600, 300, 300, 61, 3, row => row % 2 === 0))];
    expect(weakest.map(l => l.confidence)).toEqual([.92, .89]);
    for (const found of weakest) expect(found.confidence).toBeGreaterThanOrEqual(LOOT_MIN_CONFIDENCE);
  });
});

/** Rows of one hue class with the same edges; `keep` drops rows that text or scenery broke up. */
function hueBlock(x0: number, y: number, width: number, height: number, hue = 3, keep: (row: number) => boolean = () => true): HueRun[] {
  return Array.from({ length: height }, (_, row) => row).filter(keep).map(row => ({ y: y + row, x0, x1: x0 + width - 1, hue }));
}

describe("loot label detection (synthetic hue runs)", () => {
  const find = (runs: HueRun[]) => findLootLabels([], VIEW, CENTRE, runs);
  it("finds a label of the measured geometry: 61 of 63 rows of one hue, never with full confidence", () => {
    expect(find(hueBlock(1100, 500, 260, 63, 3, row => row !== 20 && row !== 41))).toEqual([{ rect: { x: 1100, y: 500, width: 260, height: 63 }, centre: { x: 1230, y: 531 }, colour: { r: 0, g: 0, b: 0 }, hue: 3, confidence: .95 }]);
    expect(find(hueBlock(600, 300, 300, 60))[0].confidence).toBe(.95);
  });
  it("rejects a tall block whole instead of reporting its remainder", () => {
    expect(find(hueBlock(600, 300, 300, 250))).toEqual([]);
    expect(find(hueBlock(600, 300, 300, 250, 3, row => row % 4 !== 3))).toEqual([]);
  });
  it("rejects thin strips, squares, screen-wide bands, sparse rows, and blocks on the first or last scanned row", () => {
    const area = lootArea(VIEW), lastRow = area.y + area.height - 1;
    for (const runs of [hueBlock(600, 300, 300, 20), hueBlock(600, 300, 60, 60), hueBlock(300, 300, 1100, 60), hueBlock(600, 300, 300, 60, 3, row => row % 3 === 0),
      hueBlock(600, area.y, 300, 60), hueBlock(600, lastRow - 59, 300, 60)]) expect(find(runs)).toEqual([]);
    expect(find(hueBlock(600, area.y + 1, 300, 60))).toHaveLength(1);
    expect(find(hueBlock(600, lastRow - 60, 300, 60))).toHaveLength(1);
  });
  it("does not join rows of another hue, shifted edges, or rows too far apart", () => {
    expect(find([...hueBlock(600, 300, 300, 30, 3), ...hueBlock(600, 330, 300, 30, 5)])).toEqual([]);
    expect(find([...hueBlock(600, 300, 300, 30, 3), ...hueBlock(640, 330, 300, 30, 3)])).toEqual([]);
    expect(find([...hueBlock(600, 300, 300, 30, 3), ...hueBlock(600, 335, 300, 30, 3)])).toEqual([]);
    expect(find(hueBlock(600, 300, 300, 60, 0))).toEqual([]);
  });
  it("clicks a real label, not the gap, when two neighbouring labels of one hue are joined", () => {
    const equal = find([...hueBlock(600, 300, 300, 60), ...hueBlock(905, 300, 300, 60)]);
    expect(equal).toHaveLength(1);
    expect(equal[0].centre.x).toBe(750);
    const nearEqual = find([...hueBlock(600, 300, 300, 60), ...hueBlock(930, 300, 320, 60)]);
    expect(nearEqual).toHaveLength(1);
    expect(nearEqual[0].centre.x).toBe(1090);
  });
  it("decodes the capture worker's 7-byte hue runs and rejects malformed data", () => {
    const bytes = Buffer.alloc(14); bytes.writeUInt16LE(505, 0); bytes.writeUInt16LE(1020, 2); bytes.writeUInt16LE(1119, 4); bytes[6] = 3; bytes.writeUInt16LE(506, 7); bytes.writeUInt16LE(7, 9); bytes.writeUInt16LE(99, 11); bytes[13] = 12;
    expect(decodeHueRuns(bytes.toString("base64"))).toEqual([{ y: 505, x0: 1020, x1: 1119, hue: 3 }, { y: 506, x0: 7, x1: 99, hue: 12 }]);
    expect(decodeHueRuns("")).toEqual([]);
    expect(() => decodeHueRuns(Buffer.alloc(8).toString("base64"))).toThrow("malformed");
    expect(() => decodeHueRuns(undefined)).toThrow("no hue runs");
  });
  it("classifies hue with the capture worker's integer arithmetic (parity table for HueClass in win-follower-host.ps1)", () => {
    // Expected values are C#: quotient truncated towards zero before the 120/240 offset. The last four differ from truncating the sum, or sit on a negative hue.
    const table: Record<string, number> = { "213,213,2": 3, "237,212,75": 3, "76,72,16": 3, "238,180,97": 2, "30,17,66": 10, "130,99,77": 0, "12,8,5": 0, "250,250,250": 0, "60,56,79": 0,
      "126,200,100": 5, "100,126,200": 9, "200,100,126": 1, "200,100,130": 12 };
    for (const [rgb, expected] of Object.entries(table)) { const [r, g, b] = rgb.split(",").map(Number); expect(hueClass(r, g, b), rgb).toBe(expected); }
  });
});

describe("loot planner (synthetic labels)", () => {
  const one = (x = 900, y = 500): LootLabel => ({ rect: { x: x - 100, y: y - 30, width: 200, height: 60 }, centre: { x, y }, colour: ORANGE, confidence: 1 });
  it("clicks the nearest label at once, then leaves the character alone to walk there", () => {
    const planner = new LootPlanner(), labels = [one(900, 500), one(1500, 300)];
    expect(planner.decide(labels, 1000)).toMatchObject({ kind: "loot", label: { centre: { x: 900, y: 500 } } });
    expect(planner.busy(1000)).toBe(false);
    planner.committed(1000, labels[0].centre);
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
    for (let i = 0; i < 3; i++) { expect(planner.decide(labels, now).kind).toBe("loot"); planner.committed(now, labels[0].centre); now += 100; }
    expect(planner.decide(labels, now)).toMatchObject({ kind: "backoff", reason: expect.stringContaining("inventory full or out of reach") });
    expect(planner.decide(labels, now + 4999).kind).toBe("backoff");
    expect(planner.decide(labels, now + 5000).kind).toBe("loot");
  });
  it("keeps going while pickups succeed: the CLICKED label leaving the ground resets the count", () => {
    const planner = new LootPlanner({ clickIntervalMs: 100, maxAttempts: 2, backoffMs: 5000 });
    // Spaced well beyond SAME_LABEL_PX (120), so each is unambiguously a different label.
    let labels = [one(900, 500), one(1300, 520), one(1700, 540), one(2100, 560)], now = 0;
    for (let picked = 0; picked < 4; picked++) {
      expect(planner.decide(labels, now).kind).toBe("loot");
      planner.committed(now, labels[0].centre); now += 100; labels = labels.slice(1);
      // The first scan with fewer labels could be a missed detection: no click until the next one agrees.
      if (labels.length) { expect(planner.decide(labels, now)).toMatchObject({ kind: "idle", label: labels[0], reason: "Confirming a pickup." }); now += 100; }
    }
    expect(planner.decide(labels, now)).toMatchObject({ kind: "idle", reason: "No loot labels in view." });
  });
  /** Scans every 100 ms with the given label counts, committing every loot decision; returns the decision kinds. */
  const run = (planner: LootPlanner, counts: number[], start = 0): string[] => counts.map((count, i) => {
    const labels = Array.from({ length: count }, (_, n) => one(900 + n * 400, 500)), kind = planner.decide(labels, start + i * 100).kind;
    if (kind === "loot") planner.committed(start + i * 100, labels[0].centre);
    return kind;
  });
  it("still backs off when detection flickers: a single empty or lower scan is not a pickup", () => {
    const config = { clickIntervalMs: 100, maxAttempts: 3, backoffMs: 5000 };
    expect(run(new LootPlanner(config), [1, 1, 0, 1, 1, 1, 0, 1, 1])).toEqual(["loot", "loot", "idle", "loot", "backoff", "backoff", "idle", "backoff", "backoff"]);
    // Other labels coming and going is NOT a pickup: the clicked one (labels[0]) never leaves, so the
    // streak runs to maxAttempts instead of being reset by every dip in the total. Live, that reset is why
    // 65 clicks went into 28 labels that never moved and the backoff never once engaged.
    expect(run(new LootPlanner(config), [3, 2, 3, 2, 3, 2, 3])).toEqual(["loot", "loot", "loot", "backoff", "backoff", "backoff", "backoff"]);
    expect(run(new LootPlanner(config), [1, 0, 1, 0, 1, 0, 1])).toEqual(["loot", "idle", "loot", "idle", "loot", "idle", "backoff"]);
  });
  it("keeps the streak across an empty view: walking past nothing is not evidence the bag has room", () => {
    const config = { clickIntervalMs: 100, maxAttempts: 2, backoffMs: 5000 };
    // An empty view only forgets WHICH label was clicked, because we may simply have walked away from it.
    // It is not a pickup, so the streak survives and the backoff still arrives. Clearing it here was the
    // second false reset: with a full bag, every gap between items wiped the evidence.
    expect(run(new LootPlanner(config), [1, 1, 0, 0, 1, 1, 1])).toEqual(["loot", "loot", "idle", "idle", "backoff", "backoff", "backoff"]);
    expect(run(new LootPlanner(config), [3, 3, 2, 2, 2, 2])).toEqual(["loot", "loot", "backoff", "backoff", "backoff", "backoff"]);
  });
  it("doubles the backoff each time until a pickup or an empty view, up to sixteen times", () => {
    const planner = new LootPlanner({ clickIntervalMs: 100, maxAttempts: 1, backoffMs: 1000 }), labels = [one()];
    let now = 0;
    for (const wait of [1000, 2000, 4000, 8000, 16000, 16000]) {
      expect(planner.decide(labels, now).kind).toBe("loot"); planner.committed(now, labels[0].centre); now += 100;
      expect(planner.decide(labels, now).kind).toBe("backoff");
      expect(planner.decide(labels, now + wait - 1).kind).toBe("backoff");
      now += wait;
    }
    expect(planner.decide([], now).kind).toBe("idle"); expect(planner.decide([], now + 100).kind).toBe("idle"); now += 200;
    expect(planner.decide(labels, now).kind).toBe("loot"); planner.committed(now, labels[0].centre); now += 100;
    expect(planner.decide(labels, now).kind).toBe("backoff");
    // Still the full 16 s: an empty view forgets the clicked label, not how many times looting has failed.
    expect(planner.decide(labels, now + 1000).kind).toBe("backoff");
    expect(planner.decide(labels, now + 16000).kind).toBe("loot");
  });
});
