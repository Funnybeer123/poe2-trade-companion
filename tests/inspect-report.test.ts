import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  INSPECT_REPORT_VERSION,
  MAX_INSPECT_MODS,
  MAX_INSPECT_TEXT_LENGTH,
  atlasHint,
  inspectItemText,
  type InspectOptions,
  type InspectReport,
} from "../src/core/inspect.js";
import { MOD_FAMILIES } from "../src/core/modKnowledge.js";
import { buildStatCatalogue } from "../src/core/statIds.js";
import { parseLearnedTiers } from "../src/core/tierLearning.js";

function fixture(name: string): string {
  return readFileSync(new URL(`../fixtures/inspect/${name}`, import.meta.url), "utf8");
}

const LEARNED = parseLearnedTiers(
  JSON.parse(readFileSync(new URL("../fixtures/inspect/learned-tiers-sample.json", import.meta.url), "utf8")),
);
const CATALOGUE = buildStatCatalogue(
  JSON.parse(readFileSync(new URL("../fixtures/trade/stats-subset.json", import.meta.url), "utf8")),
  MOD_FAMILIES,
);
const NOW = () => new Date("2026-09-14T10:00:00.000Z");

function report(name: string, options: InspectOptions = {}): InspectReport {
  const built = inspectItemText(fixture(name), {
    learnedTiers: LEARNED,
    statIds: CATALOGUE,
    now: NOW,
    ...options,
  });
  if (!built) throw new Error(`${name} did not produce a report`);
  return built;
}

function modNamed(built: InspectReport, text: string) {
  const mod = built.mods.find((entry) => entry.text === text);
  if (!mod) throw new Error(`no modifier "${text}"`);
  return mod;
}

describe("inspectItemText on an advanced description", () => {
  const built = report("advanced-rare-ring.txt");

  it("reports the item, the text kind and a deterministic timestamp", () => {
    expect(built.schemaVersion).toBe(INSPECT_REPORT_VERSION);
    expect(built.generatedAt).toBe("2026-09-14T10:00:00.000Z");
    expect(built.textKind).toBe("advanced");
    expect(built.item).toMatchObject({
      itemClass: "Rings",
      rarity: "Rare",
      name: "Storm Coil",
      baseType: "Sapphire Ring",
      itemLevel: 73,
      identified: true,
      corrupted: false,
    });
  });

  it("takes prefix/suffix, affix name, tier and range from the game's own annotation", () => {
    const life = modNamed(built, "+101 to maximum Life");
    expect(life).toMatchObject({
      side: "prefix",
      name: "Robust",
      kind: "explicit",
      affix: true,
      tags: ["Life"],
      rollPct: 40,
    });
    expect(life.tier).toMatchObject({
      label: "T3",
      rank: 3,
      of: 3,
      source: "annotation",
      requiredLevel: 68,
      observations: 5,
    });
    expect(life.range).toEqual({ min: 95, max: 110, source: "advanced-text" });
  });

  it("says a printed tier is the best this item level allows, and names the next step up", () => {
    expect(modNamed(built, "+101 to maximum Life").maxTier).toEqual({
      label: "T3",
      rank: 3,
      requiredLevel: 68,
      reached: true,
      next: { label: "T2", rank: 2, requiredLevel: 76 },
    });
  });

  it("marks an implicit as no affix and falls back to hand thresholds without a learned range", () => {
    const implicit = modNamed(built, "+18% to Cold Resistance");
    expect(implicit.kind).toBe("implicit");
    expect(implicit.affix).toBe(false);
    expect(implicit.tier?.source).toBe("family");
    expect(implicit.tier?.note).toContain("hand thresholds");
  });

  it("counts real prefixes and suffixes and the open affixes left", () => {
    expect(built.affixes).toEqual({
      prefixes: 1,
      suffixes: 2,
      unknownSide: 0,
      maxPrefixes: 3,
      maxSuffixes: 3,
      open: 3,
      countedFrom: "annotations",
    });
  });

  it("reports what it knew while deciding", () => {
    expect(built.knowledge).toEqual({
      learnedTiers: true,
      observations: 23,
      statCatalogue: true,
      // fixtures/trade/stats-subset.json: 77 entries + 29 added on 2026-09-14
      // for the build-demand families (docs/features/build-demand.md).
      catalogueEntries: 106,
      tierDirection: "desc",
    });
    expect(built.appraisal?.evidence).toBe("mods");
    expect(built.links.map((link) => link.id)).toEqual(["wiki", "poe2db"]);
  });
});

describe("inspectItemText on a plain copy of the same ring", () => {
  const built = report("plain-rare-ring.txt");

  it("has no sides and says the affix count is an estimate", () => {
    expect(built.textKind).toBe("plain");
    expect(built.mods.every((mod) => mod.side === undefined)).toBe(true);
    expect(built.affixes).toMatchObject({ countedFrom: "estimate", unknownSide: 3, open: 3 });
    expect(built.notes[0]).toContain("hold Alt in game");
    expect(built.notes.some((note) => note.includes("estimate"))).toBe(true);
  });

  it("counts the same open affixes as the advanced copy of the same ring", () => {
    // The plain copy does not mark its implicit, so the block above the
    // explicit block is discounted instead of counted as a fourth affix.
    const advanced = report("advanced-rare-ring.txt");
    expect(built.affixes.open).toBe(advanced.affixes.open);
    expect(built.mods.map((mod) => mod.text)).toEqual(advanced.mods.map((mod) => mod.text));
    expect(built.mods[0]!.block).toBeLessThan(built.mods[1]!.block);
  });

  it("still finds the tier and roll from the learned ladder", () => {
    const life = modNamed(built, "+101 to maximum Life");
    expect(life.tier).toMatchObject({ label: "T3", rank: 3, source: "learned", observations: 5 });
    expect(life.range).toEqual({ min: 95, max: 110, source: "learned" });
    expect(life.rollPct).toBe(40);
  });
});

describe("inspectItemText status and identification", () => {
  it("treats a bare Mirrored line as a status, not a modifier, and seals the affixes", () => {
    const built = report("mirrored-rare.txt");
    expect(built.item.mirrored).toBe(true);
    expect(built.mods.map((mod) => mod.text)).not.toContain("Mirrored");
    expect(built.affixes).toMatchObject({ sealedReason: "mirrored", open: 0 });
    expect(built.notes.some((note) => note.includes("Mirrored"))).toBe(true);
  });

  it("shows no modifiers and an unknown affix count for an unidentified item", () => {
    const built = report("unidentified-rare.txt");
    expect(built.item.identified).toBe(false);
    expect(built.mods).toEqual([]);
    expect(built.affixes.open).toBe(-1);
    expect(built.notes.some((note) => note.startsWith("Unidentified"))).toBe(true);
  });
});

describe("inspectItemText damage and defences", () => {
  it("computes bow DPS and the 20 % quality estimate", () => {
    const built = report("weapon-bow-elemental.txt");
    expect(built.weapon).toMatchObject({
      aps: 1.4,
      quality: 12,
      physicalDps: 56,
      elementalDps: 70.7,
      totalDps: 126.7,
    });
    expect(built.weapon?.components.map((component) => component.kind)).toEqual([
      "physical",
      "fire",
      "lightning",
    ]);
    expect(built.weapon?.atQuality20).toEqual({ physicalDps: 60, totalDps: 130.7, exact: false });
  });

  it("normalises armour to 20 % quality and reports block", () => {
    const built = report("armour-quality-12.txt");
    expect(built.weapon).toBeUndefined();
    expect(built.defences?.entries).toEqual([{ name: "Armour", value: 412, atQuality20: 441.4 }]);
    expect(built.defences?.blockChance).toBe(25);
    expect(built.defences?.exact).toBe(false);
  });
});

describe("inspectItemText map items", () => {
  const built = report("waystone-t15-deadly.txt");

  it("rates the waystone and keeps the reward lines out of the modifier list", () => {
    expect(built.mapWarnings?.overall).toBe("deadly");
    expect(built.mapWarnings?.tier).toBe(15);
    expect(built.mods.map((mod) => mod.text)).not.toContain("Item Rarity: +32%");
    expect(built.mapWarnings?.bonuses).toHaveLength(3);
    expect(built.notes.some((note) => note.includes("community-maintained"))).toBe(true);
  });

  it("applies the user's overrides", () => {
    const softened = report("waystone-t15-deadly.txt", {
      mapModOverrides: { "players-minus-max-res": "ignore" },
    });
    expect(softened.mapWarnings?.ignored).toBe(1);
    expect(softened.mapWarnings?.overall).toBe("dangerous");
  });

  it("adds no map block to a ring", () => {
    expect(report("advanced-rare-ring.txt").mapWarnings).toBeUndefined();
  });
});

describe("area context and the atlas hint", () => {
  it("points at the Atlas from a hideout with a waystone in hand", () => {
    const built = report("waystone-t15-deadly.txt", {
      area: { id: "HideoutCanal", name: "Canal Hideout", category: "hideout", level: 68 },
    });
    expect(built.context).toMatchObject({ areaId: "HideoutCanal", areaCategory: "hideout" });
    expect(built.context?.atlasHint).toContain("open the Atlas");
    expect(built.context?.atlasHint).toContain("deadly modifiers");
  });

  it("points at the Atlas from the endgame town too", () => {
    const built = report("waystone-t15-deadly.txt", {
      area: { id: "G_Endgame_Town", name: "The Ziggurat Refuge", category: "endgame-town", level: 65 },
    });
    expect(built.context?.areaCategory).toBe("endgame-town");
    expect(built.context?.atlasHint).toContain("open the Atlas");
  });

  it("names the current map when the character is inside one", () => {
    const built = report("advanced-rare-ring.txt", {
      area: { id: "MapSunTemple", name: "Sun Temple", category: "map", level: 79 },
    });
    expect(built.context?.atlasHint).toBe("Inside Sun Temple (area level 79).");
  });

  it("has no hint for a ring in a hideout, and none without an area at all", () => {
    const built = report("advanced-rare-ring.txt", {
      area: { id: "HideoutCanal", name: "Canal Hideout", category: "hideout", level: 68 },
    });
    expect(built.context?.atlasHint).toBeUndefined();
    expect(report("advanced-rare-ring.txt").context).toBeUndefined();
    expect(atlasHint({ mapWarnings: undefined }, undefined)).toBeUndefined();
  });
});

describe("the line endings the game actually sends", () => {
  const FIXTURES = [
    "advanced-rare-ring.txt",
    "plain-rare-ring.txt",
    "weapon-bow-elemental.txt",
    "armour-quality-12.txt",
    "waystone-t15-deadly.txt",
    "waystone-t3-clean.txt",
    "tablet-precursor.txt",
    "mirrored-rare.txt",
    "unidentified-rare.txt",
  ];

  it.each(FIXTURES)("reads %s identically with CRLF and with LF", (name) => {
    // The game's own Ctrl+C puts CRLF on the clipboard; the fixtures on
    // disk may be either, so every fixture is parsed both ways and the two
    // reports must be the same object. Without this, an anchored `$` in any
    // of the mod/bonus regexes could meet a trailing \r and break real
    // clipboard text while the suite stayed green.
    const text = fixture(name);
    const lf = text.replace(/\r\n/g, "\n");
    const crlf = lf.replace(/\n/g, "\r\n");
    const options: InspectOptions = { learnedTiers: LEARNED, statIds: CATALOGUE, now: NOW };
    expect(inspectItemText(crlf, options)).toEqual(inspectItemText(lf, options));
  });
});

describe("inspectItemText edge cases", () => {
  it("answers undefined for anything that is not item text", () => {
    expect(inspectItemText("hello there")).toBeUndefined();
    expect(inspectItemText("")).toBeUndefined();
  });

  it("refuses a paste far too large to be a copied item", () => {
    // `looksLikePoeItemText` only needs one `Rarity:` line, so a huge paste
    // that happens to contain one would otherwise be fully re-parsed once a
    // second on the main thread while the panel follows the clipboard.
    const huge = `${fixture("plain-rare-ring.txt")}\n${"+1 to maximum Life\n".repeat(20_000)}`;
    expect(huge.length).toBeGreaterThan(MAX_INSPECT_TEXT_LENGTH);
    expect(inspectItemText(huge, { now: NOW })).toBeUndefined();
  });

  it("caps the modifier list and says it did", () => {
    const body = "+1 to maximum Life\n".repeat(MAX_INSPECT_MODS + 20);
    const text = `Item Class: Rings\nRarity: Rare\nStorm Coil\nSapphire Ring\n--------\nItem Level: 73\n--------\n${body}`;
    expect(text.length).toBeLessThan(MAX_INSPECT_TEXT_LENGTH);
    const built = inspectItemText(text, { now: NOW })!;
    expect(built.mods).toHaveLength(MAX_INSPECT_MODS);
    expect(built.notes.some((note) => note.includes(`first ${MAX_INSPECT_MODS} modifier lines`))).toBe(true);
  });

  it("works with no learned data at all", () => {
    const built = inspectItemText(fixture("plain-rare-ring.txt"), { now: NOW })!;
    expect(built.knowledge).toMatchObject({ learnedTiers: false, statCatalogue: false, observations: 0 });
    expect(built.mods.every((mod) => mod.tier === undefined || mod.tier.source === "family")).toBe(true);
  });

  it("survives an appraisal that throws and says so", () => {
    const exploding = new Proxy(
      {},
      {
        get() {
          throw new Error("price table is broken");
        },
      },
    ) as never;
    const built = inspectItemText(fixture("plain-rare-ring.txt"), { now: NOW, priceTable: exploding })!;
    expect(built.appraisal).toBeUndefined();
    expect(built.notes.some((note) => note.includes("appraisal could not be computed"))).toBe(true);
    expect(built.mods).toHaveLength(4);
  });
});
