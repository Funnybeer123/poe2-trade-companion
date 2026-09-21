import { describe, expect, it } from "vitest";
import { TERRAIN_CELL_PX, TERRAIN_POINT_CAP, TerrainPlanner, terrainWindow } from "../src/core/followerTerrain.js";
import type { KeyPoint } from "../src/core/followerMapMarker.js";
import { channelValue } from "../src/core/followerPerception.js";

// SIMULATED world. The map draws box outlines as wall pixels around a point character that stops dead at walls.
// These tests prove the planning and bump-memory rules, not how well the real overlay map can be read.
const VIEW = { width: 2560, height: 1440 }, ORIGIN = { x: 1279, y: 700 }, WINDOW = terrainWindow(ORIGIN, VIEW);
type Box = { x0: number; y0: number; x1: number; y1: number };
/** Outline pixels of the boxes as the map would show them around a player at `me`, clipped to the planning window. */
function drawn(boxes: Box[], me: KeyPoint): KeyPoint[] {
  const points: KeyPoint[] = [], add = (wx: number, wy: number) => { const x = Math.round(ORIGIN.x + wx - me.x), y = Math.round(ORIGIN.y + wy - me.y); if (x >= WINDOW.x && y >= WINDOW.y && x < WINDOW.x + WINDOW.width && y < WINDOW.y + WINDOW.height) points.push({ x, y }); };
  for (const b of boxes) { for (let x = b.x0; x <= b.x1; x++) { add(x, b.y0); add(x, b.y1); } for (let y = b.y0; y <= b.y1; y++) { add(b.x0, y); add(b.x1, y); } }
  return points;
}
/** The gappy outlines the map draws over its building models: long runs of wall pixels with a hole every 16. */
function dottedOutlines(count: number): KeyPoint[] {
  const next = ((seed: number) => () => (seed = seed * 48271 % 2147483647) / 2147483647)(2), points: KeyPoint[] = [];
  while (points.length < count) {
    let x = WINDOW.x + Math.floor(next() * WINDOW.width), y = WINDOW.y + Math.floor(next() * WINDOW.height);
    const horizontal = next() < .5, length = 60 + Math.floor(next() * 400);
    for (let i = 0; i < length && points.length < count; i++) {
      if (i % 16 < 9) points.push({ x, y });
      if (horizontal) x++; else y++;
      if (x >= WINDOW.x + WINDOW.width || y >= WINDOW.y + WINDOW.height) break;
    }
  }
  return points;
}
/** Walks toward the planner's aim (or straight at the leader when it has none) at 48 map px/s, clicking every 110 ms. */
function simulate(solid: Box[], visible: Box[], start: KeyPoint, leader: KeyPoint, seconds: number) {
  const planner = new TerrainPlanner(), inside = (x: number, y: number) => solid.some(w => x > w.x0 && x < w.x1 && y > w.y0 && y < w.y1);
  let me = { ...start }, heading: KeyPoint | undefined, lastClick = -Infinity, lastPlan = -Infinity, aim: { dx: number; dy: number } | undefined, bumps = 0, blockedTicks = 0, arrivedAt: number | undefined, planned = 0, maxPlanMs = 0;
  for (let now = 0; now < seconds * 1000 && arrivedAt === undefined; now += 33) {
    const before = { ...me };
    if (heading) { const nx = me.x + heading.x * 48 * .033, ny = me.y + heading.y * 48 * .033; if (!inside(nx, ny)) me = { x: nx, y: ny }; else blockedTicks++; }
    planner.noteMotion({ dx: me.x - before.x, dy: me.y - before.y }, now);
    const offset = { dx: leader.x - me.x, dy: leader.y - me.y };
    if (Math.hypot(offset.dx, offset.dy) <= 12) { arrivedAt = now; break; }
    if (now - lastPlan >= 200) { lastPlan = now; const plan = planner.plan(drawn(visible, me), WINDOW, ORIGIN, offset, me, 1, now); aim = plan.aim; if (plan.aim) planned++; maxPlanMs = Math.max(maxPlanMs, plan.planMs); }
    if (now - lastClick >= 110) {
      lastClick = now; const toward = aim ?? offset, r = Math.hypot(toward.dx, toward.dy); heading = { x: toward.dx / r, y: toward.dy / r };
      if (planner.noteClick(toward, me, 1, now)) { bumps++; lastPlan = -Infinity; }
    }
  }
  return { arrivedAt, bumps, blockedTicks, planned, maxPlanMs, me };
}

describe("terrain planning round what the map shows (SIMULATED world)", () => {
  it("walks straight to the leader when the map shows nothing in the way", () => {
    const run = simulate([], [], { x: 0, y: 0 }, { x: 200, y: -150 }, 20);
    expect(run.arrivedAt).toBeLessThan(6500);
    expect(run.bumps).toBe(0);
  });
  it("goes round a mapped wall without touching it", () => {
    const wall = [{ x0: -150, y0: -160, x1: 150, y1: -140 }], run = simulate(wall, wall, { x: 0, y: 0 }, { x: 0, y: -300 }, 60);
    expect(run.arrivedAt).toBeLessThan(16_000);
    expect(run.bumps).toBe(0);
    expect(run.blockedTicks).toBeLessThan(10);
  });
  it("goes round a mapped building by its nearer corner, far faster than feeling along it would", () => {
    const building = [{ x0: -100, y0: -250, x1: 400, y1: -50 }], run = simulate(building, building, { x: 0, y: 0 }, { x: 150, y: -320 }, 90);
    // Left corner: about 100 + 250 + 270 map px of walking at 48 px/s is roughly 13 s.
    expect(run.arrivedAt).toBeLessThan(20_000);
    expect(run.bumps).toBe(0);
  });
  it("threads two staggered mapped walls, one corner after another", () => {
    const walls = [{ x0: -200, y0: -120, x1: 80, y1: -100 }, { x0: -60, y0: -260, x1: 260, y1: -240 }], run = simulate(walls, walls, { x: 0, y: 0 }, { x: 0, y: -380 }, 90);
    expect(run.arrivedAt).toBeLessThan(25_000);
    expect(run.bumps).toBe(0);
  });
  it("leaves a dead-end pocket the way it came in, like a person reading the map would", () => {
    // A U-shaped pocket open to the south; the leader is north of its closed end.
    const pocket = [{ x0: -80, y0: -60, x1: 80, y1: -40 }, { x0: -80, y0: -60, x1: -60, y1: 160 }, { x0: 60, y0: -60, x1: 80, y1: 160 }], run = simulate(pocket, pocket, { x: 0, y: 0 }, { x: 0, y: -250 }, 120);
    expect(run.arrivedAt).toBeDefined();
    expect(run.bumps).toBeLessThanOrEqual(1);
  });
  it("learns a wall the map does not show by bumping into it once or twice, and does not keep trying the same spot", () => {
    const wall = [{ x0: -150, y0: -160, x1: 150, y1: -140 }], run = simulate(wall, [], { x: 0, y: 0 }, { x: 0, y: -300 }, 240);
    expect(run.arrivedAt).toBeDefined();
    expect(run.bumps).toBeGreaterThanOrEqual(1);
    // A blind straight-line chase would be blocked on every tick of the whole run (about 7,200 of them).
    expect(run.blockedTicks).toBeLessThan(1500);
  });
  it("plans fast enough to run several times a second", () => {
    const building = [{ x0: -100, y0: -250, x1: 400, y1: -50 }], run = simulate(building, building, { x: 0, y: 0 }, { x: 150, y: -320 }, 30);
    expect(run.planned).toBeGreaterThan(10);
    expect(run.maxPlanMs).toBeLessThan(60);
  });
});

/**
 * What counts as a wall. The map draws the edge of walkable ground as a lavender line - red and green equal, blue
 * 10-30% above - and that line IS the wall. The older "terrain" plane also took anything blue-dominant (water, the
 * bright arc at the edge of the explored map) and anything bright and neutral (the map's own walkable fill, NPC name
 * labels, pale scenery). On a recorded town frame that made 19% of cells wall, tripped the planner's 30% guard and
 * returned NO PATH without searching; on a cave frame it routed to a frontier instead of the leader. Fed the outline
 * alone, the same planner reaches the leader on both. These are the cases scripts/test-follower-host.ps1 asserts natively.
 */
describe("the walls plane reads only the map's lavender outline", () => {
  it.each([
    [[128, 123, 157], 255, "the outline as measured"],
    [[150, 150, 200], 255, "the outline over brighter ground"],
    [[62, 127, 165], 0, "water and the explored-map arc: green well above red"],
    [[148, 140, 138], 0, "bright and neutral: map fill, name labels, pale scenery"],
    [[180, 120, 200], 0, "a purple spell effect: red above green"],
    [[90, 90, 100], 0, "too dark to be the map"],
    [[240, 240, 250], 0, "white text"],
    [[238, 180, 97], 0, "an orange loot label"],
  ] as const)("%j -> %i (%s)", (rgb, expected, what) => {
    expect(channelValue(rgb[0], rgb[1], rgb[2], "walls"), what).toBe(expected);
  });
});

describe("terrain planner guards", () => {
  it("makes no plan from a scene that is mostly 'wall': a grey floor or bright scene is being misread", () => {
    // Thinned to what the capture can deliver: the point cap is a transport limit, the guard must trip below it.
    const flood: KeyPoint[] = []; for (let y = WINDOW.y; y < WINDOW.y + WINDOW.height; y += 7) for (let x = WINDOW.x; x < WINDOW.x + WINDOW.width; x += 7) flood.push({ x, y });
    expect(flood.length).toBeLessThan(TERRAIN_POINT_CAP);
    expect(new TerrainPlanner().plan(flood, WINDOW, ORIGIN, { dx: 0, dy: -200 }, { x: 0, y: 0 }, 1, 0).aim).toBeUndefined();
  });
  it("makes no plan through scattered speckle: the guard counts blocked cells, not pixels", () => {
    // One pixel every 16 px is under 1% of the pixels but over half the cells once stamped, with one-cell corridors A* would happily thread.
    const speckle: KeyPoint[] = []; for (let y = WINDOW.y; y < WINDOW.y + WINDOW.height; y += 16) for (let x = WINDOW.x; x < WINDOW.x + WINDOW.width; x += 16) speckle.push({ x, y });
    expect(speckle.length).toBeLessThan(10_000);
    const plan = new TerrainPlanner().plan(speckle, WINDOW, ORIGIN, { dx: 0, dy: -200 }, { x: 0, y: 0 }, 1, 0);
    expect(plan.aim).toBeUndefined(); expect(plan.path).toEqual([]);
  });
  it("still plans when a quarter of the cells are wall", () => {
    const slab: KeyPoint[] = []; for (let y = WINDOW.y; y < WINDOW.y + WINDOW.height * .25; y += 4) for (let x = WINDOW.x; x < WINDOW.x + WINDOW.width; x += 4) slab.push({ x, y });
    expect(new TerrainPlanner().plan(slab, WINDOW, ORIGIN, { dx: 200, dy: 0 }, { x: 0, y: 0 }, 1, 0).aim).toBeDefined();
  });
  it("when the leader is sealed off on the map, walks to the reachable spot nearest to them, then makes no plan so the caller can fall back", () => {
    const ring = (me: KeyPoint): KeyPoint[] => { const points: KeyPoint[] = []; for (let a = 0; a < 6.3; a += .005) points.push({ x: Math.round(ORIGIN.x + Math.cos(a) * 60 - me.x), y: Math.round(ORIGIN.y + Math.sin(a) * 60 - me.y) }); return points; };
    const planner = new TerrainPlanner(), first = planner.plan(ring({ x: 0, y: 0 }), WINDOW, ORIGIN, { dx: 0, dy: -200 }, { x: 0, y: 0 }, 1, 0);
    expect(first.blockedAhead).toBe(true);
    expect(first.aim!.dy).toBeLessThan(-20); expect(Math.abs(first.aim!.dx)).toBeLessThan(20);
    expect(first.path.every(p => Math.hypot(p.x - ORIGIN.x, p.y - ORIGIN.y) < 60)).toBe(true);
    // Standing at that spot, nothing reachable is nearer: no plan.
    const there = { x: 0, y: -48 };
    expect(planner.plan(ring(there), WINDOW, ORIGIN, { dx: 0, dy: -152 }, there, 1, 1000).aim).toBeUndefined();
  });
  it("heads for where walkable ground runs off the edge of the view when the straight line is walled off", () => {
    // A long wall to the north with open ground to the west: the leader is north, beyond the view.
    const wall: KeyPoint[] = []; for (let x = ORIGIN.x - 150; x <= WINDOW.x + WINDOW.width; x++) for (let y = ORIGIN.y - 120; y <= ORIGIN.y - 116; y++) wall.push({ x, y });
    const plan = new TerrainPlanner().plan(wall, WINDOW, ORIGIN, { dx: 0, dy: -1500 }, { x: 0, y: 0 }, 1, 0);
    expect(plan.aim).toBeDefined();
    const end = plan.path[plan.path.length - 1];
    expect(end.y).toBeLessThan(WINDOW.y + 12);
    expect(plan.path.some(p => p.x < ORIGIN.x - 150)).toBe(true);
  });
  it("never treats the spot we stand on as wall, and aims at a leader who is outside the window by way of its edge", () => {
    const onUs: KeyPoint[] = []; for (let d = -3; d <= 3; d++) onUs.push({ x: ORIGIN.x + d, y: ORIGIN.y });
    const plan = new TerrainPlanner().plan(onUs, WINDOW, ORIGIN, { dx: 900, dy: -700 }, { x: 0, y: 0 }, 1, 0);
    expect(plan.aim).toBeDefined();
    expect(plan.aim!.dx).toBeGreaterThan(0); expect(plan.aim!.dy).toBeLessThan(0);
    expect(plan.path.every(p => p.x >= WINDOW.x && p.y >= WINDOW.y && p.x <= WINDOW.x + WINDOW.width && p.y <= WINDOW.y + WINDOW.height)).toBe(true);
  });
  it("searches a dotted outline field once through, not for ever: this scene froze a live run for 25 s and ate a gigabyte", () => {
    // Kept as float32, a stored cost rounds UP, so the identical relaxation fired again every time its cell was
    // expanded and the open list grew without end: 26 s of blocked event loop, 2.5 GB of RSS, then RangeError.
    const cells = Math.ceil(WINDOW.width / 4) * Math.ceil(WINDOW.height / 4), began = Date.now();
    const plan = new TerrainPlanner().plan(dottedOutlines(15_000), WINDOW, ORIGIN, { dx: 420, dy: -300 }, { x: 0, y: 0 }, 1, 0);
    expect(Date.now() - began).toBeLessThan(2000);
    // The invariant that bounds the search: a cell is settled at most once, so the open list cannot run away.
    expect(plan.searched).toBeGreaterThan(1000);
    expect(plan.searched).toBeLessThanOrEqual(cells);
    expect(plan.planMs).toBeLessThan(500);
    expect(plan.aim).toBeDefined();
  });
  it("gives up on its own clock rather than hold the tick loop, and steers with what it searched", () => {
    // A clock that jumps 200 ms a call, so the budget check at the 1024th settled cell stops the search.
    let call = 0; const clock = () => call++ * 200;
    const plan = new TerrainPlanner().plan(dottedOutlines(15_000), WINDOW, ORIGIN, { dx: 420, dy: -300 }, { x: 0, y: 0 }, 1, 0, clock);
    expect(plan.searched).toBe(1024);
    expect(plan.aim).toBeDefined();
  });
  it("forgets bumps from another odometry epoch and old ones", () => {
    const planner = new TerrainPlanner();
    for (let now = 0; now <= 1200; now += 110) { planner.noteMotion({ dx: 0, dy: 0 }, now); planner.noteClick({ dx: 0, dy: -1 }, { x: 0, y: 0 }, 1, now); }
    expect(planner.bumpCount).toBe(1);
    expect(planner.plan([], WINDOW, ORIGIN, { dx: 0, dy: -200 }, { x: 0, y: 0 }, 1, 2000).bumps).toBe(1);
    expect(planner.plan([], WINDOW, ORIGIN, { dx: 0, dy: -200 }, { x: 0, y: 0 }, 2, 2100).bumps).toBe(0);
    for (let now = 3000; now <= 4200; now += 110) { planner.noteMotion({ dx: 0, dy: 0, tracked: true }, now); planner.noteClick({ dx: 0, dy: -1 }, { x: 0, y: 0 }, 2, now); }
    expect(planner.plan([], WINDOW, ORIGIN, { dx: 0, dy: -200 }, { x: 0, y: 0 }, 2, 4300).bumps).toBe(1);
    expect(planner.plan([], WINDOW, ORIGIN, { dx: 0, dy: -200 }, { x: 0, y: 0 }, 2, 4300 + 46_000).bumps).toBe(0);
  });
  it("never records a bump without positive evidence of standing still: no motion samples, or blind odometry", () => {
    const silent = new TerrainPlanner(), blind = new TerrainPlanner();
    for (let now = 0; now <= 5000; now += 110) {
      expect(silent.noteClick({ dx: 0, dy: -1 }, { x: 0, y: 0 }, 1, now)).toBe(false);
      blind.noteMotion({ dx: 0, dy: 0, tracked: false }, now); expect(blind.noteClick({ dx: 0, dy: -1 }, { x: 0, y: 0 }, 1, now)).toBe(false);
    }
    expect(silent.bumpCount).toBe(0); expect(blind.bumpCount).toBe(0);
  });
  it("needs tracked samples over the whole click window: a blind frame, a gap or a stale sample starts the wait again", () => {
    const click = (p: TerrainPlanner, now: number) => p.noteClick({ dx: 0, dy: -1 }, { x: 0, y: 0 }, 1, now);
    // Blind until 2000, then tracked and still: the clicks made while blind do not count.
    const recovered = new TerrainPlanner(); let bumpedAt: number | undefined;
    for (let now = 0; now <= 4000 && bumpedAt === undefined; now += 110) { recovered.noteMotion({ dx: 0, dy: 0, tracked: now >= 2000 }, now); if (click(recovered, now)) bumpedAt = now; }
    expect(bumpedAt).toBeGreaterThanOrEqual(2000 + 800);
    // One blind frame every 700 ms: never a full window of evidence.
    const flaky = new TerrainPlanner();
    for (let now = 0, n = 0; now <= 6000; now += 100, n++) { flaky.noteMotion({ dx: 0, dy: 0, tracked: n % 7 !== 0 }, now); expect(click(flaky, now)).toBe(false); }
    // Samples that stopped arriving say nothing about now.
    const stale = new TerrainPlanner();
    for (let now = 0; now <= 3000; now += 110) { if (now < 500) stale.noteMotion({ dx: 0, dy: 0 }, now); expect(click(stale, now)).toBe(false); }
  });
  it("does not record a bump while the character is moving", () => {
    const planner = new TerrainPlanner();
    for (let now = 0; now <= 3000; now += 110) { planner.noteMotion({ dx: 0, dy: -5 }, now); expect(planner.noteClick({ dx: 0, dy: -1 }, { x: 0, y: -now / 20 }, 1, now)).toBe(false); }
  });
});

/**
 * Asking the capture host for one point per planner cell instead of every wall pixel.
 *
 * Why it exists: the terrain scan overflows its 50,000-point cap in busy scenes, and an overflow makes
 * the host return null, which makes the loop discard the WHOLE plan. Measured over 16 recorded frames,
 * 4 overflowed (a built-up area 56,264 points, the worst 113,022) and live runs produced no plan 84-96%
 * of the time — so the planner failed exactly where walls were densest and the follower steered by
 * straight line into them. Per-cell points cut those frames 4.1-16x, worst case 9,123.
 *
 * It is safe because it is lossless, and that is what these tests pin: the planner buckets every wall
 * pixel by floor((x - window.x) / CELL), so a point at its cell's top-left lands in the same cell.
 */
describe("one terrain point per planner cell", () => {
  /** Exactly what the native scan now emits for `grid`: the top-left of each occupied cell, in scan order. */
  const perCell = (points: KeyPoint[]): KeyPoint[] => {
    const seen = new Set<number>(), out: KeyPoint[] = [];
    for (const p of points) {
      const cx = Math.floor((p.x - WINDOW.x) / TERRAIN_CELL_PX), cy = Math.floor((p.y - WINDOW.y) / TERRAIN_CELL_PX);
      const key = cy * 8192 + cx;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ x: WINDOW.x + cx * TERRAIN_CELL_PX, y: WINDOW.y + cy * TERRAIN_CELL_PX });
    }
    return out;
  };

  it("plans exactly the same route from cell points as from every pixel, and from far fewer of them", () => {
    // A building between us and the leader, so there is a real detour to get wrong.
    const boxes = [{ x0: 40, y0: -120, x1: 150, y1: 120 }];
    const raw = drawn(boxes, { x: 0, y: 0 }), cells = perCell(raw);
    const offset = { dx: 260, dy: 0 };
    const full = new TerrainPlanner().plan(raw, WINDOW, ORIGIN, offset, { x: 0, y: 0 }, 1, 1000);
    const gridded = new TerrainPlanner().plan(cells, WINDOW, ORIGIN, offset, { x: 0, y: 0 }, 1, 1000);
    expect(full.aim).toBeDefined();
    expect(gridded.aim).toEqual(full.aim);
    expect(gridded.pathPx).toBe(full.pathPx);
    expect(gridded.blockedAhead).toBe(full.blockedAhead);
    expect(cells.length).toBeLessThan(raw.length);
  });

  it("holds for the gappy dotted outlines the map really draws, which is where a coarser scan would leak", () => {
    const raw = dottedOutlines(30_000), cells = perCell(raw);
    const offset = { dx: 300, dy: 120 };
    const full = new TerrainPlanner().plan(raw, WINDOW, ORIGIN, offset, { x: 0, y: 0 }, 1, 1000);
    const gridded = new TerrainPlanner().plan(cells, WINDOW, ORIGIN, offset, { x: 0, y: 0 }, 1, 1000);
    expect(gridded.aim).toEqual(full.aim);
    expect(gridded.pathPx).toBe(full.pathPx);
    expect(gridded.blockedAhead).toBe(full.blockedAhead);
    // The point of the change: the same walls, comfortably inside the cap that used to bind.
    expect(cells.length).toBeLessThan(raw.length / 3);
    expect(cells.length).toBeLessThan(TERRAIN_POINT_CAP);
  });
});

/**
 * "Is there a wall between us, and does the route really get to them?" - the two facts steering needs in order to
 * walk a route read off the map instead of guessing. With both true the plan outranks the trail and the straight line.
 */
describe("what the plan says about the straight line and about itself", () => {
  const at = { x: 0, y: 0 };
  it("sees a wall anywhere on the line to the leader, not just inside the lookahead", () => {
    const far = [{ x0: 200, y0: -120, x1: 230, y1: 120 }];   // 200 px away: well beyond the 56 px lookahead
    const plan = new TerrainPlanner().plan(drawn(far, at), WINDOW, ORIGIN, { dx: 420, dy: 0 }, at, 1, 1000);
    expect(plan.blockedAhead).toBe(false);
    expect(plan).toMatchObject({ wallBetween: true, reachesLeader: true });
    expect(plan.aim).toBeDefined();
  });
  it("reports a clear line as clear", () => {
    const aside = [{ x0: 100, y0: 200, x1: 300, y1: 260 }];
    expect(new TerrainPlanner().plan(drawn(aside, at), WINDOW, ORIGIN, { dx: 420, dy: 0 }, at, 1, 1000)).toMatchObject({ wallBetween: false, reachesLeader: true });
  });
  it("does not claim to reach a leader it can only approach: a sealed room routes to the nearest reachable spot", () => {
    const room = [{ x0: 300, y0: -60, x1: 420, y1: 60 }];    // the leader stands inside a closed box
    const plan = new TerrainPlanner().plan(drawn(room, at), WINDOW, ORIGIN, { dx: 360, dy: 0 }, at, 1, 1000);
    expect(plan.wallBetween).toBe(true);
    expect(plan.reachesLeader).toBe(false);
  });
});
