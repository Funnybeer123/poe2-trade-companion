import { describe, expect, it } from "vitest";
import { defaultCombatConfig, parseCombatConfig, readCombatFrame, requireCombatCalibration, type CombatReading } from "../src/core/combatAssist.js";
import { SigilSequence } from "../src/core/sigilSequence.js";

const ready: CombatReading = { valid: true, reason: "fixture", unleash: "ready", verisium: "ready" };
function setup() {
  const c = defaultCombatConfig();
  c.sigilSequence.enabled = c.unleash.enabled = c.verisium.enabled = true;
  const p = new SigilSequence();
  const keys = (now = 0, r = ready, down = false) => p.decisions(c, r, now, down).map((a) => a.decision.intended[0].key);
  return { c, p, keys };
}

describe("manual Sigil macro", () => {
  it("migrates old settings and rejects invalid or conflicting configuration", () => {
    const { c } = setup();
    expect(parseCombatConfig({ ...c, sigilSequence: undefined }).sigilSequence.enabled).toBe(false);
    for (const castMs of [-1, NaN, Infinity, 5001]) expect(() => parseCombatConfig({ ...c, sigilSequence: { ...c.sigilSequence, castMs } })).toThrow();
    expect(() => parseCombatConfig({ ...c, sigilSequence: { ...c.sigilSequence, swapKey: "R" } })).toThrow(/different key/);
    expect(() => parseCombatConfig({ ...c, unleash: { ...c.unleash, key: "MOUSE5" } })).toThrow(/letter or digit/);
    c.verisium.enabled = false;
    expect(() => parseCombatConfig(c)).toThrow(/both skill/);
  });

  it("never starts from ready icons or elapsed time", () => {
    const { p, keys } = setup();
    for (const now of [0, 600, 1000, 60000]) expect(keys(now)).toEqual([]);
    expect(keys(60016, { ...ready, unleash: "cooldown" })).toEqual([]);
    expect(keys(70000)).toEqual([]);
    expect(p.active).toBe(false);
  });

  it("follows a physical press with exactly X then T, independent of icon state", () => {
    const { p, keys } = setup();
    const unknown = { ...ready, unleash: "unknown" as const, verisium: "unknown" as const };
    expect(p.trigger(100)).toBe(true);
    expect(keys(100, unknown)).toEqual([]); // physical R already reached the game
    expect(keys(699, unknown)).toEqual([]);
    expect(keys(700, unknown)).toEqual(["X"]);
    expect(keys(710, unknown)).toEqual(["X"]); // no progress until acknowledged
    p.committed("weaponSwap", 710);
    expect(keys(809, unknown)).toEqual([]);
    expect(keys(810, unknown)).toEqual(["T"]);
    p.committed("verisium", 810);
    expect(p.active).toBe(false);
    for (const now of [826, 20000, 60000]) expect(keys(now)).toEqual([]);
    expect(p.trigger(70000)).toBe(true);
    expect(keys(70600)).toEqual(["X"]);
  });

  it("ignores busy presses without resetting the delay or queuing another cycle", () => {
    const { p, keys } = setup();
    p.trigger(0);
    expect(p.trigger(599)).toBe(false);
    expect(keys(600)).toEqual(["X"]);
    p.committed("weaponSwap", 600);
    expect(p.trigger(699)).toBe(false);
    expect(keys(700)).toEqual(["T"]);
    p.committed("verisium", 700);
    expect(keys(5000)).toEqual([]);
  });

  it("waits for trigger release before swapping and never regenerates R", () => {
    const { p, keys } = setup();
    p.trigger(0);
    expect(keys(600, ready, true)).toEqual([]);
    expect(keys(2000, ready, true)).toEqual([]);
    expect(keys(2016)).toEqual(["X"]);
    p.committed("weaponSwap", 2016);
    expect(keys(2116)).toEqual(["T"]);
  });

  it("cancels on invalid context and bounds delayed follow-up actions", () => {
    const { p, keys } = setup();
    expect(keys(0, { ...ready, valid: false })).toEqual([]);
    p.trigger(0);
    expect(() => keys(16, { ...ready, valid: false })).toThrow(/interrupted/);
    expect(() => keys(5701)).toThrow(/timed out/);
  });

  it("previews only after a physical trigger, then waits for a new one", () => {
    const { c, p, keys } = setup();
    c.dryRun = true;
    c.sigilSequence.castMs = c.sigilSequence.swapMs = 0;
    expect(keys()).toEqual([]);
    p.trigger(0);
    expect(keys()).toEqual(["X"]); p.committed("weaponSwap", 0);
    expect(keys(16)).toEqual(["T"]); p.committed("verisium", 16);
    expect(keys(10000)).toEqual([]);
  });

  it("needs no HUD calibration for the manual macro but keeps foreground and freshness checks", () => {
    const { c } = setup();
    expect(() => requireCombatCalibration(c)).not.toThrow();
    const frame = { capturedAt: 0, hwnd: "123", process: "PathOfExileSteam", width: 2560, height: 1440, samples: {} };
    expect(readCombatFrame(c, frame, 16)).toMatchObject({ valid: true, reason: "Armed — press R for one cycle" });
    expect(readCombatFrame(c, { ...frame, process: "Notepad" }, 16).valid).toBe(false);
    expect(readCombatFrame(c, frame, 121).valid).toBe(false);
    c.mana.enabled = true;
    expect(() => requireCombatCalibration(c)).toThrow(/ornament/);
    c.regions.anchor = { x: 0, y: 0, width: 3, height: 3, reference: Array(768).fill(80) };
    expect(() => requireCombatCalibration(c)).toThrow(/mana/);
    c.regions.mana = { x: 0, y: 0, width: 3, height: 3, reference: Array(1500).fill(80) };
    expect(() => requireCombatCalibration(c)).not.toThrow();
  });
});
