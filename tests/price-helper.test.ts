import { describe, expect, it } from "vitest";
import { helperDefaults, parseHelperStack, parseNinjaExchange, parseRumourCsv, priceHelperRow, rumourHelperRow, validateHelperConfig, validRegion, type CategorySnapshot } from "../src/core/priceHelper.js";

const snapshot = (name = "Divine Orb", exalted = 300, divine = 1): CategorySnapshot => ({ category: "Currency", fetchedAt: "2026-09-13T01:00:00Z", prices: [{ id: "item", name, exalted, divine }] });
const now = Date.parse("2026-09-13T01:10:00Z");
describe("read-only helper prices", () => {
  it("converts the API's actual primary denomination in softcore and hardcore", () => {
    const base = { items: [{ id: "rune", name: "A Rune" }], lines: [{ id: "rune", primaryValue: 2 }] };
    expect(parseNinjaExchange({ ...base, core: { primary: "divine", rates: { exalted: 300 } } })[0]).toMatchObject({ divine: 2, exalted: 600 });
    expect(parseNinjaExchange({ ...base, core: { primary: "exalted", rates: { divine: 0.01 } } })[0]).toMatchObject({ divine: 0.02, exalted: 2 });
    expect(() => parseNinjaExchange({ ...base, core: { primary: "unknown" } })).toThrow();
    expect(parseNinjaExchange({ ...base, core: { primary: "divine", rates: {} } })[0]?.exalted).toBeUndefined();
  });
  it.each(["2x Divine Orb", "2 × Divine Orb", "Divine Orb x2", "Divine Orb (2)"])("shows stack and unit prices for %s", text => {
    expect(priceHelperRow(text, [snapshot()], now)).toMatchObject({ total: 2, unit: 1, quantity: 2, currency: "div", stale: false });
  });
  it.each([
    [0.999, undefined], [1, "high"], [9.999, "high"], [10, "very-high"],
  ] as const)("classifies %s divine without rounding across a value threshold", (divine, valueTier) => {
    expect(priceHelperRow("Valuable Rune", [snapshot("Valuable Rune", divine * 300, divine)], now).valueTier).toBe(valueTier);
  });
  it("uses known stack totals when rewards cross a value threshold", () => {
    const prices = [snapshot("Valuable Rune", 180, 0.6)];
    expect(priceHelperRow("1x Valuable Rune", prices, now).valueTier).toBeUndefined();
    expect(priceHelperRow("2x Valuable Rune", prices, now)).toMatchObject({ total: 1.2, valueTier: "high" });
    expect(priceHelperRow("20x Valuable Rune", prices, now)).toMatchObject({ total: 12, valueTier: "very-high" });
  });
  it("uses the same divine thresholds when the Hardcore feed is denominated in exalteds", () => {
    const items = [{ id: "saga", name: "Olroth's Saga" }];
    const prices = parseNinjaExchange({ core: { primary: "exalted", rates: { divine: 0.01 } }, items, lines: [{ id: "saga", primaryValue: 100 }] });
    const hc: CategorySnapshot = { category: "Verisium", fetchedAt: snapshot().fetchedAt, prices };
    expect(priceHelperRow("1x Olroth's Saga", [hc], now)).toMatchObject({ total: 1, currency: "div", valueTier: "high" });
    expect(priceHelperRow("10x Olroth's Saga", [hc], now)).toMatchObject({ total: 10, valueTier: "very-high" });
    const cheap = parseNinjaExchange({ core: { primary: "exalted", rates: { divine: 0.001 } }, items, lines: [{ id: "saga", primaryValue: 100 }] });
    expect(priceHelperRow("1x Olroth's Saga", [{ ...hc, prices: cheap }], now).valueTier).toBeUndefined();
  });
  it.each([
    [0.6, undefined], [1, "high"], [10, "very-high"],
  ] as const)("emphasizes only the %s divine unit estimate when quantity is unreadable", (divine, valueTier) => {
    for (const prefix of ["lx", "Ix"]) {
      const row = priceHelperRow(`${prefix} Valuable Rune`, [snapshot("Valuable Rune", divine * 300, divine)], now);
      expect(row.valueTier).toBe(valueTier);
      expect(row.detail).toContain("each · quantity unreadable");
      expect(row.quantity).toBeUndefined(); expect(row.total).toBeUndefined();
    }
  });
  it("does not emphasize stale, ambiguous, absent, or unconverted market data", () => {
    const valuable = snapshot("Valuable Rune", 3000, 10);
    const noConversion: CategorySnapshot = { ...valuable, prices: [{ id: "rune", name: "Valuable Rune", exalted: 3000 }] };
    const noData: CategorySnapshot = { ...valuable, prices: [{ id: "rune", name: "Valuable Rune" }] };
    expect(priceHelperRow("Valuable Rune", [valuable], now + 30 * 60_000).valueTier).toBeUndefined();
    expect(priceHelperRow("Valuable Rune", [{ ...valuable, error: "HTTP 429" }], now).valueTier).toBeUndefined();
    expect(priceHelperRow("Valuable Rune", [valuable, valuable], now).valueTier).toBeUndefined();
    expect(priceHelperRow("Unmatched Rune", [valuable], now).valueTier).toBeUndefined();
    expect(priceHelperRow("Valuable Rune", [noData], now)).toMatchObject({ state: "no-data" });
    expect(priceHelperRow("Valuable Rune", [noData], now).valueTier).toBeUndefined();
    expect(priceHelperRow("Valuable Rune", [noConversion], now)).toMatchObject({ state: "priced", currency: "ex", total: 3000 });
    expect(priceHelperRow("Valuable Rune", [noConversion], now).valueTier).toBeUndefined();
  });
  it("keeps tiny per-item values precise until the stack is calculated", () => {
    expect(priceHelperRow("100x Tiny Rune", [snapshot("Tiny Rune", 0.0023, 0.000001)], now)).toMatchObject({ total: 0.22999999999999998, unit: 0.0023, currency: "ex" });
  });
  it.each(["Uncut Skill Gem", "Uncut Skill Gem (Level 18)", "Uncut Spirit Gem (Level 19)", "Uncut Skill Gem (Level l9)"])("does not guess gem type or level: %s", text => {
    expect(priceHelperRow(text, [snapshot("Uncut Skill Gem (Level 19)")], now).state).toBe("unknown");
  });
  it("matches an exact gem level with a stack marker", () => {
    expect(priceHelperRow("2x Uncut Skill Gem (Level 19)", [snapshot("Uncut Skill Gem (Level 19)")], now).total).toBe(2);
  });
  it.each(["lx Divine Orb", "Ix Divine Orb"])("shows only a unit estimate when Windows OCR cannot read the quantity: %s", text => {
    const row = priceHelperRow(text, [snapshot()], now);
    expect(row).toMatchObject({ state: "priced", name: "Divine Orb", unit: 1, detail: "1 div each · quantity unreadable" });
    expect(row.quantity).toBeUndefined();
    expect(row.total).toBeUndefined();
    expect(priceHelperRow("lx Uncut Skill Gem (Level l9)", [snapshot("Uncut Skill Gem (Level 19)")], now).state).toBe("unknown");
    expect(priceHelperRow("lx Divine Orb (2)", [snapshot()], now).state).toBe("unknown");
  });
  it.each(["0x Divine Orb", "2x Divine Orb (3)", "Divine Orb xO", "999999x Divine Orb"])("refuses ambiguous quantities: %s", text => {
    expect(priceHelperRow(text, [snapshot()], now).state).toBe("unknown");
  });
  it("distinguishes absent market data from zero, and labels retained stale prices", () => {
    const s = snapshot(); s.prices[0] = { id: "divine", name: "Divine Orb" };
    expect(priceHelperRow("Divine Orb", [s], now).state).toBe("no-data");
    expect(priceHelperRow("Divine Orb", [snapshot()], now + 3600_000).stale).toBe(true);
    expect(priceHelperRow("Divine Orb", [{ ...snapshot(), error: "HTTP 429" }], now).stale).toBe(true);
    expect(priceHelperRow("Divine Orb", [snapshot(), snapshot()], now).state).toBe("unknown");
    expect(parseHelperStack("Uncut Skill Gem (Level 19)")?.quantity).toBe(1);
  });
  it("rejects negative and nonnumeric market values", () => {
    const p = parseNinjaExchange({ core: { primary: "exalted" }, items: [{ id: "a", name: "A" }, { id: "b", name: "B" }], lines: [{ id: "a", primaryValue: -5 }, { id: "b", primaryValue: "200" }] });
    expect(p.every(v => v.exalted === undefined)).toBe(true);
  });
});
describe("helper settings and rumour text", () => {
  it("validates league names and bounded game-relative regions", () => {
    expect(validateHelperConfig({ ...helperDefaults(), league: "HC Forbidden Rites" }).league).toBe("HC Forbidden Rites");
    expect(() => validateHelperConfig({ ...helperDefaults(), league: "../../file?token=secret" })).toThrow();
    expect(() => validateHelperConfig({ ...helperDefaults(), autoRefresh: "true" })).toThrow();
    expect(validRegion({ x: 100, y: 20, width: 400, height: 600, clientWidth: 1920, clientHeight: 1080 })).toBe(true);
    expect(validRegion({ x: -1, y: 20, width: 400, height: 600, clientWidth: 1920, clientHeight: 1080 })).toBe(false);
    expect(validRegion({ x: 1500, y: 20, width: 600, height: 600, clientWidth: 1920, clientHeight: 1080 })).toBe(false);
  });
  it("parses quoted CSV and only accepts unique explicit truncations", () => {
    const rumours = parseRumourCsv('Rumor,Map Type,Mods,Rating\r\n"Fallen Stars",Moor,"Runestones, more",S+\r\nUnknown ruins one,Moor,Oil,A\r\nUnknown ruins two,Moor,Oil,B');
    expect(rumours[0]?.mods).toBe("Runestones, more");
    expect(rumourHelperRow("Fallen Stars", rumours, "2026-09-13T01:00:00Z", now).state).toBe("rumour");
    expect(rumourHelperRow("Unknown ruins…", rumours).state).toBe("unknown");
    expect(rumourHelperRow("Unknown ruins one…", rumours).state).toBe("rumour");
    expect(() => parseRumourCsv("<html>Login required</html>")).toThrow();
  });
});
