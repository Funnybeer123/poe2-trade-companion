import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildHostProbes,
  classifyPatch,
  decideFlaskFire,
  defaultFlaskGuardConfig,
  looksLikeFilledGlobe,
  normalizeFlaskGuardConfig,
  probeReadiness,
  probeThresholds,
  vkForFlaskKey,
  type FlaskGuardConfig,
} from "../src/shared/flaskGuard.js";
import { loadFlaskGuardConfig, saveFlaskGuardConfig } from "../src/core/flaskGuardConfig.js";
import { FlaskGuardRunner, type WinHostLike } from "../src/adapters/flaskGuardRunner.js";

// Colours measured on the user's 4K client (2026-09-07).
const LIFE_RED = { r: 144, g: 33, b: 41 };
const LIFE_TEAL_ES = { r: 125, g: 206, b: 206 };
const LIFE_DARK_SHADE = { r: 33, g: 88, b: 128 };
const MANA_BLUE = { r: 29, g: 102, b: 155 };
const EMPTY_GLASS = { r: 32, g: 32, b: 37 };
const RIM_GREY = { r: 78, g: 72, b: 68 };

function calibrated(): FlaskGuardConfig {
  const config = defaultFlaskGuardConfig();
  config.enabled = true;
  config.life = { ...config.life, point: { x: 240, y: 1920 }, reference: LIFE_RED, calibratedAt: "2026-09-07T00:00:00.000Z" };
  config.mana = { ...config.mana, point: { x: 3600, y: 1920 }, reference: MANA_BLUE, calibratedAt: "2026-09-07T00:00:00.000Z" };
  return config;
}

describe("flask guard config", () => {
  it("defaults: disabled, life on 1, mana on 2, nothing calibrated", () => {
    const config = defaultFlaskGuardConfig();
    expect(config.enabled).toBe(false);
    expect(config.life.key).toBe("1");
    expect(config.mana.key).toBe("2");
    expect(config.life.point).toBeNull();
    expect(probeReadiness(config.life)).toEqual({ ready: false, reason: "not calibrated" });
  });

  it("refuses bad keys and clamps numbers, keeping the rest", () => {
    const { config, issues } = normalizeFlaskGuardConfig({
      enabled: true,
      chromaRatio: 5,
      life: { key: "ctrl", cooldownMs: 10 },
      mana: { key: "Q", cooldownMs: "abc" },
    });
    expect(config.enabled).toBe(true);
    expect(config.chromaRatio).toBe(0.95);
    expect(config.life.key).toBe("1");
    expect(config.life.cooldownMs).toBe(250);
    expect(config.mana.key).toBe("q");
    expect(config.mana.cooldownMs).toBe(4000);
    expect(issues.some((issue) => issue.includes("life: key"))).toBe(true);
    expect(issues.some((issue) => issue.includes("mana: cooldownMs"))).toBe(true);
  });

  it("clears a point saved without its reference colour", () => {
    const { config, issues } = normalizeFlaskGuardConfig({ life: { point: { x: 1, y: 2 } } });
    expect(config.life.point).toBeNull();
    expect(config.life.reference).toBeNull();
    expect(issues[0]).toMatch(/calibrated together/);
  });

  it("round-trips through the file the daemon polls", () => {
    const root = mkdtempSync(path.join(tmpdir(), "flask-guard-"));
    try {
      expect(loadFlaskGuardConfig(root).source).toBe("defaults");
      const saved = saveFlaskGuardConfig(root, calibrated());
      expect(saved.issues).toEqual([]);
      const loaded = loadFlaskGuardConfig(root);
      expect(loaded.source).toBe("file");
      expect(loaded.mtimeMs).toBeGreaterThan(0);
      expect(loaded.config.life.point).toEqual({ x: 240, y: 1920 });
      expect(loaded.config.mana.reference).toEqual(MANA_BLUE);
      expect(loaded.config.enabled).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("flask guard classifier", () => {
  it("reads fluid as filled and empty glass as low against a red life reference", () => {
    const thresholds = probeThresholds(defaultFlaskGuardConfig(), LIFE_RED);
    expect(classifyPatch(LIFE_RED, thresholds)).toBe("filled");
    expect(classifyPatch(EMPTY_GLASS, thresholds)).toBe("low");
    expect(classifyPatch(RIM_GREY, thresholds)).toBe("low");
  });

  it("is hue-agnostic: energy shield teal and plain red both count as filled", () => {
    const fromTeal = probeThresholds(defaultFlaskGuardConfig(), LIFE_TEAL_ES);
    expect(classifyPatch(LIFE_RED, fromTeal)).toBe("filled");
    expect(classifyPatch(LIFE_DARK_SHADE, fromTeal)).toBe("filled");
    expect(classifyPatch(EMPTY_GLASS, fromTeal)).toBe("low");
    const fromRed = probeThresholds(defaultFlaskGuardConfig(), LIFE_RED);
    expect(classifyPatch(LIFE_TEAL_ES, fromRed)).toBe("filled");
  });

  it("classifies the mana globe", () => {
    const thresholds = probeThresholds(defaultFlaskGuardConfig(), MANA_BLUE);
    expect(classifyPatch(MANA_BLUE, thresholds)).toBe("filled");
    expect(classifyPatch({ r: 60, g: 140, b: 200 }, thresholds)).toBe("filled");
    expect(classifyPatch(EMPTY_GLASS, thresholds)).toBe("low");
  });

  it("keeps threshold floors so a dim calibration cannot read noise as filled", () => {
    const dim = probeThresholds(defaultFlaskGuardConfig(), { r: 20, g: 22, b: 30 });
    expect(dim.minChroma).toBe(18);
    expect(dim.minBright).toBe(40);
  });

  it("accepts fluid and rejects glass as a calibration click", () => {
    expect(looksLikeFilledGlobe(LIFE_RED)).toBe(true);
    expect(looksLikeFilledGlobe(MANA_BLUE)).toBe(true);
    expect(looksLikeFilledGlobe(EMPTY_GLASS)).toBe(false);
    expect(looksLikeFilledGlobe(RIM_GREY)).toBe(false);
  });

  it("maps flask keys to virtual-key codes", () => {
    expect(vkForFlaskKey("1")).toBe(0x31);
    expect(vkForFlaskKey("5")).toBe(0x35);
    expect(vkForFlaskKey("q")).toBe(0x51);
    expect(vkForFlaskKey("F1")).toBeUndefined();
    expect(vkForFlaskKey("")).toBeUndefined();
  });
});

describe("flask fire decision (mirror of the host loop)", () => {
  const base = { cooldownMs: 3000, staleAfterMs: 12_000, staleCooldownMs: 10_000 };

  it("never fires while filled, and arms the probe", () => {
    expect(decideFlaskFire({ ...base, state: "filled", armed: false, sinceFireMs: Infinity, sinceFilledMs: 0 })).toEqual({
      fire: false,
      armed: true,
      stale: false,
    });
  });

  it("never fires before the HUD has ever been seen filled", () => {
    expect(decideFlaskFire({ ...base, state: "low", armed: false, sinceFireMs: Infinity, sinceFilledMs: 0 }).fire).toBe(false);
  });

  it("fires instantly on the first low read, then respects the cooldown", () => {
    expect(decideFlaskFire({ ...base, state: "low", armed: true, sinceFireMs: Infinity, sinceFilledMs: 30 }).fire).toBe(true);
    expect(decideFlaskFire({ ...base, state: "low", armed: true, sinceFireMs: 2999, sinceFilledMs: 3029 }).fire).toBe(false);
    expect(decideFlaskFire({ ...base, state: "low", armed: true, sinceFireMs: 3000, sinceFilledMs: 3030 }).fire).toBe(true);
  });

  it("slows to the stale cadence when no fill has been seen for a long time", () => {
    const stale = decideFlaskFire({ ...base, state: "low", armed: true, sinceFireMs: 5000, sinceFilledMs: 20_000 });
    expect(stale).toEqual({ fire: false, armed: true, stale: true });
    expect(decideFlaskFire({ ...base, state: "low", armed: true, sinceFireMs: 10_000, sinceFilledMs: 20_000 }).fire).toBe(true);
  });
});

describe("host probe payload", () => {
  it("skips disabled and uncalibrated globes and carries continuity", () => {
    const config = calibrated();
    config.mana.enabled = false;
    const probes = buildHostProbes(config, { life: { armed: true, lastFireMsAgo: 1200, lastFilledMsAgo: 40 } });
    expect(probes).toHaveLength(1);
    expect(probes[0]).toMatchObject({
      id: "life",
      x: 240,
      y: 1920,
      vk: 0x31,
      cooldownMs: 3000,
      armed: true,
      lastFireMsAgo: 1200,
      lastFilledMsAgo: 40,
      minChroma: Math.round(111 * 0.4),
      minBright: Math.round(144 * 0.4),
    });
    const fresh = defaultFlaskGuardConfig();
    fresh.enabled = true;
    expect(buildHostProbes(fresh)).toEqual([]);
  });
});

describe("FlaskGuardRunner", () => {
  function fakeHost(replies: Array<Record<string, unknown>>) {
    const sent: Array<Record<string, unknown>> = [];
    let closed = 0;
    const host: WinHostLike = {
      async send(payload) {
        sent.push(payload);
        if (payload.op === "ping") return { ok: true, pong: true };
        await new Promise((resolve) => setTimeout(resolve, 5));
        return replies.shift() ?? { ok: true, stoppedBy: "deadline", fires: [], states: {} };
      },
      async close() {
        closed += 1;
      },
    };
    return { host, sent, closed: () => closed };
  }

  it("re-issues cycles with continuity carried over and logs fires", async () => {
    const config = calibrated();
    const { host, sent, closed } = fakeHost([
      {
        ok: true,
        stoppedBy: "deadline",
        fires: [{ id: "life", t: 120, r: 30, g: 30, b: 35, stale: false, dry: false }],
        states: {
          life: { state: "low", r: 30, g: 30, b: 35, armed: true, fires: 1, lastFireMsAgo: 800, lastFilledMsAgo: 900 },
          mana: { state: "filled", r: 29, g: 102, b: 155, armed: true, fires: 0, lastFireMsAgo: -1, lastFilledMsAgo: 5 },
        },
      },
    ]);
    const logs: Array<{ phase: string; message: string }> = [];
    const runner = new FlaskGuardRunner({
      root: "unused",
      log: (entry) => logs.push(entry),
      cycleMs: 500,
      hostFactory: () => host,
      configLoader: () => ({ config, issues: [], mtimeMs: 1 }),
    });
    runner.start();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await runner.stop();

    const cycles = sent.filter((payload) => payload.op === "flaskguard");
    expect(cycles.length).toBeGreaterThanOrEqual(2);
    const first = cycles[0]!.probes as Array<Record<string, unknown>>;
    expect(first.map((probe) => probe.id)).toEqual(["life", "mana"]);
    expect(first[0]).toMatchObject({ armed: false, lastFireMsAgo: -1 });
    const second = cycles[1]!.probes as Array<Record<string, unknown>>;
    expect(second[0]).toMatchObject({ id: "life", armed: true, lastFireMsAgo: 800, lastFilledMsAgo: 900 });
    expect(second[1]).toMatchObject({ id: "mana", armed: true, lastFireMsAgo: -1 });
    expect(logs.some((entry) => entry.phase === "fire" && entry.message.startsWith("life flask pressed"))).toBe(true);
    expect(logs[0]).toMatchObject({ phase: "state" });
    expect(logs[0]!.message).toContain("life→key 1");
    expect(closed()).toBe(1);
    expect(runner.status().totalFires).toBe(1);
  });

  it("idles without a host when disabled, and pause interrupts a running cycle", async () => {
    const config = calibrated();
    config.enabled = false;
    let hostsMade = 0;
    const { host, sent } = fakeHost([]);
    const logs: Array<{ phase: string; message: string }> = [];
    const runner = new FlaskGuardRunner({
      root: "unused",
      log: (entry) => logs.push(entry),
      cycleMs: 500,
      hostFactory: () => {
        hostsMade += 1;
        return host;
      },
      configLoader: () => ({ config, issues: [], mtimeMs: 1 }),
    });
    runner.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(hostsMade).toBe(0);
    expect(logs[0]!.message).toContain("disabled");

    config.enabled = true;
    runner.interrupt();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(hostsMade).toBe(1);
    expect(runner.togglePause()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent.some((payload) => payload.op === "ping")).toBe(true);
    expect(logs.some((entry) => entry.message.includes("paused"))).toBe(true);
    expect(runner.status().paused).toBe(true);
    await runner.stop();
  });
});
