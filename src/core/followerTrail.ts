import type { KeyPoint } from "./followerMapMarker.js";
import type { PixelRect } from "./followerPerception.js";

/**
 * Following the leader's path instead of the leader's position. Aiming straight at someone who has
 * gone round a corner walks into the corner. The overlay map is centred on the player, so its blue
 * outlines slide across the screen as the player moves: the slide between two captures is the
 * player's own movement in map pixels. Adding the leader's offset to that gives where the leader
 * was, and those places are walkable because the leader walked them.
 * Pure functions over captured pixels; nothing here emits OS input.
 */
export const ODOMETRY_CHANNEL = "blue" as const, ODOMETRY_THRESHOLD = 60;
/** The part of the overlay map watched for movement: around the map centre, inside the view. */
export function odometryWindow(origin: KeyPoint, view: { width: number; height: number }): PixelRect {
  const halfWidth = Math.round(view.height * .22), halfHeight = Math.round(view.height * .16);
  const x = Math.max(0, origin.x - halfWidth), y = Math.max(0, origin.y - halfHeight);
  return { x, y, width: Math.min(view.width, origin.x + halfWidth) - x, height: Math.min(view.height, origin.y + halfHeight) - y };
}

const SEARCH = 9, SAMPLE = 450, MIN_POINTS = 60, MIN_SUPPORT = .3, MAX_GAP_MS = 250, MAX_LOST = 6;
export interface OdometryStep { dx: number; dy: number; quality: number; tracked: boolean }
/** Estimates how far the player moved between captures from the shift of the map's outline pixels. */
export class MapOdometry {
  private previous?: { at: number; keys: Set<number> };
  private lost = 0;
  /** Player position in map pixels since tracking (re)started. */
  position: KeyPoint = { x: 0, y: 0 };
  /** Increments whenever continuity is broken: positions from different epochs are unrelated. */
  epoch = 0;
  private restart(): void { this.epoch++; this.position = { x: 0, y: 0 }; this.lost = 0; }
  update(points: KeyPoint[] | undefined, at: number): OdometryStep {
    const key = (x: number, y: number) => y * 8192 + x, previous = this.previous;
    const keys = new Set<number>(); for (const p of points ?? []) keys.add(key(p.x, p.y));
    this.previous = points && points.length >= MIN_POINTS ? { at, keys } : undefined;
    if (!this.previous) { if (previous) this.restart(); return { dx: 0, dy: 0, quality: 0, tracked: false }; }
    if (!previous || at - previous.at > MAX_GAP_MS) { this.restart(); return { dx: 0, dy: 0, quality: 0, tracked: false }; }
    const step = Math.max(1, Math.floor(points!.length / SAMPLE)), sample = points!.filter((_, i) => i % step === 0);
    const size = SEARCH * 2 + 1, tally = new Array<number>(size * size).fill(0);
    let best = 0, shiftX = 0, shiftY = 0;
    for (let dy = -SEARCH; dy <= SEARCH; dy++) for (let dx = -SEARCH; dx <= SEARCH; dx++) {
      let votes = 0;
      // A pixel now at p was at p − shift before.
      for (const p of sample) if (previous.keys.has(key(p.x - dx, p.y - dy))) votes++;
      tally[(dy + SEARCH) * size + dx + SEARCH] = votes;
      // Prefer the smaller shift on ties: a still map must read as no movement.
      if (votes > best || (votes === best && Math.abs(dx) + Math.abs(dy) < Math.abs(shiftX) + Math.abs(shiftY))) { best = votes; shiftX = dx; shiftY = dy; }
    }
    // Thick lines also match one pixel off; a rival shift is one that is not next to the winner.
    let second = 0;
    for (let dy = -SEARCH; dy <= SEARCH; dy++) for (let dx = -SEARCH; dx <= SEARCH; dx++) if (Math.abs(dx - shiftX) > 2 || Math.abs(dy - shiftY) > 2) second = Math.max(second, tally[(dy + SEARCH) * size + dx + SEARCH]);
    const quality = best / sample.length;
    if (quality < MIN_SUPPORT || second > best * .9) {
      if (++this.lost >= MAX_LOST) this.restart();
      return { dx: 0, dy: 0, quality: Math.round(quality * 100) / 100, tracked: false };
    }
    this.lost = 0;
    // The map slides opposite to the player.
    this.position = { x: this.position.x - shiftX || 0, y: this.position.y - shiftY || 0 };
    return { dx: -shiftX || 0, dy: -shiftY || 0, quality: Math.round(quality * 100) / 100, tracked: true };
  }
}

const TRAIL_SPACING = 6, TRAIL_MAX = 600, LOOKAHEAD = 45, DIRECT_WITHIN = 35;
export interface TrailAim { dx: number; dy: number; via: "trail" | "direct"; trailPoints: number }
/** Where the leader has been, in the odometry frame, and the point on it to walk toward next. */
export class LeaderTrail {
  private points: KeyPoint[] = [];
  private epoch = -1;
  private nearest = 0;
  /** Records the leader at `offset` from a player at `position`. A new epoch forgets the old trail. */
  record(position: KeyPoint, offset: { dx: number; dy: number }, epoch: number): void {
    if (epoch !== this.epoch) { this.epoch = epoch; this.points = []; this.nearest = 0; }
    const at = { x: position.x + offset.dx, y: position.y + offset.dy }, last = this.points[this.points.length - 1];
    if (last && Math.hypot(at.x - last.x, at.y - last.y) < TRAIL_SPACING) return;
    this.points.push(at);
    if (this.points.length > TRAIL_MAX) { this.points.shift(); this.nearest = Math.max(0, this.nearest - 1); }
  }
  /**
   * The offset to walk toward: a point LOOKAHEAD map pixels further along the trail than the part of it
   * we are closest to, or straight at the leader when they are close or the trail has nothing to add.
   */
  aim(position: KeyPoint, offset: { dx: number; dy: number }, epoch: number): TrailAim {
    const direct: TrailAim = { dx: offset.dx, dy: offset.dy, via: "direct", trailPoints: this.points.length };
    if (epoch !== this.epoch || this.points.length < 3 || Math.hypot(offset.dx, offset.dy) <= DIRECT_WITHIN) return direct;
    // Only look forward from where we already were on the trail, so a loop in it cannot send us backwards.
    let nearest = this.nearest, nearestDistance = Infinity;
    for (let i = this.nearest; i < this.points.length; i++) { const d = Math.hypot(this.points[i].x - position.x, this.points[i].y - position.y); if (d < nearestDistance) { nearestDistance = d; nearest = i; } }
    this.nearest = nearest;
    if (this.nearest > 0) { this.points.splice(0, this.nearest); this.nearest = 0; }
    let travelled = 0, target = this.points[0];
    for (let i = 1; i < this.points.length && travelled < LOOKAHEAD; i++) { travelled += Math.hypot(this.points[i].x - this.points[i - 1].x, this.points[i].y - this.points[i - 1].y); target = this.points[i]; }
    // The trail ends at the leader: with little of it left, the leader is the target.
    if (travelled < LOOKAHEAD) return direct;
    return { dx: target.x - position.x, dy: target.y - position.y, via: "trail", trailPoints: this.points.length };
  }
  get length(): number { return this.points.length; }
}
