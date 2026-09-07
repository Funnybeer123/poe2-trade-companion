import { describe, expect, it } from "vitest";
import {
  generateLootFilter,
  NEVER_HIDE_CLASSES,
  valuableBaseLabels,
  type LootFilterOptions,
} from "../src/core/lootFilter.js";
import { VALUABLE_BASES } from "../src/core/lookupScreen.js";
import { PRICE_TABLE_SCHEMA_VERSION, type PriceEntry, type PriceTable } from "../src/core/priceTable.js";

const GENERATED_AT = new Date("2026-09-07T12:00:00.000Z");

function table(entries: PriceEntry[], updatedAt?: string): PriceTable {
  return {
    schemaVersion: PRICE_TABLE_SCHEMA_VERSION,
    currency: "exalted",
    ...(updatedAt ? { updatedAt } : {}),
    entries,
  };
}

const SMALL_TABLE = table(
  [
    { id: "feed:poe2scout:divine", match: { name: "Divine Orb" }, value: 40, note: "poe2scout · Runes of Aldur · 2026-09-07" },
    { id: "feed:poe2scout:temporalis-silk-robe", match: { name: "Temporalis", baseType: "Silk Robe", rarity: "Unique" }, value: 300 },
    { id: "any-unique", match: { rarity: "Unique" }, value: 1, note: "Floor for unreviewed uniques." },
  ],
  "2026-09-07T11:00:00.000Z",
);

function generate(overrides: Partial<LootFilterOptions> = {}) {
  return generateLootFilter({
    name: "test",
    priceTable: SMALL_TABLE,
    league: "Runes of Aldur",
    generatedAt: GENERATED_AT,
    divineRate: 40,
    ...overrides,
  });
}

/** Blocks in order: each starts with Show/Hide and carries its condition lines. */
function blocks(text: string): string[][] {
  return text
    .split(/\n\n+/)
    .map((chunk) => chunk.split("\n").filter((line) => line.trim() && !line.startsWith("#")))
    .filter((lines) => lines.length > 0 && /^(Show|Hide)$/.test(lines[0]!));
}

describe("generateLootFilter", () => {
  it("produces the golden filter for a small table", () => {
    const { text, summary } = generate();
    expect(text).toBe(
      [
        "# PoE2 Trade Companion loot filter: test",
        "# Generated 2026-09-07T12:00:00.000Z · league: Runes of Aldur",
        "# Price table: 3 rows (2 from the poe2scout feed, updated 2026-09-07T11:00:00.000Z) · 1 rows a filter cannot express",
        "# Thresholds in exalted: chase ≥ 50 ex · valuable ≥ 5 ex · pickup ≥ 1 ex · 1 divine ≈ 40 ex",
        "# Every price is a local estimate, never a guaranteed sale. Currency, waystones, gems, jewels and anything",
        "# the table does not mention are never hidden; unique prices are rated per BASE (filters cannot see names).",
        "",
        "# Chase (≥ 50 ex) unique bases, rated at the best unique on each: Silk Robe (300 ex)",
        "Show",
        "    Rarity Unique",
        '    BaseType == "Silk Robe"',
        "    SetFontSize 45",
        "    SetTextColor 255 255 255 255",
        "    SetBorderColor 255 0 0 255",
        "    SetBackgroundColor 120 0 0 255",
        "    PlayAlertSound 6 300",
        "    PlayEffect Red",
        "    MinimapIcon 0 Red Star",
        "",
        "# Valuable (≥ 5 ex) currency and stackables, per unit: Divine Orb (40 ex)",
        "Show",
        '    BaseType == "Divine Orb"',
        "    SetFontSize 40",
        "    SetTextColor 255 255 255 255",
        "    SetBorderColor 255 200 0 255",
        "    SetBackgroundColor 70 50 0 255",
        "    PlayAlertSound 1 300",
        "    PlayEffect Yellow",
        "    MinimapIcon 1 Yellow Diamond",
        "",
        "# Valuable jewel bases — the base is the value whatever the mods say",
        "Show",
        '    BaseType "Time-Lost" "Timeless" "Diamond"',
        "    SetFontSize 40",
        "    SetTextColor 255 255 255 255",
        "    SetBorderColor 255 200 0 255",
        "    SetBackgroundColor 70 50 0 255",
        "    PlayAlertSound 1 300",
        "    PlayEffect Yellow",
        "    MinimapIcon 1 Yellow Diamond",
        "",
        "# Every other unique stays visible",
        "Show",
        "    Rarity Unique",
        "    SetFontSize 36",
        "    SetTextColor 175 96 37 255",
        "    SetBorderColor 175 96 37 255",
        "    SetBackgroundColor 0 0 0 200",
        "    PlayAlertSound 3 200",
        "    MinimapIcon 2 Brown Circle",
        "",
        "# Never hidden, whatever the rarity or item level",
        "Show",
        `    Class ${NEVER_HIDE_CLASSES.map((name) => `"${name}"`).join(" ")}`,
        "",
        "# Normal gear below item level 65",
        "Hide",
        "    Rarity Normal",
        "    ItemLevel < 65",
        "",
        "# Everything else stays visible",
        "Show",
        "",
      ].join("\n"),
    );
    expect(summary).toMatchObject({
      tiers: {
        chase: { uniqueBases: 1, currency: 0, bases: 0 },
        valuable: { uniqueBases: 0, currency: 1, bases: 0 },
        pickup: { uniqueBases: 0, currency: 0, bases: 0 },
      },
      highlightedBases: 5, // Silk Robe, Divine Orb, three valuable jewel labels
      uniqueBases: 1,
      currencyRows: 1,
      skippedEntries: 1,
      priceRows: 3,
      feedRows: 2,
      divineRate: 40,
      league: "Runes of Aldur",
      generatedAt: "2026-09-07T12:00:00.000Z",
    });
  });

  it("is deterministic and independent of table entry order", () => {
    const reversed = table([...SMALL_TABLE.entries].reverse(), SMALL_TABLE.updatedAt);
    expect(generate().text).toBe(generate({ priceTable: reversed }).text);
  });

  it("groups uniques by base type and rates each base at its most valuable unique", () => {
    const { text, summary } = generate({
      priceTable: table([
        { id: "u1", match: { name: "Temporalis", baseType: "Silk Robe", rarity: "Unique" }, value: 300 },
        { id: "u2", match: { name: "Cloak of Flame", baseType: "Silk Robe", rarity: "Unique" }, value: 2 },
        { id: "u3", match: { name: "Widowhail", baseType: "Crude Bow", rarity: "Unique" }, value: 6 },
        { id: "u4", match: { name: "Quill Rain", baseType: "Crude Bow", rarity: "Unique" }, value: 1.5 },
        { id: "u5", match: { name: "Goldrim", baseType: "Leather Cap", rarity: "Unique" }, value: 0.2 },
        { id: "u6", match: { name: "Named Only", rarity: "Unique" }, value: 500 },
      ]),
    });
    const uniqueBlocks = blocks(text).filter((lines) => lines.includes("    Rarity Unique"));
    // chase (Silk Robe), valuable (Crude Bow), catch-all
    expect(uniqueBlocks).toHaveLength(3);
    expect(uniqueBlocks[0]).toContain('    BaseType == "Silk Robe"');
    expect(uniqueBlocks[1]).toContain('    BaseType == "Crude Bow"');
    expect(uniqueBlocks[2]).toEqual([
      "Show",
      "    Rarity Unique",
      "    SetFontSize 36",
      "    SetTextColor 175 96 37 255",
      "    SetBorderColor 175 96 37 255",
      "    SetBackgroundColor 0 0 0 200",
      "    PlayAlertSound 3 200",
      "    MinimapIcon 2 Brown Circle",
    ]);
    // Silk Robe appears exactly once as a rated base; Leather Cap (0.2 ex) is
    // below the pickup tier; the name-only unique cannot be expressed.
    expect(text.match(/"Silk Robe"/g)).toHaveLength(1);
    expect(text).not.toContain("Leather Cap");
    expect(text).not.toContain("Named Only");
    expect(summary.uniqueBases).toBe(2);
    expect(summary.skippedEntries).toBe(1);
  });

  it("buckets currency rows by unit value into the three tiers", () => {
    const { text, summary } = generate({
      priceTable: table([
        { id: "c1", match: { name: "Perfect Jeweller's Orb" }, value: 60 },
        { id: "c2", match: { name: "Divine Orb" }, value: 40 },
        { id: "c3", match: { name: "Exalted Orb" }, value: 1 },
        { id: "c4", match: { name: "Chaos Orb" }, value: 0.5 },
        { id: "c5", match: { name: "Greater Jeweller's Orb" }, value: 5 },
      ]),
    });
    const currencyBlocks = blocks(text).filter((lines) =>
      lines.some((line) => line.startsWith("    BaseType ==")),
    );
    expect(currencyBlocks.map((lines) => lines[1])).toEqual([
      '    BaseType == "Perfect Jeweller\'s Orb"',
      '    BaseType == "Divine Orb" "Greater Jeweller\'s Orb"',
      '    BaseType == "Exalted Orb"',
    ]);
    expect(currencyBlocks[0]).toContain("    SetFontSize 45");
    expect(currencyBlocks[1]).toContain("    SetFontSize 40");
    expect(currencyBlocks[2]).toContain("    SetFontSize 35");
    expect(text).not.toContain("Chaos Orb");
    expect(summary.tiers.chase.currency).toBe(1);
    expect(summary.tiers.valuable.currency).toBe(2);
    expect(summary.tiers.pickup.currency).toBe(1);
    expect(summary.currencyRows).toBe(4);
  });

  it("honours custom thresholds and keeps them ordered", () => {
    const { text, summary } = generate({
      tiers: { chaseAtOrAbove: 20, valuableAtOrAbove: 30, pickupAtOrAbove: 10 },
    });
    // valuable (30) > chase (20) is impossible: chase is lifted to 30.
    expect(summary.tierThresholds).toEqual({
      chaseAtOrAbove: 30,
      valuableAtOrAbove: 30,
      pickupAtOrAbove: 10,
    });
    expect(text).toContain("# Chase (≥ 30 ex) unique bases");
    expect(text).toContain("# Chase (≥ 30 ex) currency and stackables, per unit: Divine Orb (40 ex)");
  });

  it("hides only Normal gear below the item level, and Magic only on request", () => {
    const withMagic = generate({ hideNormalBelowItemLevel: 70, hideMagicBelowItemLevel: 60 }).text;
    const hides = blocks(withMagic).filter((lines) => lines[0] === "Hide");
    expect(hides).toEqual([
      ["Hide", "    Rarity Normal", "    ItemLevel < 70"],
      ["Hide", "    Rarity Magic", "    ItemLevel < 60"],
    ]);
    // Safety net precedes the Hide rules and the file ends with a default Show.
    const all = blocks(withMagic);
    const safetyIndex = all.findIndex((lines) => lines[1]?.startsWith("    Class "));
    const firstHide = all.findIndex((lines) => lines[0] === "Hide");
    expect(safetyIndex).toBeGreaterThan(-1);
    expect(safetyIndex).toBeLessThan(firstHide);
    expect(all[all.length - 1]).toEqual(["Show"]);

    const noHide = generate({ hideNormalBelowItemLevel: 0 }).text;
    expect(noHide).not.toContain("Hide");
  });

  it("never hides currency, waystones, gems, or jewels", () => {
    const { text } = generate();
    const safety = blocks(text).find((lines) => lines[1]?.startsWith("    Class "))!;
    for (const cls of ["Currency", "Waystone", "Gem", "Jewel"]) {
      expect(safety[1]).toContain(`"${cls}"`);
    }
    // Hide rules never mention a class or a currency rarity.
    for (const hide of blocks(text).filter((lines) => lines[0] === "Hide")) {
      expect(hide.join("\n")).not.toMatch(/Class|Currency/);
    }
  });

  it("can drop the unique catch-all and still shows rated uniques", () => {
    const { text } = generate({ alwaysShowUniques: false });
    expect(text).not.toContain("# Every other unique stays visible");
    expect(text).toContain('    BaseType == "Silk Robe"');
  });

  it("expresses plain base rows with their rarity and item-level floor", () => {
    const { text } = generate({
      priceTable: table([
        { id: "b1", match: { baseType: "Sapphire Ring", minItemLevel: 82 }, value: 8 },
        { id: "b2", match: { baseType: "Attuned Wand", rarity: "Normal" }, value: 2 },
      ]),
    });
    expect(text).toContain(
      ["Show", "    ItemLevel >= 82", '    BaseType == "Sapphire Ring"'].join("\n"),
    );
    expect(text).toContain(
      ["Show", "    Rarity Normal", '    BaseType == "Attuned Wand"'].join("\n"),
    );
  });

  it("keeps the valuable-base labels in sync with lookupScreen's patterns", () => {
    const labels = valuableBaseLabels();
    expect(labels).toEqual(["Time-Lost", "Timeless", "Diamond"]);
    for (const pattern of VALUABLE_BASES) {
      expect(labels.some((label) => pattern.test(label))).toBe(true);
    }
  });

  it("stamps an unknown league when none is known and defaults the name", () => {
    const { text, summary } = generateLootFilter({
      name: "   ",
      priceTable: SMALL_TABLE,
      generatedAt: GENERATED_AT,
    });
    expect(text.startsWith("# PoE2 Trade Companion loot filter: poe2-companion\n")).toBe(true);
    expect(text).toContain("league: unknown");
    expect(summary.league).toBeUndefined();
    // Divine rate falls back to the crafting economy's default when the table lacks one.
    expect(summary.divineRate).toBeGreaterThan(0);
  });
});
