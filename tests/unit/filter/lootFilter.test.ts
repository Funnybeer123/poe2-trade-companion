import { DEFAULT_FILTER_PROFILE, GGG_DISCLAIMER, generateLootFilter } from "@poe2tc/core";
import { describe, expect, it } from "vitest";

describe("local loot filter export", () => {
  it("generates a local filter body without OAuth sync", () => {
    const body = generateLootFilter(DEFAULT_FILTER_PROFILE);
    expect(body).toContain("Local loot-filter export only. No OAuth filter sync.");
    expect(body).toContain(GGG_DISCLAIMER);
    expect(body).toContain("Show");
    expect(body).toContain("Hide");
    expect(body).not.toMatch(/account:item_filter|api\.pathofexile\.com/i);
  });
});
