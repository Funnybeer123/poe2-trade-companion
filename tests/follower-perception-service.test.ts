import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FollowerPerceptionService } from "../src/main/followerPerceptionService.js";

// SYNTHETIC host: a scripted scene replaces the desktop. No capture, no OS input.
const W = 640, H = 360;
interface Scene { name?: { x: number; y: number }; error?: string; view?: { width: number; height: number } }
function pixels(scene: Scene, r: { x: number; y: number; width: number; height: number }): string {
  const out = new Uint8Array(r.width * r.height).fill(20);
  if (scene.name) for (let y = 0; y < 10; y++) for (let x = 0; x < 60; x++) {
    // A striped bar with a notch stands in for name text.
    if ((x % 6 < 3 || y < 2) && !(x > 40 && y > 6)) { const px = scene.name.x + x - r.x, py = scene.name.y + y - r.y; if (px >= 0 && py >= 0 && px < r.width && py < r.height) out[py * r.width + px] = 240; }
  }
  return Buffer.from(out).toString("base64");
}
function fakeHost(scene: Scene, log: Array<Record<string, unknown>>) {
  return () => ({
    send: async (payload: Record<string, unknown>) => {
      log.push(payload);
      if (payload.op === "ping") return { ok: true };
      if (scene.error) return { ok: false, error: scene.error };
      const view = scene.view ?? { width: W, height: H };
      const region = payload.op === "preview" ? { x: 0, y: 0, ...view } : { x: Number(payload.x), y: Number(payload.y), width: Number(payload.width), height: Number(payload.height) };
      return { ok: true, hwnd: "1", ...view, captureMs: 4, pixels: pixels(scene, region), ...(payload.op === "preview" ? { image: "data:image/png;base64,AAAA" } : {}) };
    },
    close: async () => { log.push({ op: "closed" }); },
  });
}
const services: FollowerPerceptionService[] = [], directories: string[] = [];
function setup(scene: Scene, extra: { target?: () => string; blocked?: () => string | undefined; directory?: string } = {}) {
  const directory = extra.directory ?? mkdtempSync(path.join(tmpdir(), "poe-follower-perception-")); directories.push(directory);
  const log: Array<Record<string, unknown>> = [];
  const service = new FollowerPerceptionService({ directory, targetName: extra.target ?? (() => "Main"), blocked: extra.blocked, createHost: fakeHost(scene, log), pollMs: 5 });
  services.push(service);
  return { service, log, directory };
}
const NAMEPLATE = { x: 95, y: 76, width: 72, height: 18 };
afterEach(() => { services.splice(0).forEach(s => s.stop()); directories.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });

describe("follower perception service (synthetic capture host)", () => {
  it("calibrates from the main process's captured pixels, persists, and restores across restarts", async () => {
    const scene: Scene = { name: { x: 100, y: 80 } }, { service, directory, log } = setup(scene);
    expect(() => service.calibrate({ nameplate: NAMEPLATE })).toThrow("Capture the game view");
    await expect(service.capture()).resolves.toMatchObject({ width: W, height: H, image: expect.stringContaining("data:image/png") });
    expect(log.some(entry => entry.op === "closed")).toBe(true);
    const status = service.calibrate({ nameplate: NAMEPLATE });
    expect(status).toMatchObject({ observing: false, inputCapability: "none", calibration: { targetName: "Main", view: { width: W, height: H }, nameplate: { x: 99, y: 79, width: 62, height: 12 } } });
    expect(JSON.stringify(status)).not.toContain("mask");
    const restored = setup(scene, { directory }).service.status();
    expect(restored.calibration?.nameplate).toEqual(status.calibration?.nameplate);
    expect(restored.calibrationIssue).toBeUndefined();
  });
  it("observes identity, evidence, confidence, age and timing, then follows movement with a tracking window", async () => {
    const scene: Scene = { name: { x: 100, y: 80 } }, { service, log } = setup(scene);
    await service.capture(); service.calibrate({ nameplate: NAMEPLATE });
    await service.start();
    await expect.poll(() => service.status().observation?.found).toBe(true);
    const seen = service.status();
    expect(seen.observation).toMatchObject({ identity: { name: "Main", method: "nameplate-template" }, position: { x: 130, y: 85 }, confidence: 1, evidence: { score: 1, runnerUp: 0, candidates: 1 }, timing: { captureMs: 4 } });
    expect(seen.observation!.ageMs).toBeGreaterThanOrEqual(0);
    expect(seen.stats!.observationsPerSecond).toBeGreaterThan(0);
    scene.name = { x: 180, y: 140 };
    await expect.poll(() => service.status().observation?.position).toEqual({ x: 210, y: 145 });
    expect(log.some(entry => entry.op === "sample" && Number(entry.width) < W)).toBe(true);
    scene.name = undefined;
    await expect.poll(() => service.status().observation?.found).toBe(false);
    expect(service.status().observation).toMatchObject({ confidence: 0, position: undefined });
    expect(service.stop().observation).toBeUndefined();
    expect(log.every(entry => ["ping", "preview", "sample", "closed"].includes(String(entry.op)))).toBe(true);
  });
  it("shows no observation while the game is unfocused and resumes afterwards", async () => {
    const scene: Scene = { name: { x: 100, y: 80 } }, { service } = setup(scene);
    await service.capture(); service.calibrate({ nameplate: NAMEPLATE }); await service.start();
    await expect.poll(() => service.status().observation?.found).toBe(true);
    scene.error = "Focus Path of Exile 2 to continue";
    await expect.poll(() => service.status().reason).toContain("Focus Path of Exile 2");
    expect(service.status()).toMatchObject({ observing: true, observation: undefined });
    scene.error = undefined;
    await expect.poll(() => service.status().observation?.found, { timeout: 3000 }).toBe(true);
  });
  it("invalidates calibration when the game view or the selected character changes", async () => {
    const scene: Scene = { name: { x: 100, y: 80 } };
    let target = "Main";
    const { service } = setup(scene, { target: () => target });
    await service.capture(); service.calibrate({ nameplate: NAMEPLATE }); await service.start();
    await expect.poll(() => service.status().observation?.found).toBe(true);
    scene.view = { width: 1280, height: 720 };
    await expect.poll(() => service.status().observing).toBe(false);
    expect(service.status().reason).toContain("Game view changed from 640 × 360 to 1280 × 720");
    scene.view = undefined; target = "Other";
    expect(service.status().calibrationIssue).toContain("calibrate again for Other");
    await expect(service.start()).rejects.toThrow("calibrate again for Other");
    target = "";
    await service.capture();
    expect(() => service.calibrate({ nameplate: NAMEPLATE })).toThrow("Enter and save the character");
  });
  it("honours the emergency latch for capture and observation, and stops a running preview", async () => {
    let blocked: string | undefined;
    const scene: Scene = { name: { x: 100, y: 80 } }, { service } = setup(scene, { blocked: () => blocked });
    await service.capture(); service.calibrate({ nameplate: NAMEPLATE }); await service.start();
    await expect.poll(() => service.status().observation?.found).toBe(true);
    blocked = "Emergency stop is latched.";
    await expect.poll(() => service.status().observing).toBe(false);
    await expect(service.start()).rejects.toThrow("Emergency stop");
    await expect(service.capture()).rejects.toThrow("Emergency stop");
  });
  it("reports unusable saved calibration and clears it on request", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "poe-follower-perception-"));
    writeFileSync(path.join(directory, "calibration.json"), "{\"version\":1}");
    const { service } = setup({}, { directory });
    expect(service.status().calibrationIssue).toContain("invalid");
    await expect(service.start()).rejects.toThrow("invalid");
    expect(service.clearCalibration()).toMatchObject({ calibration: undefined, calibrationIssue: undefined });
    expect(existsSync(path.join(directory, "calibration.json"))).toBe(false);
  });
  it("rejects incomplete frames and host failures without leaving the preview running", async () => {
    const log: Array<Record<string, unknown>> = [], directory = mkdtempSync(path.join(tmpdir(), "poe-follower-perception-")); directories.push(directory);
    const good = setup({ name: { x: 100, y: 80 } }, { directory }).service;
    await good.capture(); good.calibrate({ nameplate: NAMEPLATE });
    expect(readFileSync(path.join(directory, "calibration.json"), "utf8")).toContain("\"targetName\":\"Main\"");
    const service = new FollowerPerceptionService({ directory, targetName: () => "Main", pollMs: 5, createHost: () => ({ send: async p => { log.push(p); return p.op === "ping" ? { ok: true } : { ok: true, width: W, height: H, pixels: "AAAA" }; }, close: async () => {} }) });
    services.push(service);
    await service.start();
    await expect.poll(() => service.status().observing).toBe(false);
    expect(service.status().reason).toContain("incomplete frame");
  });
});
