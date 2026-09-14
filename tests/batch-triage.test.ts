import { describe, expect, it } from "vitest";
import { assessItem, assessBatch, BUNDLED_KNOWLEDGE } from "../src/core/batchTriage.js";
import { parseItemText } from "../src/core/parseItem.js";
import { affix, text, strongText, settings, batch, AT } from "./support/batchFixtures.js";
const assess = (raw: string) => assessItem(raw, settings());
describe("offline class-aware batch assessment", () => {
  it("recognizes relevant T1/T2 evidence and multiple T2 without requiring T1", () => {
    const result = assess(text([affix("Prefix", 2, "+95(85-99) to maximum Life"), affix("Suffix", 2, "+38(36-40)% to Fire Resistance"), affix("Suffix", 2, "+39(36-40)% to Cold Resistance")]));
    expect(result.outcome).toBe("keep");
    expect(result.modifiers.every(mod => mod.tier === 2 && mod.tierEvidence === "advanced")).toBe(true);
    const weapon = assess(text([affix("Prefix", 2, "130(120-139)% increased Physical Damage"), affix("Suffix", 2, "20(18-22)% increased Attack Speed")], { itemClass: "Crossbows", base: "Advanced Crossbow" }));
    expect(weapon.outcome).toBe("craft");
  });
  it("separates weak triple resistance from strong resistance and life", () => {
    const weak = assess(text([affix("Suffix", 8, "+8% to Fire Resistance"), affix("Suffix", 8, "+8% to Cold Resistance"), affix("Suffix", 8, "+8% to Lightning Resistance"), affix("Prefix", 8, "+12 to maximum Life")]));
    expect(weak.resistance).toMatchObject({ triple: true, elementalTotal: 24, affixGroups: 3 });
    expect(weak.outcome).toBe("low-priority");
    expect(assess(strongText()).outcome).toBe("keep");
  });
  it("keeps chaos separate and evaluates useful mixed coverage without multiplying affix slots", () => {
    const result = assess(text([affix("Prefix", 1, "+110 to maximum Life"), affix("Suffix", 2, "+24% to Chaos Resistance"), affix("Suffix", 2, "+18% to Fire and Cold Resistances")]));
    expect(result.resistance).toMatchObject({ chaos: 24, elementalTotal: 36, affixGroups: 2 });
    expect(result.outcome).toBe("keep");
    const all = assess(text([affix("Suffix", 2, "+16% to all Elemental Resistances")]));
    expect(all.resistance).toMatchObject({ elementalTotal: 48, affixGroups: 1, triple: true });
  });
  it("does not turn a single irrelevant T1 into usefulness", () => {
    expect(assess(text([affix("Suffix", 1, "15% increased Light Radius"), affix("Prefix", 8, "+12 to maximum Life"), affix("Suffix", 8, "+8% to Cold Resistance"), affix("Prefix", 8, "+12 to maximum Mana")])).outcome).toBe("low-priority");
  });
  it("counts hybrid annotation groups, and retains uncertainty for unsupported hybrid shapes", () => {
    const result = assess(text([affix("Prefix", 2, "120% increased Physical Damage\n+100 to Accuracy Rating"), affix("Suffix", 2, "20% increased Attack Speed")], { itemClass: "Crossbows" }));
    expect(result.crafting).toMatchObject({ prefixes: 1, suffixes: 1, freePrefixes: 2, freeSuffixes: 2 });
    expect(result.modifiers[0]!.group).toBe(result.modifiers[1]!.group);
    expect(assess(text([affix("Prefix", 1, "+110 to maximum Life\n+38% to Fire Resistance")])).outcome).toBe("review");
  });
  it("uses class-specific life ranges rather than one threshold, without upgrading a low tier's perfect roll", () => {
    const ring = assess(text(["+110 to maximum Life"]));
    const body = assess(text(["+110 to maximum Life"], { itemClass: "Body Armours" }));
    expect(ring.modifiers[0]).toMatchObject({ tier: 1, tierEvidence: "verified-range" });
    expect(body.modifiers[0]!.tier).toBe(6);
    const weak = assess(text([affix("Prefix", 8, "+19(10-19) to maximum Life")]));
    expect(weak.modifiers[0]).toMatchObject({ tier: 8, rollPosition: 1 });
    expect(weak.outcome).toBe("review");
  });
  it("does not compare a hybrid defence/life group against standalone life tiers", () => {
    const hybrid = assess(text([affix("Prefix", 2, "38(33-38)% increased Armour\n+40(33-41) to maximum Life")], { itemClass: "Body Armours" }));
    expect(hybrid.modifiers.map(mod => mod.tier)).toEqual([2, 2]);
    expect(hybrid.uncertainty).not.toContain("Advanced life tier conflicts with verified class range.");
    const standalone = assess(text([affix("Prefix", 2, "+40(33-41) to maximum Life")], { itemClass: "Body Armours" }));
    expect(standalone.uncertainty).toContain("Advanced life tier conflicts with verified class range.");
  });
  it("models ordinary jewels separately from special jewels and equipment", () => {
    const raw = text([affix("Prefix", 1, "18(10-20)% increased maximum Energy Shield"), affix("Suffix", 1, "7(5-8)% increased Cast Speed")], { itemClass: "Jewels", base: "Sapphire" });
    expect(assess(raw).crafting.limits).toEqual({ prefixes: 2, suffixes: 2 });
    expect(assess(raw.replace("Sapphire", "Time-Lost Sapphire")).outcome).toBe("review");
  });
  it("preserves decorated magic base names using exact advanced affix names", () => {
    const raw = 'Item Class: Jewels\nRarity: Magic\nShimmering Sapphire of Conjuring\n--------\nItem Level: 80\n--------\n' +
      affix("Prefix", 1, "18(10-20)% increased maximum Energy Shield", "Shimmering") + "\n" + affix("Suffix", 1, "7(5-8)% increased Cast Speed", "of Conjuring");
    expect(parseItemText(raw).baseType).toBe("Sapphire");
    const saved = batch([raw]);
    saved.rows[0]!.baseType = "Old decorated base";
    expect(assessBatch(saved).rows[0]!.baseType).toBe("Sapphire");
    expect(assess(raw).crafting.limits).toEqual({ prefixes: 1, suffixes: 1 });
  });
  it("recognizes normal and magic crafting bases without two strong affixes", () => {
    expect(assess(text([], { rarity: "Normal", base: "Unset Ring" })).outcome).toBe("craft");
    expect(assess(text(["{ Implicit Modifier }\nGrants 1 additional Skill Slots"], { rarity: "Normal", base: "Unset Ring" })).outcome).toBe("craft");
    const absent = assess(text([], { rarity: "Normal", base: "Absent Amulet", itemClass: "Amulets" }));
    expect(absent.outcome).toBe("review");
    expect(absent.crafting.limits).toBeUndefined();
    expect(absent.crafting.routes).toHaveLength(0);
    expect(assess(text([affix("Prefix", 2, "+95 to maximum Life")], { rarity: "Magic", base: "Unset Ring" })).outcome).toBe("craft");
    expect(assess(text([], { rarity: "Normal", base: "Unknown Ring" })).outcome).toBe("review");
    expect(assess(text([], { rarity: "Normal", base: "Unset Ring", itemLevel: 10 })).outcome).toBe("review");
  });
  it("keeps finished full-affix good items and corrupted useful items without suggesting crafting", () => {
    const full = text([affix("Prefix", 1, "+110 to maximum Life"), affix("Prefix", 1, "+100 to maximum Mana"), affix("Prefix", 1, "Adds 20 to 40 Fire Damage"),
      affix("Suffix", 2, "+38% to Fire Resistance"), affix("Suffix", 2, "+38% to Cold Resistance"), affix("Suffix", 2, "+38% to Lightning Resistance")]);
    expect(assess(full)).toMatchObject({ outcome: "keep", crafting: { freePrefixes: 0, freeSuffixes: 0, routes: [] } });
    for (const status of ["Corrupted", "  Mirrored  ", "Sanctified"]) {
      const result = assess(strongText() + "\n--------\n" + status);
      expect(result).toMatchObject({ outcome: "keep", crafting: { restricted: true }, components: { craftingPotential: 0 } });
    }
  });
  it("recognizes documented uniques separately and retains unknown uniques", () => {
    expect(assess(text(["Uncatalogued unique effect"], { rarity: "Unique", name: "Mageblood", itemClass: "Belts" })).outcome).toBe("keep");
    expect(assess(text(["Uncatalogued unique effect"], { rarity: "Unique" })).outcome).toBe("review");
  });
  it("retains unknown and incomplete items rather than interpreting absence as weak evidence", () => {
    for (const raw of ["nonsense", text(["Unknown effect"]), strongText() + "\nA strange unrecognized effect", strongText().replace(/Item Level: 82/, "")]) expect(assess(raw).outcome).toBe("review");
    expect(assess(text([affix("Prefix", 1, "+110 to maximum Life"), "Missing header effect"])).crafting.freePrefixes).toBeUndefined();
  });
  it("does not combine incompatible player/minion or attack/spell bonuses", () => {
    const minion = assess(text([affix("Prefix", 1, "Minions deal 15(5-15)% increased Damage"), affix("Suffix", 1, "8(5-8)% increased Cast Speed")], { itemClass: "Jewels", base: "Sapphire" }));
    expect(minion.outcome).toBe("review");
    const generic = assess(text([affix("Prefix", 1, "15(5-15)% increased Fire Damage"), affix("Suffix", 1, "Minions have 4(2-4)% increased Attack and Cast Speed")], { itemClass: "Jewels", base: "Ruby" }));
    expect(generic.outcome).toBe("review");
    expect(assess(text([affix("Prefix", 1, "150% increased Physical Damage"), affix("Suffix", 1, "30% increased Cast Speed")], { itemClass: "Crossbows" })).outcome).toBe("review");
  });
  it("reassesses hundreds of physical items offline, preserves histories, and records changed profiles", () => {
    const saved = batch(Array.from({ length: 276 }, () => strongText()));
    saved.rows[0]!.status = "moved"; saved.rows[0]!.actualDestination = "Amulets"; saved.rows[0]!.reasons.push("Verified receipt fixture.");
    saved.rows[1]!.status = "failed"; saved.rows[1]!.actualDestination = "inventory";
    const original = structuredClone(saved);
    const next = assessBatch(saved, { ...saved.settings, weights: { life: 0 }, feedback: { [saved.rows[2]!.id]: "review" } }, AT);
    expect(next.rows).toHaveLength(276);
    expect(new Set(next.rows.map(row => row.id)).size).toBe(276);
    expect(next.rows[0]).toMatchObject({ status: "moved", actualDestination: "Amulets" });
    expect(next.rows[0]!.reasons).toContain("Verified receipt fixture.");
    expect(next.rows[1]).toMatchObject({ status: "failed", actualDestination: "inventory" });
    expect(next.rows[2]!.assessment?.outcome).toBe("review");
    expect(next.assessmentHistory).toHaveLength(2);
    expect(next.knowledgeSnapshots?.[BUNDLED_KNOWLEDGE.id]).toEqual(BUNDLED_KNOWLEDGE);
    expect(next.rows[3]!.gearScore).not.toBe(saved.rows[3]!.gearScore);
    expect(saved).toEqual(original);
  });
  it("separates explicitly selected leagues and keeps unsupported league research unknown", () => {
    const next = assessBatch(batch(), { ...settings(), league: "Hardcore Forbidden Rites" }, AT);
    expect(next.capture!.league).toBe("Forbidden Rites");
    expect(next.league).toBe("Hardcore Forbidden Rites");
    expect(next.rows[0]!.assessment).toMatchObject({ outcome: "review", patch: "unknown" });
  });
});
