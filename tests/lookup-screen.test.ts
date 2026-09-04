import { describe, expect, it } from "vitest";
import type { ItemAppraisal, ModAppraisal } from "../src/core/appraisal.js";
import { screenForLookup, summarizeScreen } from "../src/core/lookupScreen.js";

function appraisal(
  overrides: Partial<ItemAppraisal> & { mods?: ModAppraisal[] } = {},
): ItemAppraisal {
  return {
    valueScore: 10,
    confidence: 50,
    band: "medium",
    evidence: "mods",
    reasons: [],
    mods: [],
    ...overrides,
  };
}

const notable = (label: string, tier: 1 | 2 | 3, points = 10): ModAppraisal => ({
  text: label,
  familyId: label.toLowerCase(),
  familyLabel: label,
  tier,
  points,
});
const dud = (text: string): ModAppraisal => ({ text, points: 0 });

describe("screenForLookup", () => {
  it("routes tiers, price-table hits, and Normal items without a lookup", () => {
    const decisions = screenForLookup([
      { key: "keep", name: "Kept", tier: "keep", rarity: "Rare" },
      { key: "dump", name: "Dumped", tier: "dump", rarity: "Rare" },
      {
        key: "table",
        name: "Priced",
        tier: "sell",
        rarity: "Unique",
        appraisal: appraisal({
          evidence: "price-table",
          estimatedValue: { amount: 40, currency: "exalted", basis: "price-table", unitValue: 40 },
        }),
      },
      { key: "white", name: "White", tier: "unknown", rarity: "Normal", itemLevel: 70 },
      { key: "base", name: "Craft base", tier: "unknown", rarity: "Normal", itemLevel: 82 },
    ]);
    const byKey = Object.fromEntries(decisions.map((decision) => [decision.key, decision.route]));
    expect(byKey).toEqual({
      keep: "keep",
      dump: "vendor",
      table: "local-price",
      white: "vendor",
      base: "floor",
    });
  });

  it("floors rares with no notable mods and looks up the ones with substance, best first", () => {
    const decisions = screenForLookup([
      {
        key: "junk",
        name: "Junk rare",
        tier: "unknown",
        rarity: "Rare",
        appraisal: appraisal({ mods: [dud("+3 to Strength"), dud("5% increased Rarity")] }),
      },
      {
        key: "good",
        name: "Good rare",
        tier: "unknown",
        rarity: "Rare",
        appraisal: appraisal({
          valueScore: 60,
          confidence: 80,
          mods: [notable("Life", 1), notable("Fire Resistance", 2), dud("+3 to Strength")],
        }),
      },
      {
        key: "okay",
        name: "Okay rare",
        tier: "unknown",
        rarity: "Rare",
        appraisal: appraisal({ valueScore: 20, confidence: 50, mods: [notable("Life", 3)] }),
      },
      { key: "uniq", name: "Unlisted unique", tier: "unknown", rarity: "Unique" },
    ]);
    expect(decisions.map((decision) => decision.key)).toEqual(["uniq", "good", "okay", "junk"]);
    expect(decisions[1]).toMatchObject({ route: "lookup", notableMods: 2 });
    expect(decisions[1]!.reason).toContain("Life, Fire Resistance");
    expect(decisions[3]).toMatchObject({ route: "floor", notableMods: 0 });
    expect(decisions[3]!.reason).toContain("no notable mods");
    expect(summarizeScreen(decisions)).toBe(
      "screen: 3 lookup · 1 floor · 0 vendor · 0 local · 0 keep",
    );
  });

  it("looks up valuable bases whatever the mods say (live 2026-09-03: Time-Lost jewel)", () => {
    const decisions = screenForLookup([
      {
        key: "tl",
        name: "Mystic Time-Lost Sapphire of Enchanting",
        tier: "unknown",
        rarity: "Magic",
        baseType: "Mystic Time-Lost Sapphire of Enchanting",
        appraisal: appraisal({ mods: [dud("12% increased Damage")] }),
      },
      {
        key: "white",
        name: "Time-Lost Ruby",
        tier: "unknown",
        rarity: "Normal",
        baseType: "Time-Lost Ruby",
        itemLevel: 60,
      },
      {
        key: "plain",
        name: "Bramble Star",
        tier: "unknown",
        rarity: "Rare",
        baseType: "Sapphire",
        appraisal: appraisal({ mods: [dud("12% increased Damage")] }),
      },
    ]);
    const byKey = Object.fromEntries(decisions.map((decision) => [decision.key, decision]));
    expect(byKey.tl).toMatchObject({ route: "lookup" });
    expect(byKey.tl!.reason).toContain("valuable base (Time-Lost)");
    expect(byKey.white).toMatchObject({ route: "lookup" });
    expect(byKey.plain).toMatchObject({ route: "floor" });
    expect(decisions[0]!.key).not.toBe("plain");
  });

  it("puts unappraised items at the back of the lookup queue", () => {
    const decisions = screenForLookup([
      { key: "blank", name: "Mystery", tier: "unknown", rarity: "Rare" },
      {
        key: "scored",
        name: "Scored",
        tier: "unknown",
        rarity: "Magic",
        appraisal: appraisal({ valueScore: 15, mods: [notable("Life", 2)] }),
      },
    ]);
    expect(decisions.map((decision) => decision.key)).toEqual(["scored", "blank"]);
    expect(decisions[1]).toMatchObject({ route: "lookup", score: 0 });
  });
});
