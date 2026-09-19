import { describe, expect, it } from "vitest";
import { DROP_MAX_TRACKS, DropWatch, type DropCounts, type DropVerdict } from "../src/core/followerDrops.js";
import { lootArea, type LootLabel } from "../src/core/followerLoot.js";
import type { KeyPoint } from "../src/core/followerMapMarker.js";
import type { PixelRect } from "../src/core/followerPerception.js";

// SIMULATED world. Named things stand at fixed world places while a camera pans over them, and each scan
// reports what the label detector would report on that frame: a box clipped by the scanned area at the
// sides (the runs stop there), and nothing at all until its flat top and bottom rows are inside it.
// Odometry is the camera position in map pixels, rounded to whole ones as the real one is, so the tests
// carry its quantisation. Nothing here measures how well a real frame can be read.
const VIEW = { width: 2560, height: 1440 }, AREA = lootArea(VIEW), SCALE = 7, SCAN_MS = 250, PAN = 103, WIDTH = 258, HEIGHT = 50;
interface Thing { id: string; x: number; y: number; width?: number }
type World = Thing[] | ((i: number, camera: KeyPoint) => Thing[]);
interface Frame { verdicts: Record<string, DropVerdict>; counts: DropCounts }

function onScreen(t: Thing, camera: KeyPoint): PixelRect | undefined {
  const half = Math.round((t.width ?? WIDTH) / 2), cx = Math.round(t.x - camera.x + VIEW.width / 2), cy = Math.round(t.y - camera.y + VIEW.height / 2);
  const x0 = Math.max(AREA.x, cx - half), x1 = Math.min(AREA.x + AREA.width - 1, cx + half), y0 = cy - HEIGHT / 2, y1 = cy + HEIGHT / 2;
  if (y0 < AREA.y || y1 > AREA.y + AREA.height - 1 || x1 - x0 + 1 < HEIGHT * 1.2) return undefined;
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}
const label = (id: string, rect: PixelRect): LootLabel & { id: string } => ({ id, rect, centre: { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }, colour: { r: 6, g: 6, b: 7 }, confidence: .9 });
/** Scans `scans` times while the camera walks the path, and returns what was said about each thing. */
function pan(world: World, camera: (i: number) => KeyPoint, scans: number, opts: { tracked?: (i: number) => boolean; epoch?: (i: number) => number } = {}) {
  const watch = new DropWatch(), seen: Record<string, DropVerdict[]> = {}, log: Frame[] = [];
  for (let i = 0; i < scans; i++) {
    const at = camera(i), things = typeof world === "function" ? world(i, at) : world;
    const labels = things.map(t => [t, onScreen(t, at)] as const).filter(([, r]) => r).map(([t, r]) => label(t.id, r!));
    const counts = watch.observe(labels, VIEW, { x: Math.round(at.x / SCALE), y: Math.round(at.y / SCALE) }, opts.epoch?.(i) ?? 1, opts.tracked?.(i) ?? true, SCALE, i * SCAN_MS);
    const verdicts: Record<string, DropVerdict> = {};
    for (const l of labels) { verdicts[l.id] = watch.verdict(l); (seen[l.id] ??= []).push(verdicts[l.id]); }
    log.push({ verdicts, counts });
  }
  return { watch, seen, log };
}
const GRID: Thing[] = [];
for (let x = -3200; x <= 3200; x += 640) for (let y = -2400; y <= 2400; y += 320) GRID.push({ id: `f${x}:${y}`, x, y });
const FURNITURE: Thing[] = [{ id: "door", x: 1500, y: -600 }, { id: "npc", x: 2600, y: 500 }, { id: "chest", x: 3400, y: -300 }];

describe("telling a drop from level furniture (SIMULATED world past a SIMULATED camera)", () => {
  it("calls furniture furniture whichever edge it slides in across, and never a drop", () => {
    // A crawl, walking pace, sprinting, and faster than the game can move: the last carries a label from
    // outside the view to well inside it between two scans, which is the case the mapping-back test exists for.
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]] as const) for (const speed of [31, PAN, PAN * 3, PAN * 8]) {
      const run = pan(GRID, i => ({ x: dx * speed * i, y: dy * speed * i }), 30), verdicts = Object.values(run.seen).flat();
      expect(verdicts).not.toContain("dropped");
      // Not just shrugged at: the ones that came in across an edge were judged.
      expect(verdicts.filter(v => v === "furniture").length).toBeGreaterThan(10);
    }
  });

  it("calls an item that lands in the middle of ground we could already see a drop, and goes on calling it one", () => {
    // Dropped at scan 10 under the camera, and it stays on that patch of world while the camera walks on.
    const run = pan(i => [...FURNITURE, ...(i >= 10 ? [{ id: "drop", x: PAN * 10, y: 0 }] : [])], i => ({ x: PAN * i, y: 0 }), 18);
    expect(run.seen.drop).toEqual(new Array(8).fill("dropped"));
    expect(run.seen.door).not.toContain("dropped");
    // The counts the status line reads add up to the labels in the scan.
    for (const f of run.log) expect(f.counts.dropped + f.counts.furniture + f.counts.unknown).toBe(f.counts.labels);
    expect(run.log[17].counts.dropped).toBe(1);
  });

  it("holds a verdict while the label is tracked, through its text changing width and with another label right under it", () => {
    const world = (i: number): Thing[] => [{ id: "door", x: 900, y: 0, width: i % 2 ? WIDTH : WIDTH - 22 }, ...(i >= 12 ? [{ id: "drop", x: 900, y: 62 }] : [])];
    const run = pan(world, i => ({ x: PAN * i, y: 0 }), 18);
    expect(run.seen.door.length).toBeGreaterThan(12);
    expect(new Set(run.seen.door)).toEqual(new Set(["furniture"]));
    expect(new Set(run.seen.drop)).toEqual(new Set(["dropped"]));
  });

  it("knows nothing without a usable previous scan: the first one, an untracked one, or a fresh odometry epoch", () => {
    const world = (i: number): Thing[] => [...FURNITURE, ...(i >= 5 ? [{ id: "drop", x: PAN * 5, y: 0 }] : [])], path = (i: number) => ({ x: PAN * i, y: 0 });
    // Blind odometry cannot place the previous scan's labels, and the verdict it did not earn sticks.
    const blind = pan(world, path, 10, { tracked: i => i !== 5 });
    expect(new Set(blind.seen.drop)).toEqual(new Set(["unknown"]));
    // A restart makes every position before it unrelated, so everything on screen is untrusted from then on.
    const restarted = pan(world, path, 10, { epoch: i => (i < 5 ? 1 : 2) });
    expect(new Set(restarted.seen.drop)).toEqual(new Set(["unknown"]));
    expect(Object.values(restarted.log[5].verdicts)).not.toContain("dropped");
    const first = pan([{ id: "here", x: 0, y: 0 }], () => ({ x: 0, y: 0 }), 1);
    expect(first.log[0].verdicts.here).toBe("unknown");
  });

  it("forgets a label the moment it leaves the view, so coming back is a first sighting again", () => {
    // Out to the right until it is off the scanned area at scan 14, then back the way we came.
    const run = pan((i, c) => (i >= 2 ? [{ id: "gem", x: 206, y: 0 }] : []), i => ({ x: (i <= 14 ? i : 28 - i) * PAN, y: 0 }), 28);
    expect(run.seen.gem[0]).toBe("dropped");
    expect(run.log[14].verdicts.gem).toBeUndefined();
    // Gone from the view a single scan after it was last seen, long before the forget window.
    expect(run.log[14].counts.tracks).toBe(0);
    expect(run.log[16].verdicts.gem).toBe("furniture");
    expect(run.log.slice(15).map(f => f.verdicts.gem)).not.toContain("dropped");
  });

  it("sits through a scan or two of flicker, but forgets a label gone a couple of seconds", () => {
    // Enters from the right, then the camera stands still: the only thing that changes is detection.
    const world = (gone: (i: number) => boolean) => (i: number): Thing[] => (gone(i) ? [] : [{ id: "door", x: 900, y: 0 }]), still = (i: number) => ({ x: Math.min(i, 4) * 206, y: 0 });
    const flicker = pan(world(i => i === 8 || i === 9), still, 12);
    expect(flicker.log[7].verdicts.door).toBe("furniture");
    expect(flicker.log[10].verdicts.door).toBe("furniture");
    // The honest cost of a bounded memory: a door hidden for longer than the forget window reads as a drop.
    const forgotten = pan(world(i => i >= 8 && i <= 20), still, 22);
    expect(forgotten.log[21].verdicts.door).toBe("dropped");
  });

  it("bounds what it remembers over a long session on a crowded screen", () => {
    const dense: Thing[] = [];
    for (let x = -1000; x <= 42_000; x += 200) for (let y = -520; y <= 520; y += 80) dense.push({ id: `d${x}:${y}`, x, y });
    const run = pan(dense, i => ({ x: PAN * i, y: 0 }), 400), sizes = run.log.map(f => f.counts.tracks);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(DROP_MAX_TRACKS);
    expect(run.log[0].counts.labels).toBeGreaterThan(DROP_MAX_TRACKS);
    expect(run.watch.size).toBe(DROP_MAX_TRACKS);
  });

  it("answers only for labels from the latest scan", () => {
    const watch = new DropWatch(), here = { x: 0, y: 0 }, at = (t: Thing) => label(t.id, onScreen(t, here)!);
    const first = at({ id: "door", x: 0, y: 0 });
    watch.observe([first], VIEW, { x: 0, y: 0 }, 1, true, SCALE, 0);
    const second = at({ id: "drop", x: 0, y: 200 });
    watch.observe([first, second], VIEW, { x: 0, y: 0 }, 1, true, SCALE, SCAN_MS);
    expect(watch.dropped(second)).toBe(true);
    expect(watch.dropped(first)).toBe(false);
    // A label object from an older scan, or from nowhere at all, is not something it can speak for.
    expect(watch.verdict(at({ id: "door", x: 0, y: 0 }))).toBe("unknown");
    expect(watch.dropped(at({ id: "door", x: 0, y: 0 }))).toBe(false);
  });
});
