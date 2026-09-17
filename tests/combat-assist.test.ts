import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { calibratedCombat, color, combatFrame, fill } from "./combatFixtures.js";
import { CombatPlanner, defaultCombatConfig, estimateGlobe, parseCombatConfig, readCombatFrame, requireCombatCalibration, type CombatConfig } from "../src/core/combatAssist.js";

describe("combat HUD perception and configuration", () => {
  it("defaults to 25%, bindings 1/Mouse5/R, 16 ms, and opt-in modules", () => {
    const config = defaultCombatConfig();
    expect(config.health).toMatchObject({ threshold: 25, key: "1", enabled: false });
    expect(config.mana).toMatchObject({ threshold: 25, key: "MOUSE5", enabled: false });
    expect(config.unleash).toMatchObject({ key: "R", enabled: false });
    expect(config.verisium).toMatchObject({ key: "T", enabled: false, retryMs: 350 });
    expect(config.pollMs).toBe(16);
  });
  it("loads a settings file written before Powered by Verisium existed, keeping that skill off", () => {
    const legacy = calibratedCombat() as Partial<CombatConfig>;
    delete legacy.verisium;
    delete legacy.regions!.verisium;
    const parsed = parseCombatConfig(legacy);
    expect(parsed.verisium).toEqual({ enabled: false, key: "T", retryMs: 350 });
    expect(parsed.regions.verisium).toBeUndefined();
    expect(() => requireCombatCalibration(parsed)).not.toThrow();
    // A saved skill block that is present must still be valid.
    expect(() => parseCombatConfig({ ...calibratedCombat(), verisium: { enabled: "yes" } })).toThrow(/verisium toggle/);
  });
  it("keeps the two skills on different keys and needs both calibrations for an enabled skill", () => {
    const c = calibratedCombat();
    c.verisium.enabled = true;
    expect(parseCombatConfig(c).verisium.key).toBe("T");
    c.verisium.key = "R";
    expect(() => parseCombatConfig(c)).toThrow(/different keys/);
    c.verisium.key = "T";
    c.unleash.enabled = false;
    expect(() => parseCombatConfig(c)).not.toThrow();
    expect(() => requireCombatCalibration(c)).not.toThrow();
    delete c.regions.verisium!.cooldown;
    expect(() => requireCombatCalibration(c)).toThrow(/Powered by Verisium both ready and on cooldown/);
    delete c.regions.verisium;
    expect(() => requireCombatCalibration(c)).toThrow(/Calibrate Powered by Verisium first/);
    c.verisium.enabled = false;
    c.health.enabled = c.mana.enabled = false;
    expect(() => requireCombatCalibration(c)).toThrow(/Enable a flask or a skill/);
  });
  it("accepts Mouse Button 5, preserves old keyboard settings and rejects duplicate mouse bindings", () => {
    const c = calibratedCombat();
    c.mana.key = "Mouse Button 5";
    expect(parseCombatConfig(c).mana.key).toBe("MOUSE5");
    c.mana.key = "2";
    expect(parseCombatConfig(c).mana.key).toBe("2");
    c.mana.key = "mouse5"; c.health.key = "MOUSE5";
    expect(() => parseCombatConfig(c)).toThrow(/different keys/);
    c.health.key = "1"; c.mana.key = "MOUSE6";
    expect(() => parseCombatConfig(c)).toThrow(/Choose/);
  });
  it("reads a full life globe through the highlight and buff-tint bands drawn over it (live sample)", () => {
    const sample = JSON.parse(readFileSync(path.resolve("fixtures/combat/health-globe-effect-bands.json"), "utf8")) as { actual: number[]; reference: number[] };
    expect(estimateGlobe(sample.actual, sample.reference)).toBe(100);
    // The same bands over a half-full globe still read the true surface.
    const half = sample.actual.map((v, i) => i < 50 * 15 ? 5 : v);
    expect(estimateGlobe(half, sample.reference)).toBe(50);
    // A band that reaches the top is a surface, not an overlay.
    const top = sample.actual.map((v, i) => i < 14 * 15 ? 5 : v);
    expect(estimateGlobe(top, sample.reference)).toBe(86);
  });
  it("reads globe surfaces at threshold boundaries, including empty mana", () => {
    const full = calibratedCombat().regions.mana!.reference;
    for (const percent of [0, 1, 24, 25, 26, 50, 100]) expect(estimateGlobe(fill(full, percent), full)).toBe(percent);
    expect(estimateGlobe(color(0, 255, 0, 500), full)).toBeUndefined();
    const noisy = full.map((v, i) => Math.floor(i / 15) % 2 ? v : 0);
    expect(estimateGlobe(noisy, full)).toBeUndefined();
  });
  it("rejects stale, changed-size, wrong-process and covered-HUD frames", () => {
    const c = calibratedCombat(), f = combatFrame(c);
    expect(readCombatFrame(c, f, 121).valid).toBe(false);
    expect(readCombatFrame(c, { ...f, capturedAt: 1 }, 0).valid).toBe(false);
    expect(readCombatFrame(c, { ...f, width: 1920 }, 0).valid).toBe(false);
    expect(readCombatFrame(c, { ...f, process: "NotPathOfExileSteam" }, 0).valid).toBe(false);
    f.samples.anchor = color(0, 0, 0);
    expect(readCombatFrame(c, f, 0).valid).toBe(false);
  });
  it("reads each skill icon on its own", () => {
    const c = calibratedCombat(), f = combatFrame(c);
    expect(readCombatFrame(c, f, 0)).toMatchObject({ unleash: "ready", verisium: "ready" });
    f.samples.verisium = c.regions.verisium!.cooldown;
    expect(readCombatFrame(c, f, 0)).toMatchObject({ unleash: "ready", verisium: "cooldown" });
    f.samples.unleash = color(150, 200, 30);
    expect(readCombatFrame(c, f, 0)).toMatchObject({ unleash: "unknown", verisium: "cooldown" });
    delete c.regions.verisium;
    expect(readCombatFrame(c, f, 0).verisium).toBeUndefined();
  });
  it("recognizes ready/cooldown and refuses ambiguous skill appearances", () => {
    const c = calibratedCombat(), f = combatFrame(c);
    expect(readCombatFrame(c, f, 0).unleash).toBe("ready");
    f.samples.unleash = c.regions.unleash!.cooldown;
    expect(readCombatFrame(c, f, 0).unleash).toBe("cooldown");
    f.samples.unleash = color(150, 200, 30);
    expect(readCombatFrame(c, f, 0).unleash).toBe("unknown");
    f.samples.health = fill(c.regions.health!.reference, 0);
    expect(readCombatFrame(c, f, 0).valid).toBe(false);
  });
  it("validates persisted/IPC configuration and rejects unusable calibration", () => {
    expect(parseCombatConfig(calibratedCombat()).unleash.key).toBe("R");
    expect(() => requireCombatCalibration(calibratedCombat())).not.toThrow();
    for (const bad of [NaN, Infinity, -1, 0, 15]) expect(() => parseCombatConfig({ ...calibratedCombat(), pollMs: bad })).toThrow();
    const c = calibratedCombat();
    c.health.key = "Enter";
    expect(() => parseCombatConfig(c)).toThrow();
    c.health.key = "R";
    expect(() => parseCombatConfig(c)).toThrow(/different keys/);
    c.health.key = "1";
    c.regions.health!.reference = color(0, 0, 0, 500);
    expect(() => parseCombatConfig(c)).toThrow(/fully filled/);
    c.regions.health!.reference = color(160, 15, 20, 500);
    c.regions.unleash!.cooldown = c.regions.unleash!.reference;
    expect(() => parseCombatConfig(c)).toThrow(/too similar/);
    delete c.regions.unleash!.cooldown;
    expect(() => requireCombatCalibration(c)).toThrow(/cooldown/);
    delete c.regions.anchor;
    expect(() => requireCombatCalibration(c)).toThrow(/ornament/);
  });
});

describe("combat replay decisions", () => {
  it("prioritizes health, then mana, then R; 25% exactly does not trigger", () => {
    const p = new CombatPlanner(), c = calibratedCombat();
    const reading = { valid: true, reason: "fixture", health: 25, mana: 25, unleash: "unknown" as const };
    expect(p.decisions(c, reading, 0)).toEqual([]);
    const decisions = p.decisions(c, { ...reading, health: 24, mana: 0, unleash: "ready" }, 0);
    expect(decisions.map((d) => d.decision.intended[0].key)).toEqual(["1", "MOUSE5", "R"]);
  });
  it("casts both skills in one frame, in priority order, and tracks their cooldowns independently", () => {
    const p = new CombatPlanner(), c = calibratedCombat();
    c.verisium.enabled = true;
    const both = { valid: true, reason: "fixture", health: 24, mana: 100, unleash: "ready" as const, verisium: "ready" as const };
    expect(p.decisions(c, both, 0).map((d) => d.decision.intended[0].key)).toEqual(["1", "R", "T"]);
    p.committed("unleash", 0);
    p.committed("verisium", 0);
    // Verisium confirms its cooldown and relights while Unleash is still lit without confirmation:
    // Verisium casts at once, Unleash waits for its 750 ms unconfirmed-retry window.
    const verisiumCooling = { ...both, health: 100, verisium: "cooldown" as const };
    expect(p.decisions(c, verisiumCooling, 16)).toEqual([]);
    expect(p.decisions(c, verisiumCooling, 32)).toEqual([]);
    const relit = p.decisions(c, { ...both, health: 100 }, 400);
    expect(relit.map((d) => d.name)).toEqual(["verisium"]);
    expect(relit[0].decision.reason).toBe("Powered by Verisium icon ready");
    p.committed("verisium", 400);
    expect(p.decisions(c, { ...both, health: 100 }, 750).map((d) => d.name)).toEqual(["unleash"]);
    p.committed("unleash", 750);
    c.verisium.enabled = false;
    expect(p.decisions(c, { ...both, health: 100, verisium: "ready" }, 5000).map((d) => d.name)).toEqual([]);
  });
  it("limits flask retries while low, even across threshold flicker", () => {
    const p = new CombatPlanner(), c = calibratedCombat();
    const low = { valid: true, reason: "fixture", health: 24, mana: 100 };
    p.committed("health", 0);
    expect(p.decisions(c, low, 1499)).toEqual([]);
    p.decisions(c, { ...low, health: 26 }, 500);
    expect(p.decisions(c, low, 800)).toEqual([]);
    expect(p.decisions(c, low, 1500).map((d) => d.name)).toEqual(["health"]);
    c.health.enabled = false;
    expect(p.decisions(c, low, 3000)).toEqual([]);
  });
  it("casts promptly after a confirmed cooldown without waiting for the retry interval", () => {
    const p = new CombatPlanner(), c = calibratedCombat();
    const ready = { valid: true, reason: "fixture", health: 100, mana: 100, unleash: "ready" as const };
    expect(p.decisions(c, ready, 0).map((d) => d.name)).toEqual(["unleash"]);
    p.committed("unleash", 0);
    expect(p.decisions(c, { ...ready, unleash: "cooldown" }, 200)).toEqual([]);
    expect(p.decisions(c, { ...ready, unleash: "cooldown" }, 216)).toEqual([]);
    expect(p.decisions(c, ready, 349)).toEqual([]);
    expect(p.decisions(c, ready, 350).map((d) => d.name)).toEqual(["unleash"]);
  });
  it("retries an acknowledged but unconfirmed cast only after 750 ms and two fresh ready frames", () => {
    const p = new CombatPlanner(), c = calibratedCombat();
    const ready = { valid: true, reason: "fixture", health: 100, mana: 100, unleash: "ready" as const };
    p.committed("unleash", 0);
    expect(p.decisions(c, ready, 16)).toEqual([]);
    expect(p.decisions(c, ready, 749)).toEqual([]);
    const retry = p.decisions(c, ready, 750);
    expect(retry.map((d) => d.name)).toEqual(["unleash"]);
    expect(retry[0].decision.reason).toContain("retrying unconfirmed cast");
    p.committed("unleash", 750);
    expect(p.decisions(c, ready, 1500)).toEqual([]);
    expect(p.decisions(c, ready, 1516).map((d) => d.name)).toEqual(["unleash"]);
  });
  it("recovers from persistent rejected casts without sending R on every frame", () => {
    const p = new CombatPlanner(), c = calibratedCombat();
    const ready = { valid: true, reason: "fixture", health: 100, mana: 100, unleash: "ready" as const };
    const attempts: number[] = [];
    for (let now = 0; now <= 5000; now += 16) {
      const actions = p.decisions(c, ready, now);
      if (actions.some((d) => d.name === "unleash")) { attempts.push(now); p.committed("unleash", now); }
    }
    expect(attempts[0]).toBe(0);
    expect(attempts.length).toBeGreaterThan(1);
    for (let i = 1; i < attempts.length; i++) {
      expect(attempts[i] - attempts[i - 1]).toBeGreaterThanOrEqual(750);
      expect(attempts[i] - attempts[i - 1]).toBeLessThan(766);
    }
  });
  it("honours a longer configured minimum gap and the Unleash toggle on retries", () => {
    const p = new CombatPlanner(), c = calibratedCombat(); c.unleash.retryMs = 1200;
    const ready = { valid: true, reason: "fixture", health: 100, mana: 100, unleash: "ready" as const };
    p.committed("unleash", 0);
    expect(p.decisions(c, ready, 750)).toEqual([]);
    expect(p.decisions(c, ready, 1199)).toEqual([]);
    c.unleash.enabled = false;
    expect(p.decisions(c, ready, 1200)).toEqual([]);
    c.unleash.enabled = true;
    expect(p.decisions(c, ready, 1216).map((d) => d.name)).toEqual(["unleash"]);
  });
  it.each(["unknown", "dead", "focus", "stale", "covered"] as const)("does not retry on %s evidence or a single ready frame afterward", (kind) => {
    const p = new CombatPlanner(), c = calibratedCombat(), f = combatFrame(c);
    const ready = readCombatFrame(c, f, 0);
    p.committed("unleash", 0);
    expect(p.decisions(c, ready, 800)).toEqual([]);
    if (kind === "unknown") f.samples.unleash = color(150, 200, 30);
    if (kind === "dead") f.samples.health = fill(c.regions.health!.reference, 0);
    if (kind === "focus") f.process = "NotPathOfExile";
    if (kind === "covered") f.samples.anchor = color(0, 0, 0);
    const interrupted = readCombatFrame(c, f, kind === "stale" ? 121 : 0);
    expect(p.decisions(c, interrupted, 816)).toEqual([]);
    expect(p.decisions(c, ready, 932)).toEqual([]);
    expect(p.decisions(c, ready, 948).map((d) => d.name)).toEqual(["unleash"]);
  });
});
