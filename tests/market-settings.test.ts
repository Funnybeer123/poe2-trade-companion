import { describe, expect, it } from "vitest";
import { DEFAULT_MARKET_SETTINGS, normalizeMarketSettings } from "../src/core/marketSettings.js";

describe("normalizeMarketSettings", () => {
  it("answers the defaults for nothing at all", () => {
    const { value, issues } = normalizeMarketSettings(undefined);
    expect(value).toEqual(DEFAULT_MARKET_SETTINGS);
    expect(issues).toEqual([]);
  });

  it("keeps live search and resume off by default", () => {
    expect(DEFAULT_MARKET_SETTINGS.resumeLiveSearches).toBe(false);
    expect(DEFAULT_MARKET_SETTINGS.liveNotify).toBe(false);
    expect(DEFAULT_MARKET_SETTINGS.minSpareFetches).toBe(2);
    expect(DEFAULT_MARKET_SETTINGS.stopLiveAfterHours).toBe(6);
  });

  it("clamps the numbers and says so", () => {
    const { value, issues } = normalizeMarketSettings({
      staleAfterHours: 10_000,
      minSpareFetches: -4,
      stopLiveAfterHours: 999,
    });
    expect(value.staleAfterHours).toBe(720);
    expect(value.minSpareFetches).toBe(0);
    expect(value.stopLiveAfterHours).toBe(48);
    expect(issues).toHaveLength(3);
  });

  it("falls back on an unknown enum", () => {
    const { value, issues } = normalizeMarketSettings({ defaultStatus: "somewhere", defaultSaleType: 7 });
    expect(value.defaultStatus).toBe("online");
    expect(value.defaultSaleType).toBe("priced");
    expect(issues).toHaveLength(2);
  });

  it("accepts only a trade2 currency id", () => {
    expect(normalizeMarketSettings({ defaultCurrency: "Divine Orb" }).issues).toHaveLength(1);
    expect(normalizeMarketSettings({ defaultCurrency: "divine" }).value.defaultCurrency).toBe("divine");
    expect(normalizeMarketSettings({ defaultCurrency: "" }).value.defaultCurrency).toBe("");
  });

  it("refuses a non-boolean toggle", () => {
    const { value, issues } = normalizeMarketSettings({ liveSound: "yes", collapseAfterOffer: 0 });
    expect(value.liveSound).toBe(true);
    expect(value.collapseAfterOffer).toBe(true);
    expect(issues).toHaveLength(2);
  });

  it("survives a non-object", () => {
    expect(normalizeMarketSettings("nope").value).toEqual(DEFAULT_MARKET_SETTINGS);
    expect(normalizeMarketSettings([1, 2]).value).toEqual(DEFAULT_MARKET_SETTINGS);
  });
});
