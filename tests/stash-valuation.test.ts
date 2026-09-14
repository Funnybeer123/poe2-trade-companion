import { describe, expect, it } from "vitest";
import { defaultStashValuationSettings, evaluateStashItem, unavailableStashQuote,
  validateStashValuationSettings, type StashMarketQuote, type StashValuationSettings } from "../src/core/stashValuation.js";

const at = "2026-09-14T18:00:00.000Z";
const settings: StashValuationSettings = { ...defaultStashValuationSettings(), league: "Forbidden Rites", routingMode: "purpose" };
const item = (mods: string[], extra = "") => ["Item Class: Rings", "Rarity: Rare", "Doom Loop", "Ruby Ring",
  "--------", "Item Level: 82", "--------", ...mods, ...(extra ? ["--------", extra] : [])].join("\n");
const ordinary = item(["+18 to maximum Life", "+9% to Fire Resistance"]);
const craft = item(["+162 to maximum Life", "+40% to Chaos Resistance"]);
const quote = (extra: Partial<StashMarketQuote> = {}): StashMarketQuote => ({
  state: "priced", league: settings.league, provider: "trade2", fetchedAt: at, currency: "chaos",
  low: 2, fair: 3, high: 4, sampleSize: 6, candidateCount: 10, confidence: 75, reasons: ["Asking prices."], ...extra,
});
const score = (raw = ordinary, market = quote(), config = settings) => evaluateStashItem(raw, market, config, { at, row: 0, col: 0 });

describe("dump item market decisions", () => {
  it("requires the conservative estimate to be strictly over one chaos", () => {
    expect(score()).toMatchObject({ decision: "valuable", destination: "Sell", status: "planned", quote: { currency: "chaos" } });
    expect(score(ordinary, quote({ low: 1, fair: 1, high: 1 }))).toMatchObject({ decision: "leave", destination: "Dump", status: "stay" });
    expect(score(ordinary, quote({ low: 0.9, fair: 2 }))).toMatchObject({ decision: "review", destination: "Dump" });
  });
  it.each([
    { league: "Standard" }, { fetchedAt: "2026-09-13T18:00:00Z" }, { fetchedAt: "garbage" },
    { fetchedAt: "2026-09-15T18:00:00Z" }, { sampleSize: 2 }, { confidence: 40 },
    { low: Number.NaN }, { low: 10, fair: 1 }, { high: Number.POSITIVE_INFINITY },
  ])("retains items when market evidence is invalid: %o", extra => {
    expect(score(ordinary, quote(extra))).toMatchObject({ decision: "review", status: "stay", destination: "Dump" });
  });
  it("does not infer worthless or saleable items from missing prices or a generic unique floor", () => {
    const missing = unavailableStashQuote(settings.league, "HTTP 403", at);
    expect(score(ordinary, missing)).toMatchObject({ decision: "review", quote: { state: "unavailable" } });
    expect(score(ordinary, missing).quote.fair).toBeUndefined();
    expect(score(ordinary.replace("Rarity: Rare", "Rarity: Unique"), missing).decision).toBe("review");
  });
  it("keeps unrecognized or unidentified item copies for review", () => {
    expect(score("clipboard noise").decision).toBe("review");
    expect(score(item([], "Unidentified"))).toMatchObject({ decision: "review", gearScore: 0, craftScore: 0 });
  });
  it("reports unfamiliar mods instead of allowing a low heuristic score to call them junk", () => {
    const result = score(item(["Grants a never-seen power"]), quote({ low: 0.2, fair: 0.3, high: 0.5 }));
    expect(result.decision).toBe("review");
    expect(result.mods[0]?.familyId).toBeUndefined();
    expect(result.reasons.join(" ")).toContain("outside the scoring knowledge base");
  });
  it("keeps location, raw text, model version, and market evidence for later rescoring", () => {
    expect(score()).toMatchObject({ rawText: ordinary, sourceTab: "Dump", row: 0, col: 0, scoreVersion: expect.any(String),
      fingerprint: expect.any(String), quote: { sampleSize: 6, fetchedAt: at, league: settings.league } });
  });
  it.each(["", "garbage", "2026-09-14T17:59:59Z", at])("rejects invalid or elapsed provider evidence expiry: %s", validUntil => {
    const result = score(ordinary, quote({ validUntil }));
    expect(result).toMatchObject({ decision: "review", status: "stay" });
    expect(result.reasons.join(" ")).toContain("market evidence expiry is invalid or elapsed");
    expect(score(ordinary, quote({ validUntil, low: 0.2, fair: 0.3, high: 0.5 })).decision).toBe("review");
  });
  it("uses provider evidence expiry alongside the configured maximum age", () => {
    expect(score(ordinary, quote({ validUntil: "2026-09-14T18:00:01Z" })).decision).toBe("valuable");
    expect(score(ordinary, quote({ validUntil: "2026-09-15T18:00:01Z", fetchedAt: "2026-09-13T18:00:00Z" })).decision).toBe("review");
    expect(score(ordinary, quote({ validUntil: null as unknown as string })).decision).toBe("review");
    expect(score(ordinary, quote()).decision).toBe("valuable");
  });
});

describe("crafting candidates", () => {
  const missing = unavailableStashQuote(settings.league, "No comparable listings", at);
  it("routes sparse coherent strong gear without inventing a currency price", () => {
    const result = score(craft, missing);
    expect(result).toMatchObject({ decision: "craft", destination: "Craft", status: "planned", craftScore: 80 });
    expect(result.quote.fair).toBeUndefined();
    expect(result.reasons.join(" ")).toContain("not a profit estimate");
  });
  it("prioritizes a supported sale over speculative crafting", () => {
    expect(score(craft).decision).toBe("valuable");
  });
  it.each(["Corrupted", "Twice Corrupted", "  Twice\t Corrupted  ", "Mirrored", "  Mirrored  ", "Sanctified",
    "  sanctified  ", "Split", "Unmodifiable", "Cannot be modified", "Unidentified"])("does not craft %s items", marker => {
    expect(score(`${craft}\n--------\n${marker}`, missing)).toMatchObject({ decision: "review", craftScore: 0 });
  });
  it("excludes unknown explicit modifiers from automatic crafting even beside a strong known pair", () => {
    const result = score(`${craft}\nGrants an unfamiliar unique power`, missing);
    expect(result).toMatchObject({ decision: "review", craftScore: 0 });
    expect(result.reasons.join(" ")).toContain("Unrecognized explicit modifier lines exclude automated crafting");
    expect(score(`${craft}\nGrants an unfamiliar unique power (implicit)`, missing).decision).toBe("craft");
  });
  it("does not mistake implicit/enchant mods or duplicated families for strong explicit affixes", () => {
    expect(score(item(["+162 to maximum Life (implicit)", "+40% to Chaos Resistance (enchant)"]), missing).decision).toBe("review");
    expect(score(item(["+162 to maximum Life", "+180 to maximum Life"]), missing).decision).toBe("review");
  });
  it("does not claim crafting room on a full six-line rare", () => {
    const full = item(["+162 to maximum Life", "+40% to Chaos Resistance", "+35% to Fire Resistance", "+35% to Cold Resistance",
      "+35% to Lightning Resistance", "+100 to maximum Mana"]);
    expect(score(full, missing)).toMatchObject({ decision: "review", craftScore: 0 });
  });
  it("uses complete advanced groups to recognize a five-affix rare's remaining prefix", () => {
    const annotated = item([
      '{ Prefix Modifier "Strong life" (Tier: 1) — Life }', "+162(150-174) to maximum Life",
      '{ Prefix Modifier "Mana" (Tier: 2) — Mana }', "+100(90-104) to maximum Mana",
      '{ Suffix Modifier "Chaos" (Tier: 1) — Chaos, Resistance }', "+40(36-40)% to Chaos Resistance",
      '{ Suffix Modifier "Fire" (Tier: 2) — Fire, Resistance }', "+35(31-35)% to Fire Resistance",
      '{ Suffix Modifier "Cold" (Tier: 2) — Cold, Resistance }', "+35(31-35)% to Cold Resistance",
    ]);
    const result = score(annotated, missing);
    expect(result.decision).toBe("craft");
    expect(result.reasons.join(" ")).toContain("5 explicit lines in 2 prefix and 3 suffix groups; 1 prefix and 0 suffix slots remain");
    const withoutHeaders = annotated.split("\n").filter(line => !line.startsWith("{")).join("\n");
    expect(score(withoutHeaders, missing).craftScore).toBe(0);
  });
  it("scores jewel-scale modifiers and excludes full four-affix rare jewels from crafting", () => {
    const jewel = item(["6% increased maximum Life", "8% increased Attack Speed"]).replace("Item Class: Rings", "Item Class: Jewels");
    expect(score(jewel, missing).decision).toBe("craft");
    expect(score(`${jewel}\n8% increased maximum Energy Shield\n6% increased Skill Speed`, missing).craftScore).toBe(0);
  });
  it("counts supported hybrid lines together and still excludes full annotated rares", () => {
    const annotated = item([
      '{ Prefix Modifier "Hybrid" (Tier: 2) — Mana, Damage, Caster }', "70% increased Spell Damage", "+100 to maximum Mana",
      '{ Prefix Modifier "Life" (Tier: 1) — Life }', "+162 to maximum Life",
      '{ Suffix Modifier "Chaos" (Tier: 1) — Chaos, Resistance }', "+40% to Chaos Resistance",
      '{ Suffix Modifier "Fire" (Tier: 2) — Fire, Resistance }', "+35% to Fire Resistance",
      '{ Suffix Modifier "Cold" (Tier: 2) — Cold, Resistance }', "+35% to Cold Resistance",
    ]);
    expect(score(annotated, missing).decision).toBe("craft");
    expect(score(annotated, missing).reasons.join(" ")).toContain("6 explicit lines in 2 prefix and 3 suffix groups");
    const full = score(annotated + '\n{ Prefix Modifier "Shield" }\n+50 to maximum Energy Shield', missing);
    expect(full).toMatchObject({ decision: "review", craftScore: 0 });
    expect(full.reasons.join(" ")).toContain("0 prefix and 0 suffix slots remain");
  });
  it.each([
    "--------\n+35% to Cold Resistance", "+35% to Cold Resistance",
    '{ Suffix Modifier "Cold" (Tier: 2)\n+35% to Cold Resistance',
    "{ Explicit Modifier }\n+35% to Cold Resistance",
    '{ Suffix Modifier "Empty" }\n{ Suffix Modifier "Cold" }\n+35% to Cold Resistance',
  ])("falls back conservatively for incomplete annotations: %s", ending => {
    const annotated = item([
      '{ Prefix Modifier "Life" }', "+162 to maximum Life", '{ Prefix Modifier "Mana" }', "+100 to maximum Mana",
      '{ Suffix Modifier "Chaos" }', "+40% to Chaos Resistance", '{ Suffix Modifier "Fire" }', "+35% to Fire Resistance", ending,
    ]);
    const result = score(annotated, missing);
    expect(result).toMatchObject({ decision: "review", craftScore: 0 });
    expect(result.reasons.join(" ")).toMatch(/incomplete or ambiguous|exceed ordinary rare limits/);
    expect(result.reasons.join(" ")).not.toContain("slots remain");
  });
  it("ignores implicit/enchant affix annotations and retains unknown-mod gates", () => {
    const annotated = item([
      '{ Implicit Modifier — Life }', "+10 to maximum Life", '{ Enchant Modifier }', "+12 to maximum Mana", "--------",
      '{ Prefix Modifier "Life" }', "+162 to maximum Life", '{ Suffix Modifier "Chaos" }', "+40% to Chaos Resistance",
    ]);
    expect(score(annotated, missing).reasons.join(" ")).toContain("2 explicit lines in 1 prefix and 1 suffix groups");
    const unknown = score(annotated + '\n{ Suffix Modifier "Unknown" }\nGrants an unfamiliar power', missing);
    expect(unknown).toMatchObject({ decision: "review", craftScore: 0 });
  });
  it.each([
    ["Minions deal 16% increased Damage", "8% increased Attack Speed"],
    ["16% increased Minion Damage", "8% increased Attack Speed"],
    ["16% increased Damage", "Minions have 8% increased Attack and Cast Speed"],
    ["16% increased Spell Damage", "Minions have 8% increased Attack and Cast Speed"],
    ["16% increased Attack Damage", "8% increased Cast Speed"],
    ["16% increased Damage with Bow Skills", "8% increased Cast Speed"],
    ["16% increased Minion Damage", "20% increased Critical Hit Chance"],
  ])("does not pool incompatible jewel modifiers: %s / %s", (first, second) => {
    const jewel = item([first, second]).replace("Item Class: Rings", "Item Class: Jewels");
    const result = score(jewel, missing);
    expect(result.decision).toBe("review");
    expect(result.craftScore).toBeLessThan(70);
    expect(result.reasons.join(" ")).toContain("do not share a supported crafting archetype");
  });
  it.each([
    ["6% increased maximum Life", "8% increased Attack Speed", "player-attack"],
    ["6% increased maximum Life", "8% increased maximum Energy Shield", "general-defence"],
    ["16% increased Spell Damage", "8% increased Cast Speed", "player-caster"],
    ["16% increased Attack Damage", "8% increased Attack Speed", "player-attack"],
    ["16% increased Damage with Bow Skills", "8% increased Attack Speed", "player-attack"],
    ["Minions deal 16% increased Damage", "Minions have 8% increased Attack and Cast Speed", "minion"],
  ])("retains coherent jewel candidates: %s / %s", (first, second, archetype) => {
    const jewel = item([first, second]).replace("Item Class: Rings", "Item Class: Jewels");
    const result = score(jewel, missing);
    expect(result).toMatchObject({ decision: "craft", craftScore: 80 });
    expect(result.reasons.join(" ")).toContain(`${archetype} scoring archetype`);
  });
  it.each(["Minions have 7% increased maximum Life", "Offerings have 20% increased maximum Life",
    "Your Totems have 20% increased maximum Life", "Nearby Allies have 20% increased maximum Life",
    "20% increased maximum Life of Minions", "20% increased maximum Life for Totems"])("does not assign player-life points to other entities: %s", mod => {
    const jewel = item([mod]).replace("Item Class: Rings", "Item Class: Jewels");
    const result = score(jewel, missing);
    expect(result).toMatchObject({ gearScore: 0, craftScore: 0, decision: "review", rawText: jewel });
    expect(result.mods[0]).toMatchObject({ text: mod, points: 0 });
    expect(result.mods[0]?.familyId).toBeUndefined();
    expect(score(`${jewel}\n8% increased Attack Speed`, missing).decision).toBe("review");
  });
  it("can assess physical crafting potential independently of an expired currency quote", () => {
    const result = score(craft, quote({ validUntil: at }));
    expect(result.decision).toBe("craft");
    expect(result.reasons.join(" ")).toContain("quote was rejected");
  });
  it("keeps observed accessory tiers separate from generic bands and recognizes coherent ES crafting room", () => {
    const dusk = item([
      '{ Prefix Modifier "Incandescent" (Tier: 1) — Energy Shield }', "+88(80-89) to maximum Energy Shield",
      '{ Prefix Modifier "Indomitable" (Tier: 2) — Energy Shield }', "39(39-44)% increased maximum Energy Shield",
      '{ Suffix Modifier "of the Leviathan" (Tier: 2) — Attribute }', "+29(28-30) to Strength",
      '{ Suffix Modifier "of the Lightning" (Tier: 2) — Elemental, Lightning, Resistance }', "+40(36-40)% to Lightning Resistance",
    ]).replace("Item Class: Rings", "Item Class: Amulets");
    const result = score(dusk, missing);
    expect(result).toMatchObject({ decision: "craft", craftScore: 85, rawText: dusk });
    expect(result.mods[0]).toMatchObject({ familyId: "energy-shield-flat", tier: 3, craftTier: 1,
      observedAffix: { kind: "prefix", name: "Incandescent", tier: 1 } });
    expect(result.mods[1]).toMatchObject({ familyId: "energy-shield-percent", craftTier: 2 });
    expect(result.reasons.join(" ")).toContain("1 prefix and 1 suffix slots remain");
    expect(result.reasons.join(" ")).toContain("Modifier tiers do not establish market value");
    expect(score(dusk.replace('(Tier: 1)', '(Tier: 4)'), missing).decision).toBe("review");
    expect(score(dusk + '\n{ Suffix Modifier "Unknown" (Tier: 1) }\nAn unrecognized power', missing).craftScore).toBe(0);
  });
  it("recognizes Loath Beads' single remaining prefix without promoting weak or full accessories", () => {
    const loath = item([
      '{ Prefix Modifier "Incandescent" (Tier: 1) — Energy Shield }', "+81(80-89) to maximum Energy Shield",
      '{ Prefix Modifier "Virile" (Tier: 2) — Life }', "+113(100-119) to maximum Life",
      '{ Suffix Modifier "of the Walrus" (Tier: 4) — Cold, Resistance }', "+26(26-30)% to Cold Resistance",
      '{ Suffix Modifier "of the Multiverse" (Tier: 2) — Attribute }', "+21(21-22) to all Attributes",
      '{ Suffix Modifier "of the Maelstrom" (Tier: 3) — Lightning, Resistance }', "+34(31-35)% to Lightning Resistance",
    ]).replace("Item Class: Rings", "Item Class: Amulets");
    expect(score(loath, missing)).toMatchObject({ decision: "craft", craftScore: 85 });
    expect(score(loath, missing).reasons.join(" ")).toContain("1 prefix and 0 suffix slots remain");
    expect(score(loath + '\n{ Prefix Modifier "Mana" (Tier: 1) }\n+170 to maximum Mana', missing).craftScore).toBe(0);
  });
  it("does not treat a single hybrid as two independently strong retained affixes", () => {
    const hybrid = item(['{ Prefix Modifier "Hybrid" (Tier: 1) — Mana, Damage, Caster }',
      "100% increased Spell Damage", "+160 to maximum Mana"]).replace("Item Class: Rings", "Item Class: Wands");
    expect(score(hybrid, missing).decision).toBe("review");
    expect(score(hybrid + '\n{ Suffix Modifier "Speed" (Tier: 1) }\n30% increased Cast Speed', missing).decision).toBe("craft");
  });
  it("does not apply copied jewel Tier 1 labels as accessory strength or trust incomplete tier evidence", () => {
    const jewel = item(['{ Prefix Modifier "Shield" (Tier: 1) }', "10% increased maximum Energy Shield",
      '{ Suffix Modifier "Speed" (Tier: 1) }', "2% increased Attack Speed"]).replace("Item Class: Rings", "Item Class: Jewels");
    expect(score(jewel, missing).decision).toBe("review");
    expect(score(jewel, missing).mods.every(mod => mod.craftTier === undefined)).toBe(true);
    const incomplete = item(['{ Prefix Modifier "Life" (Tier: 1) }', "+18 to maximum Life", "--------", "+40% to Chaos Resistance"]);
    expect(score(incomplete, missing).decision).toBe("review");
    expect(score(incomplete, missing).mods.every(mod => mod.craftTier === undefined)).toBe(true);
  });
  it("exposes editable multipliers and retains raw rolls", () => {
    const tuned = score(craft, missing, { ...settings, weights: { life: 0 } });
    expect(tuned.decision).toBe("review");
    expect(tuned.gearScore).toBeLessThan(score(craft, missing).gearScore);
    expect(tuned.mods.find(mod => mod.familyId === "life")).toMatchObject({ points: 0, multiplier: 0 });
  });
});

describe("valuation settings", () => {
  it("uses the user's G folder and exact class tab names for qualifying items", () => {
    const config = { ...defaultStashValuationSettings(), league: settings.league };
    expect(config.destinationFolder).toBe("G");
    expect(score(ordinary, quote(), config).destination).toBe("Rings");
    expect(score(ordinary.replace("Item Class: Rings", "Item Class: Body Armours"), quote(), config).destination).toBe("Body Armour");
    expect(score(craft, unavailableStashQuote(settings.league, "No comps", at), config)).toMatchObject({ decision: "craft", destination: "Rings" });
    expect(score(ordinary.replace("Item Class: Rings", "Item Class: One Hand Axes"), quote(), config)).toMatchObject({ decision: "review", destination: "Dump" });
  });
  it("requires an explicit league before starting", () => {
    expect(validateStashValuationSettings(defaultStashValuationSettings()).join(" ")).toMatch(/exact league/i);
    expect(validateStashValuationSettings(settings)).toEqual([]);
  });
  it("rejects nonfinite thresholds, unsafe tab names and unknown scoring knobs", () => {
    expect(validateStashValuationSettings({ ...settings, minChaos: Number.NaN, craftTab: "Dump", weights: { nonsense: 8 } }).length).toBe(3);
    expect(validateStashValuationSettings({ ...settings, valuableTab: "~price 1 chaos" }).length).toBe(1);
  });
});
