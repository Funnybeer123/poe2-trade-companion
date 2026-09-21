import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FlaskPlanner, flaskReferenceIssue, lifeGlobeColumn, parseFlaskSettings, readLife, type FlaskCalibration } from "../src/core/followerFlask.js";
import { KillSwitch } from "../src/core/killSwitch.js";
import { FollowerFlaskService } from "../src/main/followerFlaskService.js";

// SYNTHETIC. A life globe is a 5 x 100 colour column: red liquid below a surface, dark glass above it. The host
// is a plain object; "presses" are entries in an array. Nothing is captured and no OS input is possible here.
const RED = [150, 18, 20], GLASS = [24, 20, 20];
const globe = (percent: number): number[] => { const out: number[] = []; for (let y = 0; y < 100; y++) for (let x = 0; x < 5; x++) out.push(...(y >= 100 - percent ? RED : GLASS)); return out; };
const VIEW = { width: 2560, height: 1440 };
const calibration = (): FlaskCalibration => ({ version: 1, view: VIEW, region: lifeGlobeColumn(VIEW), reference: globe(100), calibratedAt: "2026-09-21T00:00:00.000Z" });

describe("life globe reading", () => {
  it("puts the column on the liquid measured at 2560 x 1440 and scales it with view height", () => {
    expect(lifeGlobeColumn(VIEW)).toEqual({ x: 175, y: 1190, width: 20, height: 210 });
    expect(lifeGlobeColumn({ width: 1920, height: 1080 })).toEqual({ x: 131, y: 893, width: 15, height: 157 });
  });
  it("reads the surface against a full reference", () => {
    for (const p of [100, 80, 53, 30, 10]) expect(readLife(globe(p), calibration())).toBe(p);
  });
  // Live: a black loading/teleport screen read as 0 % three times in a minute and spent three flask charges.
  it("does not believe an empty column: no liquid at all is a covered globe, not zero life", () => {
    expect(readLife(globe(0), calibration())).toBeUndefined();
    expect(readLife(new Array(1500).fill(0), calibration())).toBeUndefined();
    expect(readLife(globe(5), calibration())).toBe(5);
  });
  it("accepts only a full red globe as the reference: one taken at half life would read half life as full and never drink", () => {
    expect(flaskReferenceIssue(globe(100))).toBeUndefined();
    expect(flaskReferenceIssue(globe(53))).toMatch(/does not look full/);
    expect(flaskReferenceIssue(globe(90))).toMatch(/top of the life globe is not red/);
    expect(flaskReferenceIssue([1, 2, 3])).toMatch(/wrong size/);
  });
  it("allows only the combat worker's bindings and a sane threshold", () => {
    expect(parseFlaskSettings({ key: "1" })).toEqual({ key: "1", below: 55, retryMs: 1500 });
    expect(() => parseFlaskSettings({ key: "SPACE" })).toThrow(/letter, digit or Mouse Button|allowed bindings/);   // the combat binding guard speaks first
    expect(() => parseFlaskSettings({ key: "1", below: 99 })).toThrow(/between 10 and 90/);
  });
});

describe("when to drink", () => {
  const planner = () => new FlaskPlanner({ key: "1", below: 55, retryMs: 1500 });
  it("needs two low readings in a row, so one odd frame never spends a charge", () => {
    const p = planner();
    expect(p.decide(40, 0)).toBeUndefined();
    expect(p.decide(80, 150)).toBeUndefined();
    expect(p.decide(40, 300)).toBeUndefined();
    expect(p.decide(40, 450)).toMatchObject({ module: "combat", rule: "follower-life-flask", intended: [{ kind: "key", key: "1" }] });
  });
  it("never treats an unreadable globe as low life", () => {
    const p = planner();
    expect(p.decide(40, 0)).toBeUndefined();
    expect(p.decide(undefined, 150)).toBeUndefined();
    expect(p.decide(40, 300)).toBeUndefined();   // the streak started over
  });
  it("presses at most once per retry, and a refused press does not count", () => {
    const p = planner();
    p.decide(40, 0);
    expect(p.decide(40, 150)).toBeDefined();      // refused: not committed, so it may try again at once
    expect(p.decide(40, 300)).toBeDefined();
    p.committed(300);
    expect(p.decide(30, 450)).toBeUndefined();
    expect(p.decide(30, 1799)).toBeUndefined();
    expect(p.decide(30, 1800)).toBeDefined();
  });
});

describe("life flask service (synthetic host, no OS input)", () => {
  const dirs: string[] = [], services: FollowerFlaskService[] = [];
  afterEach(() => { for (const s of services.splice(0)) s.stop(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  function rig(options: { dryRun?: boolean; blocked?: () => string | undefined; killSwitch?: KillSwitch } = {}) {
    const directory = mkdtempSync(path.join(tmpdir(), "poe-flask-")); dirs.push(directory);
    const state = { life: 100, taps: [] as Array<Record<string, unknown>>, tapError: undefined as string | undefined, ops: [] as string[], hwnd: "4242" };
    const host = { send: async (payload: Record<string, unknown>) => {
      state.ops.push(String(payload.op));
      if (payload.op === "tap") { if (state.tapError) return { ok: false, error: state.tapError }; state.taps.push(payload); return { ok: true }; }
      const regions = payload.regions as Record<string, unknown>;
      return { ok: true, hwnd: state.hwnd, process: "PathOfExileSteam", width: VIEW.width, height: VIEW.height, samples: regions.health ? { health: Buffer.from(globe(state.life)).toString("base64") } : {} };
    }, close: async () => { state.ops.push("closed"); } };
    const service = new FollowerFlaskService({ directory, killSwitch: options.killSwitch ?? new KillSwitch(), mode: "authorized-qa", settings: { key: "1", below: 55, retryMs: 1500 }, dryRun: options.dryRun ?? false, blocked: options.blocked, createHost: () => host, pollMs: 2 });
    services.push(service);
    return { service, state };
  }
  const soon = { timeout: 3000, interval: 4 };

  it("refuses to start uncalibrated, and refuses to calibrate on anything but a full globe", async () => {
    const { service, state } = rig();
    expect(() => service.start()).toThrow(/not calibrated/);
    state.life = 60;
    await expect(service.calibrate()).rejects.toThrow(/does not look full/);
    state.life = 100;
    expect((await service.calibrate()).region).toEqual(lifeGlobeColumn(VIEW));
    expect(state.taps).toEqual([]);   // calibration only ever captures
  });
  it("drinks once life is low, bound to the window the low reading came from, and not again until the retry", async () => {
    const { service, state } = rig();
    await service.calibrate(); service.start();
    await expect.poll(() => service.status.readings, soon).toBeGreaterThan(3);
    expect(state.taps).toEqual([]);
    state.life = 40;
    await expect.poll(() => state.taps.length, soon).toBe(1);
    expect(state.taps[0]).toEqual({ op: "tap", key: "1", expectedHwnd: "4242" });
    await new Promise(r => setTimeout(r, 60));
    expect(state.taps).toHaveLength(1);
    expect(service.status).toMatchObject({ presses: 1, life: 40 });
    // The only things this service ever asks its worker for.
    expect(new Set(state.ops)).toEqual(new Set(["sample", "tap", "closed"]));
  });
  it("previews in a dry run: the worker is never asked to tap", async () => {
    const { service, state } = rig({ dryRun: true });
    await service.calibrate(); service.start(); state.life = 30;
    await expect.poll(() => service.status.previewed, soon).toBe(1);
    expect(state.taps).toEqual([]);
  });
  it("sends nothing while the human holds the PC or the kill switch is latched, and says why", async () => {
    let held = true; const killSwitch = new KillSwitch();
    const { service, state } = rig({ blocked: () => held ? "you have manual control" : undefined, killSwitch });
    await service.calibrate(); service.start(); state.life = 30;
    await expect.poll(() => service.status.reason, soon).toMatch(/not drinking: you have manual control/);
    expect(state.taps).toEqual([]);
    held = false; killSwitch.trip();
    await new Promise(r => setTimeout(r, 60));
    expect(state.taps).toEqual([]);
  });
  it("counts a refused press as refused and tries again, because a refusal is not an action", async () => {
    const { service, state } = rig();
    await service.calibrate(); service.start();
    state.tapError = "Modifier or action binding held"; state.life = 30;
    await expect.poll(() => service.status.refused, soon).toBeGreaterThanOrEqual(2);
    expect(service.status.presses).toBe(0);
    state.tapError = undefined;
    await expect.poll(() => service.status.presses, soon).toBe(1);
  });
});
