import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildHostProbes,
  classifyPatch,
  decideFlaskFire,
  defaultFlaskGuardConfig,
  describeFlaskKey,
  flaskKeyInput,
  looksLikeFilledGlobe,
  looksLikeReadySkill,
  normalizeFlaskGuardConfig,
  probeConfigFor,
  probeReadiness,
  probeThresholds,
  skillIdFromLabel,
  skillProbeId,
  skillThresholds,
  uniqueSkillId,
  vkForFlaskKey,
  type FlaskGuardConfig,
} from "../src/shared/flaskGuard.js";
import { loadFlaskGuardConfig, saveFlaskGuardConfig } from "../src/core/flaskGuardConfig.js";
import {
  calibrateFlaskProbe,
  FlaskGuardRunner,
  sampleFlaskProbes,
  type WinHostLike,
} from "../src/adapters/flaskGuardRunner.js";

// Colours measured on the user's 4K client (2026-09-07).
const LIFE_RED = { r: 144, g: 33, b: 41 };
const LIFE_TEAL_ES = { r: 125, g: 206, b: 206 };
const LIFE_DARK_SHADE = { r: 33, g: 88, b: 128 };
const MANA_BLUE = { r: 29, g: 102, b: 155 };
const EMPTY_GLASS = { r: 32, g: 32, b: 37 };
const RIM_GREY = { r: 78, g: 72, b: 68 };
// Seen at live presses 2026-09-08: loading fade, low-life-tinted glass, loading art.
const LOADING_BLACK = { r: 3, g: 3, b: 2 };
const LOW_LIFE_TINT = { r: 30, g: 14, b: 14 };
const LOADING_ART = { r: 197, g: 172, b: 179 };
// A lit skill icon, the same icon under the cooldown sweep, and with the no-mana tint.
const ICON_READY = { r: 168, g: 132, b: 74 };
const ICON_COOLING = { r: 48, g: 38, b: 22 };
const ICON_NO_MANA = { r: 150, g: 60, b: 50 };

function calibrated(): FlaskGuardConfig {
  const config = defaultFlaskGuardConfig();
  config.enabled = true;
  config.life = { ...config.life, point: { x: 240, y: 1920 }, reference: LIFE_RED, calibratedAt: "2026-09-07T00:00:00.000Z" };
  config.mana = { ...config.mana, point: { x: 3600, y: 1920 }, reference: MANA_BLUE, calibratedAt: "2026-09-07T00:00:00.000Z" };
  return config;
}

describe("flask guard config", () => {
  it("defaults: disabled, life on 1, mana on 2, Powered by Verisium on t, nothing calibrated", () => {
    const config = defaultFlaskGuardConfig();
    expect(config.enabled).toBe(false);
    expect(config.life.key).toBe("1");
    expect(config.mana.key).toBe("2");
    expect(config.life.point).toBeNull();
    expect(probeReadiness(config.life)).toEqual({ ready: false, reason: "not calibrated" });
    expect(config.skills).toHaveLength(1);
    expect(config.skills[0]).toMatchObject({ id: "verisium", label: "Powered by Verisium", key: "t", enabled: true, point: null });
    expect(skillProbeId(config.skills[0]!)).toBe("skill:verisium");
  });

  it("a config saved before auto-cast existed gains the default skill; saved skills are kept", () => {
    const legacy = normalizeFlaskGuardConfig({ enabled: true, life: { key: "1" } });
    expect(legacy.issues).toEqual([]);
    expect(legacy.config.skills.map((skill) => skill.id)).toEqual(["verisium"]);
    const { config, issues } = normalizeFlaskGuardConfig({
      skills: [
        { id: "verisium", label: "Powered by Verisium", key: "t", cooldownMs: 100 },
        { label: "Unleash", key: "R", point: { x: 10, y: 20 }, reference: ICON_READY },
        { label: "Unleash", key: "ctrl" },
        "junk",
      ],
    });
    expect(config.skills.map((skill) => skill.id)).toEqual(["verisium", "unleash", "unleash-2"]);
    expect(config.skills[0]!.cooldownMs).toBe(250);
    // Ids at the 32-char limit still de-duplicate (and terminate): the suffix fits inside the limit.
    const long = "lightning-spear-of-splitting-alp"; // 32 chars
    expect(long).toHaveLength(32);
    const dup = normalizeFlaskGuardConfig({ skills: [{ id: long }, { id: long }, { id: long }] });
    expect(dup.config.skills.map((skill) => skill.id)).toEqual([long, "lightning-spear-of-splitting-a-2", "lightning-spear-of-splitting-a-3"]);
    expect(uniqueSkillId("a-".repeat(16), new Set(["a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-"]))).toBe("a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-2");
    expect(uniqueSkillId("skill", new Set(["skill", "skill-2"]))).toBe("skill-3");
    expect(uniqueSkillId("", new Set())).toBe("skill");
    expect(config.skills[1]).toMatchObject({ key: "r", point: { x: 10, y: 20 }, reference: ICON_READY });
    // An invalid key never falls back onto another skill's key: the row is left unbound and reported.
    expect(config.skills[2]!.key).toBe("");
    expect(probeReadiness({ ...config.skills[2]!, point: { x: 1, y: 1 }, reference: ICON_READY })).toEqual({ ready: false, reason: "no key" });
    expect(issues.some((issue) => issue.includes("Unleash: key") && issue.includes("left unbound"))).toBe(true);
    expect(issues.some((issue) => issue.includes("skills[3]"))).toBe(true);
    expect(normalizeFlaskGuardConfig({ skills: [] }).config.skills).toEqual([]);
    // A row added in the panel but not yet given a key is kept unbound, silently, and never runs.
    const unbound = normalizeFlaskGuardConfig({ skills: [{ label: "New skill", key: "", point: { x: 1, y: 2 }, reference: ICON_READY }] });
    expect(unbound.issues).toEqual([]);
    expect(unbound.config.skills[0]!.key).toBe("");
    expect(probeReadiness(unbound.config.skills[0]!)).toEqual({ ready: false, reason: "no key" });
    expect(buildHostProbes({ ...unbound.config, enabled: true })).toEqual([]);
    expect(describeFlaskKey("")).toBe("no key");
    expect(skillIdFromLabel("Powered by Verisium!")).toBe("powered-by-verisium");
    expect(probeConfigFor(config, "skill:unleash")?.label).toBe("Unleash");
    expect(probeConfigFor(config, "skill:nope")).toBeUndefined();
    expect(probeConfigFor(config, "life")?.kind).toBe("globe");
  });

  it("refuses bad keys and clamps numbers, keeping the rest", () => {
    const { config, issues } = normalizeFlaskGuardConfig({
      enabled: true,
      chromaRatio: 5,
      blackoutBelow: 500,
      life: { key: "ctrl", cooldownMs: 10 },
      mana: { key: "Q", cooldownMs: "abc" },
    });
    expect(config.enabled).toBe(true);
    expect(config.chromaRatio).toBe(0.95);
    expect(config.blackoutBelow).toBe(60);
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

  it("treats loading fades and bright overlays as unknown, never as an empty globe", () => {
    const thresholds = probeThresholds(defaultFlaskGuardConfig(), LIFE_RED);
    expect(classifyPatch(LOADING_BLACK, thresholds)).toBe("unknown");
    expect(classifyPatch(LOADING_ART, thresholds)).toBe("unknown");
    expect(classifyPatch(LOW_LIFE_TINT, thresholds)).toBe("low");
    expect(classifyPatch(EMPTY_GLASS, thresholds)).toBe("low");
  });

  it("accepts fluid and rejects glass as a calibration click", () => {
    expect(looksLikeFilledGlobe(LIFE_RED)).toBe(true);
    expect(looksLikeFilledGlobe(MANA_BLUE)).toBe(true);
    expect(looksLikeFilledGlobe(EMPTY_GLASS)).toBe(false);
    expect(looksLikeFilledGlobe(RIM_GREY)).toBe(false);
    expect(looksLikeReadySkill(ICON_READY)).toBe(true);
    expect(looksLikeReadySkill(ICON_COOLING)).toBe(false);
  });

  it("reads a skill icon as ready only while its colour matches the calibrated lit icon", () => {
    const thresholds = skillThresholds(defaultFlaskGuardConfig(), ICON_READY);
    expect(thresholds.match).toBe(40);
    expect(classifyPatch(ICON_READY, thresholds)).toBe("filled");
    expect(classifyPatch({ r: 180, g: 120, b: 60 }, thresholds)).toBe("filled");
    expect(classifyPatch(ICON_COOLING, thresholds)).toBe("low");
    expect(classifyPatch(ICON_NO_MANA, thresholds)).toBe("low");
    expect(classifyPatch(LOADING_BLACK, thresholds)).toBe("unknown");
    // Bright overlays are not "ready" either: they do not match the icon's colour.
    expect(classifyPatch(LOADING_ART, thresholds)).toBe("low");
  });

  it("maps flask keys to virtual-key codes and mouse buttons", () => {
    expect(vkForFlaskKey("1")).toBe(0x31);
    expect(vkForFlaskKey("5")).toBe(0x35);
    expect(vkForFlaskKey("q")).toBe(0x51);
    expect(vkForFlaskKey("F1")).toBeUndefined();
    expect(vkForFlaskKey("")).toBeUndefined();
    expect(vkForFlaskKey("m5")).toBeUndefined();
    expect(flaskKeyInput("M5")).toEqual({ vk: 0, mouse: 5 });
    expect(flaskKeyInput("m4")).toEqual({ vk: 0, mouse: 4 });
    expect(flaskKeyInput("m3")).toEqual({ vk: 0, mouse: 3 });
    expect(flaskKeyInput("m6")).toBeUndefined();
    expect(describeFlaskKey("m5")).toBe("mouse 5");
    expect(describeFlaskKey("1")).toBe("key 1");
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

  it("never fires on unknown and leaves the armed state alone", () => {
    expect(decideFlaskFire({ ...base, state: "unknown", armed: true, sinceFireMs: Infinity, sinceFilledMs: 50 })).toEqual({
      fire: false,
      armed: true,
      stale: false,
    });
    expect(decideFlaskFire({ ...base, state: "unknown", armed: false, sinceFireMs: Infinity, sinceFilledMs: 50 }).armed).toBe(false);
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

  it("auto-cast: edge-triggered — a ready read presses when armed, the press disarms, a cooling read re-arms", () => {
    const skill = { ...base, cooldownMs: 3000, fireOn: "filled" as const };
    // First ready read (fresh skill continuity is armed): press, and disarm.
    expect(decideFlaskFire({ ...skill, state: "filled", armed: true, sinceFireMs: Infinity, sinceFilledMs: 0 })).toEqual({
      fire: true,
      armed: false,
      stale: false,
    });
    // Still lit right after the press (the game has not drawn the cooldown yet, or the press went to chat): no re-press.
    expect(decideFlaskFire({ ...skill, state: "filled", armed: false, sinceFireMs: 40, sinceFilledMs: 0 })).toEqual({
      fire: false,
      armed: false,
      stale: false,
    });
    expect(decideFlaskFire({ ...skill, state: "filled", armed: false, sinceFireMs: 2999, sinceFilledMs: 0 }).fire).toBe(false);
    // ... until the retry gap has passed.
    expect(decideFlaskFire({ ...skill, state: "filled", armed: false, sinceFireMs: 3000, sinceFilledMs: 0 })).toEqual({
      fire: true,
      armed: false,
      stale: false,
    });
    // The icon going dark (cooldown sweep / dimmed unusable state) re-arms without firing.
    expect(decideFlaskFire({ ...skill, state: "low", armed: false, sinceFireMs: 100, sinceFilledMs: 100 })).toEqual({
      fire: false,
      armed: true,
      stale: false,
    });
    // Re-armed: the next ready read presses at once, whatever the gap.
    expect(decideFlaskFire({ ...skill, state: "filled", armed: true, sinceFireMs: 5100, sinceFilledMs: 0 }).fire).toBe(true);
    expect(decideFlaskFire({ ...skill, state: "filled", armed: true, sinceFireMs: 700, sinceFilledMs: 0 }).fire).toBe(true);
    // Unknown never fires and leaves arming alone.
    expect(decideFlaskFire({ ...skill, state: "unknown", armed: false, sinceFireMs: Infinity, sinceFilledMs: 3000 })).toEqual({
      fire: false,
      armed: false,
      stale: false,
    });
    // Stale never slows a skill: a long cooldown is not a lost HUD.
    expect(decideFlaskFire({ ...skill, state: "filled", armed: true, sinceFireMs: 600, sinceFilledMs: 30_000 }).fire).toBe(true);
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
      mouse: 0,
      cooldownMs: 2000,
      armed: true,
      lastFireMsAgo: 1200,
      lastFilledMsAgo: 40,
      minChroma: Math.round(111 * 0.4),
      minBright: Math.round(144 * 0.4),
      blackoutBelow: 12,
      overlayAbove: 150,
    });
    config.mana.enabled = true;
    config.mana.key = "m5";
    const withMouse = buildHostProbes(config);
    expect(withMouse[1]).toMatchObject({ id: "mana", vk: 0, mouse: 5, fireOn: "low", snapshot: true, match: 0 });
    const fresh = defaultFlaskGuardConfig();
    fresh.enabled = true;
    expect(buildHostProbes(fresh)).toEqual([]);
  });

  it("adds a calibrated skill as a fire-on-ready probe on its own key, without snapshots", () => {
    const config = calibrated();
    config.skills[0] = { ...config.skills[0]!, point: { x: 1900, y: 1990 }, reference: ICON_READY, calibratedAt: "2026-09-14T00:00:00.000Z" };
    const probes = buildHostProbes(config, { "skill:verisium": { armed: true, lastFireMsAgo: 300, lastFilledMsAgo: 0 } });
    expect(probes.map((probe) => probe.id)).toEqual(["life", "mana", "skill:verisium"]);
    expect(probes[2]).toMatchObject({
      id: "skill:verisium",
      x: 1900,
      y: 1990,
      size: 11,
      vk: 0x54,
      mouse: 0,
      cooldownMs: 3000,
      fireOn: "filled",
      snapshot: false,
      match: 40,
      ref: ICON_READY,
      minChroma: 0,
      minBright: 0,
      armed: true,
      lastFireMsAgo: 300,
    });
    // A skill without continuity starts ARMED (first ready read presses); a flask starts unarmed.
    const fresh = buildHostProbes(config);
    expect(fresh.find((probe) => probe.id === "skill:verisium")).toMatchObject({ armed: true, lastFireMsAgo: -1 });
    expect(fresh.find((probe) => probe.id === "life")).toMatchObject({ armed: false, lastFireMsAgo: -1 });
    config.skills[0]!.enabled = false;
    expect(buildHostProbes(config).map((probe) => probe.id)).toEqual(["life", "mana"]);
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
      snapshotDir: null,
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
    expect(logs[0]!.message).toContain("life flask→key 1");
    expect(cycles[0]!.snapshotDir).toBeUndefined();
    expect(closed()).toBe(1);
    expect(runner.status().totalFires).toBe(1);
  });

  it("carries skill continuity by probe id and summarises casts per cycle", async () => {
    const config = calibrated();
    config.skills[0] = { ...config.skills[0]!, point: { x: 1900, y: 1990 }, reference: ICON_READY, calibratedAt: "2026-09-14T00:00:00.000Z" };
    const { host, sent } = fakeHost([
      {
        ok: true,
        stoppedBy: "deadline",
        fires: [
          { id: "skill:verisium", t: 20, r: 168, g: 132, b: 74, stale: false, dry: false },
          { id: "skill:verisium", t: 3020, r: 170, g: 130, b: 70, stale: false, dry: false },
        ],
        states: {
          life: { state: "filled", r: 144, g: 33, b: 41, armed: true, fires: 0, lastFireMsAgo: -1, lastFilledMsAgo: 5 },
          mana: { state: "filled", r: 29, g: 102, b: 155, armed: true, fires: 0, lastFireMsAgo: -1, lastFilledMsAgo: 5 },
          "skill:verisium": { state: "low", r: 62, g: 50, b: 30, armed: true, fires: 2, lastFireMsAgo: 1900, lastFilledMsAgo: 1950 },
        },
      },
    ]);
    const logs: Array<{ phase: string; message: string }> = [];
    const runner = new FlaskGuardRunner({
      root: "unused",
      log: (entry) => logs.push(entry),
      cycleMs: 500,
      snapshotDir: null,
      hostFactory: () => host,
      configLoader: () => ({ config, issues: [], mtimeMs: 1 }),
    });
    runner.start();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await runner.stop();

    const cycles = sent.filter((payload) => payload.op === "flaskguard");
    const second = cycles[1]!.probes as Array<Record<string, unknown>>;
    expect(second[2]).toMatchObject({ id: "skill:verisium", armed: true, lastFireMsAgo: 1900, fireOn: "filled" });
    expect(logs[0]!.message).toContain("Powered by Verisium→key t (auto-cast, retry gap 3000ms)");
    const casts = logs.filter((entry) => entry.phase === "fire");
    expect(casts).toHaveLength(1);
    expect(casts[0]!.message).toBe("Powered by Verisium cast 2x this cycle (icon ready, read rgb(170, 130, 70))");
    expect(runner.status().totalFires).toBe(2);
  });

  it("holds auto-cast while a numpad action runs, keeps the flasks, and resumes", async () => {
    const config = calibrated();
    config.skills[0] = { ...config.skills[0]!, point: { x: 1900, y: 1990 }, reference: ICON_READY, calibratedAt: "2026-09-14T00:00:00.000Z" };
    const { host, sent } = fakeHost([]);
    const logs: Array<{ phase: string; message: string }> = [];
    const runner = new FlaskGuardRunner({
      root: "unused",
      log: (entry) => logs.push(entry),
      cycleMs: 500,
      snapshotDir: null,
      hostFactory: () => host,
      configLoader: () => ({ config, issues: [], mtimeMs: 1 }),
    });
    runner.start();
    await new Promise((resolve) => setTimeout(resolve, 25));
    runner.suspendSkills();
    await new Promise((resolve) => setTimeout(resolve, 40));
    runner.resumeSkills();
    await new Promise((resolve) => setTimeout(resolve, 40));
    await runner.stop();

    const cycles = sent.filter((payload) => payload.op === "flaskguard").map((payload) => (payload.probes as Array<{ id: string }>).map((probe) => probe.id));
    expect(cycles[0]).toEqual(["life", "mana", "skill:verisium"]);
    expect(cycles.some((ids) => ids.length === 2 && !ids.includes("skill:verisium"))).toBe(true);
    expect(cycles[cycles.length - 1]).toEqual(["life", "mana", "skill:verisium"]);
    const states = logs.filter((entry) => entry.phase === "state").map((entry) => entry.message);
    expect(states.some((message) => message.includes("auto-cast held while a numpad action runs (Powered by Verisium)"))).toBe(true);
    expect(states[states.length - 1]).not.toContain("held");
    expect(runner.status().skillsSuspended).toBe(false);
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

describe("skill calibration and sampling through the host", () => {
  /** A host that answers by op, recording every request. */
  function opHost(answers: Record<string, Record<string, unknown> | ((payload: Record<string, unknown>) => Record<string, unknown>)>) {
    const sent: Array<Record<string, unknown>> = [];
    const host: WinHostLike = {
      async send(payload) {
        sent.push(payload);
        const answer = answers[String(payload.op)];
        if (!answer) return { ok: false, error: `unexpected op ${String(payload.op)}` };
        return typeof answer === "function" ? answer(payload) : answer;
      },
      async close() {},
    };
    return { host, sent };
  }

  it("calibrateFlaskProbe stores a skill click in that row only, from the config as it is at save time", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "flask-guard-skill-"));
    try {
      saveFlaskGuardConfig(root, calibrated());
      const { host, sent } = opHost({
        rect: { ok: true, left: 0, top: 0, width: 3840, height: 2160 },
        marks: { ok: true },
        waitclick: () => {
          // The panel saved a life-cooldown edit while the click prompt was up.
          const current = loadFlaskGuardConfig(root).config;
          saveFlaskGuardConfig(root, { ...current, life: { ...current.life, cooldownMs: 3000 } });
          return { ok: true, x: 3217.4, y: 2053.6 };
        },
        sample: { ok: true, samples: [{ r: 153, g: 209, b: 231 }], foregroundIsPoe: true },
        hidemark: { ok: true },
      });
      const result = await calibrateFlaskProbe(host, "skill:verisium", { root, timeoutMs: 1_000 });
      expect(result).toMatchObject({ ok: true, target: "skill:verisium", globe: "skill:verisium", point: { x: 3217, y: 2054 }, looksFilled: true });
      const marks = sent.find((payload) => payload.op === "marks") as { rects: Array<{ label: string }> };
      expect(marks.rects[0]!.label).toContain("TOP EDGE of the POWERED BY VERISIUM icon");
      expect((sent.find((payload) => payload.op === "sample") as { points: Array<{ size: number }> }).points[0]!.size).toBe(11);
      expect(sent[sent.length - 1]!.op).toBe("hidemark");
      const saved = loadFlaskGuardConfig(root).config;
      expect(saved.skills[0]).toMatchObject({ id: "verisium", point: { x: 3217, y: 2054 }, reference: { r: 153, g: 209, b: 231 } });
      expect(saved.skills[0]!.calibratedAt).toBeTruthy();
      expect(saved.life.cooldownMs).toBe(3000);
      expect(saved.life.point).toEqual({ x: 240, y: 1920 });

      const dark = await calibrateFlaskProbe(
        opHost({ ...{ rect: { ok: true }, marks: { ok: true }, waitclick: { ok: true, x: 1, y: 2 }, hidemark: { ok: true } }, sample: { ok: true, samples: [{ r: 40, g: 47, b: 50 }] } }).host,
        "skill:verisium",
        { root, timeoutMs: 1_000, save: false },
      );
      expect(dark).toMatchObject({ ok: true, looksFilled: false });
      expect(loadFlaskGuardConfig(root).config.skills[0]!.point).toEqual({ x: 3217, y: 2054 });

      const unknown = await calibrateFlaskProbe(opHost({}).host, "skill:nope", { root });
      expect(unknown.ok).toBe(false);
      expect(unknown.error).toContain("unknown probe");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sampleFlaskProbes reads globes and calibrated skills in one request, classifying each by its own rule", async () => {
    const config = calibrated();
    config.skills[0] = { ...config.skills[0]!, point: { x: 3217, y: 2054 }, reference: { r: 153, g: 209, b: 231 }, calibratedAt: "2026-09-14T00:00:00.000Z" };
    config.skills.push({ ...config.skills[0]!, id: "unleash", label: "Unleash", key: "r", point: null, reference: null, calibratedAt: null });
    const { host, sent } = opHost({
      sample: { ok: true, foregroundIsPoe: true, samples: [{ r: 144, g: 33, b: 41 }, { r: 32, g: 32, b: 37 }, { r: 88, g: 107, b: 115 }] },
    });
    const result = await sampleFlaskProbes(host, config);
    expect(result.ok).toBe(true);
    expect((sent[0] as { points: Array<{ x: number; size: number }> }).points.map((point) => [point.x, point.size])).toEqual([[240, 15], [3600, 15], [3217, 11]]);
    expect(result.probes.map((probe) => [probe.id, probe.label, probe.state])).toEqual([
      ["life", "life flask", "filled"],
      ["mana", "mana flask", "low"],
      ["skill:verisium", "Powered by Verisium", "low"],
    ]);
    expect(result.probes[2]!.thresholds).toMatchObject({ match: 40, ref: { r: 153, g: 209, b: 231 }, minChroma: 0 });
    expect(result.probes[0]!.thresholds.match).toBe(0);
  });
});
