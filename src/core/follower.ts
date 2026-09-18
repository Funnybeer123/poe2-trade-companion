/** The planner consumes verified observations. It never reads pixels or emits OS input. */
export interface FollowPoint { x: number; y: number }
export interface FollowerConfig {
  version: 1;
  role: "leader" | "follower";
  address: string;
  port: number;
  targetName: string;
  followDistance: number;
  lootLeash: number;
  lootEnabled: boolean;
  lootScore: number;
  confidence: number;
}
export interface FollowObservation {
  capturedAt: number;
  area: string;
  player: FollowPoint;
  confidence: number;
  gameplay: boolean;
  inventoryFull: boolean;
  leader?: { name: string; area: string; position: FollowPoint; visible: boolean; confidence: number };
  /** Walkable cells in an already registered common coordinate system. Unknown cells are blocked. */
  map?: { aligned: boolean; cells: string[] };
  loot: Array<{ id: string; label: string; position: FollowPoint; score: number; confidence: number }>;
  confirmedPickupIds: string[];
}
export type FollowPhase = "acquiring" | "following" | "near-leader" | "looting" | "verifying-loot" | "rejoining" | "paused";
export interface FollowDecision {
  phase: FollowPhase;
  reason: string;
  destination?: FollowPoint;
  route: FollowPoint[];
  lootId?: string;
}
export interface FollowReplayStep { title: string; observation: FollowObservation; decision: FollowDecision }
export function defaultFollowerConfig(): FollowerConfig {
  return { version: 1, role: "follower", address: "127.0.0.1", port: 48732, targetName: "", followDistance: 2, lootLeash: 7, lootEnabled: true, lootScore: 70, confidence: .85 };
}
export function isLocalAddress(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return false;
  const parts = value.split(".").map(Number);
  if (parts.some((n, i) => n > 255 || String(n) !== value.split(".")[i])) return false;
  return parts[0] === 10 || parts[0] === 127 || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31);
}
export function parseFollowerConfig(raw: unknown): FollowerConfig {
  const c = raw as FollowerConfig | null;
  if (!c || c.version !== 1 || !["leader", "follower"].includes(c.role) || !isLocalAddress(c.address) || !Number.isInteger(c.port) || c.port < 1024 || c.port > 65535 || typeof c.targetName !== "string" || c.targetName.length > 80 || typeof c.lootEnabled !== "boolean") throw new Error("Choose a PC role, a local IPv4 address, and a port between 1024 and 65535.");
  for (const [key, min, max] of [["followDistance", 1, 10], ["lootLeash", 2, 25], ["lootScore", 0, 100], ["confidence", .5, 1]] as const) {
    if (!Number.isFinite(c[key]) || c[key] < min || c[key] > max) throw new Error(`Invalid ${key}.`);
  }
  if (c.lootLeash <= c.followDistance) throw new Error("Loot leash must exceed the following distance.");
  return { version: 1, role: c.role, address: c.address, port: c.port, targetName: c.targetName.trim(), followDistance: c.followDistance, lootLeash: c.lootLeash, lootEnabled: c.lootEnabled, lootScore: c.lootScore, confidence: c.confidence };
}
const distance = (a: FollowPoint, b: FollowPoint) => Math.hypot(a.x - b.x, a.y - b.y);
function point(p: FollowPoint): boolean { return !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.y >= 0 && p.x < 64 && p.y < 64; }
function confidence(n: number): boolean { return Number.isFinite(n) && n >= 0 && n <= 1; }
export function validFollowObservation(f: FollowObservation): boolean {
  if (!f || !Number.isFinite(f.capturedAt) || typeof f.area !== "string" || f.area.length > 120 || !point(f.player) || !confidence(f.confidence) || typeof f.gameplay !== "boolean" || typeof f.inventoryFull !== "boolean") return false;
  if (!Array.isArray(f.loot) || f.loot.length > 100 || !Array.isArray(f.confirmedPickupIds) || f.confirmedPickupIds.length > 100 || f.confirmedPickupIds.some(id => typeof id !== "string" || id.length > 100)) return false;
  if (f.loot.some(l => !l || typeof l.id !== "string" || l.id.length > 100 || typeof l.label !== "string" || l.label.length > 200 || !point(l.position) || !confidence(l.confidence) || !Number.isFinite(l.score) || l.score < 0 || l.score > 100)) return false;
  if (f.leader && (typeof f.leader.name !== "string" || f.leader.name.length > 80 || typeof f.leader.area !== "string" || f.leader.area.length > 120 || !point(f.leader.position) || !confidence(f.leader.confidence) || typeof f.leader.visible !== "boolean")) return false;
  if (f.map && (typeof f.map.aligned !== "boolean" || !Array.isArray(f.map.cells) || f.map.cells.length < 1 || f.map.cells.length > 64 || f.map.cells.some(row => typeof row !== "string" || !/^[.#?]{1,64}$/.test(row) || row.length !== f.map!.cells[0].length))) return false;
  return true;
}
/** Four-way BFS prevents diagonal corner cutting and never crosses an unknown cell. */
export function followRoute(cells: string[], start: FollowPoint, end: FollowPoint): FollowPoint[] {
  const from = { x: Math.floor(start.x), y: Math.floor(start.y) }, to = { x: Math.floor(end.x), y: Math.floor(end.y) };
  const key = (p: FollowPoint) => `${p.x},${p.y}`;
  if (cells[from.y]?.[from.x] !== "." || cells[to.y]?.[to.x] !== ".") return [];
  const queue = [from], parent = new Map<string, FollowPoint | null>([[key(from), null]]);
  for (let i = 0; i < queue.length; i++) {
    const here = queue[i];
    if (key(here) === key(to)) {
      const route: FollowPoint[] = [];
      let current: FollowPoint | null = here;
      while (current) { route.push(current); current = parent.get(key(current)) ?? null; }
      return route.reverse();
    }
    for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
      const next = { x: here.x + dx, y: here.y + dy };
      if (cells[next.y]?.[next.x] === "." && !parent.has(key(next))) { parent.set(key(next), here); queue.push(next); }
    }
  }
  return [];
}
export class FollowerPlanner {
  private pending?: { id: string; attempts: number; at: number };
  private skipped = new Set<string>();
  private area?: string;
  private lastCapturedAt = -Infinity;
  private progress?: { player: FollowPoint; destination: FollowPoint; since: number };
  constructor(private readonly config: FollowerConfig) {}
  decide(f: FollowObservation, now: number): FollowDecision {
    const result = (phase: FollowPhase, reason: string): FollowDecision => ({ phase, reason, route: [] });
    const pause = (reason: string) => { this.pending = undefined; this.progress = undefined; return result("paused", reason); };
    if (!validFollowObservation(f)) return pause("Invalid observation; waiting for verified perception.");
    if (now - f.capturedAt > 500 || now < f.capturedAt || f.capturedAt <= this.lastCapturedAt) return pause("Stale or out-of-order observation.");
    this.lastCapturedAt = f.capturedAt;
    if (this.area !== f.area) { this.area = f.area; this.pending = undefined; this.skipped.clear(); this.progress = undefined; }
    if (!f.gameplay || f.confidence < this.config.confidence) return pause("Gameplay is covered or uncertain.");
    const leader = f.leader;
    if (!this.config.targetName || !leader || leader.name !== this.config.targetName || leader.confidence < this.config.confidence) { this.pending = undefined; this.progress = undefined; return result("acquiring", "Waiting for the selected character."); }
    if (leader.area !== f.area) return pause("Leader changed area; transition needs verification.");
    const separation = distance(f.player, leader.position);
    const navigate = (destination: FollowPoint, phase: FollowPhase, reason: string): FollowDecision => {
      if (!f.map?.aligned) return pause("Waiting for a map aligned to the follower's position.");
      const route = followRoute(f.map.cells, f.player, destination);
      if (!route.length) return pause("No verified walkable route; unknown terrain is blocked.");
      if (!this.progress || distance(this.progress.player, f.player) >= .5 || distance(this.progress.destination, destination) >= 1) this.progress = { player: { ...f.player }, destination: { ...destination }, since: now };
      else if (now - this.progress.since >= 2000) return result("paused", "No movement progress for two seconds; route needs recovery.");
      return { phase, reason, route, destination: route[1] ?? route[0] };
    };
    if (!leader.visible || separation > this.config.lootLeash) {
      this.pending = undefined;
      return navigate(leader.position, "rejoining", "Suspend looting and rejoin the leader along the verified map.");
    }
    if (!this.config.lootEnabled || f.inventoryFull) this.pending = undefined;
    if (this.pending) {
      if (f.confirmedPickupIds.includes(this.pending.id)) this.pending = undefined;
      else if (now - this.pending.at < 750) return { ...result("verifying-loot", "Waiting for pickup evidence."), lootId: this.pending.id };
      else if (this.pending.attempts >= 2 || !f.loot.some(l => l.id === this.pending!.id)) { this.skipped.add(this.pending.id); this.pending = undefined; }
    }
    if (this.config.lootEnabled && !f.inventoryFull) {
      const eligible = f.loot.filter(l => !this.skipped.has(l.id) && !f.confirmedPickupIds.includes(l.id) && l.score >= this.config.lootScore && l.confidence >= this.config.confidence && distance(l.position, leader.position) <= this.config.lootLeash && distance(l.position, f.player) <= 3 && (!this.pending || this.pending.id === l.id));
      eligible.sort((a, b) => b.score - a.score || distance(a.position, f.player) - distance(b.position, f.player) || a.id.localeCompare(b.id));
      for (const loot of eligible) {
        if (!f.map?.aligned || !followRoute(f.map.cells, f.player, loot.position).length) continue;
        this.pending = { id: loot.id, attempts: (this.pending?.attempts ?? 0) + 1, at: now };
        this.progress = undefined;
        return { phase: "looting", reason: `Collect ${loot.label}; leader is within the loot leash.`, destination: loot.position, route: followRoute(f.map.cells, f.player, loot.position), lootId: loot.id };
      }
      this.pending = undefined;
    }
    if (separation <= this.config.followDistance) { this.progress = undefined; return result("near-leader", f.inventoryFull ? "Inventory full; looting paused. Holding near leader." : "Within following distance."); }
    return navigate(leader.position, "following", f.inventoryFull ? "Inventory full; continue following without looting." : "Follow the selected character.");
  }
}
