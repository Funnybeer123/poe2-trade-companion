import { describe, expect, it } from "vitest";
import { LeaderTrail, MapOdometry, odometryWindow } from "../src/core/followerTrail.js";
import type { KeyPoint } from "../src/core/followerMapMarker.js";

// SYNTHETIC map outlines and paths. They prove the geometry, not accuracy on the game's translucent, anti-aliased map.
function outline(seed: number, count = 500): KeyPoint[] {
  // Two-pixel-thick wandering polylines, like the overlay map's walkable-area outlines.
  const points = new Map<string, KeyPoint>(); let s = seed, x = 1100, y = 600, heading = 0;
  const next = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  while (points.size < count) {
    heading += (next() - .5) * 1.2; x += Math.cos(heading) * 1.5; y += Math.sin(heading) * 1.5;
    if (x < 1000 || x > 1560 || y < 500 || y > 900) { x = 1100 + next() * 300; y = 600 + next() * 200; heading = next() * 6.28; }
    for (const [ox, oy] of [[0, 0], [1, 0], [0, 1]]) { const p = { x: Math.round(x) + ox, y: Math.round(y) + oy }; points.set(`${p.x},${p.y}`, p); }
  }
  return [...points.values()];
}
const slide = (points: KeyPoint[], dx: number, dy: number) => points.map(p => ({ x: p.x + dx, y: p.y + dy }));

describe("map odometry (synthetic outlines)", () => {
  it("reads the player's movement as the opposite of the map's slide, and a still map as no movement", () => {
    const map = outline(7), odometry = new MapOdometry();
    expect(odometry.update(map, 0)).toMatchObject({ tracked: false });
    expect(odometry.update(map, 33)).toMatchObject({ dx: 0, dy: 0, tracked: true });
    expect(odometry.update(slide(map, -3, 2), 66)).toMatchObject({ dx: 3, dy: -2, tracked: true });
    expect(odometry.update(slide(map, -5, 2), 99)).toMatchObject({ dx: 2, dy: 0, tracked: true });
    expect(odometry.position).toEqual({ x: 5, y: -2 });
  });
  it("accumulates a walk and keeps one epoch while tracking holds", () => {
    const map = outline(11), odometry = new MapOdometry(); let shiftX = 0, shiftY = 0;
    odometry.update(map, 0);
    for (let i = 1; i <= 40; i++) { shiftX -= 2; shiftY += i % 2; odometry.update(slide(map, shiftX, shiftY), i * 33); }
    expect(odometry.position).toEqual({ x: 80, y: -20 });
    expect(odometry.epoch).toBe(1);
  });
  it("starts a new epoch instead of guessing after a long gap, a missing map, or a run of unmatched captures", () => {
    const map = outline(3), odometry = new MapOdometry();
    odometry.update(map, 0); odometry.update(slide(map, -2, 0), 33);
    const epoch = odometry.epoch;
    expect(odometry.update(slide(map, -4, 0), 1000)).toMatchObject({ tracked: false });
    expect(odometry.epoch).toBe(epoch + 1);
    expect(odometry.position).toEqual({ x: 0, y: 0 });
    odometry.update(slide(map, -4, 0), 1033);
    expect(odometry.update(undefined, 1066)).toMatchObject({ tracked: false });
    expect(odometry.epoch).toBe(epoch + 2);
    odometry.update(map, 1100); odometry.update(map, 1133);
    const before = odometry.epoch;
    for (let i = 0; i < 6; i++) expect(odometry.update(outline(100 + i), 1166 + i * 33).tracked).toBe(false);
    expect(odometry.epoch).toBe(before + 1);
  });
  it("refuses a shift it cannot tell from a rival: a straight line slides along itself", () => {
    const line: KeyPoint[] = []; for (let x = 1000; x < 1500; x++) line.push({ x, y: 700 }, { x, y: 701 });
    const odometry = new MapOdometry(); odometry.update(line, 0);
    expect(odometry.update(slide(line, -4, 0), 33)).toMatchObject({ dx: 0, dy: 0, tracked: false });
  });
  it("watches a window around the map centre, clipped to the view", () => {
    expect(odometryWindow({ x: 1279, y: 700 }, { width: 2560, height: 1440 })).toEqual({ x: 962, y: 470, width: 634, height: 460 });
    const tiny = odometryWindow({ x: 100, y: 60 }, { width: 640, height: 360 });
    expect(tiny).toEqual({ x: 21, y: 2, width: 158, height: 116 });
    expect(odometryWindow({ x: 10, y: 10 }, { width: 640, height: 360 })).toEqual({ x: 0, y: 0, width: 89, height: 68 });
  });
});

describe("leader trail (synthetic paths)", () => {
  /** The leader walks east along a wall, then north past its end; the follower starts south-west of the corner. */
  const path: KeyPoint[] = [...Array.from({ length: 31 }, (_, i) => ({ x: i * 10, y: 0 })), ...Array.from({ length: 30 }, (_, i) => ({ x: 300, y: -(i + 1) * 10 }))];
  it("aims along the path the leader walked, not across the corner they went round", () => {
    const trail = new LeaderTrail(), me = { x: 0, y: 0 };
    for (const p of path) trail.record(me, { dx: p.x - me.x, dy: p.y - me.y }, 1);
    const leader = path[path.length - 1], aim = trail.aim(me, { dx: leader.x, dy: leader.y }, 1);
    // Straight at the leader would be up and to the right, through the wall. The trail says: go east first.
    expect(aim.via).toBe("trail");
    expect(aim.dx).toBeGreaterThan(40); expect(Math.abs(aim.dy)).toBeLessThan(1);
  });
  it("walks the whole L when pursued step by step, then aims straight at the leader once close", () => {
    const trail = new LeaderTrail(); let me = { x: 0, y: 0 }; const leader = path[path.length - 1];
    for (const p of path) trail.record({ x: 0, y: 0 }, { dx: p.x, dy: p.y }, 1);
    const visited: KeyPoint[] = []; let via = "";
    for (let step = 0; step < 200; step++) {
      const aim = trail.aim(me, { dx: leader.x - me.x, dy: leader.y - me.y }, 1), reach = Math.hypot(aim.dx, aim.dy); via = aim.via;
      if (Math.hypot(leader.x - me.x, leader.y - me.y) < 12) break;
      me = { x: me.x + aim.dx / reach * 5, y: me.y + aim.dy / reach * 5 }; visited.push(me);
    }
    expect(Math.hypot(leader.x - me.x, leader.y - me.y)).toBeLessThan(12);
    expect(via).toBe("direct");
    // It never cut the corner: while west of the corner it stayed on the wall's line.
    expect(visited.filter(p => p.x < 250).every(p => Math.abs(p.y) < 12)).toBe(true);
  });
  it("aims straight at a nearby leader, with no trail, and across epochs", () => {
    const trail = new LeaderTrail();
    expect(trail.aim({ x: 0, y: 0 }, { dx: 200, dy: -150 }, 1)).toMatchObject({ via: "direct", dx: 200, dy: -150, trailPoints: 0 });
    for (const p of path) trail.record({ x: 0, y: 0 }, { dx: p.x, dy: p.y }, 1);
    expect(trail.aim({ x: 290, y: -280 }, { dx: 10, dy: -20 }, 1).via).toBe("direct");
    // A new epoch means positions are unrelated to the recorded ones: the old trail must not steer.
    expect(trail.aim({ x: 0, y: 0 }, { dx: 300, dy: -300 }, 2).via).toBe("direct");
    trail.record({ x: 0, y: 0 }, { dx: 50, dy: 0 }, 2);
    expect(trail.length).toBe(1);
  });
  it("records sparsely and keeps a bounded history", () => {
    const trail = new LeaderTrail();
    for (let i = 0; i < 100; i++) trail.record({ x: 0, y: 0 }, { dx: i, dy: 0 }, 1);
    expect(trail.length).toBe(17);
    for (let i = 0; i < 5000; i++) trail.record({ x: 0, y: 0 }, { dx: 100 + i * 7, dy: 0 }, 1);
    expect(trail.length).toBe(600);
  });
});
