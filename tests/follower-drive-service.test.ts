import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { parseMapCalibration } from "../src/core/followerMapMarker.js";
import { KillSwitch } from "../src/core/killSwitch.js";
import type { QaActionTrace } from "../src/core/types.js";
import { defaultDriveSettings, driveAudit, FollowerDriveService, parseDriveSettings } from "../src/main/followerDriveService.js";

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
  follow: { targetName: string; followDistance: number; confidence: number };
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
  created: { capture: number; input: number };
  newestCaptureQpc: number;
  traces: QaActionTrace[];
  /** The status reason each cycle left behind, sampled when the next capture begins. */
  reasons: Set<string>;
}
const rigs: Rig[] = [], directories: string[] = [];
const temporary = () => { const d = mkdtempSync(path.join(tmpdir(), "poe-follower-drive-")); directories.push(d); return d; };
function setup(options: { directory?: string; clock?: number; scene?: Partial<Scene>; killSwitch?: KillSwitch } = {}): Rig {
  const rig: Rig = {
    service: undefined as unknown as FollowerDriveService, directory: options.directory ?? temporary(), killSwitch: options.killSwitch ?? new KillSwitch(),
    scene: { leader: FAR, own: { dx: 0, dy: 0 }, process: GAME, hwnd: HWND, view: { width: W, height: H }, ...options.scene },
    follow: { targetName: "Main", followDistance: 2, confidence: .85 }, globalDryRun: false, clock: options.clock,
    capture: [], input: [], attempts: [], refusals: [], latencies: [37], capturePing: { ok: true }, inputPing: { ok: true }, releaseFails: false,
    created: { capture: 0, input: 0 }, newestCaptureQpc: 5_000_000, traces: [], reasons: new Set(),
  };
  const now = () => rig.clock ?? performance.now();
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
          if (payload.op !== "key") return { ok: false, error: "Unknown follower capture operation" };
          rig.reasons.add(rig.service.status().reason);
          scene.onKey?.();
          const second = payload.second as { x: number; y: number; width: number; height: number; channel: string; threshold: number };
          const area = payload.full === true ? { x: 0, y: 0, ...scene.view } : { x: Number(payload.x), y: Number(payload.y), width: Number(payload.width), height: Number(payload.height) };
          rig.newestCaptureQpc += 9;
          return {
            ...shared, capturedAtQpcMs: rig.newestCaptureQpc,
            overflow: !!scene.overflow, points: scene.corruptPoints ? scene.corruptPoints.value : scene.overflow ? "" : keyPoints(scene, area, payload.channel, Number(payload.threshold)),
            secondOverflow: false, secondPoints: keyPoints(scene, second, second.channel, second.threshold),
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
          if (payload.op === "release") { if (rig.releaseFails) throw new Error("win-input-host-closed"); return { ok: true }; }
          if (payload.op !== "moveclick") return { ok: false, error: "Unknown follower input operation" };
          rig.attempts.push({ payload, clock: now(), newestCaptureQpc: rig.newestCaptureQpc });
          const refusal = rig.refusals.shift();
          if (refusal instanceof Error) throw refusal;
          if (refusal) return { ok: false, error: refusal };
          return { ok: true, inputMs: 21, captureToInputMs: rig.latencies.length > 1 ? rig.latencies.shift() : rig.latencies[0] };
        },
        close: async () => { rig.input.push({ op: "closed" }); },
      };
    },
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
const goLive = (rig: Rig, settings: { mapScale?: number; clickIntervalMs?: number } = {}) => rig.service.configure({ version: 1, dryRun: false, mapScale: 7, clickIntervalMs: 100, ...settings });
const soon = { timeout: 5000, interval: 4 };
const ops = (log: Payload[]) => log.map(entry => String(entry.op));
const stats = (rig: Rig) => rig.service.status().stats ?? { cycles: 0, clicks: 0, previewed: 0, refused: 0, manualTakeovers: 0 };
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
      expect(attempt.payload).toEqual({ op: "moveclick", ...target, expectedHwnd: HWND, viewWidth: W, viewHeight: H, capturedAtQpcMs: attempt.newestCaptureQpc, maxAgeMs: 120 });
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
    rig.scene.own = { dx: 14, dy: 0 };
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
    rig.scene.own = { dx: 14, dy: 0 };
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
    await expect.poll(() => died.service.status().running, soon).toBe(false);
    expect(died.service.status().reason).toBe("win-input-host-exited:1");
    expect(died.attempts).toEqual([]);
    for (const rig of [blocked, retargeted, died]) await expect.poll(() => ops(rig.input).slice(-2), soon).toEqual(["release", "closed"]);
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
