import { describe, expect, it } from "vitest";
import { appraiseItem } from "../src/core/appraisal.js";
import { screenForLookup } from "../src/core/lookupScreen.js";
import { parseItemText } from "../src/core/parseItem.js";
import { buildStatFilteredQuery } from "../src/core/tradeComps.js";
import { watchForItem } from "../src/core/watchlist.js";
import { MOD_FAMILIES } from "../src/core/modKnowledge.js";
import { buildStatCatalogue } from "../src/core/statIds.js";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * A rare whose only strong lines are a socketed rune and an implicit: the
 * affixes themselves are unremarkable (both rolls sit under every family's
 * tier-3 threshold). Nothing downstream may treat the rune
 * or the implicit as the item's own substance.
 */
const RUNE_HEAVY_RARE = [
  "Item Class: Boots",
  "Rarity: Rare",
  "Gale Stride",
  "Advanced Steeltoe Boots",
  "--------",
  "Sockets: S",
  "--------",
  "Item Level: 80",
  "--------",
  "+35% to Lightning Resistance (implicit)",
  "--------",
  "+38% to Fire Resistance (rune)",
  "--------",
  "+12 to Strength",
  "+45 to maximum Mana",
].join("\n");

const stats = (() => {
  const file = path.join(process.cwd(), "fixtures", "trade", "stats-subset.json");
  return buildStatCatalogue(JSON.parse(readFileSync(file, "utf8")), MOD_FAMILIES);
})();

describe("affix-only semantics across the pricing path", () => {
  const parsed = parseItemText(RUNE_HEAVY_RARE);
  const appraisal = appraiseItem(RUNE_HEAVY_RARE, { parsed });

  it("flags rune and implicit lines as non-affixes on the appraisal", () => {
    const byText = new Map(appraisal.mods.map((mod) => [mod.text, mod]));
    expect(byText.get("+38% to Fire Resistance")).toMatchObject({ kind: "rune", affix: false });
    expect(byText.get("+35% to Lightning Resistance")).toMatchObject({ kind: "implicit", affix: false });
    expect(byText.get("+12 to Strength")?.affix).toBe(true);
    // The rune's top-tier roll still adds to the value score (the item sells with it)…
    expect(byText.get("+38% to Fire Resistance")?.tier).toBe(2);
    // …but it is not a reason to call the base craft stock.
    expect(appraisal.craftHint).toBeUndefined();
  });

  it("never turns a rune into a trade2 stat filter", () => {
    expect(buildStatFilteredQuery(parsed, appraisal, stats)).toBeUndefined();
  });

  it("screens the item to the floor instead of spending a lookup on its rune", () => {
    const [decision] = screenForLookup([
      { key: "0", name: parsed.name, tier: "unknown", rarity: parsed.rarity, baseType: parsed.baseType, itemLevel: parsed.itemLevel, appraisal },
    ]);
    expect(decision?.route).toBe("floor");
    expect(decision?.notableMods).toBe(0);
  });

  it("seeds a base-type watch, not a stat watch, from the rune", () => {
    const watch = watchForItem(
      { name: parsed.name, baseType: parsed.baseType, itemClass: parsed.itemClass, rarity: parsed.rarity, itemLevel: parsed.itemLevel },
      appraisal,
    );
    expect(watch.kind).toBe("base-type");
  });

  it("counts a real strong affix as craft-worthy substance", () => {
    const withAffix = RUNE_HEAVY_RARE.replace("+12 to Strength", "+140 to maximum Life");
    const better = appraiseItem(withAffix);
    expect(better.craftHint).toContain("2 affixes");
    expect(buildStatFilteredQuery(parseItemText(withAffix), better, stats)).toBeDefined();
  });
});
