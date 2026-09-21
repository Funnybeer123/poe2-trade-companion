import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { parseMapCalibration } from "../src/core/followerMapMarker.js";
import { CONFIRM_BAND, CONFIRM_CHANNEL, CONFIRM_POINT_CAP, CONFIRM_THRESHOLD, confirmDialog, confirmOk } from "../src/core/followerConfirm.js";
import { findTravelButton, PARTY_BAND, PARTY_CHANNEL, PARTY_POINT_CAP, PARTY_THRESHOLD } from "../src/core/followerParty.js";
import { KillSwitch } from "../src/core/killSwitch.js";
import type { QaActionTrace } from "../src/core/types.js";
import { defaultDriveSettings, driveAudit, FollowerDriveService, MANUAL_HOLD_REASON, parseDriveSettings } from "../src/main/followerDriveService.js";

// SYNTHETIC hosts. A scripted scene replaces the desktop and two plain objects replace the
// PowerShell capture and input workers: nothing is spawned, nothing is captured, and no OS input
// (cursor, mouse button, keyboard) is possible from this file. "Clicks" are entries in an array.
//
// Determinism: the synthetic hosts answer within microtasks, so one observe-decide-click cycle never
// interleaves with test code (which resumes from expect.poll timers). Tests that count clicks exactly
// freeze the service clock (`clock`) and advance it by hand; the rest only assert lower bounds.
type Payload = Record<string, unknown>;
type Offset = { dx: number; dy: number };
type Point = { x: number; y: number };
type Rgb = readonly [number, number, number];

const W = 640, H = 360;
/** The overlay map centre: the player's own marker sits at (0.4998 w, 0.4858 h). */
const ORIGIN: Point = { x: Math.round(W * .4998), y: Math.round(H * .4858) };
const DARK: Rgb = [18, 20, 24], GREEN: Rgb = [24, 236, 30], ORANGE: Rgb = [250, 140, 24];
const HWND = "66051", GAME = "PathOfExileSteam", FAR: Offset = { dx: 90, dy: -60 };

/** A 10 × 9 X marker whose centre of mass is (5, 4) from its top-left. */
const CROSS: Point[] = [];
for (let row = 0; row < 9; row++) for (const x of new Set([row, row + 1, 8 - row, 9 - row])) CROSS.push({ x, y: row });
const text = (on: (x: number, y: number) => boolean): Point[] => { const out: Point[] = []; for (let y = 0; y < 10; y++) for (let x = 0; x < 60; x++) if (on(x, y)) out.push({ x, y }); return out; };
/** Stand-ins for two different character names: text-like ink, 60 × 10. */
const LABEL_MAIN = text((x, y) => (x % 6 < 3 || y < 2) && !(x > 40 && y > 6)), LABEL_OTHER = text((x, y) => y >= 8 || x % 10 < 2);
/** Things that are not map markers: white HUD text, dim green foliage, and an orange torch far from the map centre. */
const SCENERY: Array<{ at: Point; size: number; colour: Rgb }> = [{ at: { x: 30, y: 320 }, size: 12, colour: [240, 240, 240] }, { at: { x: 520, y: 40 }, size: 14, colour: [40, 95, 45] }, { at: { x: 90, y: 60 }, size: 8, colour: ORANGE }];

interface Scene {
  /** Marker centre of each party label relative to the map centre, in map pixels. */
  leader?: Offset; twin?: Offset; other?: Offset;
  /** The player's own orange marker relative to the map centre; null hides it (a panel covers the map). */
  own: Offset | null;
  process: string; hwnd: string; view: { width: number; height: number };
  captureError?: string; overflow?: boolean;
  /** How many pixels of the leader's label something else on the map covers. */
  covered?: number;
  /** Replaces the green marker pixels of a 'key' reply with something a broken worker might send. */
  corruptPoints?: { value: unknown };
  /** Runs while a 'key' capture is "in progress". */
  onKey?: () => void;
  /** Holds a 'preview' capture open until the test lets it finish. */
  previewGate?: Promise<void>;
  /** Ground-item labels in game-client pixels, reported by op 'runs' as flat runs: `padding` flat rows (default 5), text rows with no run, `padding` flat rows. */
  loot?: LootRect[];
  /** Blue map-outline pixels for odometry: sent as `thirdPoints` of a 'key' reply when present. */
  blue?: Point[];
  /** Terrain pixels the injected map host reports for op 'terrain' (none: open ground). */
  walls?: Point[];
  /** Blue party-frame pixels the injected map host reports for the party-band 'key' scan (none: the corner is covered). */
  party?: Point[];
  /** Bright pixels the injected map host reports for the confirm-band 'key' scan. Undefined is ordinary play: far too bright, so the scan overflows its cap. */
  confirm?: Point[];
}
type Rect = { x: number; y: number; width: number; height: number };
interface LootRect extends Rect { padding?: number; colour?: Rgb }
/** A bright saturated fill, as an item filter would give a wanted item. */
const LOOT_ORANGE: Rgb = [238, 180, 97];
/** Where a click on an odd-sized label belongs: its middle pixel. */
const lootCentre = (label: LootRect): Point => ({ x: label.x + (label.width - 1) / 2, y: label.y + (label.height - 1) / 2 });
/** The capture worker's 'runs' format, written out independently of src/: 9 bytes per run, y x0 x1 as uint16 LE, then r g b. */
function flatRuns(scene: Scene, area: Rect, minLength: number, minBrightness: number): string {
  const runs: number[][] = [];
  for (const label of scene.loot ?? []) {
    const padding = label.padding ?? 5, colour = label.colour ?? LOOT_ORANGE;
    for (let row = 0; row < label.height; row++) {
      if (row >= padding && row < label.height - padding) continue; // text rows: nothing flat and long enough to report
      const y = label.y + row, x0 = Math.max(label.x, area.x), x1 = Math.min(label.x + label.width - 1, area.x + area.width - 1);
      if (y >= area.y && y < area.y + area.height && x1 - x0 + 1 >= minLength && Math.max(...colour) >= minBrightness) runs.push([y, x0, x1, ...colour]);
    }
  }
  runs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const bytes = Buffer.alloc(runs.length * 9);
  runs.forEach(([y, x0, x1, r, g, b], i) => { bytes.writeUInt16LE(y, i * 9); bytes.writeUInt16LE(x0, i * 9 + 2); bytes.writeUInt16LE(x1, i * 9 + 4); bytes[i * 9 + 6] = r; bytes[i * 9 + 7] = g; bytes[i * 9 + 8] = b; });
  return bytes.toString("base64");
}
function encodePoints(points: Point[], rect: Rect): string {
  const inside = points.filter(p => p.x >= rect.x && p.y >= rect.y && p.x < rect.x + rect.width && p.y < rect.y + rect.height);
  const bytes = Buffer.alloc(inside.length * 4);
  inside.forEach((p, i) => { bytes.writeUInt16LE(p.x, i * 4); bytes.writeUInt16LE(p.y, i * 4 + 2); });
  return bytes.toString("base64");
}
/** A fixed pseudo-random scatter of map-outline pixels round the map centre: it matches itself at no shift and nowhere else. */
function outlines(count = 160): Point[] {
  let seed = 12345;
  const next = () => (seed = seed * 48271 % 2147483647) / 2147483647;
  return Array.from({ length: count }, () => ({ x: ORIGIN.x - 70 + Math.floor(next() * 140), y: ORIGIN.y - 50 + Math.floor(next() * 100) }));
}
const markerBox = (at: Offset): Point => ({ x: ORIGIN.x + at.dx - 5, y: ORIGIN.y + at.dy - 4 });
const labelRect = (at: Offset) => ({ x: markerBox(at).x - 25, y: markerBox(at).y - 14, width: 60, height: 10 });
function ink(scene: Scene): Map<number, Rgb> {
  const pixels = new Map<number, Rgb>();
  const put = (sprite: Point[], left: number, top: number, colour: Rgb) => { for (const p of sprite) { const x = left + p.x, y = top + p.y; if (x >= 0 && y >= 0 && x < W && y < H) pixels.set(y * W + x, colour); } };
  for (const s of SCENERY) for (let y = 0; y < s.size; y++) for (let x = 0; x < s.size; x++) pixels.set((s.at.y + y) * W + s.at.x + x, s.colour);
  if (scene.own) put(CROSS, markerBox(scene.own).x, markerBox(scene.own).y, ORANGE);
  // Party markers are drawn over the player's own, as when the leader stands on the follower.
  for (const [at, sprite] of [[scene.other, LABEL_OTHER], [scene.twin, LABEL_MAIN], [scene.leader, LABEL_MAIN]] as const) {
    if (at) { put(CROSS, markerBox(at).x, markerBox(at).y, GREEN); put(at === scene.leader ? sprite.slice(scene.covered ?? 0) : sprite, labelRect(at).x, labelRect(at).y, GREEN); }
  }
  return pixels;
}
/** The native host's channel formulas, written out independently of src/. */
function channel([r, g, b]: Rgb, name: unknown): number {
  if (name === "green") return Math.max(0, g - Math.max(r, b));
  if (name === "orange") return Math.max(0, Math.min(r - g, g - b));
  if (name === "white") return Math.min(r, g, b);
  throw new Error("Unknown channel");
}
function keyPoints(scene: Scene, rect: { x: number; y: number; width: number; height: number }, name: unknown, threshold: number): string {
  const found: number[] = [];
  for (const [index, colour] of [...ink(scene)].sort((a, b) => a[0] - b[0])) {
    const x = index % W, y = Math.floor(index / W);
    if (x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height && channel(colour, name) >= threshold) found.push(x, y);
  }
  const bytes = Buffer.alloc(found.length * 2);
  found.forEach((value, i) => bytes.writeUInt16LE(value, i * 2));
  return bytes.toString("base64");
}
function crc(bytes: Buffer): number { let c = ~0; for (const b of bytes) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; } return ~c >>> 0; }
function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8); head.writeUInt32BE(body.length); head.write(type, 4, "latin1");
  const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), body])));
  return Buffer.concat([head, body, tail]);
}
/** A real 8-bit RGB PNG of the scene, as the capture worker's 'preview' would return. */
function png(scene: Scene): Buffer {
  const stride = W * 3 + 1, raw = Buffer.alloc(stride * H), painted = ink(scene);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) (painted.get(y * W + x) ?? DARK).forEach((v, c) => { raw[y * stride + 1 + x * 3 + c] = v; });
  const header = Buffer.alloc(13); header.writeUInt32BE(W, 0); header.writeUInt32BE(H, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

interface Attempt { payload: Payload; clock: number; newestCaptureQpc: number }
interface Rig {
  service: FollowerDriveService; directory: string; scene: Scene; killSwitch: KillSwitch;
  follow: { targetName: string; followDistance: number; confidence: number; lootEnabled?: boolean; lootLeash?: number };
  blocked?: string; globalDryRun: boolean;
  /** Service clock. A number freezes time until the test advances it; undefined uses the real clock. */
  clock?: number;
  capture: Payload[]; input: Payload[];
  /** Every 'moveclick' the synthetic input host received. */
  attempts: Attempt[];
  /** Refusals for the next 'moveclick' requests, in order; an Error makes the transport itself fail. */
  refusals: Array<string | Error>;
  latencies: number[];
  capturePing: Payload | Error; inputPing: Payload | Error; releaseFails: boolean;
  /** Every guarded Escape tap the synthetic input host received, and refusals to hand back for them, in order. */
  escapes: Payload[]; escapeRefusals: string[];
  created: { capture: number; input: number };
  newestCaptureQpc: number;
  traces: QaActionTrace[];
  /** The status reason each cycle left behind, sampled when the next capture begins. */
  reasons: Set<string>;
  /** Requests the injected map host received (only with `setup({ mapHost: true })`). */
  map: Payload[];
  /** capturedAtQpcMs of every 'runs' reply. */
  scanQpc: number[];
  /** capturedAtQpcMs of every party-band 'key' reply from the map host. */
  partyQpc: number[];
  /** capturedAtQpcMs of every confirm-band 'key' reply from the map host. */
  confirmQpc: number[];
  /** Refusals for 'sprint' hold requests: the first one is used up by the next request with the same `start` flag. Letting go is never refused. */
  sprintRefusals: Array<{ start: boolean; error: string }>;
  /** How many 'release' requests are answered { ok: false } (a key is still held) before one succeeds, and when each one was asked (real time). */
  releaseRefusals: number; releasedAt: number[];
  /** Injected worker round-trip costs; see `Latency`. Undefined everywhere except the freshness measurements. */
  latency?: Latency;
}
/**
 * What one worker round trip costs the loop, in milliseconds of the service clock: a floor plus a cubed-uniform
 * tail, so most requests cost about the floor and a few cost several times it — the shape the live percentiles
 * show (cycle 28.5 / 52 ms against capture→click 58 / 117 ms).
 */
type Cost = readonly [floor: number, tail: number];
/**
 * With `latency` set the rig stops being instantaneous and starts charging the loop for every worker request,
 * on a frozen clock that only these costs advance. Three things then become true at once, and together they
 * reproduce a stale refusal with no game in the room:
 *
 * - `capturedAtQpcMs` is the clock at the moment the worker took the capture, so the QPC domain the native
 *   freshness guard reads and the service clock are the same domain, exactly as they are live (both are QPC);
 * - the synthetic input host applies that guard itself, as `GuardedClick` does in
 *   `scripts/win-follower-input-host.ps1`: a capture older than `maxAgeMs` when the click finally goes out is
 *   refused with the worker's own words, however fresh it was when the click was decided;
 * - `captureToInputMs` is then the real age of that capture rather than a scripted number.
 *
 * `key` is the marker capture AND the decode that follows it, because the service's own `cycleMs` measures
 * exactly that span; `runs` likewise covers the loot scan and the label detection it feeds.
 */
interface Latency { key?: Cost; runs?: Cost; input?: Cost; sprint?: Cost; map?: Cost }
const rigs: Rig[] = [], directories: string[] = [];
const temporary = () => { const d = mkdtempSync(path.join(tmpdir(), "poe-follower-drive-")); directories.push(d); return d; };
function setup(options: { directory?: string; clock?: number; scene?: Partial<Scene>; killSwitch?: KillSwitch; mapHost?: boolean; latency?: Latency } = {}): Rig {
  const rig: Rig = {
    service: undefined as unknown as FollowerDriveService, directory: options.directory ?? temporary(), killSwitch: options.killSwitch ?? new KillSwitch(),
    scene: { leader: FAR, own: { dx: 0, dy: 0 }, process: GAME, hwnd: HWND, view: { width: W, height: H }, ...options.scene },
    follow: { targetName: "Main", followDistance: 2, confidence: .85 }, globalDryRun: false, clock: options.clock,
    capture: [], input: [], attempts: [], refusals: [], latencies: [37], capturePing: { ok: true }, inputPing: { ok: true }, releaseFails: false, escapes: [], escapeRefusals: [],
    created: { capture: 0, input: 0 }, newestCaptureQpc: 5_000_000, traces: [], reasons: new Set(),
    map: [], scanQpc: [], partyQpc: [], confirmQpc: [], sprintRefusals: [], releaseRefusals: 0, releasedAt: [],
    latency: options.latency,
  };
  const now = () => rig.clock ?? performance.now();
  // One deterministic stream for every cost in the run, so the same scenario always produces the same
  // refusals: the whole measurement is a function of the injected costs, never of how fast the test host is.
  let seed = 20_260_919;
  const dice = () => (seed = seed * 48_271 % 2_147_483_647) / 2_147_483_647;
  /** Charges one round trip to the service clock and returns what it cost. Without `latency` nothing costs anything. */
  const spend = (cost?: Cost): number => {
    if (!cost || rig.latency === undefined || rig.clock === undefined) return 0;
    const ms = cost[0] + Math.round(cost[1] * dice() ** 3);
    rig.clock += ms;
    return ms;
  };
  /** The capture instant the reply will carry: the clock as the worker enters its handler, before the capture itself. */
  const capturedAt = (): number => { if (rig.latency && rig.clock !== undefined) rig.newestCaptureQpc = rig.clock; else rig.newestCaptureQpc += 9; return rig.newestCaptureQpc; };
  /**
   * The native worker's own freshness rule, applied after the round trip this request cost: `GuardedClick`
   * and `Sprint` both re-check the capture's age when the input actually goes out, not when it was decided.
   */
  const stale = (payload: Payload): boolean => rig.latency !== undefined && rig.clock !== undefined
    && Number.isFinite(Number(payload.capturedAtQpcMs)) && rig.clock - Number(payload.capturedAtQpcMs) > Number(payload.maxAgeMs);
  rig.service = new FollowerDriveService({
    directory: rig.directory, killSwitch: rig.killSwitch, mode: "authorized-qa", pollMs: 2, now,
    follow: () => ({ ...rig.follow }), blocked: () => rig.blocked, globalDryRun: () => rig.globalDryRun, audit: traces => { rig.traces.push(...traces); },
    createCaptureHost: () => {
      rig.created.capture++;
      return {
        send: async (payload: Payload) => {
          rig.capture.push(payload);
          if (payload.op === "ping") { if (rig.capturePing instanceof Error) throw rig.capturePing; return rig.capturePing; }
          const scene = rig.scene;
          if (scene.captureError) return { ok: false, error: scene.captureError };
          const shared = { ok: true, hwnd: scene.hwnd, process: scene.process, ...scene.view, captureMs: 3 };
          if (payload.op === "preview") await scene.previewGate;
          if (payload.op === "preview") return { ...shared, pixels: "", image: `data:image/png;base64,${png(scene).toString("base64")}` };
          if (payload.op === "runs") {
            const at = capturedAt(); rig.scanQpc.push(at); spend(rig.latency?.runs);
            const scanned = { x: Number(payload.x), y: Number(payload.y), width: Number(payload.width), height: Number(payload.height) };
            return { ...shared, capturedAtQpcMs: at, overflow: false, runs: flatRuns(scene, scanned, Number(payload.minLength), Number(payload.minBrightness)) };
          }
          if (payload.op !== "key") return { ok: false, error: "Unknown follower capture operation" };
          rig.reasons.add(rig.service.status().reason);
          scene.onKey?.();
          const second = payload.second as { x: number; y: number; width: number; height: number; channel: string; threshold: number };
          const area = payload.full === true ? { x: 0, y: 0, ...scene.view } : { x: Number(payload.x), y: Number(payload.y), width: Number(payload.width), height: Number(payload.height) };
          const at = capturedAt(); spend(rig.latency?.key);
          return {
            ...shared, capturedAtQpcMs: at,
            overflow: !!scene.overflow, points: scene.corruptPoints ? scene.corruptPoints.value : scene.overflow ? "" : keyPoints(scene, area, payload.channel, Number(payload.threshold)),
            secondOverflow: false, secondPoints: keyPoints(scene, second, second.channel, second.threshold),
            ...(scene.blue ? { thirdOverflow: false, thirdPoints: encodePoints(scene.blue, payload.third as Rect) } : {}),
          };
        },
        close: async () => { rig.capture.push({ op: "closed" }); },
      };
    },
    createInputHost: () => {
      rig.created.input++;
      return {
        send: async (payload: Payload) => {
          rig.input.push(payload);
          if (payload.op === "ping") { if (rig.inputPing instanceof Error) throw rig.inputPing; return rig.inputPing; }
          if (payload.op === "release") {
            if (rig.releaseFails) throw new Error("win-input-host-closed");
            rig.releasedAt.push(performance.now());
            spend(rig.latency?.sprint);
            return rig.releaseRefusals-- > 0 ? { ok: false, error: "Space is still held" } : { ok: true };
          }
          if (payload.op === "sprint") {
            const refusal = rig.sprintRefusals[0];
            const scripted = payload.hold === true && refusal && refusal.start === payload.start;
            if (payload.hold === true) spend(rig.latency?.sprint);
            if (!scripted) return payload.hold === true && stale(payload) ? { ok: false, error: "Stale capture" } : { ok: true };
            rig.sprintRefusals.shift();
            return { ok: false, error: refusal!.error };
          }
          // A guarded Escape tap: no cursor movement and no click, so it is recorded on its own.
          if (payload.op === "key") { rig.escapes.push(payload); const refusal = rig.escapeRefusals.shift(); return refusal ? { ok: false, error: refusal } : { ok: true }; }
          if (payload.op !== "moveclick") return { ok: false, error: "Unknown follower input operation" };
          rig.attempts.push({ payload, clock: now(), newestCaptureQpc: rig.newestCaptureQpc });
          const refusal = rig.refusals.shift();
          if (refusal instanceof Error) throw refusal;
          if (refusal) return { ok: false, error: refusal };
          spend(rig.latency?.input);
          if (stale(payload)) return { ok: false, error: "Stale capture" };
          return { ok: true, inputMs: 21, captureToInputMs: rig.latency ? rig.clock! - Number(payload.capturedAtQpcMs) : rig.latencies.length > 1 ? rig.latencies.shift() : rig.latencies[0] };
        },
        close: async () => { rig.input.push({ op: "closed" }); },
      };
    },
    // Without `mapHost` no map worker exists at all, exactly as before: terrain planning is simply off.
    ...(options.mapHost ? {
      createMapHost: () => ({
        send: async (payload: Payload) => {
          rig.map.push(payload);
          const scene = rig.scene;
          // The party frame and the teleport confirmation are read by the same 'key' op as the markers, on this
          // second worker, and are told apart by the channel each one asks for.
          if (payload.op === "key") {
            capturedAt(); spend(rig.latency?.map);
            const rect = payload as unknown as Rect, reply = { ok: true, hwnd: scene.hwnd, process: scene.process, ...scene.view, captureMs: 4, capturedAtQpcMs: rig.newestCaptureQpc };
            if (payload.channel === CONFIRM_CHANNEL) {
              rig.confirmQpc.push(rig.newestCaptureQpc);
              const inside = (scene.confirm ?? []).filter(p => p.x >= rect.x && p.y >= rect.y && p.x < rect.x + rect.width && p.y < rect.y + rect.height);
              // No confirm scene at all is ordinary play: the worker gives up at the cap and says so.
              const overflow = !scene.confirm || inside.length > Number(payload.cap);
              return { ...reply, overflow, points: overflow ? "" : encodePoints(inside, rect) };
            }
            rig.partyQpc.push(rig.newestCaptureQpc);
            return { ...reply, overflow: false, points: encodePoints(scene.party ?? [], rect) };
          }
          if (payload.op !== "terrain") return { ok: false, error: "Unknown follower capture operation" };
          // The scan itself is asynchronous, but decoding its pixels and running A* share the one JS thread,
          // so the cost is charged where it lands: inside whatever the loop happens to be doing.
          spend(rig.latency?.map);
          return { ok: true, hwnd: scene.hwnd, process: scene.process, ...scene.view, captureMs: 5, capturedAtQpcMs: rig.newestCaptureQpc, overflow: false, points: encodePoints(scene.walls ?? [], payload as unknown as Rect) };
        },
        close: async () => { rig.map.push({ op: "closed" }); },
      }),
    } : {}),
  });
  rigs.push(rig);
  return rig;
}
/** Calibrated on the clean scene (leader far away, own marker at the centre), logs emptied. */
async function calibrated(options: Parameters<typeof setup>[0] = {}): Promise<Rig> {
  const rig = setup(options);
  await rig.service.calibrate();
  rig.capture.length = 0;
  return rig;
}
const goLive = (rig: Rig, settings: { mapScale?: number; clickIntervalMs?: number; sprint?: boolean } = {}) => rig.service.configure({ version: 1, dryRun: false, mapScale: 7, clickIntervalMs: 100, ...settings });
const soon = { timeout: 5000, interval: 4 };
const ops = (log: Payload[]) => log.map(entry => String(entry.op));
/** The counters, including `teleports`, `confirms` and `panelEscapes`, which the service reports but the shared status type does not name. */
const stats = (rig: Rig) => (rig.service.status().stats ?? { cycles: 0, clicks: 0, previewed: 0, refused: 0, manualTakeovers: 0, lootScans: 0, lootLabels: 0, lootClicks: 0, sprints: 0, teleports: 0, confirms: 0, panelEscapes: 0 }) as
  Record<"cycles" | "clicks" | "previewed" | "refused" | "manualTakeovers" | "lootScans" | "lootLabels" | "lootClicks" | "sprints" | "teleports" | "confirms" | "panelEscapes", number>;
/** Advances the frozen clock by one loot-scan period (250 ms) and waits for the scan that earns. Everything the scan leads to happens in the same cycle. */
async function nextScan(rig: Rig): Promise<void> {
  const from = stats(rig).lootScans;
  rig.clock! += 250;
  await expect.poll(() => stats(rig).lootScans, soon).toBe(from + 1);
}
const sprintOps = (rig: Rig) => rig.input.filter(entry => entry.op === "sprint");
const clicksIn = (rig: Rig, area: "move" | "loot" | "party" | "confirm") => rig.attempts.filter(attempt => attempt.payload.area === area);
/** Waits until the loop has completed `count` more observe-decide cycles. */
async function cycles(rig: Rig, count = 8): Promise<void> {
  const from = stats(rig).cycles;
  await expect.poll(() => stats(rig).cycles - from, soon).toBeGreaterThanOrEqual(count);
}
/** A stopped loop makes no further capture requests. */
async function cyclesNever(rig: Rig): Promise<void> {
  const keys = ops(rig.capture).filter(op => op === "key").length;
  await new Promise(resolve => setTimeout(resolve, 40));
  expect(ops(rig.capture).filter(op => op === "key").length).toBe(keys);
}
/**
 * Where the design says a click for this map offset lands: origin + unit(offset) × clamp(distance × mapScale, 0.06 h, 0.26 h).
 * Steering then pulls the target into 0.29 h of the VIEW centre; at 640 × 360 the map centre is 5 px from the view centre
 * and 0.26 h + 5 < 0.29 h, so that second clamp never moves a target in this file.
 */
function expectedClick(offset: Offset, mapScale: number): Point {
  const distance = Math.hypot(offset.dx, offset.dy), radius = Math.max(H * .06, Math.min(H * .26, distance * mapScale));
  return { x: Math.round(ORIGIN.x + offset.dx / distance * radius), y: Math.round(ORIGIN.y + offset.dy / distance * radius) };
}
/** The native worker's pure Check(): movement clicks stay in a central disc of radius 0.30 × view height. */
const insideSafeDisc = (p: Payload) => Math.hypot(Number(p.x) - W / 2, Number(p.y) - H / 2) <= H * .30;

afterEach(() => {
  rigs.splice(0).forEach(rig => rig.service.stop());
  directories.splice(0).forEach(d => rmSync(d, { recursive: true, force: true }));
});

describe("follow drive calibration (synthetic capture host)", () => {
  it("calibrates from one preview frame, persists map-calibration.json, and restores it after a restart", async () => {
    const rig = setup();
    expect(rig.service.status()).toMatchObject({ running: false, dryRun: true, calibration: undefined, calibrationIssue: undefined, stats: undefined, settings: defaultDriveSettings() });
    const result = await rig.service.calibrate();
    expect(result.capture).toMatchObject({ width: W, height: H, image: expect.stringMatching(/^data:image\/png;base64,/) });
    expect(result).toMatchObject({ running: false, reason: "Calibrated on Main's map label. Start following.", calibrationIssue: undefined });
    expect(result.calibration).toMatchObject({ targetName: "Main", view: { width: W, height: H }, origin: ORIGIN, labelPixels: LABEL_MAIN.length });
    // The status shows the operator whose name was captured: the label as rows of # and . inside the template's one-pixel
    // dark border. Nothing else of the templates leaves the calibration file.
    const row = (y: number) => Array.from({ length: 60 }, (_, x) => LABEL_MAIN.some(p => p.x === x && p.y === y) ? "#" : ".").join("");
    expect(result.calibration!.labelMask).toEqual([".".repeat(62), ...Array.from({ length: 10 }, (_, y) => `.${row(y)}.`), ".".repeat(62)]);
    expect(Object.keys(result.calibration!).sort()).toEqual(["calibratedAt", "labelMask", "labelPixels", "markerOffset", "origin", "targetName", "view"]);
    // Calibration is capture-only: one preview on a worker that is closed again, and no input worker at all.
    expect(ops(rig.capture)).toEqual(["preview", "closed"]);
    expect(rig.created).toEqual({ capture: 1, input: 0 });
    const file = path.join(rig.directory, "map-calibration.json"), saved = parseMapCalibration(JSON.parse(readFileSync(file, "utf8")));
    expect(saved).toMatchObject({ version: 1, targetName: "Main", view: { width: W, height: H }, calibratedAt: result.calibration!.calibratedAt });
    expect(saved.originAnchor.x + Math.floor(saved.originTemplate.width / 2)).toBe(ORIGIN.x);
    expect(saved.originAnchor.y + Math.floor(saved.originTemplate.height / 2)).toBe(ORIGIN.y);
    expect(readdirSync(rig.directory)).toEqual(["map-calibration.json"]);

    const restarted = setup({ directory: rig.directory });
    expect(restarted.service.status().calibration).toEqual(result.calibration);
    expect(restarted.service.status().calibrationIssue).toBeUndefined();
    await restarted.service.start();
    await expect.poll(() => restarted.service.status().observation?.leaderFound, soon).toBe(true);
    expect(ops(restarted.capture)).not.toContain("preview");
    expect(restarted.service.status().observation).toMatchObject({
      identity: { name: "Main", method: "map-label-template" }, origin: ORIGIN, leader: { x: ORIGIN.x + FAR.dx, y: ORIGIN.y + FAR.dy },
      offset: { dx: FAR.dx, dy: FAR.dy, distance: Math.round(Math.hypot(FAR.dx, FAR.dy) * 10) / 10 }, confidence: 1, originVerified: true, timing: { captureMs: 3 },
    });
  });
  it("needs the operator's selection when several party labels are on the map, and then follows only that label", async () => {
    const rig = setup({ scene: { other: { dx: -120, dy: 70 } } });
    await expect(rig.service.calibrate()).rejects.toThrow("Found 2 party labels on the overlay map. Calibrate while Main is the only other party member");
    expect(rig.service.status()).toMatchObject({ calibration: undefined, reason: expect.stringContaining("Found 2 party labels") });
    await expect(rig.service.calibrate({ label: { x: 5, y: 5, width: 40, height: 20 } })).rejects.toThrow("No party label with a map marker beneath it was found in the selection");
    expect(existsSync(path.join(rig.directory, "map-calibration.json"))).toBe(false);
    const result = await rig.service.calibrate({ label: labelRect(FAR) });
    expect(result.calibration).toMatchObject({ targetName: "Main", labelPixels: LABEL_MAIN.length });
    await rig.service.start();
    await expect.poll(() => rig.service.status().observation?.leaderFound, soon).toBe(true);
    expect(rig.service.status().observation).toMatchObject({ leader: { x: ORIGIN.x + FAR.dx, y: ORIGIN.y + FAR.dy }, confidence: 1 });
    // The other party member alone on the map is not the leader.
    rig.scene.leader = undefined;
    await expect.poll(() => rig.service.status().observation?.leaderFound, soon).toBe(false);
  });
  it("explains what is missing instead of saving a calibration", async () => {
    const noLabel = setup({ scene: { leader: undefined } });
    await expect(noLabel.service.calibrate()).rejects.toThrow("No party label found on the overlay map");
    const noOwnMarker = setup({ scene: { own: null } });
    await expect(noOwnMarker.service.calibrate()).rejects.toThrow("Could not find your own marker at the centre of the overlay map");
    const offCentre = setup({ scene: { own: { dx: 40, dy: 30 } } });
    await expect(offCentre.service.calibrate()).rejects.toThrow("Could not find your own marker");
    for (const rig of [noLabel, noOwnMarker, offCentre]) {
      expect(existsSync(path.join(rig.directory, "map-calibration.json"))).toBe(false);
      expect(rig.service.status()).toMatchObject({ running: false, calibration: undefined });
      expect(ops(rig.capture)).toEqual(["preview", "closed"]);
    }
  });
  it("waits up to 15 s for game focus before calibrating, then gives up with the capture worker's own message", async () => {
    // The service clock is frozen, so the 15 s deadline passes only when the test says so; the wait itself polls every 250 ms of real time.
    const rig = setup({ clock: 1000, scene: { captureError: "Focus Path of Exile 2 to continue" } });
    const pending = rig.service.calibrate();
    let outcome: unknown = "pending";
    pending.then(() => { outcome = "calibrated"; }, (e: unknown) => { outcome = e; });
    await expect.poll(() => rig.service.status().reason, soon).toBe("Waiting for game focus — switch to Path of Exile 2.");
    rig.clock! += 14_999;
    // One millisecond short of the deadline it is still asking: the second preview from here on proves the first one did not end the wait.
    const asked = rig.capture.length;
    await expect.poll(() => rig.capture.length, soon).toBeGreaterThanOrEqual(asked + 2);
    expect(outcome).toBe("pending");
    expect(new Set(ops(rig.capture))).toEqual(new Set(["preview"]));
    rig.clock! += 1;
    await expect(pending).rejects.toThrow("Focus Path of Exile 2 to continue");
    expect(rig.service.status()).toMatchObject({ running: false, calibration: undefined, reason: "Focus Path of Exile 2 to continue" });
    expect(existsSync(path.join(rig.directory, "map-calibration.json"))).toBe(false);
    // Waiting is capture-only too: previews on one worker that is closed once, and no input worker.
    expect(ops(rig.capture).at(-1)).toBe("closed");
    expect(ops(rig.capture).filter(op => op !== "preview")).toEqual(["closed"]);
    expect(rig.created).toEqual({ capture: 1, input: 0 });
  });
  it("calibrates as soon as the game has focus, without a second worker", async () => {
    const rig = setup({ clock: 1000, scene: { captureError: "Focus Path of Exile 2 to continue" } });
    const pending = rig.service.calibrate();
    await expect.poll(() => rig.service.status().reason, soon).toBe("Waiting for game focus — switch to Path of Exile 2.");
    expect(rig.service.status()).toMatchObject({ running: false, calibration: undefined });
    rig.scene.captureError = undefined; // the operator switched to the game
    const result = await pending;
    expect(result).toMatchObject({ running: false, reason: "Calibrated on Main's map label. Start following.", calibration: { targetName: "Main", origin: ORIGIN, labelPixels: LABEL_MAIN.length } });
    expect(result.capture).toMatchObject({ width: W, height: H });
    expect(parseMapCalibration(JSON.parse(readFileSync(path.join(rig.directory, "map-calibration.json"), "utf8"))).targetName).toBe("Main");
    const previews = ops(rig.capture).filter(op => op === "preview").length;
    expect(previews).toBeGreaterThanOrEqual(2);
    expect(ops(rig.capture)).toEqual([...Array<string>(previews).fill("preview"), "closed"]);
    expect(rig.created).toEqual({ capture: 1, input: 0 });
  });
  it("gives up waiting for focus when calibration is stopped, and only a focus error is waited for", async () => {
    const rig = setup({ clock: 1000, scene: { captureError: "Focus Path of Exile 2 to continue" } });
    const pending = rig.service.calibrate();
    await expect.poll(() => rig.service.status().reason, soon).toBe("Waiting for game focus — switch to Path of Exile 2.");
    rig.service.stop("Stopped by the operator.");
    await expect(pending).rejects.toThrow("Calibration cancelled.");
    expect(rig.service.status()).toMatchObject({ calibration: undefined, reason: "Stopped by the operator." });
    expect(ops(rig.capture).filter(op => op === "closed")).toHaveLength(1);
    // Any other capture failure is reported at once.
    const broken = setup({ clock: 1000, scene: { captureError: "Game window not found" } });
    await expect(broken.service.calibrate()).rejects.toThrow("Game window not found");
    expect(ops(broken.capture)).toEqual(["preview", "closed"]);
  });
  it("refuses to capture for calibration while blocked or without a saved character name", async () => {
    const rig = setup();
    rig.blocked = "Follow & Loot is not available in this build.";
    await expect(rig.service.calibrate()).rejects.toThrow("not available in this build");
    rig.blocked = undefined; rig.follow.targetName = "";
    await expect(rig.service.calibrate()).rejects.toThrow("Enter and save the character to follow");
    expect(rig.created).toEqual({ capture: 0, input: 0 });
  });
  it("stops a running loop before calibrating again", async () => {
    const rig = await calibrated();
    await rig.service.start();
    await cycles(rig, 2);
    await rig.service.calibrate();
    expect(rig.service.status().running).toBe(false);
    await expect.poll(() => ops(rig.input), soon).toEqual(["ping", "release", "closed"]);
  });
  it("discards a calibration capture that was stopped while in flight", async () => {
    let finishPreview = () => {};
    const rig = setup({ scene: { previewGate: new Promise<void>(resolve => { finishPreview = resolve; }) } });
    const pending = rig.service.calibrate();
    await expect.poll(() => ops(rig.capture), soon).toEqual(["preview"]);
    rig.service.stop("Stopped by the operator.");
    finishPreview();
    await expect(pending).rejects.toThrow("Calibration cancelled.");
    expect(rig.service.status()).toMatchObject({ calibration: undefined, reason: "Stopped by the operator." });
    expect(existsSync(path.join(rig.directory, "map-calibration.json"))).toBe(false);
    expect(ops(rig.capture).filter(op => op === "closed")).toHaveLength(1);
  });
  it("reports an unusable saved calibration, refuses to start on it, and clears it on request", async () => {
    const directory = temporary(), file = path.join(directory, "map-calibration.json");
    writeFileSync(file, "{\"version\":1,\"targetName\":\"Main\"}");
    const rig = setup({ directory });
    expect(rig.service.status()).toMatchObject({ calibration: undefined, calibrationIssue: "Saved map calibration is invalid. Calibrate again." });
    await expect(rig.service.start()).rejects.toThrow("Saved map calibration is invalid");
    expect(rig.service.clearCalibration()).toMatchObject({ calibration: undefined, calibrationIssue: undefined, reason: "Map calibration cleared." });
    expect(existsSync(file)).toBe(false);
    await expect(rig.service.start()).rejects.toThrow("Calibrate on the overlay map first.");
    expect(rig.created).toEqual({ capture: 0, input: 0 });
  });
});

describe("follow drive start conditions (synthetic hosts, no OS input)", () => {
  it("refuses to start without calibration, for a different character, while blocked, and while the kill switch is latched", async () => {
    const fresh = setup();
    await expect(fresh.service.start()).rejects.toThrow("Calibrate on the overlay map first.");
    expect(fresh.created).toEqual({ capture: 0, input: 0 });

    const rig = await calibrated();
    rig.follow.targetName = "Other";
    expect(rig.service.status().calibrationIssue).toBe("Map calibrated for Main; calibrate again for Other.");
    await expect(rig.service.start()).rejects.toThrow("Map calibrated for Main; calibrate again for Other.");
    rig.follow.targetName = "Main";
    rig.blocked = "Follow & Loot is switched off.";
    await expect(rig.service.start()).rejects.toThrow("Follow & Loot is switched off.");
    rig.blocked = undefined;
    rig.killSwitch.trip();
    await expect(rig.service.start()).rejects.toThrow("Emergency stop latched");
    // Nothing was spawned by any refused start: one capture worker for calibration, no input worker ever.
    expect(rig.created).toEqual({ capture: 1, input: 0 });
    expect(rig.service.status().running).toBe(false);
    rig.killSwitch.rearm();
    expect((await rig.service.start()).running).toBe(true);
    expect(rig.created).toEqual({ capture: 2, input: 1 });
    // A second start while running does not spawn a second pair of workers.
    expect((await rig.service.start()).running).toBe(true);
    expect(rig.created).toEqual({ capture: 2, input: 1 });
    rig.service.stop();
    await Promise.all([rig.service.start(), rig.service.start()]);
    expect(rig.created).toEqual({ capture: 3, input: 2 });
  });
  it("asks the capture worker for sparse marker pixels only: the full view first, then a tracking window, and the full view again each second", async () => {
    const rig = await calibrated({ clock: 5000 });
    await rig.service.start();
    await cycles(rig, 4);
    const keys = () => rig.capture.filter(entry => entry.op === "key");
    const first = keys()[0], label = labelRect(FAR);
    expect(first).toMatchObject({ op: "key", x: 0, y: 0, width: W, height: H, full: true, channel: "green", second: { channel: "orange" } });
    const second = first.second as { x: number; y: number; width: number; height: number; threshold: number };
    // The orange rectangle surrounds the player's own marker with room to notice a displaced one.
    expect(second.x).toBeLessThanOrEqual(ORIGIN.x - 5 - 14);
    expect(second.y).toBeLessThanOrEqual(ORIGIN.y - 4 - 14);
    expect(second.x + second.width).toBeGreaterThanOrEqual(ORIGIN.x + 5 + 14);
    expect(second.y + second.height).toBeGreaterThanOrEqual(ORIGIN.y + 5 + 14);
    // The native worker refuses thresholds outside 20–255 and rectangles outside the view.
    for (const request of keys()) {
      const orange = request.second as typeof second;
      for (const threshold of [Number(request.threshold), orange.threshold]) { expect(threshold).toBeGreaterThanOrEqual(20); expect(threshold).toBeLessThanOrEqual(255); }
      for (const rect of [request as unknown as typeof second, orange]) {
        expect([rect.x >= 0, rect.y >= 0, rect.width >= 8, rect.height >= 8, rect.x + rect.width <= W, rect.y + rect.height <= H]).toEqual([true, true, true, true, true, true]);
      }
    }
    const windows = keys().slice(1);
    expect(windows.length).toBeGreaterThanOrEqual(3);
    for (const request of windows) {
      expect(request.full).toBe(false);
      expect(Number(request.width) * Number(request.height)).toBeLessThan(W * H / 4);
      expect([Number(request.x) <= label.x, Number(request.y) <= label.y, Number(request.x) + Number(request.width) >= label.x + label.width, Number(request.y) + Number(request.height) >= label.y + label.height]).toEqual([true, true, true, true]);
    }
    expect(rig.service.status().observation).toMatchObject({ leaderFound: true, evidence: { searched: "window" } });
    const before = keys().length;
    rig.clock! += 1000;
    await expect.poll(() => keys().slice(before).some(request => request.full === true), soon).toBe(true);
    // Following never asks for a screenshot, a dense sample, or a recording.
    expect(new Set(ops(rig.capture))).toEqual(new Set(["ping", "key"]));
  });
  it("stops and closes both workers when either fails its ping", async () => {
    const rig = await calibrated();
    rig.capturePing = { ok: false, error: "Add-Type failed" };
    expect(await rig.service.start()).toMatchObject({ running: false, reason: "Add-Type failed" });
    await expect.poll(() => [ops(rig.capture).at(-1), ops(rig.input).at(-1)], soon).toEqual(["closed", "closed"]);
    rig.capturePing = { ok: true }; rig.inputPing = new Error("win-input-host-exited:1");
    expect(await rig.service.start()).toMatchObject({ running: false, reason: "win-input-host-exited:1" });
    await cyclesNever(rig);
    expect(rig.attempts).toEqual([]);
  });
});

describe("follow drive dry-run (synthetic hosts, no OS input)", () => {
  it("is the default: decisions are previewed and traced, and the input host never receives a moveclick", async () => {
    const rig = await calibrated();
    expect(rig.service.status()).toMatchObject({ dryRun: true, settings: { dryRun: true } });
    await rig.service.start();
    await expect.poll(() => stats(rig).previewed, soon).toBeGreaterThanOrEqual(3);
    const status = rig.service.status();
    expect(status).toMatchObject({ running: true, dryRun: true, decision: { kind: expect.stringMatching(/^(move|hold)$/) }, stats: { clicks: 0, refused: 0, manualTakeovers: 0 } });
    expect(status.stats!.captureToInputMsP50).toBeUndefined();
    expect(status.stats!.captureToInputMsP95).toBeUndefined();
    expect(status.stats!.worstCaseReactionMsP95).toBeUndefined();
    expect(status.stats!.cycleMsP50).toBeGreaterThanOrEqual(0);
    await cycles(rig, 2);
    expect([...rig.reasons]).toContain(`Preview only: would move toward Main: ${Math.round(Math.hypot(FAR.dx, FAR.dy))} map px away.`);
    expect(ops(rig.input)).toEqual(["ping"]);
    expect(rig.attempts).toEqual([]);
    const target = expectedClick(FAR, 7);
    expect(rig.traces.length).toBeGreaterThanOrEqual(3);
    for (const trace of rig.traces) {
      expect(trace).toMatchObject({ scenarioId: "follow-map-marker", module: "navigation", mode: "authorized-qa", processName: GAME, decisionRule: "follow-map-marker", result: "blocked", confidence: 1, input: { kind: "click", button: "left", ...target } });
      expect(trace.reason).toContain("safety=dry-run");
    }
    rig.service.stop();
    await expect.poll(() => ops(rig.input), soon).toEqual(["ping", "release", "closed"]);
  });
  it("paces previews like clicks, so a dry run shows the real cadence", async () => {
    const rig = await calibrated({ clock: 20_000 });
    rig.service.configure({ version: 1, dryRun: true, mapScale: 7, clickIntervalMs: 500 });
    await rig.service.start();
    await expect.poll(() => stats(rig).previewed, soon).toBe(1);
    rig.clock! += 499;
    await cycles(rig);
    expect(stats(rig).previewed).toBe(1);
    expect(rig.service.status().decision).toMatchObject({ kind: "hold", reason: "Pacing movement clicks." });
    rig.clock! += 1;
    await expect.poll(() => stats(rig).previewed, soon).toBe(2);
    expect(ops(rig.input)).toEqual(["ping"]);
  });
  it("stays dry while the app-wide dry-run switch is on, whatever the saved setting says", async () => {
    const rig = await calibrated();
    goLive(rig);
    rig.globalDryRun = true;
    expect(rig.service.status()).toMatchObject({ dryRun: true, settings: { dryRun: false } });
    await rig.service.start();
    await expect.poll(() => stats(rig).previewed, soon).toBeGreaterThanOrEqual(2);
    expect(rig.attempts).toEqual([]);
    expect(stats(rig).clicks).toBe(0);
    // A run that started as a preview stays a preview: releasing the switch stops it instead of turning it live under the operator.
    rig.globalDryRun = false;
    await expect.poll(() => rig.service.status().running, soon).toBe(false);
    expect(rig.service.status()).toMatchObject({ dryRun: false, reason: "Dry-run setting changed — press Start to resume.", stats: { clicks: 0 } });
    await cyclesNever(rig);
    await expect.poll(() => ops(rig.input), soon).toEqual(["ping", "release", "closed"]);
    expect(rig.attempts).toEqual([]);
    expect(rig.traces.every(trace => trace.result === "blocked" && trace.reason.includes("safety=dry-run"))).toBe(true);
    // Going live takes a fresh Start, which snapshots the switch as it is now.
    await rig.service.start();
    await expect.poll(() => stats(rig).clicks, soon).toBeGreaterThanOrEqual(1);
    expect(stats(rig).previewed).toBe(0);
  });
  it("stops a live run when the app-wide dry-run switch turns on, and clicks no more", async () => {
    const rig = await calibrated({ clock: 25_000 });
    goLive(rig);
    await rig.service.start();
    await expect.poll(() => stats(rig).clicks, soon).toBe(1);
    rig.globalDryRun = true;
    rig.clock! += 100; // a click would be due now
    await expect.poll(() => rig.service.status().running, soon).toBe(false);
    expect(rig.service.status()).toMatchObject({ dryRun: true, reason: "Dry-run setting changed — press Start to resume.", stats: { clicks: 1, previewed: 0 } });
    await cyclesNever(rig);
    expect(rig.attempts).toHaveLength(1);
    await expect.poll(() => ops(rig.input), soon).toEqual(["ping", "moveclick", "release", "closed"]);
    // Started again with the switch on, it previews.
    await rig.service.start();
    await expect.poll(() => stats(rig).previewed, soon).toBe(1);
    expect(rig.attempts).toHaveLength(1);
  });
  it.each([["on", "a preview run never goes live"], ["off", "a live run falls back to previewing"]])("never clicks on a decision whose capture saw the dry-run switch flip (started with the switch %s: %s)", async started => {
    const rig = await calibrated({ clock: 26_000 }), startedDry = started === "on";
    goLive(rig);
    rig.globalDryRun = startedDry;
    rig.scene.onKey = () => { rig.globalDryRun = !startedDry; }; // flips after the loop's own check, while the first capture is in progress
    await rig.service.start();
    await expect.poll(() => rig.service.status().running, soon).toBe(false);
    expect(rig.service.status().reason).toBe("Dry-run setting changed — press Start to resume.");
    // The one decision made in between was previewed, in both directions.
    expect(rig.attempts).toEqual([]);
    expect(rig.traces).toHaveLength(1);
    expect(rig.traces[0]).toMatchObject({ result: "blocked", reason: expect.stringContaining("safety=dry-run") });
    expect(ops(rig.input)).not.toContain("moveclick");
  });
});

describe("follow drive live clicks (synthetic hosts: a 'click' is an array entry, no OS input)", () => {
  it("sends a guarded moveclick toward the leader, bound to the capture it was decided from", async () => {
    const rig = await calibrated();
    goLive(rig);
    expect(rig.service.status()).toMatchObject({ dryRun: false, settings: { dryRun: false, mapScale: 7, clickIntervalMs: 100 } });
    await rig.service.start();
    await expect.poll(() => stats(rig).clicks, soon).toBeGreaterThanOrEqual(3);
    rig.service.stop();
    expect(rig.attempts.length).toBeGreaterThanOrEqual(3);
    const target = expectedClick(FAR, 7);
    for (const attempt of rig.attempts) {
      // The freshest capture at the moment of the click is the one the click is bound to.
      expect(attempt.payload).toEqual({ op: "moveclick", ...target, expectedHwnd: HWND, viewWidth: W, viewHeight: H, capturedAtQpcMs: attempt.newestCaptureQpc, maxAgeMs: 120, area: "move" });
      expect(insideSafeDisc(attempt.payload)).toBe(true);
    }
    // Direction and reach, stated without the formula: up and to the right of the map centre, 0.26 h away.
    const dx = target.x - ORIGIN.x, dy = target.y - ORIGIN.y;
    expect(dx).toBeGreaterThan(0);
    expect(dy).toBeLessThan(0);
    expect(Math.atan2(dy, dx)).toBeCloseTo(Math.atan2(FAR.dy, FAR.dx), 1);
    expect(Math.hypot(dx, dy)).toBeGreaterThan(H * .26 - 1);
    expect(Math.hypot(dx, dy)).toBeLessThan(H * .26 + 1);
    const emitted = rig.traces.filter(trace => trace.result === "emitted");
    expect(emitted).toHaveLength(rig.service.status().stats!.clicks);
    expect(JSON.parse(emitted[0].evidenceHash)).toMatchObject({ hwnd: HWND, capturedAtQpcMs: rig.attempts[0].payload.capturedAtQpcMs, leader: { x: ORIGIN.x + FAR.dx, y: ORIGIN.y + FAR.dy }, origin: ORIGIN });
    expect(rig.traces.every(trace => trace.reason.includes("safety=ok") && trace.processName === GAME)).toBe(true);
  });
  it("scales the click distance by mapScale between the clamps and follows the leader's direction as it changes", async () => {
    const rig = await calibrated({ clock: 30_000 });
    rig.follow.followDistance = 1;
    goLive(rig, { mapScale: 4 });
    rig.scene.leader = { dx: -12, dy: -9 };
    await rig.service.start();
    await expect.poll(() => stats(rig).clicks, soon).toBe(1);
    // 15 map px × 4 = 60 screen px along (−0.8, −0.6).
    expect(rig.attempts[0].payload).toMatchObject({ x: ORIGIN.x - 48, y: ORIGIN.y - 36 });
    rig.scene.leader = { dx: 0, dy: 70 };
    await expect.poll(() => rig.service.status().observation?.offset, soon).toMatchObject({ dx: 0, dy: 70 });
    rig.clock! += 100;
    await expect.poll(() => stats(rig).clicks, soon).toBe(2);
    // 70 × 4 exceeds the far clamp: straight down, 0.26 h from the map centre.
    expect(rig.attempts[1].payload).toMatchObject({ x: ORIGIN.x, y: ORIGIN.y + Math.round(H * .26) });
    expect(rig.attempts.every(a => insideSafeDisc(a.payload))).toBe(true);
  });
  it("paces clicks by clickIntervalMs: no queue and no catch-up burst", async () => {
    const rig = await calibrated({ clock: 40_000 });
    goLive(rig, { clickIntervalMs: 250 });
    await rig.service.start();
    await expect.poll(() => stats(rig).clicks, soon).toBe(1);
    rig.clock! += 249;
    await cycles(rig);
    expect(rig.attempts).toHaveLength(1);
    expect(rig.service.status().decision).toMatchObject({ kind: "hold", reason: "Pacing movement clicks." });
    rig.clock! += 1;
    await expect.poll(() => stats(rig).clicks, soon).toBe(2);
    // A long gap earns exactly one click, not one per missed interval.
    rig.clock! += 5000;
    await expect.poll(() => stats(rig).clicks, soon).toBe(3);
    await cycles(rig);
    expect(rig.attempts).toHaveLength(3);
  });
  it("keeps real-time clicks at least clickIntervalMs apart", async () => {
    const rig = await calibrated();
    goLive(rig, { clickIntervalMs: 120 });
    await rig.service.start();
    await expect.poll(() => rig.attempts.length, soon).toBeGreaterThanOrEqual(4);
    rig.service.stop();
    const gaps = rig.attempts.slice(1).map((attempt, i) => attempt.clock - rig.attempts[i].clock);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(120);
  });
  it("reports cycle and capture-to-input percentiles after live clicks", async () => {
    const rig = await calibrated();
    goLive(rig);
    await rig.service.start();
    await expect.poll(() => stats(rig).clicks, soon).toBeGreaterThanOrEqual(4);
    const running = rig.service.status().stats!;
    expect(running.observationsPerSecond).toBeGreaterThan(0);
    const final = rig.service.stop().stats!;
    expect(final).toMatchObject({ previewed: 0, manualTakeovers: 0, captureToInputMsP50: 37, captureToInputMsP95: 37 });
    expect(final.clicks).toBeGreaterThanOrEqual(4);
    expect(final.cycles).toBeGreaterThanOrEqual(final.clicks);
    expect(final.cycleMsP50).toBeGreaterThanOrEqual(0);
    expect(final.cycleMsP95).toBeGreaterThanOrEqual(final.cycleMsP50!);
    expect(final.worstCaseReactionMsP95).toBeCloseTo(final.cycleMsP95! + 37, 1);
  });
  it("orders the capture-to-input percentiles over the native latencies the input host reported", async () => {
    const rig = await calibrated({ clock: 45_000 });
    rig.latencies = [30, 34, 31, 95, 33, 32, 36, 35, 38, 37];
    goLive(rig);
    await rig.service.start();
    // The clock is frozen, so each advance of one click interval earns exactly one more click.
    for (let click = 1; click <= 10; click++) { await expect.poll(() => stats(rig).clicks, soon).toBe(click); rig.clock! += 100; }
    const final = rig.service.stop().stats!;
    expect(final.clicks).toBe(10);
    // Nine samples of 30…38 and one outlier of 95: the median ignores the outlier, the 95th percentile reports it.
    expect(final.captureToInputMsP50).toBeGreaterThanOrEqual(33);
    expect(final.captureToInputMsP50).toBeLessThanOrEqual(35);
    expect(final.captureToInputMsP95).toBe(95);
    expect(final.cycleMsP50).toBe(0);
    expect(final.worstCaseReactionMsP95).toBe(95);
  });
});

describe("follow drive never clicks without a trusted sighting (synthetic hosts, no OS input)", () => {
  it("holds within the stop distance, with hysteresis between stop and resume", async () => {
    const rig = await calibrated({ clock: 60_000 });
    rig.follow.followDistance = 5; // stop inside 30 map px, resume beyond 36
    goLive(rig);
    rig.scene.leader = { dx: 33, dy: 0 };
    await rig.service.start();
    await cycles(rig);
    expect(rig.service.status()).toMatchObject({ reason: "Within following distance.", decision: { kind: "near", distance: 33 }, observation: { leaderFound: true, confidence: 1, originVerified: true } });
    expect(rig.attempts).toEqual([]);
    // The clock is frozen, so exactly one click is possible each time the test advances it by an interval.
    const see = async (dx: number) => { rig.scene.leader = { dx, dy: 0 }; await expect.poll(() => rig.service.status().observation?.offset?.distance, soon).toBe(dx); };
    await see(40);
    await expect.poll(() => stats(rig).clicks, soon).toBe(1);
    // Closing in: still beyond the stop distance, so it keeps moving.
    await see(33);
    rig.clock! += 100;
    await expect.poll(() => stats(rig).clicks, soon).toBe(2);
    await see(28);
    rig.clock! += 100;
    await cycles(rig);
    expect(rig.service.status().decision).toMatchObject({ kind: "near", distance: 28 });
    // Drifting back out to 33 is inside the resume distance: no jitter clicks.
    await see(33);
    await cycles(rig);
    expect(rig.service.status().decision).toMatchObject({ kind: "near", distance: 33 });
    expect(rig.attempts).toHaveLength(2);
    await see(37);
    await expect.poll(() => stats(rig).clicks, soon).toBe(3);
    expect(rig.attempts).toHaveLength(3);
  });
  it("treats the leader standing on the follower as near, not as a lost map centre", async () => {
    const rig = await calibrated({ clock: 61_000 });
    goLive(rig);
    await rig.service.start();
    await expect.poll(() => stats(rig).clicks, soon).toBe(1);
    // The leader walks up: a marker moves a few map px per capture, so the last step onto the follower is a short one.
    rig.scene.leader = { dx: 20, dy: -15 };
    await expect.poll(() => rig.service.status().observation?.offset, soon).toMatchObject({ dx: 20, dy: -15 });
    expect(rig.service.status().observation).toMatchObject({ originVerified: true, evidence: { originScore: 1, originSeenAgoMs: 0 } });
    rig.scene.leader = { dx: 0, dy: 0 }; // the green marker now covers the orange one completely
    await expect.poll(() => rig.service.status().decision?.kind, soon).toBe("near");
    rig.clock! += 10_000;
    await cycles(rig);
    expect(rig.service.status()).toMatchObject({ decision: { kind: "near" }, observation: { originVerified: true, evidence: { originScore: 0, originSeenAgoMs: 10_000 } } });
    // Standing on us explains a missing marker for 10 s, not for ever: after that the map centre needs a real sighting again.
    rig.clock! += 1;
    await expect.poll(() => rig.service.status().decision?.kind, soon).toBe("pause");
    expect(rig.service.status().observation).toMatchObject({ leaderFound: true, originVerified: false, evidence: { originScore: 0, originSeenAgoMs: 10_001 } });
    expect(rig.attempts).toHaveLength(1);
    // The leader steps off, the orange marker is seen in place again, and following resumes.
    rig.scene.leader = { dx: 20, dy: -15 };
    await expect.poll(() => stats(rig).clicks, soon).toBe(2);
    expect(rig.service.status().observation).toMatchObject({ originVerified: true, evidence: { originScore: 1 } });
  });
  it("pauses when the leader's label lands on the follower in one jump: the map moved, the leader did not", async () => {
    const rig = await calibrated({ clock: 62_000 });
    goLive(rig);
    await rig.service.start();
    await expect.poll(() => stats(rig).clicks, soon).toBe(1);
    // Same end state as above, reached in a single capture from 108 map px away with the orange marker gone.
    rig.scene.leader = { dx: 0, dy: 0 };
    await expect.poll(() => rig.service.status().decision?.kind, soon).toBe("pause");
    expect(rig.service.status().observation).toMatchObject({ leaderFound: true, offset: { distance: 0 }, originVerified: false, evidence: { originScore: 0, originSeenAgoMs: null } });
    rig.clock! += 100;
    await cycles(rig);
    expect(rig.attempts).toHaveLength(1);
    // The orange marker back in place is what restores trust.
    rig.scene.leader = FAR;
    await expect.poll(() => stats(rig).clicks, soon).toBe(2);
  });
  it("holds while the leader's label is absent and resumes when it returns", async () => {
    const rig = await calibrated();
    goLive(rig);
    rig.scene.leader = undefined;
    await rig.service.start();
    await cycles(rig);
    expect(rig.service.status()).toMatchObject({ running: true, reason: "Main's map label is not visible.", decision: { kind: "hold" }, observation: { leaderFound: false, leader: undefined, offset: undefined, confidence: 0 } });
    expect(rig.attempts).toEqual([]);
    expect(rig.traces).toEqual([]);
    rig.scene.leader = FAR;
    await expect.poll(() => rig.attempts.length, soon).toBeGreaterThanOrEqual(1);
    // Losing the label mid-run: no blind pursuit of the last known direction.
    rig.scene.leader = undefined;
    await expect.poll(() => rig.service.status().decision?.kind, soon).toBe("hold");
    await expect.poll(() => rig.service.status().observation?.leaderFound, soon).toBe(false);
    const attempts = rig.attempts.length;
    await cycles(rig, 12);
    expect(rig.attempts).toHaveLength(attempts);
  });
  it("holds when a look-alike label is next to the leader's, because confidence falls below the gate", async () => {
    const rig = await calibrated({ clock: 65_000 });
    goLive(rig);
    rig.scene.twin = { dx: FAR.dx, dy: FAR.dy + 40 }; // inside the tracking window around the leader's label
    await rig.service.start();
    await cycles(rig);
    const status = rig.service.status();
    expect(status).toMatchObject({ decision: { kind: "hold" }, observation: { leaderFound: true, confidence: 0, evidence: { score: 1, runnerUp: 1, candidates: 2 } } });
    expect(status.reason).toBe("Label confidence 0 is below 0.85.");
    expect(rig.attempts).toEqual([]);
    expect(rig.traces).toEqual([]);
    // The rival is gone from the window, but only the next full search can say it is gone from the map.
    rig.scene.twin = undefined;
    await expect.poll(() => rig.service.status().observation?.evidence.candidates, soon).toBe(1);
    await cycles(rig);
    expect(rig.service.status()).toMatchObject({ decision: { kind: "hold" }, observation: { confidence: 0, evidence: { score: 1, runnerUp: 1, candidates: 1, searched: "window" } } });
    expect(rig.attempts).toEqual([]);
    rig.clock! += 1000;
    await expect.poll(() => stats(rig).clicks, soon).toBe(1);
    expect(rig.service.status().observation).toMatchObject({ confidence: 1, evidence: { runnerUp: 0, candidates: 1 } });
  });
  // Ambiguity is measured by the once-a-second full search; the tracking-window captures in between cannot see a
  // rival elsewhere on the map, so they inherit that search's runner-up instead of reporting confidence 1.
  it("holds when a look-alike label is elsewhere on the map", async () => {
    const rig = await calibrated({ clock: 66_000 });
    goLive(rig);
    rig.scene.twin = { dx: -140, dy: 80 }; // same ink, far outside the tracking window around the leader's label
    await rig.service.start();
    await cycles(rig, 12);
    expect(rig.attempts).toEqual([]);
    expect(rig.service.status()).toMatchObject({ decision: { kind: "hold" }, observation: { leaderFound: true, confidence: 0, evidence: { score: 1, runnerUp: 1, candidates: 1, searched: "window" } } });
    // Another full search with the rival still there changes nothing; one without it restores confidence.
    rig.clock! += 1000;
    await cycles(rig, 12);
    expect(rig.attempts).toEqual([]);
    rig.scene.twin = undefined;
    await cycles(rig, 12);
    expect(rig.service.status()).toMatchObject({ decision: { kind: "hold" }, observation: { confidence: 0 } });
    expect(rig.attempts).toEqual([]);
    rig.clock! += 1000;
    await expect.poll(() => stats(rig).clicks, soon).toBe(1);
  });
  it("holds while a partly covered label scores below the confidence gate", async () => {
    const rig = await calibrated();
    goLive(rig);
    rig.follow.confidence = .95;
    rig.scene.covered = 50; // Dice 2 × 283 / (333 + 283) = 0.919
    await rig.service.start();
    await cycles(rig);
    expect(rig.service.status()).toMatchObject({ running: true, reason: "Label confidence 0.919 is below 0.95.", decision: { kind: "hold" }, observation: { leaderFound: true, confidence: .919, originVerified: true } });
    expect(rig.attempts).toEqual([]);
    expect(rig.traces).toEqual([]);
    rig.scene.covered = 0;
    await expect.poll(() => rig.attempts.length, soon).toBeGreaterThanOrEqual(1);
  });
  it("stops rather than clicks when the required confidence is raised above what the sighting offers", async () => {
    const rig = await calibrated();
    goLive(rig);
    rig.scene.covered = 50;
    await rig.service.start();
    await expect.poll(() => rig.attempts.length, soon).toBeGreaterThanOrEqual(1);
    expect(rig.traces.some(trace => trace.confidence === .919 && trace.result === "emitted")).toBe(true);
    // Steering keeps the gate it started with; the controller's own confidence check is the second line behind it.
    rig.follow.confidence = .95;
    await expect.poll(() => rig.service.status().running, soon).toBe(false);
    expect(rig.service.status().reason).toContain("safety=confidence-too-low");
    expect(rig.traces.at(-1)).toMatchObject({ result: "blocked", confidence: .919 });
    expect(rig.attempts).toHaveLength(rig.traces.filter(trace => trace.result === "emitted").length);
  });
  it("pauses while the orange marker is displaced or hidden: a hidden one keeps the last good sighting for 1500 ms, a displaced one for no time at all", async () => {
    const rig = await calibrated({ clock: 70_000 });
    goLive(rig);
    rig.scene.own = { dx: 18, dy: 0 };   // past the drift the map itself shows, so the centre really has moved
    await rig.service.start();
    await cycles(rig);
    expect(rig.service.status()).toMatchObject({ decision: { kind: "pause" }, observation: { leaderFound: true, confidence: 1, originVerified: false, evidence: { originSeenAgoMs: null } } });
    expect(rig.service.status().reason).toContain("not at the calibrated map centre");
    rig.scene.own = null;
    await cycles(rig);
    expect(rig.service.status()).toMatchObject({ decision: { kind: "pause" }, observation: { originVerified: false, evidence: { originScore: 0 } } });
    expect(rig.attempts).toEqual([]);
    // A few pixels of wobble are still the map centre.
    rig.scene.own = { dx: 4, dy: -4 };
    await expect.poll(() => stats(rig).clicks, soon).toBe(1);
    // Hidden mid-run (an effect washes it out): the last in-place sighting at t = 70 000 is trusted up to and including 71 500.
    rig.scene.own = null;
    await expect.poll(() => rig.service.status().observation?.evidence.originScore, soon).toBe(0);
    rig.clock! += 1500;
    await expect.poll(() => stats(rig).clicks, soon).toBe(2);
    expect(rig.service.status().observation).toMatchObject({ originVerified: true, evidence: { originScore: 0, originSeenAgoMs: 1500 } });
    rig.clock! += 1;
    await expect.poll(() => rig.service.status().decision?.kind, soon).toBe("pause");
    rig.clock! += 5000;
    await cycles(rig);
    expect(rig.attempts).toHaveLength(2);
    expect(rig.service.status().observation).toMatchObject({ originVerified: false });
    rig.scene.own = { dx: 0, dy: 0 };
    await expect.poll(() => stats(rig).clicks, soon).toBe(3);
    // Displaced mid-run: the marker seen somewhere else says the map moved, so that sighting is withdrawn at once, not 1500 ms later.
    rig.scene.own = { dx: 18, dy: 0 };   // past the drift the map itself shows, so the centre really has moved
    await expect.poll(() => rig.service.status().decision?.kind, soon).toBe("pause");
    expect(rig.service.status().observation).toMatchObject({ leaderFound: true, originVerified: false, evidence: { originScore: 1, originSeenAgoMs: null } });
    rig.clock! += 100; // a click would be due, well inside 1500 ms of the last good sighting
    await cycles(rig);
    expect(rig.service.status().decision).toMatchObject({ kind: "pause" });
    expect(rig.attempts).toHaveLength(3);
  });
  it("holds when the capture worker reports too many green pixels to be a marker", async () => {
    const rig = await calibrated();
    goLive(rig);
    rig.scene.overflow = true;
    await rig.service.start();
    await cycles(rig);
    expect(rig.service.status()).toMatchObject({ decision: { kind: "hold" }, observation: { leaderFound: false, evidence: { overflow: true, keyPixels: 0 } } });
    expect(rig.attempts).toEqual([]);
  });
  it("makes no observation and no click while the game is unfocused, then resumes", async () => {
    const rig = await calibrated();
    goLive(rig);
    rig.scene.captureError = "Focus Path of Exile 2 to continue";
    await rig.service.start();
    await expect.poll(() => rig.service.status().reason, soon).toBe("Focus Path of Exile 2 to continue");
    expect(rig.service.status()).toMatchObject({ running: true, observation: undefined, decision: undefined, stats: undefined });
    expect(rig.attempts).toEqual([]);
    rig.scene.captureError = undefined;
    await expect.poll(() => rig.attempts.length, soon).toBeGreaterThanOrEqual(1);
    rig.scene.captureError = "Focus Path of Exile 2 to continue";
    await expect.poll(() => rig.service.status().observation, soon).toBeUndefined();
    const attempts = rig.attempts.length;
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(rig.attempts).toHaveLength(attempts);
    expect(rig.service.status().running).toBe(true);
  });
  it("never clicks from a capture older than 120 ms", async () => {
    const rig = await calibrated({ clock: 80_000 });
    goLive(rig);
    let captureTakesMs = 121;
    rig.scene.onKey = () => { rig.clock! += captureTakesMs; };
    await rig.service.start();
    await expect.poll(() => stats(rig).refused, soon).toBeGreaterThanOrEqual(3);
    expect(rig.attempts).toEqual([]);
    expect(rig.service.status()).toMatchObject({ running: true, reason: "A click was refused as stale or unfocused; retrying on a fresh capture." });
    expect(rig.traces.every(trace => trace.result === "failed" && trace.reason.includes("sink=Follow stopped or capture stale"))).toBe(true);
    captureTakesMs = 120;
    await expect.poll(() => stats(rig).clicks, soon).toBeGreaterThanOrEqual(1);
    expect(rig.attempts[0].payload).toMatchObject({ maxAgeMs: 120 });
  });
  it("never clicks from a capture that does not say which window it came from", async () => {
    const rig = await calibrated();
    goLive(rig);
    rig.scene.hwnd = "";
    await rig.service.start();
    await expect.poll(() => stats(rig).refused, soon).toBeGreaterThanOrEqual(3);
    // The incomplete guard is refused before anything reaches the input worker, and retried like any stale capture.
    expect(ops(rig.input)).toEqual(["ping"]);
    expect(rig.service.status()).toMatchObject({ running: true, stats: { clicks: 0, manualTakeovers: 0 } });
    expect(rig.traces.every(trace => trace.result === "failed" && trace.reason.includes("sink=Capture stale: incomplete capture guard"))).toBe(true);
    rig.scene.hwnd = HWND;
    await expect.poll(() => rig.attempts.length, soon).toBeGreaterThanOrEqual(1);
    expect(rig.attempts.every(attempt => attempt.payload.expectedHwnd === HWND)).toBe(true);
  });
  it("lets the controller block a process that is not on the allowlist, and stops", async () => {
    const rig = await calibrated();
    goLive(rig);
    rig.scene.process = "notepad";
    await rig.service.start();
    await expect.poll(() => rig.service.status().running, soon).toBe(false);
    expect(rig.service.status().reason).toContain("safety=process-not-allowlisted");
    expect(rig.attempts).toEqual([]);
    expect(rig.traces).toHaveLength(1);
    expect(rig.traces[0]).toMatchObject({ result: "blocked", processName: "notepad", input: { kind: "click" } });
    await expect.poll(() => ops(rig.input), soon).toEqual(["ping", "release", "closed"]);
  });
  it("accepts every allowlisted client name regardless of case", async () => {
    for (const process of ["PathOfExile", "pathofexile_x64", "PATHOFEXILESTEAM", "PathOfExile_x64Steam", "PathOfExileEGS", "PathOfExile_x64EGS"]) {
      const rig = await calibrated({ clock: 1000 });
      goLive(rig);
      rig.scene.process = process;
      await rig.service.start();
      await expect.poll(() => stats(rig).clicks, soon).toBe(1);
      rig.service.stop();
    }
  });
});

describe("follow drive input refusals (synthetic input host, no OS input)", () => {
  it.each(["Manual mouse movement", "Mouse button held - manual control", "Modifier key held"])("yields to the player for 1500 ms after '%s' and counts a takeover", async refusal => {
    const rig = await calibrated({ clock: 100_000 });
    goLive(rig);
    rig.refusals.push(refusal);
    await rig.service.start();
    await expect.poll(() => stats(rig).manualTakeovers, soon).toBe(1);
    expect(rig.service.status()).toMatchObject({ running: true, reason: "Manual control detected — following resumes shortly.", stats: { clicks: 0, refused: 0 } });
    rig.clock! += 1499;
    await cycles(rig);
    expect(rig.service.status().decision).toEqual({ kind: "pause", reason: "Manual control detected — following resumes shortly." });
    expect(rig.attempts).toHaveLength(1);
    rig.clock! += 1;
    await expect.poll(() => stats(rig).clicks, soon).toBe(1);
    expect(rig.attempts).toHaveLength(2);
    expect(rig.attempts[1].clock - rig.attempts[0].clock).toBe(1500);
    expect(rig.traces.map(trace => trace.result)).toEqual(["failed", "emitted"]);
    expect(stats(rig)).toMatchObject({ manualTakeovers: 1, clicks: 1, refused: 0 });
  });
  it("pauses for 1500 ms when another window covers the game at the click point, and counts it as refused, not as a takeover or a stop", async () => {
    const rig = await calibrated({ clock: 105_000 });
    goLive(rig);
    rig.refusals.push("Game is covered at the click point");
    await rig.service.start();
    await expect.poll(() => stats(rig).refused, soon).toBe(1);
    expect(rig.service.status()).toMatchObject({ running: true, stats: { clicks: 0, refused: 1, manualTakeovers: 0 } });
    rig.clock! += 1499;
    await cycles(rig);
    expect(rig.service.status()).toMatchObject({ running: true, decision: { kind: "pause" } });
    expect([...rig.reasons]).toContain("Another window covers the game at the click point — pausing.");
    // Unlike a stale capture, this is not retried at once: the covering window will still be there 8 ms later.
    expect(rig.attempts).toHaveLength(1);
    rig.clock! += 1;
    await expect.poll(() => stats(rig).clicks, soon).toBe(1);
    expect(rig.attempts).toHaveLength(2);
    expect(rig.attempts[1].clock - rig.attempts[0].clock).toBe(1500);
    expect(Number(rig.attempts[1].payload.capturedAtQpcMs)).toBeGreaterThan(Number(rig.attempts[0].payload.capturedAtQpcMs));
    expect(rig.traces.map(trace => trace.result)).toEqual(["failed", "emitted"]);
    expect(rig.traces[0].reason).toContain("sink=Game is covered at the click point");
    expect(stats(rig)).toMatchObject({ refused: 1, clicks: 1, manualTakeovers: 0 });
    expect(ops(rig.input)).toEqual(["ping", "moveclick", "moveclick"]);
  });
  // SUSPECTED SOURCE BUG (reported; source untouched). The covered pause reuses the manual-takeover timer, so from the
  // next cycle on the status says "Manual control detected" for 1500 ms although the player did nothing; the real
  // cause is on screen for one cycle only. Remove `.fails` once the pause keeps its own reason.
  it("keeps telling the operator that a window covers the game for as long as that pause lasts", async () => {
    const rig = await calibrated({ clock: 106_000 });
    goLive(rig);
    rig.refusals.push("Game is covered at the click point");
    await rig.service.start();
    await expect.poll(() => stats(rig).refused, soon).toBe(1);
    await cycles(rig);
    expect(rig.service.status().reason).toContain("covers the game");
  });
  it.each(["Stale capture", "Focus Path of Exile 2 to continue", "Game focus or view changed before click"])("retries at once on a fresh capture after '%s' and counts it as refused", async refusal => {
    const rig = await calibrated({ clock: 110_000 });
    goLive(rig, { clickIntervalMs: 1000 });
    rig.refusals.push(refusal);
    await rig.service.start();
    // The clock is frozen: the second attempt did not wait for the click interval.
    await expect.poll(() => stats(rig).clicks, soon).toBe(1);
    expect(stats(rig)).toMatchObject({ refused: 1, clicks: 1, manualTakeovers: 0 });
    expect(rig.attempts).toHaveLength(2);
    expect(Number(rig.attempts[1].payload.capturedAtQpcMs)).toBeGreaterThan(Number(rig.attempts[0].payload.capturedAtQpcMs));
    expect(rig.traces.map(trace => trace.result)).toEqual(["failed", "emitted"]);
    expect(rig.traces[0].reason).toContain(`sink=${refusal}`);
    // The accepted click is paced as usual.
    await cycles(rig);
    expect(rig.attempts).toHaveLength(2);
    expect(rig.service.status().running).toBe(true);
  });
  it.each<string | Error>(["Click outside the safe movement area", "Game window changed", "Game view changed", "Windows rejected movement input", "Invalid freshness limit", new Error("win-input-host-timeout:moveclick")])("stops the loop on any other input failure: %s", async refusal => {
    const rig = await calibrated();
    goLive(rig);
    rig.refusals.push(refusal);
    await rig.service.start();
    await expect.poll(() => rig.service.status().running, soon).toBe(false);
    const message = refusal instanceof Error ? refusal.message : refusal;
    expect(rig.service.status().reason).toContain("Movement input stopped:");
    expect(rig.service.status().reason).toContain(`sink=${message}`);
    expect(rig.attempts).toHaveLength(1);
    await expect.poll(() => ops(rig.input), soon).toEqual(["ping", "moveclick", "release", "closed"]);
    await expect.poll(() => ops(rig.capture).at(-1), soon).toBe("closed");
    await cyclesNever(rig);
  });
});

describe("follow drive stopping (synthetic hosts, no OS input)", () => {
  it("stops when the kill switch trips, releases the button, and cannot be restarted until rearmed", async () => {
    const rig = await calibrated();
    goLive(rig);
    await rig.service.start();
    await expect.poll(() => rig.attempts.length, soon).toBeGreaterThanOrEqual(1);
    rig.killSwitch.trip();
    await expect.poll(() => rig.service.status().running, soon).toBe(false);
    expect(rig.service.status()).toMatchObject({ reason: "Emergency stop latched — rearm in the app.", observation: undefined, decision: undefined });
    await expect.poll(() => ops(rig.input).slice(-2), soon).toEqual(["release", "closed"]);
    await expect.poll(() => ops(rig.capture).at(-1), soon).toBe("closed");
    const attempts = rig.attempts.length;
    await cyclesNever(rig);
    expect(rig.attempts).toHaveLength(attempts);
    await expect(rig.service.start()).rejects.toThrow("Emergency stop latched");
  });
  it("never sends the click decided from a capture during which the kill switch tripped", async () => {
    const rig = await calibrated();
    goLive(rig);
    rig.scene.onKey = () => rig.killSwitch.trip();
    await rig.service.start();
    await expect.poll(() => rig.service.status().running, soon).toBe(false);
    expect(rig.service.status().reason).toContain("kill-switch-latched");
    expect(rig.attempts).toEqual([]);
    expect(rig.traces).toHaveLength(1);
    expect(rig.traces[0]).toMatchObject({ result: "blocked" });
  });
  it("never sends the click decided from a capture during which the module became blocked", async () => {
    const rig = await calibrated();
    goLive(rig);
    rig.scene.onKey = () => { rig.blocked = "Follow & Loot was switched off."; };
    await rig.service.start();
    await expect.poll(() => rig.service.status().running, soon).toBe(false);
    expect(rig.service.status().reason).toBe("Follow & Loot was switched off.");
    expect(rig.attempts).toEqual([]);
    expect(rig.traces.map(trace => trace.result)).toEqual(["failed"]);
    expect(rig.traces[0].reason).toContain("sink=Follow stopped or capture stale");
  });
  it("stops at the controller's cap of 600 actions per minute", async () => {
    const rig = await calibrated({ clock: 200_000 });
    goLive(rig);
    rig.scene.onKey = () => { rig.clock! += 100; }; // every capture is one click interval later
    await rig.service.start();
    await expect.poll(() => rig.service.status().running, { timeout: 40_000, interval: 25 }).toBe(false);
    expect(rig.service.status().reason).toBe("Action limit reached (600/minute).");
    expect(rig.attempts).toHaveLength(600);
    expect(rig.traces).toHaveLength(601);
    expect(rig.traces[600]).toMatchObject({ result: "blocked", reason: expect.stringContaining("safety=rate-limited") });
    expect(rig.service.status().stats).toMatchObject({ clicks: 600 });
    await expect.poll(() => ops(rig.input).slice(-2), soon).toEqual(["release", "closed"]);
  }, 45_000);
  it("stops when the game view no longer matches the calibration", async () => {
    const rig = await calibrated();
    goLive(rig);
    await rig.service.start();
    await expect.poll(() => rig.attempts.length, soon).toBeGreaterThanOrEqual(1);
    rig.scene.view = { width: 1280, height: 720 };
    await expect.poll(() => rig.service.status().running, soon).toBe(false);
    expect(rig.service.status().reason).toBe("Game view changed from 640 × 360 to 1280 × 720. Calibrate again.");
    // Every click that was sent belonged to the calibrated view.
    expect(rig.attempts.every(a => a.payload.viewWidth === W && a.payload.viewHeight === H)).toBe(true);
    await expect.poll(() => ops(rig.input).slice(-2), soon).toEqual(["release", "closed"]);
  });
  it("stops when the module becomes blocked, the followed character changes, or the capture worker dies", async () => {
    const blocked = await calibrated();
    goLive(blocked);
    await blocked.service.start();
    await cycles(blocked, 2);
    blocked.blocked = "Follow & Loot was switched off.";
    await expect.poll(() => blocked.service.status().running, soon).toBe(false);
    expect(blocked.service.status().reason).toBe("Follow & Loot was switched off.");

    const retargeted = await calibrated();
    goLive(retargeted);
    await retargeted.service.start();
    await cycles(retargeted, 2);
    retargeted.follow.targetName = "Other";
    await expect.poll(() => retargeted.service.status().running, soon).toBe(false);
    expect(retargeted.service.status().reason).toBe("Map calibrated for Main; calibrate again for Other.");

    const died = await calibrated();
    goLive(died);
    died.scene.onKey = () => { throw new Error("win-input-host-exited:1"); };
    await died.service.start();
    // A worker that cannot survive even its first request is rebuilt a bounded number of times, then the run ends.
    await expect.poll(() => died.service.status().running, soon).toBe(false);
    expect(died.service.status().reason).toBe("win-input-host-exited:1");
    expect(died.attempts).toEqual([]);
    for (const rig of [blocked, retargeted, died]) await expect.poll(() => ops(rig.input).slice(-2), soon).toEqual(["release", "closed"]);
  });
  it("presses Escape for a panel that only PARTLY covers the map marker, not just one that hides it outright", async () => {
    // Measured live: Path of Exile 2's ritual "Favours" window left the orange marker matching at .627, displaced
    // off the anchor and so unverified. The trigger required a score of exactly 0, so Escape never fired and the
    // follower idled 50 s without a single click.
    const rig = await calibrated({ clock: 500_000 });
    goLive(rig);
    await rig.service.start();
    await cycles(rig, 2);
    rig.scene.own = { dx: 18, dy: 0 };   // found, but not where the map centre should be: a panel over it
    await cycles(rig, 2);
    expect(rig.service.status().observation).toMatchObject({ originVerified: false });
    expect(rig.service.status().observation!.evidence.originScore).toBeGreaterThan(0);
    expect(rig.escapes).toEqual([]);
    rig.clock! += 2000;   // PANEL_STUCK_MS
    await expect.poll(() => rig.escapes.length, soon).toBe(1);
    expect(rig.escapes[0]).toMatchObject({ op: "key", key: "escape", expectedHwnd: HWND });
  });
  it("rebuilds a worker that stops answering and keeps following, rather than ending the run", async () => {
    // Live, one native op stalled past its deadline: the transport killed the worker and a 260 s run ended there.
    const rig = await calibrated();
    goLive(rig);
    await rig.service.start();
    await expect.poll(() => rig.attempts.length, soon).toBeGreaterThanOrEqual(1);
    const hosts = rig.created.capture, attempts = rig.attempts.length;
    let stalled = false;
    rig.scene.onKey = () => { if (!stalled) { stalled = true; throw new Error("win-input-host-timeout:key"); } };
    await expect.poll(() => rig.created.capture, soon).toBeGreaterThan(hosts);
    expect(rig.service.status().running).toBe(true);
    // And it is following again, not merely alive: by the time this is read the reason has usually moved on
    // from the restart to the next movement decision, which is the point.
    await expect.poll(() => rig.attempts.length, soon).toBeGreaterThan(attempts);
  });
  it.each([[{ value: undefined }, "Capture worker returned no marker pixels."], [{ value: "AAA=" }, "Capture worker returned malformed marker pixels."]])("stops on a broken capture reply instead of guessing (%j)", async (corruptPoints, reason) => {
    const rig = await calibrated();
    goLive(rig);
    await rig.service.start();
    await expect.poll(() => rig.attempts.length, soon).toBeGreaterThanOrEqual(1);
    rig.scene.corruptPoints = corruptPoints;
    const attempts = rig.attempts.length;
    await expect.poll(() => rig.service.status().running, soon).toBe(false);
    expect(rig.service.status().reason).toBe(reason);
    expect(rig.attempts).toHaveLength(attempts);
    await expect.poll(() => ops(rig.input).slice(-2), soon).toEqual(["release", "closed"]);
  });
  it("stop() releases the button before closing the input worker, closes the capture worker, and clears live state", async () => {
    const rig = await calibrated();
    goLive(rig);
    await rig.service.start();
    await expect.poll(() => rig.attempts.length, soon).toBeGreaterThanOrEqual(1);
    const stopped = rig.service.stop("Stopped by the operator.");
    expect(stopped).toMatchObject({ running: false, reason: "Stopped by the operator.", observation: undefined, decision: undefined });
    expect(stopped.stats!.clicks).toBeGreaterThanOrEqual(1);
    expect(rig.service.isRunning).toBe(false);
    await expect.poll(() => ops(rig.input).at(-1), soon).toBe("closed");
    expect(ops(rig.input).slice(-2)).toEqual(["release", "closed"]);
    expect(ops(rig.input).filter(op => op === "release")).toHaveLength(1);
    expect(ops(rig.capture).at(-1)).toBe("closed");
    // Stopping twice asks nothing more of workers that are already gone.
    const inputs = rig.input.length, captures = rig.capture.length;
    rig.service.stop();
    await cyclesNever(rig);
    expect([rig.input.length, rig.capture.length]).toEqual([inputs, captures]);
    // A restart gets fresh workers and fresh counters.
    await rig.service.start();
    expect(rig.created).toEqual({ capture: 3, input: 2 });
    await expect.poll(() => stats(rig).clicks, soon).toBeGreaterThanOrEqual(1);
  });
  it("still closes the input worker when the release request itself fails", async () => {
    const rig = await calibrated();
    await rig.service.start();
    await cycles(rig, 2);
    rig.releaseFails = true;
    rig.service.stop();
    await expect.poll(() => ops(rig.input), soon).toEqual(["ping", "release", "closed"]);
  });
});

describe("follow drive stop() keeps asking for a release (synthetic input host, no OS input)", () => {
  it("asks again about 250 ms after a release that reports a key still held, and closes the input worker only after one succeeded", async () => {
    const rig = await calibrated();
    await rig.service.start();
    await cycles(rig, 2);
    rig.releaseRefusals = 2;
    expect(rig.service.stop("Stopped by the operator.")).toMatchObject({ running: false, reason: "Stopped by the operator." });
    // The first answer is { ok: false }: the worker's watchdog is the only thing that can still let go, so it must stay alive.
    await expect.poll(() => rig.releasedAt.length, soon).toBe(1);
    expect(ops(rig.input)).toEqual(["ping", "release"]);
    await expect.poll(() => rig.releasedAt.length, soon).toBe(2);
    expect(ops(rig.input)).toEqual(["ping", "release", "release"]);
    await expect.poll(() => ops(rig.input), soon).toEqual(["ping", "release", "release", "release", "closed"]);
    // Real timers: the retries are spaced by the 250 ms retry delay (a little slack for timer rounding).
    for (const gap of [rig.releasedAt[1] - rig.releasedAt[0], rig.releasedAt[2] - rig.releasedAt[1]]) { expect(gap).toBeGreaterThanOrEqual(240); expect(gap).toBeLessThan(2000); }
    // The capture worker does not wait for any of that, and nothing is asked after the close.
    expect(ops(rig.capture).at(-1)).toBe("closed");
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(ops(rig.input)).toHaveLength(5);
  });
});

describe("follow drive escapes a panel over the map centre (SYNTHETIC key taps: an 'Escape' is an array entry, no OS input)", () => {
  /** Live, then a panel over the map centre: our own marker matches 18 px off its anchor, so that capture leaves the centre unverified. */
  async function covered(clock: number, dryRun = false): Promise<Rig> {
    const rig = await calibrated({ clock });
    rig.service.configure({ version: 1, dryRun, mapScale: 7, clickIntervalMs: 100 });
    await rig.service.start();
    await cycles(rig, 2);
    rig.scene.own = { dx: 18, dy: 0 };
    await expect.poll(() => rig.service.status().observation?.originVerified, soon).toBe(false);
    return rig;
  }
  const keyCaptures = (rig: Rig) => ops(rig.capture).filter(op => op === "key").length;

  it("never presses Escape while the map centre verifies, however long the run", async () => {
    const rig = await calibrated({ clock: 800_000 });
    goLive(rig);
    await rig.service.start();
    await expect.poll(() => stats(rig).clicks, soon).toBeGreaterThanOrEqual(1);
    for (let step = 0; step < 5; step++) { rig.clock! += 2000; await cycles(rig, 3); }
    expect(rig.escapes).toEqual([]);
    expect(rig.traces.every(trace => trace.decisionRule !== "close-panel")).toBe(true);
  });
  it("spends neither an attempt nor the cooldown on a press the worker refused, and yields to the manual pause before trying again", async () => {
    const rig = await covered(810_000);
    rig.escapeRefusals.push("Manual mouse movement");
    rig.clock! += 2000;   // PANEL_STUCK_MS
    await expect.poll(() => rig.escapes.length, soon).toBe(1);
    expect(stats(rig)).toMatchObject({ manualTakeovers: 1, panelEscapes: 0 });
    // Nothing was pressed, so nothing was spent — but a hand on the mouse still holds the next attempt off for 1500 ms.
    rig.clock! += 1499;
    await cycles(rig, 3);
    expect(rig.escapes).toHaveLength(1);
    rig.clock! += 1;
    await expect.poll(() => rig.escapes.length, soon).toBe(2);
    // Both attempts are still there to spend: the refusal cost neither of them, nor the 3 s between presses.
    rig.clock! += 3000;   // PANEL_ESCAPE_COOLDOWN_MS
    await expect.poll(() => rig.escapes.length, soon).toBe(3);
    expect(stats(rig)).toMatchObject({ panelEscapes: 2 });
    rig.clock! += 3000;
    await cycles(rig, 3);
    expect(rig.escapes).toHaveLength(3);   // two presses landed: the cap, until a verified centre or the reset timer
  });
  it("gives the attempts back 30 s after the last press, so a panel they never closed cannot deadlock the run", async () => {
    const rig = await covered(820_000);
    rig.clock! += 2000;
    await expect.poll(() => rig.escapes.length, soon).toBe(1);
    rig.clock! += 3000;
    await expect.poll(() => rig.escapes.length, soon).toBe(2);
    // Live, this is where a run died: both attempts spent, and the counter reset only on a verified centre —
    // which is the one thing a panel prevents. The follower idled the last 30 s of the run.
    const pressed = rig.clock!;
    rig.clock! = pressed + 29_999;   // PANEL_ESCAPE_RESET_MS, less a millisecond
    await cycles(rig, 3);
    expect(rig.escapes).toHaveLength(2);
    expect(rig.service.status().observation?.originVerified).toBe(false);
    rig.clock! = pressed + 30_000;
    await expect.poll(() => rig.escapes.length, soon).toBe(3);
  });
  it("needs a capture taken since the last press before pressing again: the clock alone is not evidence", async () => {
    const rig = await covered(830_000);
    rig.clock! += 2000;
    await expect.poll(() => rig.escapes.length, soon).toBe(1);
    // The game loses focus straight after the press: time runs past the cooldown, but nothing is observed, so
    // everything known about the centre predates a press that may already have closed the panel. Pressing on
    // that would open the game menu instead.
    rig.scene.captureError = "Focus Path of Exile 2 to continue";
    const from = keyCaptures(rig);
    rig.clock! += 4000;
    await expect.poll(() => keyCaptures(rig), soon).toBeGreaterThan(from + 2);
    expect(rig.escapes).toHaveLength(1);
    // Focus back and the centre still covered: that capture is the fresh evidence the second press needs.
    rig.scene.captureError = undefined;
    await expect.poll(() => rig.escapes.length, soon).toBe(2);
  });
  it("previews the Escape in a dry run: the input worker receives nothing at all", async () => {
    const rig = await covered(840_000, true);
    rig.clock! += 2000;
    await expect.poll(() => [...rig.reasons], soon).toContain("Preview only: would press Escape to close a panel over the map centre: it has been unverifiable for 2.0 s.");
    expect(rig.escapes).toEqual([]);
    expect(ops(rig.input)).toEqual(["ping"]);
    expect(rig.traces.at(-1)).toMatchObject({ decisionRule: "close-panel", result: "blocked", input: { kind: "key", key: "escape", text: "tap" }, reason: expect.stringContaining("safety=dry-run") });
    expect(stats(rig)).toMatchObject({ clicks: 0, panelEscapes: 1 });
  });
});

describe("follow drive loot clicks (SYNTHETIC label runs and hosts: a 'click' is an array entry, no OS input)", () => {
  /** Leader 33 map px away with a stop distance of 30 (resume 36): steering says "near", so every moveclick in these tests is a loot click. */
  async function lootRig(clock: number, follow: Partial<Rig["follow"]> = {}): Promise<Rig> {
    const rig = await calibrated({ clock });
    rig.follow = { ...rig.follow, followDistance: 5, lootEnabled: true, lootLeash: 10, ...follow };
    goLive(rig);
    rig.scene.leader = { dx: 33, dy: 0 };
    return rig;
  }
  it("does not click a label on its first sighting; on the second scan a label that sat still is clicked at its centre, bound to the scan that found it", async () => {
    const rig = await lootRig(300_000), label = { x: 380, y: 100, width: 81, height: 21 };
    rig.scene.loot = [label];
    await rig.service.start();
    await expect.poll(() => stats(rig).lootScans, soon).toBe(1);
    await cycles(rig);
    // Seen once: the scan is asked of the loot area only (10–80 % × 5–80 % of the view), the label is counted, and nothing is clicked however many cycles pass.
    expect(rig.capture.find(entry => entry.op === "runs")).toEqual({ op: "runs", x: 64, y: 18, width: 448, height: 270, minLength: 48, minBrightness: 45 });
    expect(stats(rig)).toMatchObject({ lootScans: 1, lootLabels: 1, lootClicks: 0, clicks: 0 });
    expect([...rig.reasons]).toContain("Pick up the nearest of 1 loot label.");
    expect(rig.attempts).toEqual([]);
    expect(rig.traces).toEqual([]);
    await nextScan(rig);
    expect(rig.attempts).toHaveLength(1);
    expect(lootCentre(label)).toEqual({ x: 420, y: 110 });
    // The click carries the scan's capture time, which is newer than any marker capture before it.
    expect(rig.attempts[0].payload).toEqual({ op: "moveclick", x: 420, y: 110, expectedHwnd: HWND, viewWidth: W, viewHeight: H, capturedAtQpcMs: rig.scanQpc[1], maxAgeMs: 120, area: "loot" });
    expect(rig.scanQpc).toHaveLength(2);
    expect(rig.traces).toHaveLength(1);
    expect(rig.traces[0]).toMatchObject({ module: "loot", decisionRule: "pick-up-nearest-label", result: "emitted", confidence: 1, processName: GAME, input: { kind: "click", x: 420, y: 110, button: "left", text: "loot" } });
    expect(JSON.parse(rig.traces[0].evidenceHash)).toMatchObject({ capturedAtQpcMs: rig.scanQpc[1], hwnd: HWND, click: { x: 420, y: 110 }, label: { centre: { x: 420, y: 110 }, rect: label }, labelsInView: 1, leaderDistance: 33 });
    expect(stats(rig)).toMatchObject({ lootScans: 2, lootClicks: 1, clicks: 1 });
    // The character is left alone to walk there: no second click while the clock stands still.
    await cycles(rig);
    expect(rig.attempts).toHaveLength(1);
  });
  it("leads a label that slid between two scans by its own drift × 70 ms, clamps the led click into the loot area, and takes a jump of 120 px or more for a different label", async () => {
    const rig = await lootRig(310_000), label: LootRect = { x: 280, y: 100, width: 81, height: 21 };
    rig.scene.loot = [label];
    await rig.service.start();
    await expect.poll(() => stats(rig).lootScans, soon).toBe(1);
    // The camera scrolls: 50 px right and 25 px up in the 250 ms between the scans is 0.2 and −0.1 px/ms, so the click leads by (+14, −7).
    label.x += 50; label.y -= 25;
    await nextScan(rig);
    expect(lootCentre(label)).toEqual({ x: 370, y: 85 });
    expect(rig.attempts.map(a => a.payload)).toMatchObject([{ x: 384, y: 78, area: "loot", capturedAtQpcMs: rig.scanQpc[1] }]);
    expect(JSON.parse(rig.traces[0].evidenceHash)).toMatchObject({ label: { centre: { x: 370, y: 85 } }, click: { x: 384, y: 78 } });
    // Same direction, further along: beyond the label's centre, on the line it is sliding along.
    expect([384 - 370, 78 - 85]).toEqual([50 * 70 / 250, -25 * 70 / 250]);
    // 250 ms after a click the character is still walking (clicks are 450 ms apart), but the sighting counts for the next drift.
    Object.assign(label, { x: 363, y: 100, width: 49 });
    await nextScan(rig);
    expect(rig.attempts).toHaveLength(1);
    // Sliding right at 0.4 px/ms with its right edge on the last scanned column (511): 487 + 28 is outside, so the click is pulled back onto that column.
    label.x += 100;
    await nextScan(rig);
    expect(lootCentre(label)).toEqual({ x: 487, y: 110 });
    expect(rig.attempts.map(a => a.payload).slice(1)).toMatchObject([{ x: 511, y: 110, area: "loot" }]);
    // A label 150 px from the last one is not the same label sliding: it waits a scan like any first sighting, then is clicked where it sits.
    await nextScan(rig);
    expect(rig.attempts).toHaveLength(2);
    Object.assign(label, { x: 297, width: 81 });
    await nextScan(rig);
    expect(rig.attempts).toHaveLength(2);
    await nextScan(rig);
    expect(rig.attempts.map(a => a.payload).slice(2)).toMatchObject([{ x: 337, y: 110, area: "loot" }]);
    expect(rig.traces.every(trace => trace.module === "loot" && trace.result === "emitted")).toBe(true);
    expect(stats(rig)).toMatchObject({ lootScans: 7, lootClicks: 3, clicks: 3 });
  });
  it("never clicks a label the leash away from the CHARACTER, however close to the leader it lies, and does click one within reach", async () => {
    // The leash bounds the detour, so it is measured from us. Leash 3 units = 18 map px; mapScale 7.
    // Leader 25 map px to the left. OUTSIDE is right beside them but 25.7 map px from us; INSIDE is 15 from us and 40 from the leader.
    const rig = await lootRig(320_000, { lootLeash: 3 });
    rig.scene.leader = { dx: -25, dy: 0 };
    const outside: LootRect = { x: ORIGIN.x - 180 - 40, y: ORIGIN.y - 10, width: 81, height: 21 }, inside: LootRect = { x: ORIGIN.x + 105 - 40, y: ORIGIN.y - 10, width: 81, height: 21 };
    expect([lootCentre(outside), lootCentre(inside)]).toEqual([{ x: ORIGIN.x - 180, y: ORIGIN.y }, { x: ORIGIN.x + 105, y: ORIGIN.y }]);
    rig.scene.loot = [outside];
    await rig.service.start();
    await expect.poll(() => stats(rig).lootScans, soon).toBe(1);
    for (let scan = 0; scan < 4; scan++) await nextScan(rig);
    expect(stats(rig)).toMatchObject({ lootScans: 5, lootLabels: 0, lootClicks: 0 });
    expect(rig.attempts).toEqual([]);
    expect(rig.service.status().decision).toMatchObject({ kind: "near" });
    rig.scene.loot = [outside, inside];
    await nextScan(rig);
    expect(stats(rig)).toMatchObject({ lootLabels: 1, lootClicks: 0 });
    await nextScan(rig);
    expect(rig.attempts.map(a => a.payload)).toMatchObject([{ ...lootCentre(inside), area: "loot" }]);
    expect(JSON.parse(rig.traces[0].evidenceHash)).toMatchObject({ labelsInView: 1 });
    // Two more pickups' worth of scans: the label outside the leash is still never the target.
    for (let scan = 0; scan < 4; scan++) await nextScan(rig);
    expect(rig.attempts.length).toBeGreaterThanOrEqual(2);
    expect(rig.attempts.every(a => a.payload.x === lootCentre(inside).x && a.payload.y === lootCentre(inside).y && a.payload.area === "loot")).toBe(true);
  });
  it("keeps looting while it chases a leader up to two leashes ahead, and gives that up to catch one who is getting away", async () => {
    // Leash 5 units = 30 map px, so looting runs out to 60. Items drop where the leader fights, and waiting to be
    // back inside the leash before scanning misses most of them.
    const rig = await lootRig(322_000, { lootLeash: 5 }), label: LootRect = { x: ORIGIN.x + 105 - 40, y: ORIGIN.y - 10, width: 81, height: 21 };
    rig.scene.leader = { dx: 55, dy: 0 };
    rig.scene.loot = [label];
    await rig.service.start();
    await expect.poll(() => stats(rig).lootScans, soon).toBe(1);
    // Well beyond the leash and still chasing: the label 15 map px from us is scanned, and picked up on its second sighting.
    expect(rig.service.status().decision).toMatchObject({ kind: "hold", reason: "Pick up the nearest of 1 loot label." });
    expect(stats(rig)).toMatchObject({ lootLabels: 1, lootClicks: 0 });
    await nextScan(rig);
    expect(clicksIn(rig, "loot").map(a => ({ x: a.payload.x, y: a.payload.y }))).toEqual([lootCentre(label)]);
    // The leader is getting away: catching up is now all that matters, and the same label is left where it lies.
    rig.scene.leader = { dx: 70, dy: 0 };
    const chasing = clicksIn(rig, "move").length;
    for (let step = 0; step < 4; step++) { rig.clock! += 250; await cycles(rig, 3); }
    expect(clicksIn(rig, "loot")).toHaveLength(1);
    expect(stats(rig).lootScans).toBe(2);
    expect(clicksIn(rig, "move").length).toBeGreaterThan(chasing);
  });
  it("does not even scan for loot while the leader is more than two leashes away or loot is switched off", async () => {
    const beyond = await lootRig(325_000, { lootLeash: 5 });
    beyond.scene.leader = FAR; // 108 map px away; the leash is 30, and looting stops beyond 60
    beyond.scene.loot = [{ x: 380, y: 100, width: 81, height: 21 }];
    const off = await lootRig(326_000, { lootEnabled: false });
    off.scene.loot = beyond.scene.loot;
    for (const rig of [beyond, off]) {
      await rig.service.start();
      await cycles(rig);
      rig.clock! += 1000;
      await cycles(rig);
      expect(ops(rig.capture)).not.toContain("runs");
      expect(stats(rig)).toMatchObject({ lootScans: 0, lootClicks: 0 });
      expect(clicksIn(rig, "loot")).toEqual([]);
    }
  });
  it("gates a loot click by the loot detector's own 0.85, not by the leader-label preference: a 0.92 label is clicked with confidence 0.95 required, and following does not stop", async () => {
    // The leader's own sighting is 1 in this rig, so it passes 0.95; the label has exactly 3 flat padding rows, which the detector scores 0.8 + 3 × 0.04.
    const rig = await lootRig(330_000, { confidence: .95 }), label = { x: 380, y: 100, width: 81, height: 21, padding: 3 };
    rig.scene.loot = [label];
    await rig.service.start();
    await expect.poll(() => stats(rig).lootScans, soon).toBe(1);
    expect(rig.service.status().observation).toMatchObject({ leaderFound: true, confidence: 1 });
    await nextScan(rig);
    expect(rig.attempts.map(a => a.payload)).toMatchObject([{ ...lootCentre(label), area: "loot" }]);
    expect(rig.traces).toHaveLength(1);
    expect(rig.traces[0]).toMatchObject({ module: "loot", result: "emitted", reason: expect.stringContaining("safety=ok") });
    expect(rig.traces[0].confidence).toBeCloseTo(.92, 9);
    expect(rig.traces[0].confidence).toBeLessThan(rig.follow.confidence);
    await nextScan(rig); await nextScan(rig);
    expect(rig.service.status()).toMatchObject({ running: true, stats: { lootClicks: 2, clicks: 2, refused: 0 } });
    expect(rig.traces.some(trace => trace.reason.includes("confidence-too-low"))).toBe(false);
  });
  it("keeps sending movement clicks while loot scans find no labels: an empty scan is not a 'hold'", async () => {
    const rig = await lootRig(340_000, { followDistance: 2 });
    rig.scene.leader = { dx: 40, dy: 0 }; // beyond the stop distance, inside the 60 px leash
    await rig.service.start();
    await expect.poll(() => stats(rig).clicks, soon).toBe(1);
    expect(stats(rig)).toMatchObject({ lootScans: 1, lootLabels: 0 });
    // The clock is frozen: each 250 ms step earns exactly one scan and one movement click, in the same cycle as the scan.
    for (let step = 1; step <= 5; step++) {
      await nextScan(rig);
      expect(stats(rig)).toMatchObject({ lootScans: step + 1, clicks: step + 1, lootClicks: 0 });
      expect(rig.service.status().decision).toMatchObject({ kind: "move" });
    }
    await cycles(rig, 3);
    expect(rig.service.status().decision).toMatchObject({ kind: "hold", reason: "Pacing movement clicks." });
    expect(clicksIn(rig, "move")).toHaveLength(6);
    expect([...rig.reasons]).not.toContain("No loot labels in view.");
  });
  it("leaves the character alone to walk to an item it clicked, and follows again the moment the item is gone", async () => {
    // Walking to an item takes longer than the gap between movement clicks, so a movement click sent while it
    // walks cancels the walk and the item is never picked up. That was the live failure.
    const rig = await lootRig(360_000, { followDistance: 2 }), label: LootRect = { x: ORIGIN.x + 100, y: ORIGIN.y - 73, width: 81, height: 21 };
    rig.scene.leader = { dx: 40, dy: 0 };   // well beyond the stop distance: movement clicks are due every tick
    rig.scene.loot = [label];
    await rig.service.start();
    await expect.poll(() => stats(rig).lootScans, soon).toBe(1);
    await nextScan(rig);
    expect(clicksIn(rig, "loot")).toHaveLength(1);
    const moves = clicksIn(rig, "move").length;
    for (let scan = 0; scan < 4; scan++) {
      await nextScan(rig);
      expect(clicksIn(rig, "move").length).toBe(moves);
      expect(rig.service.status().decision?.kind).toBe("hold");
    }
    // Between scans the hold is the walk itself, not the planner talking about the label.
    await cycles(rig, 2);
    expect(rig.service.status().decision).toMatchObject({ kind: "hold", reason: "Walking to a loot pickup." });
    // Picked up: one fewer label, and the leader is worth chasing again on the very next scan.
    rig.scene.loot = [];
    await nextScan(rig);
    await cycles(rig, 3);
    expect(clicksIn(rig, "move").length).toBeGreaterThan(moves);
  });
  it("keeps sending movement clicks while loot is backing off after five fruitless pickups", async () => {
    const rig = await lootRig(350_000, { followDistance: 2 });
    rig.scene.leader = { dx: 40, dy: 0 };
    rig.scene.loot = [{ x: ORIGIN.x + 100, y: ORIGIN.y - 73, width: 81, height: 21 }]; // never picked up: the inventory is full
    await rig.service.start();
    await expect.poll(() => stats(rig).lootScans, soon).toBe(1);
    // Loot clicks are 450 ms apart and scans 250 ms, so one pickup per two scans: five of them by the 10th scan, and the 12th decides to back off.
    for (let scan = 2; scan <= 12; scan++) await nextScan(rig);
    expect(stats(rig)).toMatchObject({ lootScans: 12, lootClicks: 5 });
    expect(clicksIn(rig, "loot")).toHaveLength(5);
    const moves = clicksIn(rig, "move").length;
    // A clicked item is left alone for up to 3 s to be walked to. The inventory is full, so nothing is
    // collected, the wait lapses, and following wins again.
    expect(rig.service.status().decision).toMatchObject({ kind: "hold", reason: "Walking to a loot pickup." });
    rig.clock! += 3000;
    await cycles(rig, 3);
    for (let step = 1; step <= 3; step++) {
      await nextScan(rig);
      expect(clicksIn(rig, "move").length).toBeGreaterThanOrEqual(moves + step);
      expect(rig.service.status().decision?.kind).toBe("move");
    }
    expect(stats(rig)).toMatchObject({ lootClicks: 5, lootLabels: 1 });
    expect(clicksIn(rig, "loot")).toHaveLength(5);
    expect([...rig.reasons].some(reason => reason.includes("not picking anything up"))).toBe(false);
    expect(rig.service.status().running).toBe(true);
  });
});

describe("follow drive sprint (synthetic input host: 'sprint' requests are array entries, no key is ever pressed)", () => {
  async function sprintRig(clock: number): Promise<Rig> {
    const rig = await calibrated({ clock });
    goLive(rig, { sprint: true });
    return rig;
  }
  const renews = (rig: Rig) => sprintOps(rig).filter(entry => entry.hold === true && entry.start === false).length;
  it("accepts sprint only as a boolean and saves it only when on", () => {
    const base = { version: 1, dryRun: false, mapScale: 7, clickIntervalMs: 100 } as const;
    expect(parseDriveSettings({ ...base, sprint: true })).toEqual({ ...base, sprint: true });
    expect(parseDriveSettings({ ...base, sprint: false })).toEqual(base);
    expect(() => parseDriveSettings({ ...base, sprint: "yes" })).toThrow("sprint must be on or off");
  });
  it("starts the hold through the controller on the back of an emitted move click, renews it on later cycles, and starts again through the controller after 'Sprint lapsed'", async () => {
    const rig = await sprintRig(400_000); // leader FAR: 108 map px, beyond the 70 px start distance
    await rig.service.start();
    await expect.poll(() => stats(rig).sprints, soon).toBe(1);
    expect(rig.service.status()).toMatchObject({ running: true, sprinting: true, settings: { sprint: true }, stats: { clicks: 1 } });
    // The click comes first, so the cursor already points where we are heading; the hold is bound to the same capture as that click.
    expect(rig.input.slice(0, 3)).toEqual([{ op: "ping" }, rig.attempts[0].payload, { op: "sprint", hold: true, start: true, expectedHwnd: HWND, viewWidth: W, viewHeight: H, capturedAtQpcMs: rig.attempts[0].payload.capturedAtQpcMs, maxAgeMs: 120 }]);
    expect(rig.traces.map(trace => [trace.decisionRule, trace.result])).toEqual([["follow-map-marker", "emitted"], ["sprint-to-catch-up", "emitted"]]);
    expect(rig.traces[1]).toMatchObject({ module: "navigation", reason: expect.stringContaining("Sprint: 108 map px behind."), input: { kind: "key", key: "space", text: "hold" } });
    // Pacing cycles keep the hold alive with start:false, each bound to that cycle's fresh capture, without going through the controller again.
    await expect.poll(() => renews(rig), soon).toBeGreaterThanOrEqual(3);
    const renewals = sprintOps(rig).slice(1);
    expect(renewals.every(entry => entry.hold === true && entry.start === false && entry.expectedHwnd === HWND && entry.maxAgeMs === 120)).toBe(true);
    expect(renewals.map(entry => Number(entry.capturedAtQpcMs)).every((qpc, i, all) => qpc > Number(i ? all[i - 1] : rig.attempts[0].payload.capturedAtQpcMs))).toBe(true);
    expect(rig.traces).toHaveLength(2);
    expect(rig.service.status().sprinting).toBe(true);
    // The worker let the key go by itself (its hold lapsed): a renew can never press it again.
    rig.sprintRefusals.push({ start: false, error: "Sprint lapsed" });
    await expect.poll(() => rig.service.status().sprinting, soon).toBe(false);
    expect(rig.service.status().running).toBe(true);
    const lapsedAt = sprintOps(rig).length;
    await cycles(rig);
    // No renew of a hold that is gone, no start without a fresh move click, and no stop.
    expect(sprintOps(rig)).toHaveLength(lapsedAt);
    expect(rig.service.status()).toMatchObject({ running: true, sprinting: false, stats: { sprints: 1, refused: 0, manualTakeovers: 0 } });
    rig.clock! += 100;
    await expect.poll(() => stats(rig).sprints, soon).toBe(2);
    expect(sprintOps(rig)[lapsedAt]).toMatchObject({ op: "sprint", hold: true, start: true, capturedAtQpcMs: rig.attempts[1].payload.capturedAtQpcMs });
    expect(rig.input[rig.input.indexOf(sprintOps(rig)[lapsedAt]) - 1]).toBe(rig.attempts[1].payload);
    expect(rig.traces.filter(trace => trace.decisionRule === "sprint-to-catch-up").map(trace => trace.result)).toEqual(["emitted", "emitted"]);
    expect(rig.service.status().sprinting).toBe(true);
    // Nothing ever asked the worker to let go in all this.
    expect(sprintOps(rig).some(entry => entry.hold !== true)).toBe(false);
  });
  it("does not sprint under 70 map px or with the setting off, keeps sprinting down to 40 map px once started, and lets go below that", async () => {
    const off = await calibrated({ clock: 405_000 });
    goLive(off);
    const close = await sprintRig(406_000);
    close.scene.leader = { dx: 69, dy: 0 };
    for (const rig of [off, close]) {
      await rig.service.start();
      await expect.poll(() => stats(rig).clicks, soon).toBe(1);
      await cycles(rig);
      expect(sprintOps(rig)).toEqual([]);
      expect(rig.service.status().sprinting).toBe(false);
    }
    // One more map px and the next move click starts it.
    close.scene.leader = { dx: 70, dy: 0 };
    close.clock! += 100;
    await expect.poll(() => stats(close).sprints, soon).toBe(1);
    const see = async (dx: number) => { close.scene.leader = { dx, dy: 0 }; await expect.poll(() => close.service.status().observation?.offset?.distance, soon).toBe(dx); };
    await see(40);
    const before = renews(close);
    await expect.poll(() => renews(close), soon).toBeGreaterThan(before + 2);
    expect(close.service.status().sprinting).toBe(true);
    await see(39);
    await expect.poll(() => close.service.status().sprinting, soon).toBe(false);
    expect(sprintOps(close).at(-1)).toEqual({ op: "sprint", hold: false });
    await cycles(close);
    expect(sprintOps(close).filter(entry => entry.hold === false)).toHaveLength(1);
    expect(sprintOps(close).at(-1)).toEqual({ op: "sprint", hold: false });
  });
  it("lets go of the sprint key before a loot click is sent", async () => {
    const rig = await calibrated({ clock: 410_000 });
    rig.follow = { ...rig.follow, lootEnabled: true, lootLeash: 20 }; // 120 map px: the leader is inside it at sprinting distance
    goLive(rig, { sprint: true });
    await rig.service.start();
    await expect.poll(() => rig.service.status().sprinting, soon).toBe(true);
    rig.scene.loot = [{ x: ORIGIN.x + 100, y: ORIGIN.y - 73, width: 81, height: 21 }];
    // First sighting, then the click: by then the hold may have been started again by a move click in between.
    await nextScan(rig);
    expect(clicksIn(rig, "loot")).toEqual([]);
    await expect.poll(() => rig.service.status().sprinting, soon).toBe(true);
    await nextScan(rig);
    expect(clicksIn(rig, "loot")).toHaveLength(1);
    const at = rig.input.indexOf(clicksIn(rig, "loot")[0].payload);
    expect(rig.input[at - 1]).toEqual({ op: "sprint", hold: false });
    // The last thing said about the key before the click, with a hold somewhere before that.
    expect(rig.input.slice(0, at - 1).some(entry => entry.op === "sprint" && entry.start === true)).toBe(true);
    expect(rig.service.status().sprinting).toBe(false);
    // While the character walks to the item nothing holds the key again.
    await cycles(rig);
    expect(rig.input.slice(at + 1).filter(entry => entry.op === "sprint")).toEqual([]);
  });
  it.each([["Stale capture", "refused"], ["Manual mouse movement", "manualTakeovers"]] as const)("lets go of the sprint key after a moveclick refused with '%s' while sprinting", async (refusal, counter) => {
    const rig = await sprintRig(420_000);
    await rig.service.start();
    await expect.poll(() => rig.service.status().sprinting, soon).toBe(true);
    await expect.poll(() => renews(rig), soon).toBeGreaterThanOrEqual(1);
    rig.refusals.push(refusal);
    rig.clock! += 100;
    await expect.poll(() => stats(rig)[counter], soon).toBe(1);
    const at = rig.input.indexOf(rig.attempts[1].payload);
    // That cycle renewed the hold, had its click refused, and let go at once.
    expect(rig.input.slice(at - 1, at + 2)).toMatchObject([{ op: "sprint", hold: true, start: false }, { op: "moveclick" }, { op: "sprint", hold: false }]);
    expect(rig.service.status().running).toBe(true);
    if (counter === "manualTakeovers") {
      // The player has the mouse: no hold of any kind for the 1500 ms pause.
      expect(rig.service.status().sprinting).toBe(false);
      rig.clock! += 1499;
      await cycles(rig);
      expect(rig.input.slice(at + 2)).toEqual([]);
      rig.clock! += 1;
    }
    // The retry's accepted click starts the hold again, through the controller.
    await expect.poll(() => stats(rig).sprints, soon).toBe(2);
    expect(rig.input.slice(at + 2, at + 4)).toMatchObject([{ op: "moveclick", area: "move" }, { op: "sprint", hold: true, start: true }]);
    expect(sprintOps(rig).filter(entry => entry.hold === false)).toHaveLength(1);
  });
  it("counts a sprint start refused with 'Space held - manual control' as a manual takeover pause, not a stop", async () => {
    const rig = await sprintRig(430_000);
    rig.sprintRefusals.push({ start: true, error: "Space held - manual control" });
    await rig.service.start();
    await expect.poll(() => stats(rig).manualTakeovers, soon).toBe(1);
    expect(rig.service.status()).toMatchObject({ running: true, sprinting: false, reason: "Manual control detected — following resumes shortly.", stats: { clicks: 1, sprints: 0, refused: 0 } });
    expect(rig.traces.map(trace => [trace.decisionRule, trace.result])).toEqual([["follow-map-marker", "emitted"], ["sprint-to-catch-up", "failed"]]);
    expect(rig.traces[1].reason).toContain("sink=Space held - manual control");
    rig.clock! += 1499;
    await cycles(rig);
    expect(rig.service.status().decision).toEqual({ kind: "pause", reason: "Manual control detected — following resumes shortly." });
    expect(ops(rig.input)).toEqual(["ping", "moveclick", "sprint"]);
    rig.clock! += 1;
    await expect.poll(() => stats(rig).sprints, soon).toBe(1);
    expect(rig.service.status()).toMatchObject({ running: true, sprinting: true, stats: { clicks: 2, manualTakeovers: 1 } });
    // The key was never down while the player held it, so there was nothing to let go of.
    expect(sprintOps(rig).slice(0, 2)).toMatchObject([{ hold: true, start: true }, { hold: true, start: true }]);
    expect(sprintOps(rig).some(entry => entry.hold === false)).toBe(false);
  });
  it("lets go of the sprint key when a capture fails while sprinting", async () => {
    const rig = await sprintRig(440_000);
    await rig.service.start();
    await expect.poll(() => rig.service.status().sprinting, soon).toBe(true);
    rig.scene.captureError = "Focus Path of Exile 2 to continue";
    await expect.poll(() => sprintOps(rig).at(-1), soon).toEqual({ op: "sprint", hold: false });
    expect(rig.service.status()).toMatchObject({ running: true, sprinting: false, reason: "Focus Path of Exile 2 to continue", observation: undefined });
    // Said once; the failed captures that follow have nothing left to let go of.
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(sprintOps(rig).filter(entry => entry.hold === false)).toHaveLength(1);
    expect(sprintOps(rig).at(-1)).toEqual({ op: "sprint", hold: false });
    // Focus returns: the next accepted move click starts the hold again.
    rig.scene.captureError = undefined;
    rig.clock! += 100;
    await expect.poll(() => stats(rig).sprints, soon).toBe(2);
  });
});

describe("follow drive aim source (SYNTHETIC blue outline pixels for odometry and an injected map host, no OS input)", () => {
  it("walks the terrain plan while the leader has left no trail, and the leader-walked trail once there is one and nothing has been bumped into", async () => {
    const rig = await calibrated({ clock: 500_000, mapHost: true });
    goLive(rig);
    rig.scene.blue = outlines();
    rig.scene.leader = { dx: 40, dy: 0 };
    await rig.service.start();
    // Open ground on the map scan: a plan exists. One trail point is no trail, so the plan is what is walked.
    await expect.poll(() => rig.service.status().terrain?.planned, soon).toBe(true);
    await expect.poll(() => rig.service.status().odometry, soon).toMatchObject({ tracked: true, quality: 1, trailPoints: 1, via: "plan" });
    expect(rig.map[0]).toMatchObject({ op: "terrain", x: 64, y: 18, width: 448, height: 270, full: false, channel: "walls", grid: 4 });   // grid: one point per planner cell, so a busy scene cannot overflow the cap and lose the plan
    expect(rig.service.status().terrain).toMatchObject({ planned: true, walls: 0, bumps: 0, blockedAhead: false });
    // The leader walks off to the right in 10 px steps while we stand still (the outline pixels do not slide): 7 trail points, 60 px of trail.
    for (let dx = 50; dx <= 100; dx += 10) { rig.scene.leader = { dx, dy: 0 }; await expect.poll(() => rig.service.status().observation?.offset?.dx, soon).toBe(dx); }
    await expect.poll(() => rig.service.status().odometry?.via, soon).toBe("trail");
    // The plan is still there and still has an aim: the trail won, it did not merely fill a gap.
    expect(rig.service.status()).toMatchObject({ odometry: { tracked: true, trailPoints: 7, via: "trail" }, terrain: { planned: true, bumps: 0 } });
    rig.service.stop();
    await expect.poll(() => ops(rig.map).at(-1), soon).toBe("closed");
  });
  // Live: the follower stood against rock at 0 px/s, steering "direct" into it. A wall on the straight line plus a route
  // read all the way to the leader is not a guess, so it outranks the leader's trail as well as the straight line.
  it("walks the route read off the map when a wall stands on the straight line, even once the leader has left a trail", async () => {
    const rig = await calibrated({ clock: 530_000, mapHost: true });
    goLive(rig);
    rig.scene.blue = outlines();
    rig.scene.leader = { dx: 40, dy: 0 };
    // A wall across the straight line, 70 px to our right, open at its ends: there is a way round, and the map shows it.
    rig.scene.walls = []; for (let y = ORIGIN.y - 60; y <= ORIGIN.y + 60; y++) for (let x = ORIGIN.x + 68; x <= ORIGIN.x + 72; x++) rig.scene.walls.push({ x, y });
    await rig.service.start();
    await expect.poll(() => rig.service.status().terrain?.planned, soon).toBe(true);
    // The leader walks off to the right, THROUGH where the wall is drawn, leaving a trail as it goes.
    for (let dx = 50; dx <= 120; dx += 10) { rig.scene.leader = { dx, dy: 0 }; await expect.poll(() => rig.service.status().observation?.offset?.dx, soon).toBe(dx); }
    // The plan in hand is still the one made when they stood 40 px away with nothing in between, so for now the trail
    // they have left is what steering walks - exactly the old rule.
    await expect.poll(() => rig.service.status().odometry?.via, soon).toBe("trail");
    rig.clock! += 300;   // plans are made every 250 ms of service time, and this clock only moves by hand
    await expect.poll(() => rig.service.status().terrain, soon).toMatchObject({ planned: true, wallBetween: true, reachesLeader: true });
    // The fresh plan sees the wall and a way round it to the leader: the map outranks the trail now.
    await expect.poll(() => rig.service.status().odometry?.via, soon).toBe("plan");
    rig.service.stop();
    await expect.poll(() => ops(rig.map).at(-1), soon).toBe("closed");
  });
  /**
   * A solid map outline across the view between us and the leader, with gappy stubs on our side: every plan has
   * to search all the ground it can reach, which is what the real dotted outlines make it do.
   */
  function sealedOff(): Point[] {
    const next = ((seed: number) => () => (seed = seed * 48271 % 2147483647) / 2147483647)(7), points: Point[] = [];
    for (let x = 0; x < W; x++) points.push({ x, y: ORIGIN.y - 30 }, { x, y: ORIGIN.y - 29 });
    for (let i = 0; i < 40; i++) {
      let x = 4 + Math.floor(next() * (W - 8)), y = ORIGIN.y - 14 + Math.floor(next() * 120);
      const horizontal = next() < .5, length = 10 + Math.floor(next() * 80);
      for (let k = 0; k < length; k++) {
        if (k % 16 < 9 && Math.hypot(x - ORIGIN.x, y - ORIGIN.y) > 12) points.push({ x, y });
        if (horizontal) x++; else y++;
        if (x >= W || y >= H) break;
      }
    }
    return points;
  }
  const terrainScans = (rig: Rig) => rig.map.filter(entry => entry.op === "terrain");
  it("plans over and over at a bounded cost: one settled cell per grid cell, so no search and no heap can run away", async () => {
    // A live 420 s run froze for 25-80 s at a time and reached 1.29 GB: costs kept in a Float32Array rounded UP,
    // so the same relaxation fired again on every expansion and A*'s open list grew without end.
    const rig = await calibrated({ clock: 520_000, mapHost: true });
    goLive(rig);
    rig.scene.blue = outlines();
    rig.scene.walls = sealedOff();
    await rig.service.start();
    await expect.poll(() => rig.service.status().terrain, soon).toBeDefined();
    const cells = 112 * 68;   // the 448 × 270 planning window, 4 px to a cell
    const heapBefore = process.memoryUsage().heapUsed;
    let plans = 0, worstSearched = 0, worstPlanMs = 0;
    for (let i = 0; i < 40; i++) {
      const from = terrainScans(rig).length;
      rig.clock! += 250;      // one planning period
      await expect.poll(() => terrainScans(rig).length, soon).toBeGreaterThan(from);
      await cycles(rig, 2);
      const terrain = rig.service.status().terrain!;
      plans++; worstSearched = Math.max(worstSearched, terrain.searched); worstPlanMs = Math.max(worstPlanMs, terrain.planMs);
    }
    expect(plans).toBe(40);
    // The scene really is searched rather than thrown out by the wall-fraction guard, and each plan settles
    // a cell at most once: the structure that grew cannot grow again.
    expect(worstSearched).toBeGreaterThan(500);
    expect(worstSearched).toBeLessThanOrEqual(cells);
    // Under the search's own 120 ms clock budget, so a plan can never hold the 50 ms tick loop for long.
    expect(worstPlanMs).toBeLessThan(120);
    // Nothing of the 40 plans is kept: a runaway open list of ~160 M numbers was 1.3 GB.
    expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(64 * 1024 * 1024);
  });
  it("reports 'direct' without a map host and without odometry, as in every other test of this file", async () => {
    const rig = await calibrated({ clock: 510_000 });
    goLive(rig);
    await rig.service.start();
    await cycles(rig);
    expect(rig.service.status()).toMatchObject({ odometry: { tracked: false, trailPoints: 0, via: "direct" }, terrain: undefined });
    expect(rig.map).toEqual([]);
  });
});

describe("follow drive travel to the leader (SYNTHETIC party-frame pixels and hosts: a 'click' is an array entry, no OS input)", () => {
  const VIEW = { width: W, height: H };
  /** The party frame's travel button: a solid blue swirl measured at 2560 × 1440 as 28 × 28 px at (11, 322), scaled to this view. */
  function travelButton(view = VIEW): Point[] {
    const scale = view.height / 1440, size = Math.max(4, Math.round(28 * scale)), left = Math.round(11 * scale), top = Math.round(322 * scale), points: Point[] = [];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) points.push({ x: left + x, y: top + y });
    return points;
  }
  // Both party-frame and confirm-band scans are 'key' on the map host; the channel says which is which.
  const partyScans = (rig: Rig) => rig.map.filter(entry => entry.op === "key" && entry.channel === PARTY_CHANNEL);
  /** Live, with the map host that carries the party scan, the button on screen, and the leader far away on the map. */
  async function travelRig(clock: number): Promise<Rig> {
    const rig = await calibrated({ clock, mapHost: true });
    goLive(rig);
    rig.scene.party = travelButton();
    return rig;
  }
  /** Takes the leader off the map and waits for the tracker to say so; the frozen clock has not moved. */
  async function leaderLeaves(rig: Rig): Promise<void> {
    rig.scene.leader = undefined;
    await expect.poll(() => rig.service.status().observation?.leaderFound, soon).toBe(false);
  }
  it("clicks the party frame's travel button once the leader's marker has been gone for 3 s, bound to the party scan that found it", async () => {
    const rig = await travelRig(600_000);
    await rig.service.start();
    await expect.poll(() => stats(rig).clicks, soon).toBe(1);   // an ordinary movement click: the leader is still on the map
    await leaderLeaves(rig);
    // A marker missing for a moment is a dropped frame, not an area transition: nothing is even scanned yet.
    rig.clock! += 2999;
    await cycles(rig, 3);
    expect(partyScans(rig)).toEqual([]);
    expect(clicksIn(rig, "party")).toEqual([]);
    rig.clock! += 1;
    await expect.poll(() => stats(rig).teleports, soon).toBe(1);
    const button = findTravelButton(travelButton(), VIEW);
    expect(button).toBeDefined();
    // The scan is the party band on the SECOND worker, so the marker capture keeps its 120 ms freshness budget.
    expect(partyScans(rig)).toEqual([{ op: "key", ...PARTY_BAND(VIEW), full: false, channel: PARTY_CHANNEL, threshold: PARTY_THRESHOLD, cap: PARTY_POINT_CAP }]);
    expect(clicksIn(rig, "party").map(attempt => attempt.payload)).toEqual([
      { op: "moveclick", ...button!.centre, expectedHwnd: HWND, viewWidth: W, viewHeight: H, capturedAtQpcMs: rig.partyQpc.at(-1), maxAgeMs: 120, area: "party" },
    ]);
    const trace = rig.traces.at(-1)!;
    expect(trace).toMatchObject({ module: "navigation", decisionRule: "travel-to-leader", result: "emitted", confidence: 1, processName: GAME, input: { kind: "click", ...button!.centre, button: "left", text: "party" } });
    expect(JSON.parse(trace.evidenceHash)).toMatchObject({ hwnd: HWND, capturedAtQpcMs: rig.partyQpc.at(-1), button: button!.centre, leaderMissingMs: 3000 });
    expect(rig.service.status()).toMatchObject({ running: true, reason: "Travel to Main: their map marker has been gone for 3.0 s.", decision: { kind: "hold" }, stats: { teleports: 1, clicks: 2 } });
  });
  it("never travels while the leader is on the map: the button is always drawn, so it says nothing about where they are", async () => {
    const rig = await travelRig(610_000);
    await rig.service.start();
    await expect.poll(() => stats(rig).clicks, soon).toBe(1);
    // Four times the absence period with the leader in sight the whole while.
    for (let step = 0; step < 4; step++) { rig.clock! += 3000; await cycles(rig, 3); }
    expect(partyScans(rig)).toEqual([]);
    expect(clicksIn(rig, "party")).toEqual([]);
    expect(stats(rig).teleports).toBe(0);
    expect(rig.traces.every(trace => trace.decisionRule !== "travel-to-leader")).toBe(true);
  });
  it("travels at most once per 10 s, scanning for nothing in between: the new area needs that long to load", async () => {
    const rig = await travelRig(620_000);
    await rig.service.start();
    await expect.poll(() => stats(rig).clicks, soon).toBe(1);
    await leaderLeaves(rig);
    rig.clock! += 3000;
    await expect.poll(() => stats(rig).teleports, soon).toBe(1);
    rig.clock! += 9999;
    await cycles(rig, 5);
    expect(partyScans(rig)).toHaveLength(1);
    expect(stats(rig).teleports).toBe(1);
    // Still no leader after the cooldown: the first click missed, or they moved on again.
    rig.clock! += 1;
    await expect.poll(() => stats(rig).teleports, soon).toBe(2);
    expect(clicksIn(rig, "party")).toHaveLength(2);
    expect(partyScans(rig)).toHaveLength(2);
  });
  it("charges no cooldown for a travel click the worker refused: nothing was sent, so only the manual pause holds the retry", async () => {
    // Measured live: two travel clicks refused for manual control, each charged the full 10 s, put 23 s between
    // the leader leaving and the teleport although the game had seen nothing at all.
    const rig = await travelRig(650_000);
    await rig.service.start();
    await expect.poll(() => stats(rig).clicks, soon).toBe(1);
    await leaderLeaves(rig);
    rig.clock! += 2999;
    await cycles(rig, 3);
    rig.refusals.push("Manual mouse movement");
    rig.clock! += 1;
    await expect.poll(() => stats(rig).manualTakeovers, soon).toBe(1);
    expect(clicksIn(rig, "party")).toHaveLength(1);
    expect(stats(rig)).toMatchObject({ teleports: 0, clicks: 1 });
    // The 1500 ms the takeover costs, not the 10 s an area load would.
    rig.clock! += 1499;
    await cycles(rig, 3);
    expect(clicksIn(rig, "party")).toHaveLength(1);
    rig.clock! += 1;
    await expect.poll(() => stats(rig).teleports, soon).toBe(1);
    expect(clicksIn(rig, "party")).toHaveLength(2);
    expect(rig.traces.map(trace => trace.result).slice(-2)).toEqual(["failed", "emitted"]);
  });
  it("closes the panel first when the leader is gone and the map centre is covered at once, then travels once the centre verifies", async () => {
    const rig = await travelRig(660_000);
    await rig.service.start();
    await expect.poll(() => stats(rig).clicks, soon).toBe(1);
    rig.scene.own = { dx: 18, dy: 0 };   // a panel over the map centre
    await leaderLeaves(rig);
    rig.clock! += 3000;                  // LEADER_GONE_MS and PANEL_STUCK_MS both due
    await expect.poll(() => rig.escapes.length, soon).toBe(1);
    // Escape wins: the travel click needs a verified centre of its own, so the two recoveries never fight.
    expect(partyScans(rig)).toEqual([]);
    expect(clicksIn(rig, "party")).toEqual([]);
    expect(stats(rig).teleports).toBe(0);
    rig.scene.own = { dx: 0, dy: 0 };    // the panel is gone: travel takes over by itself, cooldown untouched
    await expect.poll(() => stats(rig).teleports, soon).toBe(1);
    expect(rig.escapes).toHaveLength(1);
  });
  // Live: the follower died, resurrected in town standing on a portal, and the portal's map icon covered two thirds
  // of its own marker. Nothing was open, so Escape could not help, travel stayed gated on a verified centre, and the
  // follower never left town. Once Escape has had its even number of turns, the button being found is the evidence.
  it("travels with the map centre still unverifiable once Escape has had its turns, on the evidence of the button itself", async () => {
    const rig = await travelRig(690_000);
    await rig.service.start();
    await expect.poll(() => stats(rig).clicks, soon).toBe(1);
    rig.scene.own = { dx: 18, dy: 0 };   // our marker is covered and stays covered: no panel to close
    await leaderLeaves(rig);
    rig.clock! += 3000;
    await expect.poll(() => rig.escapes.length, soon).toBe(1);
    expect(stats(rig).teleports).toBe(0);            // one press in: a menu we opened may still be up
    rig.clock! += 3000;                              // PANEL_ESCAPE_COOLDOWN_MS
    await expect.poll(() => rig.escapes.length, soon).toBe(2);
    rig.clock! += 250;
    await expect.poll(() => stats(rig).teleports, soon).toBe(1);
    expect(clicksIn(rig, "party")).toHaveLength(1);
    expect(rig.escapes).toHaveLength(2);
    expect(JSON.parse(String(rig.traces.find(t => t.decisionRule === "travel-to-leader")!.evidenceHash))).toMatchObject({ centreVerified: false });
  });
  it("still refuses to travel on an unverified centre when the button is not there: a panel over the corner hides it", async () => {
    const rig = await travelRig(720_000);
    rig.scene.party = [];
    await rig.service.start();
    await expect.poll(() => stats(rig).clicks, soon).toBe(1);
    rig.scene.own = { dx: 18, dy: 0 };
    await leaderLeaves(rig);
    rig.clock! += 3000;
    await expect.poll(() => rig.escapes.length, soon).toBe(1);
    rig.clock! += 3000;
    await expect.poll(() => rig.escapes.length, soon).toBe(2);
    rig.clock! += 250;
    await expect.poll(() => partyScans(rig).length, soon).toBeGreaterThanOrEqual(1);
    await cycles(rig, 5);
    expect(clicksIn(rig, "party")).toEqual([]);
    expect(stats(rig).teleports).toBe(0);
  });
  it("sends nothing while the button is not in the band, and keeps looking at the scan pace until it is", async () => {
    const rig = await travelRig(630_000), band = PARTY_BAND(VIEW);
    // A panel over the corner: a few stray blue pixels, not the button.
    rig.scene.party = [{ x: band.x + 2, y: band.y + 3 }, { x: band.x + 5, y: band.y + 9 }, { x: band.x + 6, y: band.y + 10 }];
    expect(findTravelButton(rig.scene.party, VIEW)).toBeUndefined();
    await rig.service.start();
    await expect.poll(() => stats(rig).clicks, soon).toBe(1);
    await leaderLeaves(rig);
    rig.clock! += 3000;
    await expect.poll(() => partyScans(rig).length, soon).toBe(1);
    await cycles(rig, 5);
    expect(clicksIn(rig, "party")).toEqual([]);
    expect(stats(rig).teleports).toBe(0);
    // Paced, not run every cycle; and a scan that finds nothing costs no cooldown, because the panel may close.
    expect(partyScans(rig)).toHaveLength(1);
    rig.clock! += 250;
    await expect.poll(() => partyScans(rig).length, soon).toBe(2);
    rig.scene.party = travelButton();
    rig.clock! += 250;
    await expect.poll(() => stats(rig).teleports, soon).toBe(1);
    expect(clicksIn(rig, "party")).toHaveLength(1);
  });
  it("previews the travel click in a dry run: the input worker receives nothing at all", async () => {
    const rig = await travelRig(640_000);
    rig.service.configure({ version: 1, dryRun: true, mapScale: 7, clickIntervalMs: 100 });
    await rig.service.start();
    await expect.poll(() => stats(rig).previewed, soon).toBe(1);
    await leaderLeaves(rig);
    rig.clock! += 3000;
    await expect.poll(() => stats(rig).teleports, soon).toBe(1);
    expect(rig.attempts).toEqual([]);
    expect(ops(rig.input)).toEqual(["ping"]);
    expect(stats(rig)).toMatchObject({ clicks: 0, previewed: 2, teleports: 1 });
    expect(rig.traces.at(-1)).toMatchObject({ decisionRule: "travel-to-leader", result: "blocked", input: { text: "party" }, reason: expect.stringContaining("safety=dry-run") });
    expect(rig.service.status()).toMatchObject({ running: true, reason: "Preview only: would travel to Main: their map marker has been gone for 3.0 s.", decision: { kind: "hold" } });
  });

  describe("confirming the teleport (SYNTHETIC dialog pixels: the modal is an array of points, no OS input)", () => {
    /** A deterministic 1-in-`step` scatter of bright pixels over the whole confirm band. */
    function bandPixels(step: number, view = VIEW): Point[] {
      const band = CONFIRM_BAND(view), points: Point[] = [];
      for (let y = band.y; y < band.y + band.height; y++) for (let x = band.x; x < band.x + band.width; x++) if ((x * 7 + y * 13) % step === 0) points.push({ x, y });
      return points;
    }
    /** The dimmed modal: a few hundred points of text and button borders. */
    const DIALOG = bandPixels(100);
    /** The same band in ordinary play, bright enough that the scan gives up at its cap. */
    const LIT = bandPixels(3);
    const OK = confirmOk(VIEW);
    const confirmScans = (rig: Rig) => rig.map.filter(entry => entry.op === "key" && entry.channel === CONFIRM_CHANNEL);
    /** Live, the leader gone, one travel click already sent: the game is about to ask "are you sure?". */
    async function travelled(clock: number): Promise<Rig> {
      const rig = await travelRig(clock);
      await rig.service.start();
      await expect.poll(() => stats(rig).clicks, soon).toBe(1);
      await leaderLeaves(rig);
      rig.clock! += 3000;
      await expect.poll(() => stats(rig).teleports, soon).toBe(1);
      return rig;
    }
    // Live: 19 of one day's 31 confirmed teleports had Escape pressed into the loading screen. With nothing open that
    // OPENS the game menu, and the first movement click came a median 14.0 s after the OK instead of 3.2 s.
    it("does not press Escape into the loading screen after its own teleport, and takes it up again if the map never comes back", async () => {
      const rig = await travelled(760_000);
      rig.scene.confirm = DIALOG;
      rig.clock! += 250;
      await expect.poll(() => stats(rig).confirms, soon).toBe(1);
      rig.scene.confirm = undefined;
      rig.scene.own = null;                 // the new area is loading: no map, no marker, nothing to close
      rig.scene.party = [];                 // and no party frame either, so nothing here is a second travel attempt
      for (const step of [2500, 4000, 4000, 3500]) { rig.clock! += step; await cycles(rig, 2); }   // 14 s of loading, well past PANEL_STUCK_MS
      expect(rig.escapes).toEqual([]);      // 14 s of load and not one press
      rig.clock! += 2000;                   // past the grace: a map that never came back is a real problem again
      await expect.poll(() => rig.escapes.length, soon).toBe(1);
    });
    it("hands Escape back the moment the map centre verifies, so a panel opened in the new area is still closed", async () => {
      const rig = await travelled(790_000);
      rig.scene.confirm = DIALOG;
      rig.clock! += 250;
      await expect.poll(() => stats(rig).confirms, soon).toBe(1);
      rig.scene.confirm = undefined;
      rig.scene.own = null;
      rig.clock! += 3000; await cycles(rig, 3);
      rig.scene.own = { dx: 0, dy: 0 };     // loaded: the centre verifies and the grace ends there
      await expect.poll(() => rig.service.status().observation?.originVerified, soon).toBe(true);
      rig.scene.own = { dx: 18, dy: 0 };    // and now a real panel covers it
      rig.scene.party = [];
      rig.clock! += 1600; await cycles(rig, 3);   // past the 1500 ms a hidden marker is still trusted for
      rig.clock! += 2100;                         // then PANEL_STUCK_MS
      await expect.poll(() => rig.escapes.length, soon).toBe(1);
    });
    it("clicks OK on its own teleport confirmation, bound to the confirm-band scan that found it", async () => {
      const rig = await travelled(700_000);
      expect(confirmDialog(DIALOG, VIEW)).toEqual({ ok: OK });
      rig.scene.confirm = DIALOG;
      rig.clock! += 250;
      await expect.poll(() => stats(rig).confirms, soon).toBe(1);
      // The band is read on the SECOND worker, like the party frame, so the marker capture keeps its 120 ms budget.
      expect(confirmScans(rig).at(-1)).toEqual({ op: "key", ...CONFIRM_BAND(VIEW), full: false, channel: CONFIRM_CHANNEL, threshold: CONFIRM_THRESHOLD, cap: CONFIRM_POINT_CAP });
      expect(clicksIn(rig, "confirm").map(attempt => attempt.payload)).toEqual([
        { op: "moveclick", ...OK, expectedHwnd: HWND, viewWidth: W, viewHeight: H, capturedAtQpcMs: rig.confirmQpc.at(-1), maxAgeMs: 120, area: "confirm" },
      ]);
      // OK is the right-hand button; CANCEL is its mirror image left of centre and is never a target.
      expect(OK.x).toBeGreaterThan(W / 2);
      const trace = rig.traces.at(-1)!;
      expect(trace).toMatchObject({ module: "navigation", decisionRule: "confirm-teleport", result: "emitted", confidence: 1, processName: GAME, reason: expect.stringContaining("Confirm the teleport to Main."), input: { kind: "click", ...OK, button: "left", text: "confirm" } });
      expect(JSON.parse(trace.evidenceHash)).toMatchObject({ hwnd: HWND, capturedAtQpcMs: rig.confirmQpc.at(-1), ok: OK });
      expect(stats(rig)).toMatchObject({ confirms: 1, teleports: 1, clicks: 3 });
      await expect.poll(() => [...rig.reasons], soon).toContain("Confirm the teleport to Main.");
    });
    it("never answers a confirmation it did not ask for: with no travel click of ours, the band is not even scanned", async () => {
      const rig = await travelRig(710_000);
      rig.scene.confirm = DIALOG;
      await rig.service.start();
      await expect.poll(() => stats(rig).clicks, soon).toBe(1);
      // Four whole confirm windows with the leader in sight and the dialog on screen the entire time.
      for (let step = 0; step < 4; step++) { rig.clock! += 4000; await cycles(rig, 3); }
      expect(confirmScans(rig)).toEqual([]);
      expect(clicksIn(rig, "confirm")).toEqual([]);
      expect(stats(rig).confirms).toBe(0);
      expect(rig.traces.every(trace => trace.decisionRule !== "confirm-teleport")).toBe(true);
    });
    it("clicks nothing while the band is lit, and gives up by itself when no dialog ever appears", async () => {
      const rig = await travelled(720_000);
      rig.scene.confirm = LIT;
      expect(LIT.length).toBeGreaterThan(CONFIRM_POINT_CAP);
      for (let step = 0; step < 4; step++) { rig.clock! += 250; await expect.poll(() => confirmScans(rig).length, soon).toBeGreaterThanOrEqual(step + 1); }
      expect(clicksIn(rig, "confirm")).toEqual([]);
      expect(stats(rig).confirms).toBe(0);
      // Past the window the state is gone, so a travel that went nowhere cannot wedge the loop — and a dialog
      // turning up late is not ours to answer.
      rig.clock! += 4000;
      await cycles(rig, 4);
      const scans = confirmScans(rig).length;
      rig.scene.confirm = DIALOG;
      rig.clock! += 250;
      await cycles(rig, 4);
      expect(confirmScans(rig)).toHaveLength(scans);
      expect(clicksIn(rig, "confirm")).toEqual([]);
      expect(stats(rig).confirms).toBe(0);
    });
    it("clicks OK once per travel attempt, however long the dialog stays up", async () => {
      const rig = await travelled(730_000);
      rig.scene.confirm = DIALOG;
      rig.clock! += 250;
      await expect.poll(() => stats(rig).confirms, soon).toBe(1);
      const scans = confirmScans(rig).length;
      // Still on screen six seconds later (a slow teleport, a dropped click): the window is spent all the same,
      // and the post-teleport cooldown keeps the travel button from being clicked again meanwhile.
      for (let step = 0; step < 6; step++) { rig.clock! += 1000; await cycles(rig, 3); }
      expect(confirmScans(rig)).toHaveLength(scans);
      expect(clicksIn(rig, "confirm")).toHaveLength(1);
      expect(stats(rig)).toMatchObject({ confirms: 1, teleports: 1 });
    });
    it("confirms with the map centre covered, where ordinary movement and looting are shut down", async () => {
      const rig = await travelled(740_000);
      const moves = clicksIn(rig, "move").length;
      // What the modal actually does: it covers the map centre, so our own marker is gone and every guard that
      // depends on a verified centre turns false. The confirm step has to survive exactly that.
      rig.scene.own = null; rig.scene.confirm = DIALOG;
      rig.clock! += 1501;
      await expect.poll(() => stats(rig).confirms, soon).toBe(1);
      expect(rig.service.status().observation?.originVerified).toBe(false);
      expect(clicksIn(rig, "confirm")).toHaveLength(1);
      expect(clicksIn(rig, "move")).toHaveLength(moves);
      expect(rig.traces.at(-1)).toMatchObject({ decisionRule: "confirm-teleport", result: "emitted", input: { ...OK, text: "confirm" } });
    });
    it("scans and clicks nothing while manual control is detected, and answers the same dialog once the pause lapses", async () => {
      const rig = await travelled(750_000);
      // The operator takes the mouse just as the leader reappears: the movement click is refused natively.
      rig.refusals.push("Manual mouse movement");
      rig.scene.leader = FAR;
      await expect.poll(() => stats(rig).manualTakeovers, soon).toBe(1);
      expect(rig.service.status().reason).toBe("Manual control detected — following resumes shortly.");
      const scans = confirmScans(rig).length;
      rig.scene.confirm = DIALOG;
      rig.clock! += 500;
      await cycles(rig, 4);
      expect(confirmScans(rig)).toHaveLength(scans);
      expect(clicksIn(rig, "confirm")).toEqual([]);
      rig.clock! += 1500;
      await expect.poll(() => stats(rig).confirms, soon).toBe(1);
      expect(clicksIn(rig, "confirm")).toHaveLength(1);
    });
    it("previews the OK in a dry run: the input worker receives nothing at all", async () => {
      const rig = await travelRig(760_000);
      rig.service.configure({ version: 1, dryRun: true, mapScale: 7, clickIntervalMs: 100 });
      await rig.service.start();
      await expect.poll(() => stats(rig).previewed, soon).toBe(1);
      await leaderLeaves(rig);
      rig.clock! += 3000;
      await expect.poll(() => stats(rig).teleports, soon).toBe(1);
      rig.scene.confirm = DIALOG;
      rig.clock! += 250;
      await expect.poll(() => stats(rig).confirms, soon).toBe(1);
      expect(rig.attempts).toEqual([]);
      expect(ops(rig.input)).toEqual(["ping"]);
      expect(stats(rig)).toMatchObject({ clicks: 0, previewed: 3, teleports: 1, confirms: 1 });
      expect(rig.traces.at(-1)).toMatchObject({ decisionRule: "confirm-teleport", result: "blocked", input: { text: "confirm" }, reason: expect.stringContaining("safety=dry-run") });
      await expect.poll(() => [...rig.reasons], soon).toContain("Preview only: would confirm the teleport to Main.");
    });
  });
});

describe("follow drive click freshness under injected worker latency (synthetic hosts, no OS input)", () => {
  /**
   * Worker round trips fitted to the 420 s live run this work started from: it measured cycle 28.5 / 52 ms
   * and capture→click 58 / 117 ms against the 120 ms limit, and 237 of its 1,696 movement clicks came back
   * refused as stale. Nothing here is about pixels — the refusals are an ordering problem inside one tick,
   * and an ordering problem can be reproduced, and fixed, without the game.
   */
  const LIVE: Latency = { key: [24, 32], runs: [9, 20], input: [23, 49], sprint: [5, 12], map: [12, 40] };
  /**
   * A leader circling at a steady 108 map px. Far enough to sprint the whole way, and — the point — actually
   * moving, so the leader's offset changes every capture and reactive wall-following never decides we are
   * stuck against something and stops clicking mid-measurement.
   */
  function orbit(rig: Rig): void {
    let angle = 0;
    rig.scene.onKey = () => { angle += .02; rig.scene.leader = { dx: Math.round(108 * Math.cos(angle)), dy: Math.round(108 * Math.sin(angle)) }; };
  }
  interface Measured { attempts: number; refused: number; share: number; clicks: number; lootScans: number; sprints: number; cycleMsP50?: number; cycleMsP95?: number; captureToInputMsP50?: number; captureToInputMsP95?: number }
  async function measure(options: { loot?: boolean; sprint?: boolean; attempts?: number } = {}): Promise<Measured> {
    const rig = await calibrated({ clock: 600_000, latency: LIVE });
    orbit(rig);
    if (options.loot) rig.follow = { ...rig.follow, lootEnabled: true, lootLeash: 30 };
    goLive(rig, { sprint: options.sprint === true, clickIntervalMs: 110 });
    await rig.service.start();
    const target = options.attempts ?? 200;
    // Every decision the service makes runs off the injected clock, so the run is a pure function of the
    // costs above: real time only decides how long the test waits, never what the loop does.
    await expect.poll(() => stats(rig).clicks + stats(rig).refused, { timeout: 60_000, interval: 5 }).toBeGreaterThanOrEqual(target);
    rig.service.stop();
    const final = stats(rig), percentiles = rig.service.status().stats!;
    const attempts = final.clicks + final.refused;
    return {
      attempts, refused: final.refused, clicks: final.clicks, lootScans: final.lootScans, sprints: final.sprints,
      share: Math.round(final.refused / attempts * 1000) / 10,
      cycleMsP50: percentiles.cycleMsP50, cycleMsP95: percentiles.cycleMsP95,
      captureToInputMsP50: percentiles.captureToInputMsP50, captureToInputMsP95: percentiles.captureToInputMsP95,
    };
  }
  it("MEASURE: refusals with loot scanning and sprint on", async () => {
    const m = await measure({ loot: true, sprint: true });
    console.log("loot+sprint", JSON.stringify(m));
  }, 70_000);
  it("MEASURE: refusals with sprint only", async () => {
    const m = await measure({ sprint: true });
    console.log("sprint only", JSON.stringify(m));
  }, 70_000);
  it("MEASURE: refusals with loot only", async () => {
    const m = await measure({ loot: true });
    console.log("loot only", JSON.stringify(m));
  }, 70_000);
  it("MEASURE: refusals with neither", async () => {
    const m = await measure({});
    console.log("neither", JSON.stringify(m));
  }, 70_000);
});

describe("follow drive settings", () => {
  const valid = { version: 1, dryRun: false, mapScale: 9.5, clickIntervalMs: 140 } as const;
  it("defaults to dry-run and accepts only complete settings inside the limits", () => {
    expect(defaultDriveSettings()).toEqual({ version: 1, dryRun: true, mapScale: 7, clickIntervalMs: 110 });
    expect(parseDriveSettings(defaultDriveSettings())).toEqual(defaultDriveSettings());
    expect(parseDriveSettings({ ...valid, extra: "dropped" })).toEqual(valid);
    expect(parseDriveSettings({ ...valid, mapScale: 2, clickIntervalMs: 100 })).toMatchObject({ mapScale: 2, clickIntervalMs: 100 });
    expect(parseDriveSettings({ ...valid, mapScale: 20, clickIntervalMs: 1000 })).toMatchObject({ mapScale: 20, clickIntervalMs: 1000 });
    const invalid: unknown[] = [
      null, undefined, "settings", 7, {}, { ...valid, version: 2 }, { ...valid, dryRun: "false" }, { ...valid, dryRun: undefined }, { ...valid, dryRun: 0 },
      { ...valid, mapScale: 1.99 }, { ...valid, mapScale: 20.01 }, { ...valid, mapScale: Number.NaN }, { ...valid, mapScale: Number.POSITIVE_INFINITY }, { ...valid, mapScale: "7" }, { ...valid, mapScale: undefined },
      { ...valid, clickIntervalMs: 99 }, { ...valid, clickIntervalMs: 1001 }, { ...valid, clickIntervalMs: 110.5 }, { ...valid, clickIntervalMs: "110" }, { ...valid, clickIntervalMs: undefined },
    ];
    for (const raw of invalid) expect(() => parseDriveSettings(raw), JSON.stringify(raw)).toThrow("Invalid follow settings");
  });
  it("persists settings to drive.json, restores them after a restart, and keeps the old ones when new ones are invalid", () => {
    const rig = setup();
    expect(rig.service.configure(valid)).toMatchObject({ settings: valid, dryRun: false, running: false });
    expect(JSON.parse(readFileSync(path.join(rig.directory, "drive.json"), "utf8"))).toEqual(valid);
    expect(readdirSync(rig.directory)).toEqual(["drive.json"]);
    expect(() => rig.service.configure({ ...valid, mapScale: 50 })).toThrow("Invalid follow settings");
    expect(rig.service.status().settings).toEqual(valid);
    expect(JSON.parse(readFileSync(path.join(rig.directory, "drive.json"), "utf8"))).toEqual(valid);
    expect(setup({ directory: rig.directory }).service.status()).toMatchObject({ settings: valid, dryRun: false });
  });
  it("falls back to dry-run defaults when the saved settings are unusable", () => {
    for (const content of ["{not json", JSON.stringify({ ...valid, clickIntervalMs: 5 }), JSON.stringify({ ...valid, dryRun: "no" })]) {
      const directory = temporary();
      writeFileSync(path.join(directory, "drive.json"), content);
      expect(setup({ directory }).service.status()).toMatchObject({ dryRun: true, settings: defaultDriveSettings(), reason: "Saved follow settings were invalid and have been reset." });
    }
  });
  it("stops a running loop when settings change, and leaves it running when they are rejected", async () => {
    const rig = await calibrated();
    await rig.service.start();
    await cycles(rig, 2);
    expect(() => rig.service.configure({ ...valid, clickIntervalMs: 10 })).toThrow("Invalid follow settings");
    expect(rig.service.status().running).toBe(true);
    expect(rig.service.configure(valid)).toMatchObject({ running: false, reason: "Follow settings changed — press Start to resume.", settings: valid });
    await expect.poll(() => ops(rig.input), soon).toEqual(["ping", "release", "closed"]);
  });
  it("appends action traces to a dated JSONL audit file and writes nothing for an empty batch", async () => {
    const directory = temporary(), audit = driveAudit(path.join(directory, "audit"));
    audit([]);
    expect(existsSync(path.join(directory, "audit"))).toBe(false);
    const rig = await calibrated();
    await rig.service.start();
    await expect.poll(() => rig.traces.length, soon).toBeGreaterThanOrEqual(2);
    rig.service.stop();
    audit(rig.traces.slice(0, 1)); audit(rig.traces.slice(1, 2));
    const files = readdirSync(path.join(directory, "audit"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^follow-actions-\d{4}-\d{2}-\d{2}\.jsonl$/);
    const lines = readFileSync(path.join(directory, "audit", files[0]), "utf8").trim().split("\n").map(line => JSON.parse(line) as QaActionTrace);
    expect(lines).toEqual(rig.traces.slice(0, 2));
  });
});

/**
 * Ctrl+Shift+M: the human takes this PC for as long as they want, then gives it back.
 *
 * The two mechanisms either side of this one are tested elsewhere: the reactive cursor guard resumes
 * 1.5 s after the mouse rests, and the kill switch ends the run. What is asserted here is what neither
 * of those does — input stops indefinitely while the loop KEEPS OBSERVING, so handing control back
 * resumes from a live marker instead of re-acquiring from cold.
 */
describe("deliberate manual control", () => {
  it("sends nothing while the human holds the PC, keeps watching throughout, and follows again when they hand it back", async () => {
    const rig = await calibrated();
    goLive(rig, { sprint: true });
    await rig.service.start();
    await cycles(rig, 4);
    const before = stats(rig).clicks;
    expect(before).toBeGreaterThan(0);

    rig.service.setManualControl(true);
    expect(rig.service.manualControlHeld).toBe(true);
    const heldAt = stats(rig).clicks, cyclesAt = stats(rig).cycles, sprintsAt = sprintOps(rig).filter(e => e.start === true).length;
    await cycles(rig, 10);
    // Not one click, and not one renewal of the held sprint key, for as long as the hold lasts.
    expect(stats(rig).clicks).toBe(heldAt);
    expect(sprintOps(rig).filter(e => e.start === true).length).toBe(sprintsAt);
    // Still perceiving: this is a pause, not a stop, which is the whole point of it.
    expect(stats(rig).cycles).toBeGreaterThan(cyclesAt);
    expect(rig.service.status().reason).toBe(MANUAL_HOLD_REASON);
    expect(rig.service.isRunning).toBe(true);

    rig.service.setManualControl(false);
    expect(rig.service.manualControlHeld).toBe(false);
    await expect.poll(() => stats(rig).clicks, soon).toBeGreaterThan(heldAt);
  });

  it("never opens a run already held, so a press left over from a previous run cannot silence the next one", async () => {
    const rig = await calibrated();
    goLive(rig);
    rig.service.setManualControl(true);
    await rig.service.start();
    expect(rig.service.manualControlHeld).toBe(false);
    await expect.poll(() => stats(rig).clicks, soon).toBeGreaterThan(0);
  });
});

/**
 * Instrumentation for telling "blocked" from "behind".
 *
 * Distance to the leader cannot do it: measured across three live runs, stalls where the distance never
 * improved while clicking at 4-6 clicks/s reached 25.4 s in a run jammed on a door and 32.4 s in a run
 * that was following perfectly well, so no threshold separates them. Whether the follower is moving at
 * all should, and nothing recorded it. Nothing decides on these numbers yet — they exist to be measured.
 */
describe("own-movement instrumentation", () => {
  it("reports zero while the outlines hold still, and a real speed once they slide", async () => {
    const rig = await calibrated();
    goLive(rig);
    rig.scene.blue = outlines();
    rig.scene.leader = FAR;
    await rig.service.start();
    // Standing still: the map outlines do not slide, so own displacement is exactly zero — and it is
    // reported as 0, not as "unknown", which is the distinction the whole measurement rests on.
    await expect.poll(() => rig.service.status().odometry?.movedPxPerSec, soon).toBe(0);
    // Not 1: the first sample in the window has no previous frame to match against, so it is untracked.
    // That is the point of reporting the share — a window that barely tracked cannot be read as "not moving".
    expect(rig.service.status().odometry?.movedTracked).toBeGreaterThan(0.9);

    // Sliding the outlines is the follower moving: the window has to show it.
    rig.scene.onKey = () => { rig.scene.blue = rig.scene.blue!.map(p => ({ x: p.x - 2, y: p.y })); };
    await expect.poll(() => rig.service.status().odometry?.movedPxPerSec ?? 0, soon).toBeGreaterThan(0);
  });
});
