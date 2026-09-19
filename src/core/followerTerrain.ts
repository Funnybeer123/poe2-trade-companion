import type { KeyPoint } from "./followerMapMarker.js";
import type { PixelRect } from "./followerPerception.js";

/**
 * Reading the landscape from the overlay map. The map draws the edge of the walkable area as a thin
 * lavender outline, water edges in bright blue, and buildings as translucent white models. Those pixels
 * become walls on a small grid, a
 * path is searched from the player's marker toward the leader, and steering aims along it, so the
 * character goes round a building instead of into it.
 *
 * The outline is dotted where it crosses the map's white building models, and the map shows only what
 * this client has explored, so the grid can be wrong. Anything the character actually runs into is
 * therefore remembered as a wall too ("bumps", kept in the odometry frame), which means the same
 * spot is not tried twice. Pure functions over captured pixels; nothing here emits OS input.
 */
export const TERRAIN_CHANNEL = "terrain" as const, TERRAIN_THRESHOLD = 128, TERRAIN_POINT_CAP = 50000;
/** More blocked cells than this is not a map: a grey stone floor, speckle or a bright scene is being misread, so no plan is made. */
const MAX_WALL_FRACTION = .3;
/** How much farther from the leader (in cells) a map-edge exit may be than where we stand and still be worth walking to. */
const EDGE_DETOUR_CELLS = 40, COMMIT_MS = 12_000, COMMIT_ARRIVED_CELLS = 6;
const CELL = 4, LOOKAHEAD_PX = 56, MIN_AIM_PX = 20, CLEAR_START_CELLS = 1, NEAR_WALL_COST = 3;
const BUMP_RADIUS_CELLS = 3, BUMP_AHEAD_PX = 14, BUMP_TTL_MS = 45_000, BUMP_MAX = 60, STUCK_MS = 1000, STUCK_CLICKS = 5, STUCK_TOLERANCE_PX = 2.5, MOTION_GAP_MS = 250;

/** The part of the overlay map used for planning: the whole world view, clear of the HUD, party frames and quest tracker. */
export function terrainWindow(origin: KeyPoint, view: { width: number; height: number }): PixelRect {
  const left = Math.round(view.width * .10), top = Math.round(view.height * .05), right = Math.round(view.width * .80), bottom = Math.round(view.height * .80);
  void origin;
  return { x: left, y: top, width: Math.max(8, right - left), height: Math.max(8, bottom - top) };
}

export interface TerrainPlan {
  /** Where to walk next, in map pixels from the player: a point along the planned path. Absent when no path was found. */
  aim?: { dx: number; dy: number };
  /** True when the straight line toward the leader is blocked close ahead. */
  blockedAhead: boolean;
  pathPx: number;
  /** The planned path in game-client pixels, for display and tests. */
  path: KeyPoint[];
  walls: number;
  bumps: number;
  planMs: number;
}

export class TerrainPlanner {
  private bumps: Array<{ x: number; y: number; at: number; epoch: number }> = [];
  private steps: Array<{ at: number; dx: number; dy: number }> = [];
  private clicks: Array<{ at: number; dx: number; dy: number }> = [];
  private checkedAt = -Infinity;
  /** Start of the unbroken run of tracked odometry samples, and the latest of them. */
  private trackedSince?: number;
  private motionAt = -Infinity;
  /** A fallback goal we set out for, in the odometry frame: kept until reached, unreachable or stale, so plans do not flip between exits. */
  private committed?: { x: number; y: number; epoch: number; until: number };

  /** Own movement since the previous observation (map pixels), from odometry; call on every tick, with tracked:false when odometry is blind. */
  noteMotion(step: { dx: number; dy: number; tracked?: boolean }, now: number): void {
    // Blind odometry, or a gap in it, is not evidence of standing still.
    if (step.tracked === false) { this.trackedSince = undefined; this.steps = []; return; }
    if (this.trackedSince === undefined || now - this.motionAt > MOTION_GAP_MS) this.trackedSince = now;
    this.motionAt = now;
    if (step.dx || step.dy) this.steps.push({ at: now, dx: step.dx, dy: step.dy });
    while (this.steps.length && now - this.steps[0].at > STUCK_MS) this.steps.shift();
  }
  /**
   * A committed movement click in direction (dx, dy). Several of them without any movement mean we are
   * against something just ahead: remember that place, in the odometry frame, as a wall.
   */
  noteClick(direction: { dx: number; dy: number }, position: KeyPoint, epoch: number, now: number): boolean {
    this.clicks.push({ at: now, ...direction });
    while (this.clicks.length && now - this.clicks[0].at > STUCK_MS) this.clicks.shift();
    if (this.trackedSince === undefined || this.trackedSince > this.clicks[0].at || now - this.motionAt > MOTION_GAP_MS) return false;
    let mx = 0, my = 0; for (const s of this.steps) if (now - s.at <= STUCK_MS) { mx += s.dx; my += s.dy; }
    if (this.clicks.length < STUCK_CLICKS || now - this.checkedAt < STUCK_MS || now - this.clicks[0].at < STUCK_MS * .8 || Math.hypot(mx, my) >= STUCK_TOLERANCE_PX) return false;
    this.checkedAt = now;
    let ax = 0, ay = 0; for (const c of this.clicks) { const r = Math.hypot(c.dx, c.dy) || 1; ax += c.dx / r; ay += c.dy / r; }
    const r = Math.hypot(ax, ay) || 1;
    this.bumps.push({ x: position.x + ax / r * BUMP_AHEAD_PX, y: position.y + ay / r * BUMP_AHEAD_PX, at: now, epoch });
    if (this.bumps.length > BUMP_MAX) this.bumps.shift();
    this.clicks = [];
    return true;
  }
  get bumpCount(): number { return this.bumps.length; }

  plan(walls: KeyPoint[], window: PixelRect, origin: KeyPoint, leader: { dx: number; dy: number }, position: KeyPoint, epoch: number, now: number, clock: () => number = () => performance.now()): TerrainPlan {
    const began = clock(), cols = Math.ceil(window.width / CELL), rows = Math.ceil(window.height / CELL), size = cols * rows;
    this.bumps = this.bumps.filter(b => b.epoch === epoch && now - b.at <= BUMP_TTL_MS);
    const empty: TerrainPlan = { blockedAhead: false, pathPx: 0, path: [], walls: walls.length, bumps: this.bumps.length, planMs: 0 };
    const cell = (x: number, y: number) => ({ cx: Math.floor((x - window.x) / CELL), cy: Math.floor((y - window.y) / CELL) });
    const start = cell(origin.x, origin.y);
    if (start.cx < 1 || start.cy < 1 || start.cx >= cols - 1 || start.cy >= rows - 1) return empty;
    // 2 = wall (dilated by one cell so dotted outlines and diagonal lines do not leak), 1 = next to a wall.
    const grid = new Uint8Array(size);
    const block = (cx: number, cy: number, radius: number) => { for (let y = Math.max(0, cy - radius); y <= Math.min(rows - 1, cy + radius); y++) for (let x = Math.max(0, cx - radius); x <= Math.min(cols - 1, cx + radius); x++) grid[y * cols + x] = 2; };
    for (const p of walls) { const c = cell(p.x, p.y); if (c.cx >= 0 && c.cy >= 0 && c.cx < cols && c.cy < rows) block(c.cx, c.cy, 1); }
    // Counted in cells after dilation, so the guard is the same at any resolution and catches scattered speckle too.
    let blocked = 0; for (let i = 0; i < size; i++) if (grid[i] === 2) blocked++;
    if (blocked > size * MAX_WALL_FRACTION) return empty;
    for (const b of this.bumps) { const c = cell(origin.x + b.x - position.x, origin.y + b.y - position.y); if (c.cx >= 0 && c.cy >= 0 && c.cx < cols && c.cy < rows) block(c.cx, c.cy, BUMP_RADIUS_CELLS); }
    // We are standing where we are standing: never inside a wall, whatever the outline says. Bumps stay: they are ahead of us, not under us.
    for (let y = start.cy - CLEAR_START_CELLS; y <= start.cy + CLEAR_START_CELLS; y++) for (let x = start.cx - CLEAR_START_CELLS; x <= start.cx + CLEAR_START_CELLS; x++) {
      if (x >= 0 && y >= 0 && x < cols && y < rows && Math.hypot(x - start.cx, y - start.cy) <= CLEAR_START_CELLS && !this.bumps.some(b => { const c = cell(origin.x + b.x - position.x, origin.y + b.y - position.y); return Math.hypot(c.cx - x, c.cy - y) <= BUMP_RADIUS_CELLS; })) grid[y * cols + x] = 0;
    }
    for (let y = 1; y < rows - 1; y++) for (let x = 1; x < cols - 1; x++) if (!grid[y * cols + x] && (grid[y * cols + x - 1] === 2 || grid[y * cols + x + 1] === 2 || grid[(y - 1) * cols + x] === 2 || grid[(y + 1) * cols + x] === 2)) grid[y * cols + x] = 1;
    // Goal: the leader's marker, or the point where the line toward them leaves the window.
    const distance = Math.hypot(leader.dx, leader.dy);
    if (distance < 1) return empty;
    let reach = distance; const ux = leader.dx / distance, uy = leader.dy / distance, margin = CELL * 2;
    if (ux > 0) reach = Math.min(reach, (window.x + window.width - margin - origin.x) / ux); else if (ux < 0) reach = Math.min(reach, (window.x + margin - origin.x) / ux);
    if (uy > 0) reach = Math.min(reach, (window.y + window.height - margin - origin.y) / uy); else if (uy < 0) reach = Math.min(reach, (window.y + margin - origin.y) / uy);
    const goal = cell(origin.x + ux * reach, origin.y + uy * reach);
    goal.cx = Math.max(0, Math.min(cols - 1, goal.cx)); goal.cy = Math.max(0, Math.min(rows - 1, goal.cy));
    // The leader is standing there, so it is walkable; a clipped goal on the window edge is cleared too, or a wall on the edge would hide every path.
    for (let y = goal.cy - 1; y <= goal.cy + 1; y++) for (let x = goal.cx - 1; x <= goal.cx + 1; x++) if (x >= 0 && y >= 0 && x < cols && y < rows && grid[y * cols + x] === 2) grid[y * cols + x] = 1;
    let blockedAhead = false;
    for (let s = CELL; s <= Math.min(reach, LOOKAHEAD_PX); s += CELL) { const c = cell(origin.x + ux * s, origin.y + uy * s); if (grid[c.cy * cols + c.cx] === 2) { blockedAhead = true; break; } }
    // A* over 8 neighbours, no corner cutting, with a penalty for hugging walls.
    const cost = new Float32Array(size).fill(Infinity), from = new Int32Array(size).fill(-1), open: number[] = [], priority = new Float32Array(size);
    const heuristic = (i: number) => { const dx = Math.abs(i % cols - goal.cx), dy = Math.abs(Math.floor(i / cols) - goal.cy); return Math.max(dx, dy) + .4142 * Math.min(dx, dy); };
    const push = (i: number) => { open.push(i); let at = open.length - 1; while (at > 0) { const parent = (at - 1) >> 1; if (priority[open[parent]] <= priority[open[at]]) break; [open[parent], open[at]] = [open[at], open[parent]]; at = parent; } };
    const pop = () => { const top = open[0], last = open.pop()!; if (open.length) { open[0] = last; let at = 0; for (;;) { const l = at * 2 + 1, r = l + 1; let m = at; if (l < open.length && priority[open[l]] < priority[open[m]]) m = l; if (r < open.length && priority[open[r]] < priority[open[m]]) m = r; if (m === at) break; [open[m], open[at]] = [open[at], open[m]]; at = m; } } return top; };
    const startIndex = start.cy * cols + start.cx, goalIndex = goal.cy * cols + goal.cx;
    cost[startIndex] = 0; priority[startIndex] = heuristic(startIndex); push(startIndex);
    let found = false;
    while (open.length) {
      const here = pop();
      if (here === goalIndex) { found = true; break; }
      const hx = here % cols, hy = Math.floor(here / cols);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = hx + dx, ny = hy + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const next = ny * cols + nx;
        if (grid[next] === 2 || (dx && dy && (grid[hy * cols + nx] === 2 || grid[ny * cols + hx] === 2))) continue;
        const stepCost = cost[here] + (dx && dy ? 1.4142 : 1) + (grid[next] === 1 ? NEAR_WALL_COST : 0);
        if (stepCost >= cost[next]) continue;
        cost[next] = stepCost; from[next] = here; priority[next] = stepCost + heuristic(next); push(next);
      }
    }
    // The line toward the leader may leave the mapped walkable area through a wall. Then head for the reachable place that
    // gets nearest to them: preferably where walkable ground runs off the edge of what we can see, else simply the nearest spot.
    let endIndex = goalIndex;
    if (found) this.committed = undefined;
    else {
      const kept = this.committed && this.committed.epoch === epoch && now <= this.committed.until ? cell(origin.x + this.committed.x - position.x, origin.y + this.committed.y - position.y) : undefined;
      const keptIndex = kept && kept.cx >= 0 && kept.cy >= 0 && kept.cx < cols && kept.cy < rows ? kept.cy * cols + kept.cx : -1;
      // Still on the way to the exit chosen earlier, and it is still reachable: keep going there.
      if (keptIndex !== -1 && cost[keptIndex] !== Infinity && Math.hypot(kept!.cx - start.cx, kept!.cy - start.cy) > COMMIT_ARRIVED_CELLS) endIndex = keptIndex;
      else {
        this.committed = undefined;
      const lx = (origin.x + leader.dx - window.x) / CELL, ly = (origin.y + leader.dy - window.y) / CELL;
      let bestEdge = -1, bestEdgeScore = Infinity, bestAny = -1, bestAnyScore = Infinity;
      for (let i = 0; i < size; i++) {
        if (cost[i] === Infinity || i === startIndex) continue;
        const x = i % cols, y = Math.floor(i / cols), toLeader = Math.hypot(x - lx, y - ly);
        if (toLeader < bestAnyScore) { bestAnyScore = toLeader; bestAny = i; }
        if ((x <= 1 || y <= 1 || x >= cols - 2 || y >= rows - 2) && cost[i] + toLeader < bestEdgeScore) { bestEdgeScore = cost[i] + toLeader; bestEdge = i; }
      }
      const startToLeader = Math.hypot(start.cx - lx, start.cy - ly);
      // An edge exit is only worth taking if it does not lead away from the leader; a nearest spot only if it is nearer than here.
      endIndex = bestEdge !== -1 && Math.hypot(bestEdge % cols - lx, Math.floor(bestEdge / cols) - ly) < startToLeader + EDGE_DETOUR_CELLS ? bestEdge : bestAny !== -1 && bestAnyScore < startToLeader - 2 ? bestAny : -1;
      if (endIndex === -1) return { ...empty, blockedAhead, planMs: Math.round((clock() - began) * 10) / 10 };
      this.committed = { x: position.x + (endIndex % cols - start.cx) * CELL, y: position.y + (Math.floor(endIndex / cols) - start.cy) * CELL, epoch, until: now + COMMIT_MS };
      }
    }
    const path: Array<{ cx: number; cy: number }> = [];
    for (let i = endIndex; i !== -1; i = from[i]) path.push({ cx: i % cols, cy: Math.floor(i / cols) });
    path.reverse();
    const clear = (a: { cx: number; cy: number }, b: { cx: number; cy: number }) => { const n = Math.max(Math.abs(b.cx - a.cx), Math.abs(b.cy - a.cy)) * 2; for (let i = 1; i < n; i++) { const x = Math.round(a.cx + (b.cx - a.cx) * i / n), y = Math.round(a.cy + (b.cy - a.cy) * i / n); if (grid[y * cols + x]) return false; } return true; };
    // Aim at the farthest point within the lookahead that can be walked to in a straight line, so steering does not zigzag along grid steps.
    let along = 0, pathPx = 0, target = path[Math.min(path.length - 1, 1)];
    for (let i = 1; i < path.length; i++) {
      const stepPx = Math.hypot(path[i].cx - path[i - 1].cx, path[i].cy - path[i - 1].cy) * CELL; pathPx += stepPx;
      if (along + stepPx <= LOOKAHEAD_PX) { along += stepPx; if (clear(path[0], path[i]) || along < MIN_AIM_PX) target = path[i]; }
    }
    return { aim: { dx: (target.cx - start.cx) * CELL, dy: (target.cy - start.cy) * CELL }, blockedAhead, pathPx: Math.round(pathPx), path: path.map(p => ({ x: window.x + p.cx * CELL + CELL / 2, y: window.y + p.cy * CELL + CELL / 2 })), walls: walls.length, bumps: this.bumps.length, planMs: Math.round((clock() - began) * 10) / 10 };
  }
}
