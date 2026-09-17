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
  function macroHarness(dryRun = false) {
    const h = harness(dryRun);
    h.config.health.enabled = h.config.mana.enabled = false;
    h.config.verisium.enabled = h.config.sigilSequence.enabled = true;
    h.service.configure(h.config);
    return h;
  }
  function physicalR(h: ReturnType<typeof harness>, id = 1, ageMs = 0, hwnd = h.frame.hwnd) {
    h.frame.trigger = { id, ageMs, hwnd };
  }
  function nativeKeys(h: ReturnType<typeof harness>) {
    return h.host.send.mock.calls.filter(([p]) => p.op === "tap").map(([p]) => p.key);
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
  it("arms the native trigger without casting automatically, even when the skill icons stay ready", async () => {
    const h = macroHarness();
    await h.service.start(); await vi.advanceTimersByTimeAsync(20_000);
    expect(h.host.send.mock.calls.slice(0, 3).map(([p]) => p.op)).toEqual(["ping", "configureTrigger", "sample"]);
    expect(h.host.send).toHaveBeenCalledWith({ op: "configureTrigger", key: "R" });
    expect(nativeKeys(h)).toEqual([]);
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.service.status).toMatchObject({ running: true, reason: "Armed — press R for one cycle", actions: 0 });
    h.service.stop();
  });
  it.each([false, true])("follows one physical R with X and T, never another R, with preview=%s", async (dryRun) => {
    const h = macroHarness(dryRun);
    physicalR(h);
    await h.service.start(); await vi.advanceTimersByTimeAsync(0);
    expect(nativeKeys(h)).toEqual([]);
    await vi.advanceTimersByTimeAsync(720);
    const keys = h.audit.mock.calls.flat(2).filter((t) => t.decisionRule.startsWith("sigil-sequence")).map((t) => t.input.key);
    expect(keys).toEqual(["X", "T"]);
    expect(nativeKeys(h)).toEqual(dryRun ? [] : ["X", "T"]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.service.status.actions).toBe(2);
    h.service.stop();
  });
  it("runs without saved HUD calibration and samples only the foreground target", async () => {
    const h = macroHarness();
    h.config.regions = {};
    h.config.width = h.config.height = 0;
    h.service.configure(h.config);
    h.frame.samples = {};
    physicalR(h);
    await h.service.start(); await vi.advanceTimersByTimeAsync(720);
    expect(h.host.send).toHaveBeenCalledWith({ op: "sample", regions: {} });
    expect(nativeKeys(h)).toEqual(["X", "T"]);
    h.service.stop();
  });
  it.each([0, 200])("completes the manual macro when optional flask HUD becomes unreadable after %i ms", async (unreadableAt) => {
    const h = macroHarness();
    h.config.mana.enabled = true;
    h.service.configure(h.config);
    physicalR(h);
    if (unreadableAt === 0) h.frame.samples = {};
    await h.service.start(); await vi.advanceTimersByTimeAsync(unreadableAt);
    h.frame.samples = {};
    await vi.advanceTimersByTimeAsync(800);
    expect(nativeKeys(h)).toEqual(["X", "T"]);
    expect(h.audit.mock.calls.flat(2).every((t) => t.decisionRule.startsWith("sigil-sequence"))).toBe(true);
    expect(h.service.status.running).toBe(true);
    h.service.stop();
  });
  it("waits the configured delays and for physical R release before swapping", async () => {
    const h = macroHarness();
    physicalR(h); h.frame.triggerDown = true;
    await h.service.start(); await vi.advanceTimersByTimeAsync(900);
    expect(nativeKeys(h)).toEqual([]);
    h.frame.triggerDown = false;
    await vi.advanceTimersByTimeAsync(16);
    expect(nativeKeys(h)).toEqual(["X"]);
    await vi.advanceTimersByTimeAsync(80);
    expect(nativeKeys(h)).toEqual(["X"]);
    await vi.advanceTimersByTimeAsync(32);
    expect(nativeKeys(h)).toEqual(["X", "T"]);
    h.service.stop();
  });
  it("discards presses received while busy, then allows only a new press after completion", async () => {
    const h = macroHarness(); physicalR(h);
    await h.service.start(); await vi.advanceTimersByTimeAsync(200);
    physicalR(h, 2);
    await vi.advanceTimersByTimeAsync(800);
    expect(nativeKeys(h)).toEqual(["X", "T"]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(nativeKeys(h)).toEqual(["X", "T"]);
    physicalR(h, 3);
    await vi.advanceTimersByTimeAsync(750);
    expect(nativeKeys(h)).toEqual(["X", "T", "X", "T"]);
    h.service.stop();
  });
  it("drains a physical press arriving during the final T request instead of queuing another cycle", async () => {
    const h = macroHarness(); physicalR(h);
    let latePress = false;
    h.host.send.mockImplementation(async (p) => {
      if (p.op === "sample") {
        const reply = { ok: true, ...h.frame };
        delete h.frame.trigger; // Native sampling consumes one pending physical edge.
        return reply;
      }
      if (p.op === "tap" && p.key === "T" && !latePress) {
        latePress = true;
        physicalR(h, 2); // Arrives after the final sample, while T is still in flight.
      }
      if (p.op === "completeTriggerCycle") delete h.frame.trigger;
      return { ok: true };
    });
    await h.service.start(); await vi.advanceTimersByTimeAsync(720);
    expect(latePress).toBe(true);
    expect(h.host.send).toHaveBeenCalledWith({ op: "completeTriggerCycle" });
    await vi.advanceTimersByTimeAsync(2000);
    expect(nativeKeys(h)).toEqual(["X", "T"]);
    physicalR(h, 3);
    await vi.advanceTimersByTimeAsync(750);
    expect(nativeKeys(h)).toEqual(["X", "T", "X", "T"]);
    h.service.stop();
  });
  it.each([
    { id: 1, ageMs: 251, hwnd: "1234" },
    { id: 1, ageMs: -1, hwnd: "1234" },
    { id: 1, ageMs: Number.NaN, hwnd: "1234" },
    { id: 1, ageMs: 0, hwnd: "other-game-window" },
    { id: 0, ageMs: 0, hwnd: "1234" },
    { id: 1.5, ageMs: 0, hwnd: "1234" },
  ])("rejects an invalid physical trigger: %j", async (trigger) => {
    const h = macroHarness(); h.frame.trigger = trigger;
    await h.service.start(); await vi.advanceTimersByTimeAsync(1500);
    expect(nativeKeys(h)).toEqual([]);
    expect(h.service.status.running).toBe(true);
    h.service.stop();
  });
  it("discards a trigger from invalid foreground evidence without replaying it after recovery", async () => {
    const h = macroHarness(); physicalR(h); h.frame.process = "notepad";
    await h.service.start(); await vi.advanceTimersByTimeAsync(100);
    h.frame.process = "PathOfExileSteam";
    await vi.advanceTimersByTimeAsync(1000);
    expect(nativeKeys(h)).toEqual([]);
    physicalR(h, 2);
    await vi.advanceTimersByTimeAsync(750);
    expect(nativeKeys(h)).toEqual(["X", "T"]);
    h.service.stop();
  });
  it.each(["stop", "focus", "kill", "window", "invalid-reading"])("cancels the pending swap on %s", async (cause) => {
    const h = macroHarness(); physicalR(h);
    await h.service.start(); await vi.advanceTimersByTimeAsync(0);
    if (cause === "stop") h.service.stop();
    if (cause === "kill") h.killSwitch.trip();
    if (cause === "focus") h.host.send.mockResolvedValue({ ok: false, error: "Game is not foreground" });
    if (cause === "window") h.frame.hwnd = "5678";
    if (cause === "invalid-reading") h.frame.process = "notepad";
    await vi.advanceTimersByTimeAsync(1000);
    expect(nativeKeys(h)).toEqual([]);
    expect(h.service.status.running).toBe(false);
  });
  it.each(["stop", "focus", "kill"])("cancels the pending Verisium cast after a swap on %s", async (cause) => {
    const h = macroHarness(); physicalR(h);
    await h.service.start(); await vi.advanceTimersByTimeAsync(608);
    expect(nativeKeys(h)).toEqual(["X"]);
    if (cause === "stop") h.service.stop();
    if (cause === "kill") h.killSwitch.trip();
    if (cause === "focus") h.host.send.mockResolvedValue({ ok: false, error: "Game is not foreground" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(nativeKeys(h)).toEqual(["X"]);
    expect(h.service.status.running).toBe(false);
  });
  it("stops if the native trigger cannot be configured and never samples or taps", async () => {
    const h = macroHarness();
    h.host.send.mockImplementation(async (p) => p.op === "configureTrigger" ? { ok: false, error: "Keyboard hook unavailable" } : { ok: true });
    await h.service.start(); await vi.advanceTimersByTimeAsync(1000);
    expect(h.host.send.mock.calls.map(([p]) => p.op)).toEqual(["ping", "configureTrigger"]);
    expect(h.service.status).toMatchObject({ running: false, reason: "Keyboard hook unavailable" });
    expect(h.host.close).toHaveBeenCalledOnce();
  });
  it("sends immediate low-health and R decisions through audited input", async () => {
    const h = harness();
    await h.service.start(); await vi.advanceTimersByTimeAsync(0);
    expect(h.host.send.mock.calls.filter(([p]) => p.op === "tap").map(([p]) => p.key)).toEqual(["1", "R"]);
    expect(h.audit.mock.calls.flat(2)).toEqual(expect.arrayContaining([expect.objectContaining({ module: "combat", result: "emitted" })]));
    h.service.stop();
  });
  it("taps T for Powered by Verisium after R when both skills are enabled and ready", async () => {
    const h = harness();
    h.config.verisium.enabled = true;
    h.service.configure(h.config);
    await h.service.start(); await vi.advanceTimersByTimeAsync(0);
    expect(h.host.send.mock.calls.filter(([p]) => p.op === "tap").map(([p]) => p.key)).toEqual(["1", "R", "T"]);
    expect(h.audit.mock.calls.flat(2)).toContainEqual(expect.objectContaining({ decisionRule: "combat-verisium", input: { kind: "key", key: "T" }, result: "emitted" }));
    expect(h.service.status.reading).toMatchObject({ unleash: "ready", verisium: "ready" });
    h.service.stop();
  });
  it("skips a second-skill press that aged past the capture window instead of stopping combat", async () => {
    const h = harness();
    h.config.verisium.enabled = true;
    h.service.configure(h.config);
    let taps = 0;
    h.host.send.mockImplementation(async (p) => {
      if (p.op === "sample") return { ok: true, ...h.frame, capturedAt: undefined };
      if (p.op === "tap") {
        taps++;
        // The first tap of the frame (health) is slow: by the time R and T come, the frame is 125 ms old.
        if (taps === 1) vi.setSystemTime(Date.now() + 125);
      }
      return { ok: true };
    });
    await h.service.start(); await vi.advanceTimersByTimeAsync(0);
    // Over budget after the slow tap: the remaining skills wait for the next frame; nothing fails, nothing stops.
    const first = (h.audit.mock.calls.flat(2) as Array<{ decisionRule: string; result: string }>).map((t) => [t.decisionRule, t.result]);
    expect(first).toEqual([["combat-health", "emitted"]]);
    expect(h.service.status.running).toBe(true);
    h.audit.mockClear();
    await vi.advanceTimersByTimeAsync(20);
    const next = (h.audit.mock.calls.flat(2) as Array<{ decisionRule: string; result: string }>).map((t) => [t.decisionRule, t.result]);
    expect(next).toEqual(expect.arrayContaining([["combat-unleash", "emitted"], ["combat-verisium", "emitted"]]));
    expect(h.service.status.running).toBe(true);
    h.service.stop();
  });
  it("treats the worker's stale-capture refusal as a skipped press, not a stop", async () => {
    const h = harness();
    h.config.verisium.enabled = true;
    h.service.configure(h.config);
    let refused = false;
    h.host.send.mockImplementation(async (p) => {
      if (p.op === "sample") return { ok: true, ...h.frame };
      if (p.op === "tap" && p.key === "R" && !refused) { refused = true; return { ok: false, error: "Stale capture or window moved" }; }
      return { ok: true };
    });
    await h.service.start(); await vi.advanceTimersByTimeAsync(0);
    const first = (h.audit.mock.calls.flat(2) as Array<{ decisionRule: string; result: string; reason: string }>);
    expect(first.map((t) => [t.decisionRule, t.result])).toEqual([["combat-health", "emitted"], ["combat-unleash", "failed"]]);
    expect(first[1]!.reason).toContain("Stale capture");
    expect(h.service.status.running).toBe(true);
    h.audit.mockClear();
    await vi.advanceTimersByTimeAsync(20);
    expect((h.audit.mock.calls.flat(2) as Array<{ decisionRule: string; result: string }>).map((t) => [t.decisionRule, t.result]))
      .toEqual(expect.arrayContaining([["combat-unleash", "emitted"], ["combat-verisium", "emitted"]]));
    // Any other worker failure still stops the loop.
    h.host.send.mockImplementation(async (p) => p.op === "sample" ? { ok: true, ...h.frame } : p.op === "tap" ? { ok: false, error: "Windows rejected combat input" } : { ok: true });
    await vi.advanceTimersByTimeAsync(1_000); // the next retry press fails for a non-stale reason
    expect(h.service.status.running).toBe(false);
    expect(h.service.status.reason).toContain("Windows rejected");
  });
  it("dry-runs decisions without any native tap", async () => {
    const h = harness(true);
    await h.service.start(); await vi.advanceTimersByTimeAsync(100);
    expect(h.host.send.mock.calls.some(([p]) => p.op === "tap")).toBe(false);
    expect(h.service.status.actions).toBe(2);
    h.service.stop();
  });
  it("retries a refused swap without stopping or casting Verisium before the swap succeeds", async () => {
    const h = macroHarness(); physicalR(h);
    let held = true;
    h.host.send.mockImplementation(async (p) => {
      if (p.op === "sample") return { ok: true, ...h.frame };
      if (p.op === "tap" && held) return { ok: false, error: 'Exception calling "Tap": "Modifier or action binding held"' };
      return { ok: true };
    });
    await h.service.start(); await vi.advanceTimersByTimeAsync(750);
    expect(h.service.status.running).toBe(true);
    expect(h.service.status.actions).toBe(0);
    expect(nativeKeys(h)).toEqual(["X"]);
    held = false;
    await vi.advanceTimersByTimeAsync(350);
    expect(h.service.status.actions).toBe(2);
    expect(h.audit.mock.calls.flat(2).filter((t) => t.result === "emitted").map((t) => t.input.key)).toEqual(["X", "T"]);
    h.service.stop();
  });
  it("waits for a held modifier during an active sequence and resumes from a fresh sample", async () => {
    const h = macroHarness(); physicalR(h);
    await h.service.start(); await vi.advanceTimersByTimeAsync(0);
    h.host.send.mockImplementation(async (p) => p.op === "sample" ? { ok: false, error: "Release modifier keys to resume" } : { ok: true });
    await vi.advanceTimersByTimeAsync(200);
    expect(h.service.status.running).toBe(true);
    expect(h.service.status.actions).toBe(0);
    h.host.send.mockImplementation(async (p) => p.op === "sample" ? { ok: true, ...h.frame } : { ok: true });
    await vi.advanceTimersByTimeAsync(600);
    expect(nativeKeys(h)).toEqual(["X", "T"]);
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
