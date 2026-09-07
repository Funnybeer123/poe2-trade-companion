import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MOD_FAMILIES } from "../src/core/modKnowledge.js";
import {
  buildStatCatalogue,
  modTextToStatText,
  patternToStatRegex,
  resolveStatIds,
  statEntries,
  statIdsForMatch,
  statIdsForModText,
  unresolvedFamilies,
} from "../src/core/statIds.js";

/** Trimmed live catalogue (2026-09-07): every entry our families resolve to. */
const FIXTURE: unknown = JSON.parse(
  readFileSync(new URL("../fixtures/trade/stats-subset.json", import.meta.url), "utf8"),
);

describe("trade2 stat ids", () => {
  it("resolves every mod family against the catalogue subset", () => {
    const ids = resolveStatIds(FIXTURE, MOD_FAMILIES);
    expect(unresolvedFamilies(ids, MOD_FAMILIES)).toEqual([]);
    expect(ids.get("life")).toEqual(["explicit.stat_3299347043"]);
    expect(ids.get("mana")).toEqual(["explicit.stat_1050105434"]);
    expect(ids.get("adds-ele")).toHaveLength(3);
    expect(ids.get("attribute")).toHaveLength(3);
    // "(Local)" and global attack speed are both the family.
    expect(ids.get("attack-speed")).toHaveLength(2);
    expect(ids.get("skill-levels")!.length).toBeGreaterThanOrEqual(10);
    // PoE2 wordings the PoE1-era regexes never matched are pinned by statText.
    expect(ids.get("additional-projectiles")).toEqual(["explicit.stat_3885405204"]);
    expect(ids.get("onslaught-on-kill")).toEqual(["explicit.stat_1881230714"]);
    expect(ids.get("life-regen")).toEqual(["explicit.stat_3325883026"]);
    expect(ids.get("jewel-leech")).toHaveLength(3);
  });

  it("keys a Ctrl+C line to its exact stat", () => {
    const catalogue = buildStatCatalogue(FIXTURE, MOD_FAMILIES);
    expect(modTextToStatText("+120 to maximum Life")).toBe("# to maximum life");
    expect(modTextToStatText("Adds 12 to 24 Fire Damage")).toBe("adds # to # fire damage");
    expect(statIdsForModText(catalogue, "Adds 12 to 24 Fire Damage")).toEqual([
      "explicit.stat_709508406",
    ]);
    expect(statIdsForModText(catalogue, "+1 to Level of all Spell Skills")).toEqual([
      "explicit.stat_124131830",
    ]);
    expect(statIdsForModText(catalogue, "12% increased Attack Speed")).toHaveLength(2);
    // A digit-less line has no `#` form; the family's lone id stands in.
    expect(statIdsForModText(catalogue, "Bow Attacks fire an additional Arrow")).toEqual([]);
    expect(
      statIdsForMatch(catalogue, "additional-projectiles", "Bow Attacks fire an additional Arrow"),
    ).toEqual(["explicit.stat_3885405204"]);
  });

  it("adds sibling ids only for small families", () => {
    const catalogue = buildStatCatalogue(FIXTURE, MOD_FAMILIES);
    const strength = statIdsForMatch(catalogue, "attribute", "+40 to Strength");
    expect(strength[0]).toBe("explicit.stat_4080418644");
    expect(strength).toHaveLength(3);
    // "increased … Damage" spans twenty stats: only the exact text counts.
    expect(statIdsForMatch(catalogue, "jewel-damage", "12% increased Spell Damage")).toEqual([
      "explicit.stat_2974417149",
    ]);
  });

  it("anchors rewritten patterns so a family cannot claim look-alike stats", () => {
    const regex = patternToStatRegex(String.raw`\d+% increased Attack Speed`);
    expect(regex.test("#% increased attack speed")).toBe(true);
    expect(regex.test("#% increased attack speed per 10 dexterity")).toBe(false);
    expect(
      patternToStatRegex(String.raw`\+?\d+% to Chaos Resistance`).test("#% to chaos resistance"),
    ).toBe(true);
    expect(
      patternToStatRegex(String.raw`Regenerate [\d.]+ Life per second`).test(
        "regenerate # life per second",
      ),
    ).toBe(true);
  });

  it("ignores unknown shapes and reads only explicit entries by default", () => {
    expect(statEntries(null)).toEqual([]);
    expect(statEntries({ result: "nope" })).toEqual([]);
    expect(resolveStatIds({ result: [] }, MOD_FAMILIES).size).toBe(0);
    expect(buildStatCatalogue(undefined, MOD_FAMILIES).entryCount).toBe(0);
    expect(statEntries(FIXTURE).every((entry) => entry.type === "explicit")).toBe(true);
    const pseudo = statEntries(FIXTURE, ["pseudo"]);
    expect(pseudo.some((entry) => entry.id === "pseudo.pseudo_total_life")).toBe(true);
  });
});
