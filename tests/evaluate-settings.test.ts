import { describe, expect, it } from "vitest";
import {
  autoSearchKeyFor,
  DEFAULT_EVALUATE_SETTINGS,
  normalizeEvaluateSettings,
} from "../src/shared/evaluate.js";

describe("normalizeEvaluateSettings", () => {
  it("answers with the defaults for nothing at all", () => {
    expect(normalizeEvaluateSettings(undefined).value).toEqual(DEFAULT_EVALUATE_SETTINGS);
    expect(normalizeEvaluateSettings(null).value).toEqual(DEFAULT_EVALUATE_SETTINGS);
    expect(normalizeEvaluateSettings("nonsense").issues).toEqual([]);
  });

  it("clamps the profile slack, the mod cap and the page size, and says what it changed", () => {
    const { value, issues } = normalizeEvaluateSettings({
      profiles: { "quick-price": { slack: 0.1, maxMods: 500 }, broad: { slack: 3, maxMods: -2 } },
      pageSize: 50,
    });
    expect(value.profiles["quick-price"]).toEqual({ slack: 0.5, maxMods: 99 });
    expect(value.profiles.broad).toEqual({ slack: 1, maxMods: 0 });
    // One trade2 fetch takes ten ids: a page can never be larger.
    expect(value.pageSize).toBe(10);
    expect(issues.length).toBeGreaterThanOrEqual(4);
    expect(issues.join(" ")).toContain("pageSize");
  });

  it("falls back on an unknown enum and keeps the rest", () => {
    const { value, issues } = normalizeEvaluateSettings({
      defaultProfile: "vibes",
      defaultStatus: "sometimes",
      defaultIndexed: "yesterday",
      defaultCurrency: "mirror",
      captureMode: "aggressive",
      pseudoMods: false,
    });
    expect(value.defaultProfile).toBe("quick-price");
    expect(value.defaultStatus).toBe("online");
    expect(value.defaultIndexed).toBe("");
    expect(value.defaultCurrency).toBe("");
    expect(value.captureMode).toBe("auto");
    expect(value.pseudoMods).toBe(false);
    expect(issues).toHaveLength(5);
  });

  it("drops unknown keys and keeps every auto-search switch typed", () => {
    const { value } = normalizeEvaluateSettings({
      autoSearch: { rare: false, unicorn: true },
      somethingElse: 42,
    });
    expect(value.autoSearch.rare).toBe(false);
    expect(value.autoSearch.waystone).toBe(false);
    expect(value.autoSearch.unique).toBe(true);
    expect(Object.keys(value.autoSearch).sort()).toEqual([
      "currency",
      "gem",
      "magic",
      "normal",
      "other",
      "rare",
      "unique",
      "waystone",
    ]);
    expect("somethingElse" in value).toBe(false);
  });

  it("is idempotent — sanitizing its own output changes nothing", () => {
    const once = normalizeEvaluateSettings({ pageSize: 99, profiles: { broad: { slack: 0.2 } } }).value;
    const twice = normalizeEvaluateSettings(once);
    expect(twice.value).toEqual(once);
    expect(twice.issues).toEqual([]);
  });
});

describe("autoSearchKeyFor", () => {
  it("folds the item kinds onto the eight switches the settings expose", () => {
    expect(autoSearchKeyFor("rare")).toBe("rare");
    expect(autoSearchKeyFor("unidentified-unique")).toBe("unique");
    expect(autoSearchKeyFor("tablet")).toBe("other");
    expect(autoSearchKeyFor("flask")).toBe("other");
    expect(autoSearchKeyFor("waystone")).toBe("waystone");
  });
});
