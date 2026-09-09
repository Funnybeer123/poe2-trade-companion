import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CombatAssistService } from "../src/main/combatAssistService.js";
import { KillSwitch } from "../src/core/killSwitch.js";
import { CombatInputSink } from "../src/adapters/combatInputSink.js";
import type { WinReply } from "../src/adapters/winHost.js";
import { calibratedCombat, combatFrame, fill } from "./combatFixtures.js";

describe("combat service lifecycle and input interlocks", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  function harness(dryRun = false) {
    const config = calibratedCombat(); config.dryRun = dryRun;
    const frame = combatFrame(config);
    frame.samples.health = fill(config.regions.health!.reference, 24);
    const host = { send: vi.fn(async (p: Record<string, unknown>): Promise<WinReply> => p.op === "sample" ? { ok: true, ...frame } : { ok: true }), close: vi.fn(async () => {}) };
    const killSwitch = new KillSwitch(), audit = vi.fn();
    const createHost = vi.fn(() => host);
    const service = new CombatAssistService({ config, killSwitch, mode: "public-companion", audit, createHost, now: () => Date.now() });
    return { config, frame, host, killSwitch, audit, service, createHost };
  }
  it.each([
    "Focus Path of Exile 2 to continue",
    'Exception calling "Foreground" with "0" argument(s): "Focus Path of Exile 2 to continue"',
  ])("waits for game focus on the same preview worker, then captures without input: %s", async (error) => {
    const h = harness();
    h.host.send.mockResolvedValue({ ok: false, error });
    const preview = h.service.preview();
    await vi.advanceTimersByTimeAsync(750);
    expect(h.service.status).toMatchObject({ running: false, reason: "Waiting for game focus — switch to Path of Exile 2" });
    expect(h.host.send.mock.calls.length).toBeGreaterThan(1);
    h.host.send.mockResolvedValue({ ok: true, image: "data:image/png;base64,capture", width: 2560, height: 1440 });
    await vi.advanceTimersByTimeAsync(250);
    await expect(preview).resolves.toEqual({ image: "data:image/png;base64,capture", width: 2560, height: 1440 });
    expect(h.createHost).toHaveBeenCalledOnce();
    expect(h.host.close).toHaveBeenCalledOnce();
    expect(h.host.send.mock.calls.every(([p]) => p.op === "preview")).toBe(true);
    expect(h.service.status.reason).toBe("Paused for HUD calibration");
  });
  it.each([
    { ok: false, error: "Game window unavailable" },
    { ok: false, error: "Focus Path of Exile 2 to continue: unexpected failure" },
    { ok: false, error: 'Exception calling "Preview" with "0" argument(s): "Focus Path of Exile 2 to continue"' },
    { ok: true },
  ])("does not retry other preview failures: %j", async (reply) => {
    const h = harness();
    h.host.send.mockResolvedValue(reply);
    await expect(h.service.preview()).rejects.toThrow(reply.error ?? "Capture failed");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.host.send).toHaveBeenCalledOnce();
    expect(h.host.close).toHaveBeenCalledOnce();
  });
  it("ends the focus wait after 15 seconds and closes the preview worker", async () => {
    const h = harness();
    h.host.send.mockResolvedValue({ ok: false, error: "Focus Path of Exile 2 to continue" });
    const failure = expect(h.service.preview()).rejects.toThrow("Capture timed out waiting for game focus");
    await vi.advanceTimersByTimeAsync(14_999);
    expect(h.host.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await failure;
    expect(h.service.status.reason).toBe("Capture timed out waiting for game focus");
    expect(h.host.close).toHaveBeenCalledOnce();
    const calls = h.host.send.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.host.send).toHaveBeenCalledTimes(calls);
  });
  it("cancels a focus wait immediately on stop, closes the worker and never retries", async () => {
    const h = harness();
    h.host.send.mockResolvedValue({ ok: false, error: "Focus Path of Exile 2 to continue" });
    const failure = expect(h.service.preview()).rejects.toThrow("Calibration cancelled");
    await vi.advanceTimersByTimeAsync(0);
    h.service.stop();
    expect(h.host.close).toHaveBeenCalledOnce();
    await failure;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.host.send).toHaveBeenCalledOnce();
    expect(h.host.close).toHaveBeenCalledOnce();
    expect(h.service.status.reason).toBe("Stopped");
  });
  it("keeps the 15-second deadline when a retry is still waiting for its native reply", async () => {
    const h = harness();
    let resolve!: (reply: WinReply) => void;
    h.host.send.mockResolvedValueOnce({ ok: false, error: "Focus Path of Exile 2 to continue" })
      .mockImplementation(() => new Promise((r) => { resolve = r; }));
    const failure = expect(h.service.preview()).rejects.toThrow("Capture timed out waiting for game focus");
    await vi.advanceTimersByTimeAsync(15_000);
    await failure;
    expect(h.host.close).toHaveBeenCalledOnce();
    resolve({ ok: true, image: "late-capture", width: 2560, height: 1440 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.host.send).toHaveBeenCalledTimes(2);
    expect(h.service.status.reason).toBe("Capture timed out waiting for game focus");
  });
  it("rejects a preview that completes after stop without retrying or replacing stop status", async () => {
    const h = harness();
    let resolve!: (reply: WinReply) => void;
    h.host.send.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const failure = expect(h.service.preview()).rejects.toThrow("Calibration cancelled");
    h.service.stop();
    resolve({ ok: true, image: "late-capture", width: 2560, height: 1440 });
    await failure;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.host.send).toHaveBeenCalledOnce();
    expect(h.host.close).toHaveBeenCalledOnce();
    expect(h.service.status.reason).toBe("Stopped");
  });
  it("sends immediate low-health and R decisions through audited input", async () => {
    const h = harness();
    await h.service.start(); await vi.advanceTimersByTimeAsync(0);
    expect(h.host.send.mock.calls.filter(([p]) => p.op === "tap").map(([p]) => p.key)).toEqual(["1", "R"]);
    expect(h.audit.mock.calls.flat(2)).toEqual(expect.arrayContaining([expect.objectContaining({ module: "combat", result: "emitted" })]));
    h.service.stop();
  });
  it("dry-runs decisions without any native tap", async () => {
    const h = harness(true);
    await h.service.start(); await vi.advanceTimersByTimeAsync(100);
    expect(h.host.send.mock.calls.some(([p]) => p.op === "tap")).toBe(false);
    expect(h.service.status.actions).toBe(2);
    h.service.stop();
  });
  it("routes low mana to Mouse5 through the same audited and guarded input path", async () => {
    const h = harness();
    h.frame.samples.mana = fill(h.config.regions.mana!.reference, 24);
    await h.service.start(); await vi.advanceTimersByTimeAsync(0);
    expect(h.host.send.mock.calls.filter(([p]) => p.op === "tap").map(([p]) => p.key)).toEqual(["1", "MOUSE5", "R"]);
    expect(h.audit.mock.calls.flat(2)).toContainEqual(expect.objectContaining({ decisionRule: "combat-mana", input: { kind: "key", key: "MOUSE5" }, result: "emitted" }));
    h.service.stop();
  });
  it("decodes compact RGB from the native pipe before making decisions", async () => {
    const h = harness(true);
    h.host.send.mockImplementation(async (p) => p.op === "sample" ? { ok: true, ...h.frame, samples: Object.fromEntries(Object.entries(h.frame.samples).map(([name, rgb]) => [name, Buffer.from(rgb!).toString("base64")])) } : { ok: true });
    await h.service.start(); await vi.advanceTimersByTimeAsync(0);
    expect(h.service.status.reading).toMatchObject({ valid: true, health: 24, unleash: "ready" });
    expect(h.service.status.actions).toBe(2);
    h.service.stop();
  });
  it("stops while a capture is pending; stale completion cannot emit or restart", async () => {
    const h = harness();
    let resolve!: (reply: WinReply) => void;
    h.host.send.mockImplementation(async (p) => p.op === "sample" ? new Promise((r) => { resolve = r; }) : { ok: true });
    await h.service.start();
    h.service.stop();
    resolve({ ok: true, ...h.frame }); await vi.advanceTimersByTimeAsync(500);
    expect(h.service.status.running).toBe(false);
    expect(h.host.close).toHaveBeenCalledOnce();
    expect(h.host.send.mock.calls.some(([p]) => p.op === "tap")).toBe(false);
  });
  it("kill switch blocks a subsequent action in the same frame", async () => {
    const h = harness();
    h.host.send.mockImplementation(async (p) => {
      if (p.op === "sample") return { ok: true, ...h.frame };
      if (p.op === "tap") h.killSwitch.trip();
      return { ok: true };
    });
    await h.service.start(); await vi.advanceTimersByTimeAsync(100);
    expect(h.host.send.mock.calls.filter(([p]) => p.op === "tap")).toHaveLength(1);
    expect(h.service.status.running).toBe(false);
    await expect(h.service.start()).rejects.toThrow(/latched/);
  });
  it("does not overlap slow captures or act on old evidence", async () => {
    const h = harness();
    h.host.send.mockImplementation(async (p) => {
      if (p.op !== "sample") return { ok: true };
      await new Promise((r) => setTimeout(r, 150));
      return { ok: true, ...h.frame };
    });
    await h.service.start(); await vi.advanceTimersByTimeAsync(149);
    expect(h.host.send.mock.calls.filter(([p]) => p.op === "sample")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.host.send.mock.calls.some(([p]) => p.op === "tap")).toBe(false);
    expect(h.service.status.reason).toContain("Stale");
    h.service.stop();
  });
  it("handles focus loss without input and resumes only on a fresh HUD frame", async () => {
    const h = harness();
    h.host.send.mockImplementation(async (p) => p.op === "sample" ? { ok: false, error: "Focus Path of Exile 2 to continue" } : { ok: true });
    await h.service.start(); await vi.advanceTimersByTimeAsync(100);
    expect(h.host.send.mock.calls.some(([p]) => p.op === "tap")).toBe(false);
    h.host.send.mockImplementation(async (p) => p.op === "sample" ? { ok: true, ...h.frame } : { ok: true });
    await vi.advanceTimersByTimeAsync(100);
    expect(h.host.send.mock.calls.some(([p]) => p.op === "tap")).toBe(true);
    h.service.stop();
  });
  it("persists toggles but starts stopped; changing configuration cancels input", async () => {
    const h = harness();
    expect(h.service.status.running).toBe(false);
    await h.service.start(); await vi.advanceTimersByTimeAsync(0);
    h.config.health.enabled = false;
    expect(h.service.configure(h.config).running).toBe(false);
    expect(h.service.status.config.health.enabled).toBe(false);
  });
  it("stops on a failed worker or audit write instead of silently continuing", async () => {
    const h = harness();
    h.audit.mockImplementation(() => { throw new Error("disk full"); });
    await h.service.start(); await vi.advanceTimersByTimeAsync(0);
    expect(h.service.status.running).toBe(false);
    expect(h.service.status.reason).toContain("disk full");
  });
  it("restricts the native sink to single configured key events and a fresh window", async () => {
    const host = { send: vi.fn(async () => ({ ok: true })) };
    const sink = new CombatInputSink(host, () => undefined);
    await expect(sink.emit({ kind: "key", key: "R" })).rejects.toThrow(/stopped/);
    const active = new CombatInputSink(host, () => "123");
    await expect(active.emit({ kind: "click", x: 1, y: 2 })).rejects.toThrow(/Invalid/);
    await expect(active.emit({ kind: "key", key: "CTRL+R" })).rejects.toThrow(/Choose/);
    expect(host.send).not.toHaveBeenCalled();
  });
});
