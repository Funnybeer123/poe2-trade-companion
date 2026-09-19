import { describe, expect, it } from "vitest";
import { TerrainPlanner, terrainWindow } from "../src/core/followerTerrain.js";
import type { KeyPoint } from "../src/core/followerMapMarker.js";

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

describe("terrain planner guards", () => {
  it("makes no plan from a scene that is mostly 'wall': a grey floor or bright scene is being misread", () => {
    const flood: KeyPoint[] = []; for (let y = WINDOW.y; y < WINDOW.y + WINDOW.height; y += 2) for (let x = WINDOW.x; x < WINDOW.x + WINDOW.width; x += 1) flood.push({ x, y });
    expect(new TerrainPlanner().plan(flood, WINDOW, ORIGIN, { dx: 0, dy: -200 }, { x: 0, y: 0 }, 1, 0).aim).toBeUndefined();
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
  it("forgets bumps from another odometry epoch and old ones", () => {
    const planner = new TerrainPlanner();
    for (let now = 0; now <= 1200; now += 110) planner.noteClick({ dx: 0, dy: -1 }, { x: 0, y: 0 }, 1, now);
    expect(planner.bumpCount).toBe(1);
    expect(planner.plan([], WINDOW, ORIGIN, { dx: 0, dy: -200 }, { x: 0, y: 0 }, 1, 2000).bumps).toBe(1);
    expect(planner.plan([], WINDOW, ORIGIN, { dx: 0, dy: -200 }, { x: 0, y: 0 }, 2, 2100).bumps).toBe(0);
    for (let now = 3000; now <= 4200; now += 110) planner.noteClick({ dx: 0, dy: -1 }, { x: 0, y: 0 }, 2, now);
    expect(planner.plan([], WINDOW, ORIGIN, { dx: 0, dy: -200 }, { x: 0, y: 0 }, 2, 4300).bumps).toBe(1);
    expect(planner.plan([], WINDOW, ORIGIN, { dx: 0, dy: -200 }, { x: 0, y: 0 }, 2, 4300 + 46_000).bumps).toBe(0);
  });
  it("does not record a bump while the character is moving", () => {
    const planner = new TerrainPlanner();
    for (let now = 0; now <= 3000; now += 110) { planner.noteMotion({ dx: 0, dy: -5 }, now); expect(planner.noteClick({ dx: 0, dy: -1 }, { x: 0, y: -now / 20 }, 1, now)).toBe(false); }
  });
});
