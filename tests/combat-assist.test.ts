import { describe, expect, it } from "vitest";
import { calibratedCombat, color, combatFrame, fill } from "./combatFixtures.js";
import { CombatPlanner, defaultCombatConfig, estimateGlobe, parseCombatConfig, readCombatFrame, requireCombatCalibration } from "../src/core/combatAssist.js";

describe("combat HUD perception and configuration", () => {
  it("defaults to 25%, keys 1/2/R, 16 ms, and opt-in modules", () => {
    const config = defaultCombatConfig();
    expect(config.health).toMatchObject({ threshold: 25, key: "1", enabled: false });
    expect(config.mana).toMatchObject({ threshold: 25, key: "2", enabled: false });
    expect(config.unleash).toMatchObject({ key: "R", enabled: false });
    expect(config.pollMs).toBe(16);
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
    expect(decisions.map((d) => d.decision.intended[0].key)).toEqual(["1", "2", "R"]);
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
  it("casts once per observed cooldown, never from icon occlusion", () => {
    const p = new CombatPlanner(), c = calibratedCombat();
    const ready = { valid: true, reason: "fixture", health: 100, mana: 100, unleash: "ready" as const };
    expect(p.decisions(c, ready, 0).map((d) => d.name)).toEqual(["unleash"]);
    p.committed("unleash", 0);
    expect(p.decisions(c, ready, 1000)).toEqual([]);
    p.decisions(c, { ...ready, unleash: "unknown" }, 1100);
    expect(p.decisions(c, ready, 1200)).toEqual([]);
    p.decisions(c, { ...ready, unleash: "cooldown" }, 1300);
    expect(p.decisions(c, ready, 1400)).toEqual([]);
    p.decisions(c, { ...ready, unleash: "cooldown" }, 1500);
    p.decisions(c, { ...ready, unleash: "cooldown" }, 1516);
    expect(p.decisions(c, ready, 2000).map((d) => d.name)).toEqual(["unleash"]);
  });
});
