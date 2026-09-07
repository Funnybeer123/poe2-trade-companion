import { describe, expect, it } from "vitest";
import { pricingReadiness } from "../../src/renderer/utils/readiness.js";
import type { PriceFeedStatusView } from "../../src/renderer/services/rendererApi.js";

function status(overrides: Partial<PriceFeedStatusView> = {}): PriceFeedStatusView {
  return {
    config: { league: "auto", autoRefreshDaily: false, poesessid: "" },
    resolvedLeague: "Runes of Aldur",
    leagueCandidates: [{ value: "Runes of Aldur", divinePrice: 624 }],
    leagueAmbiguous: false,
    feedEntryCount: 800,
    feedAgeHours: 3,
    refreshing: false,
    tradeBudget: { lookups: 9 },
    ...overrides,
  };
}

describe("pricingReadiness", () => {
  it("is empty without a bridge (browser preview)", () => {
    expect(pricingReadiness(undefined)).toEqual([]);
  });

  it("is all green for a resolved league, a fresh feed and spare lookups", () => {
    const checks = pricingReadiness(status());
    expect(checks.map((check) => check.ok)).toEqual([true, true, true]);
    expect(checks[0]?.detail).toBe("auto → Runes of Aldur");
    expect(checks[1]?.detail).toContain("800 feed prices");
    expect(checks[2]?.detail).toBe("9 lookups spare right now");
  });

  it("names a pinned league as-is", () => {
    const [league] = pricingReadiness(
      status({ config: { league: "Runes of Aldur", autoRefreshDaily: false, poesessid: "" } }),
    );
    expect(league?.detail).toBe("Runes of Aldur");
  });

  it("flags an ambiguous league with the fix", () => {
    const [league] = pricingReadiness(
      status({
        resolvedLeague: undefined,
        leagueAmbiguous: true,
        leagueCandidates: [
          { value: "Forbidden Rites", divinePrice: 98 },
          { value: "Runes of Aldur", divinePrice: 624 },
        ],
      }),
    );
    expect(league?.ok).toBe(false);
    expect(league?.detail).toContain("2 current leagues");
    expect(league?.detail).toContain("Tools → Settings");
  });

  it("flags a never-refreshed or stale feed", () => {
    expect(pricingReadiness(status({ feedAgeHours: undefined, feedEntryCount: 0 }))[1]).toMatchObject({
      ok: false,
      detail: expect.stringContaining("Never refreshed"),
    });
    expect(pricingReadiness(status({ feedAgeHours: 60 }))[1]).toMatchObject({
      ok: false,
      detail: expect.stringContaining("refresh before pricing"),
    });
  });

  it("flags a penalty window and an exhausted pacer", () => {
    const restricted = pricingReadiness(
      status({ tradeBudget: { lookups: 0, restrictedUntilIso: "2026-09-07T10:30:00.000Z" } }),
    )[2];
    expect(restricted?.ok).toBe(false);
    expect(restricted?.detail).toContain("Penalty window until");
    const exhausted = pricingReadiness(status({ tradeBudget: { lookups: 0 } }))[2];
    expect(exhausted).toMatchObject({ ok: false, detail: expect.stringContaining("No lookup spare") });
  });
});
