import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateWithAppraisal } from "../src/core/appraisal.js";
import {
  applyProfile,
  boundsFor,
  complexityHint,
  initialQueryState,
  profileOf,
  queryStateToTradeQuery,
  sanitizeQueryState,
  type BuildStateInput,
} from "../src/core/evaluateQuery.js";
import { parseAdvancedItemText } from "../src/core/itemAnnotations.js";
import { MOD_FAMILIES } from "../src/core/modKnowledge.js";
import { parseItemText } from "../src/core/parseItem.js";
import { buildStatCatalogue } from "../src/core/statIds.js";
import { toTradeSearchBody, type EvaluateProfileId } from "../src/core/tradeQuery.js";
import { DEFAULT_EVALUATE_SETTINGS, type EvaluateSettings } from "../src/shared/evaluate.js";

const STATS = JSON.parse(
  readFileSync(new URL("../fixtures/trade/stats-subset.json", import.meta.url), "utf8"),
) as unknown;

const CATALOGUE = buildStatCatalogue(STATS, MOD_FAMILIES, [
  "explicit",
  "implicit",
  "pseudo",
  "rune",
  "enchant",
  "fractured",
  "desecrated",
]);

function fixture(name: string): string {
  return readFileSync(new URL(`../fixtures/evaluate/${name}`, import.meta.url), "utf8");
}

function build(
  raw: string,
  profile?: EvaluateProfileId,
  settings: EvaluateSettings = DEFAULT_EVALUATE_SETTINGS,
  withCatalogue = true,
) {
  const advanced = parseAdvancedItemText(raw);
  const parsed = parseItemText(advanced.plainText);
  const verdict = evaluateWithAppraisal(raw, { rules: { keep: [], sell: [], dump: [] } });
  const input: BuildStateInput = {
    parsed,
    advanced,
    ...(verdict.appraisal ? { appraisal: verdict.appraisal } : {}),
    ...(withCatalogue ? { catalogue: CATALOGUE } : {}),
    settings,
    ...(profile ? { profile } : {}),
  };
  return { state: initialQueryState(input), parsed, input };
}

function row(state: ReturnType<typeof build>["state"], key: string) {
  return state.rows.find((entry) => entry.key === key);
}

describe("initialQueryState — Quick Price", () => {
  const { state } = build(fixture("rare-ring-resists.txt"));

  it("builds the design's worked example body", () => {
    expect(toTradeSearchBody(queryStateToTradeQuery(state))).toEqual({
      query: {
        status: { option: "online" },
        type: "Ruby Ring",
        stats: [
          {
            type: "and",
            filters: [
              { id: "explicit.stat_3299347043", value: { min: 61 } },
              { id: "pseudo.pseudo_total_elemental_resistance", value: { min: 72 } },
            ],
          },
        ],
        filters: {
          type_filters: { filters: { rarity: { option: "nonunique" } } },
          misc_filters: { filters: { ilvl: { min: 78 } } },
        },
      },
      sort: { price: "asc" },
    });
  });

  it("marks the lines a ticked pseudo speaks for and leaves them unticked", () => {
    const fire = state.rows.find((entry) => entry.label === "+31% to Fire Resistance");
    expect(fire?.consumedBy).toBe("pseudo:total_elemental_resistance");
    expect(fire?.enabled).toBe(false);
    // Only one resistance total is ticked: they contain each other.
    const ticked = state.rows.filter((entry) => entry.kind === "pseudo" && entry.enabled);
    expect(ticked.map((entry) => entry.key)).toEqual(["pseudo:total_elemental_resistance"]);
  });

  it("never ticks the socketed rune line (it is not the item's substance)", () => {
    expect(state.rows.some((entry) => entry.label.includes("Strength"))).toBe(false);
  });
});

describe("the advanced copy (Ctrl+Alt+C)", () => {
  it("labels each row with its affix side, name and printed tier", () => {
    const { state } = build(fixture("rare-gloves-advanced-copy.txt"), "exact-match");
    const cold = state.rows.find((entry) => entry.label.includes("Cold Damage"));
    expect(cold).toMatchObject({ affix: "prefix", modName: "Glaciated", tier: 3, tierSource: "copy" });
    const life = state.rows.find((entry) => entry.label === "+48 to maximum Life");
    expect(life).toMatchObject({ affix: "suffix", modName: "Robust", tier: 2 });
    const crafted = state.rows.find((entry) => entry.label.includes("to Strength"));
    expect(crafted?.affix).toBe("suffix");
    // The implicit is not the item's substance on a rare: no row for it.
    expect(state.rows.some((entry) => entry.label === "+12 to maximum Life")).toBe(false);
  });

  it("offers a flask's own modifiers and reads each one's direction", () => {
    const { state } = build(fixture("flask-life.txt"), "exact-match");
    // "reduced Charges per use" is a BENEFIT: the direction list (F4
    // itemStats.LOWER_IS_BETTER) only marks real penalties.
    const charges = state.rows.find((entry) => entry.label.includes("Charges per use"));
    expect(charges?.lowerIsBetter).toBe(false);
    const movement = state.rows.find((entry) => entry.label.includes("Movement Speed during Effect"));
    expect(movement?.lowerIsBetter).toBe(false);
  });

  it("bounds a real penalty from above instead of asking for more of it", () => {
    const { state } = build(
      [
        "Item Class: Boots",
        "Rarity: Rare",
        "Doom Stride",
        "Iron Greaves",
        "--------",
        "Item Level: 80",
        "--------",
        "12% reduced Movement Speed",
      ].join("\n"),
      "quick-price",
    );
    const penalty = state.rows.find((entry) => entry.label.includes("reduced Movement Speed"));
    expect(penalty?.lowerIsBetter).toBe(true);
  });
});

describe("profiles", () => {
  it("Exact Match pins every searchable mod at its own roll and adds the properties", () => {
    const { state } = build(fixture("weapon-quarterstaff.txt"), "exact-match");
    const physical = state.rows.find((entry) => entry.label.includes("increased Physical Damage"));
    expect(physical?.enabled).toBe(true);
    expect(physical?.min).toBe(118);
    expect(physical?.max).toBe(118);
    expect(row(state, "prop:dps")?.enabled).toBe(true);
    expect(state.rows.every((entry) => entry.kind !== "pseudo" || !entry.enabled)).toBe(true);
  });

  it("leaves Exact Match's PROPERTY rows open-ended (a pinned decimal DPS matches nothing)", () => {
    const { state } = build(fixture("weapon-quarterstaff.txt"), "exact-match");
    const dps = row(state, "prop:dps");
    expect(dps?.enabled).toBe(true);
    expect(dps?.max).toBeUndefined();
    expect(dps?.min).toBeCloseTo(dps?.value ?? 0, 2);
    const equipment = queryStateToTradeQuery(state).equipment ?? {};
    expect(equipment.dps?.max).toBeUndefined();
  });

  it("Quick Price ticks the DPS property for a weapon at the profile's slack", () => {
    const { state } = build(fixture("weapon-quarterstaff.txt"));
    const dps = row(state, "prop:dps");
    expect(dps?.enabled).toBe(true);
    expect(dps?.min).toBeCloseTo((dps?.value ?? 0) * 0.85, 1);
    expect(dps?.max).toBeUndefined();
  });

  it("Crafting Base keeps the item level floor and ticks no properties", () => {
    const { state } = build(fixture("weapon-quarterstaff.txt"), "crafting-base");
    expect(state.ilvl).toEqual({ min: 79, enabled: true });
    expect(state.rows.some((entry) => entry.kind === "property" && entry.enabled)).toBe(false);
    expect(state.rows.some((entry) => entry.kind === "mod" && entry.enabled)).toBe(false);
  });

  it("Broad ticks at most two lines and drops the item-level floor", () => {
    const { state } = build(fixture("weapon-quarterstaff.txt"), "broad");
    expect(state.ilvl.enabled).toBe(false);
    expect(state.rows.filter((entry) => entry.kind === "mod" && entry.enabled).length).toBeLessThanOrEqual(2);
  });

  it("takes the percentages and mod caps from settings", () => {
    const settings: EvaluateSettings = {
      ...DEFAULT_EVALUATE_SETTINGS,
      profiles: { ...DEFAULT_EVALUATE_SETTINGS.profiles, "quick-price": { slack: 0.5, maxMods: 1 } },
    };
    expect(profileOf("quick-price", settings)).toEqual({ id: "quick-price", slack: 0.5, maxMods: 1 });
    expect(profileOf("exact-match", settings).maxMods).toBe(Number.POSITIVE_INFINITY);
    const { state } = build(fixture("weapon-quarterstaff.txt"), "quick-price", settings);
    expect(state.rows.filter((entry) => entry.kind === "mod" && entry.enabled).length).toBe(1);
  });

  it("applyProfile keeps the user's identity edits while re-selecting the rows", () => {
    const { state } = build(fixture("rare-ring-resists.txt"));
    const edited = { ...state, type: "Sapphire Ring", status: "any" as const };
    const next = applyProfile(edited, profileOf("broad", DEFAULT_EVALUATE_SETTINGS), DEFAULT_EVALUATE_SETTINGS);
    expect(next.type).toBe("Sapphire Ring");
    expect(next.status).toBe("any");
    expect(next.profile).toBe("broad");
  });
});

describe("boundsFor", () => {
  it("asks for the profile's share of a positive roll", () => {
    expect(boundsFor({ value: 72, lowerIsBetter: false }, 0.85)).toEqual({ min: 61 });
    expect(boundsFor({ value: 72, lowerIsBetter: false }, 1)).toEqual({ min: 72, max: 72 });
  });

  it("loosens a negative roll instead of tightening it", () => {
    expect(boundsFor({ value: -17, lowerIsBetter: false }, 0.85)).toEqual({ min: -20 });
  });

  it("bounds a penalty from above", () => {
    expect(boundsFor({ value: 10, lowerIsBetter: true }, 0.85)).toEqual({ max: 12 });
    expect(boundsFor({ value: 10, lowerIsBetter: true }, 1)).toEqual({ min: 10, max: 10 });
  });

  it("keeps decimals for fractional rolls and says nothing about a zero", () => {
    expect(boundsFor({ value: 1.4, lowerIsBetter: false }, 0.85)).toEqual({ min: 1.19 });
    expect(boundsFor({ value: 0, lowerIsBetter: false }, 0.85)).toEqual({});
    expect(boundsFor({ lowerIsBetter: false }, 0.85)).toEqual({});
  });
});

describe("queryStateToTradeQuery", () => {
  it("turns a line that matched several catalogue ids into a count group", () => {
    const { state } = build(
      [
        "Item Class: Amulets",
        "Rarity: Rare",
        "Soul Thread",
        "Stellar Amulet",
        "--------",
        "Item Level: 80",
        "--------",
        "+12 to all Attributes",
      ].join("\n"),
      "exact-match",
    );
    const query = queryStateToTradeQuery(state);
    const group = query.stats.find((entry) => entry.type === "count");
    expect(group?.filters.map((filter) => filter.id).sort()).toEqual([
      "explicit.stat_1379411836",
      "explicit.stat_2897413282",
    ]);
    expect(group?.value).toEqual({ min: 1 });
  });

  it("maps the tri-state flags and the modifiable-only shortcut", () => {
    const { state } = build(fixture("rare-ring-resists.txt"));
    const flagged = { ...state, flags: { ...state.flags, corrupted: false, desecrated: true } };
    expect(queryStateToTradeQuery(flagged).misc).toMatchObject({ corrupted: false, desecrated_item: true });

    const modifiable = { ...state, flags: { ...state.flags, modifiableOnly: true } };
    expect(queryStateToTradeQuery(modifiable).misc).toMatchObject({
      corrupted: false,
      mirrored: false,
      sanctified: false,
    });
  });

  it("sends the sockets, the open-affix pseudo and the search filters", () => {
    const { state } = build(fixture("rare-ring-resists.txt"));
    const next = {
      ...state,
      runeSockets: { min: 2, enabled: true },
      openAffixes: { count: 3, enabled: true, statId: "pseudo.pseudo_empty" },
      indexed: "1week" as const,
      priceCurrency: "divine" as const,
    };
    const query = queryStateToTradeQuery(next);
    expect(query.equipment?.rune_sockets).toEqual({ min: 2 });
    expect(query.stats[0]?.filters.some((filter) => filter.id === "pseudo.pseudo_empty")).toBe(true);
    expect(query.trade).toEqual({ price: { option: "divine" }, indexed: "1week" });
  });

  it("leaves the stat filters out entirely when no catalogue is loaded", () => {
    const { state } = build(fixture("rare-ring-resists.txt"), "quick-price", DEFAULT_EVALUATE_SETTINGS, false);
    expect(state.rows.every((entry) => entry.kind === "property" || entry.statIds.length === 0)).toBe(true);
    expect(state.rows.find((entry) => entry.kind === "mod")?.unsearchableReason).toContain("catalogue");
    expect(queryStateToTradeQuery(state).stats).toEqual([]);
  });
});

describe("item-kind seeds", () => {
  it("searches a stackable by its type and a waystone by tier", () => {
    const currency = build(fixture("currency-divine.txt")).state;
    expect(currency.type).toBe("Divine Orb");

    const waystone = build(
      [
        "Item Class: Waystones",
        "Rarity: Normal",
        "Waystone (Tier 11)",
        "--------",
        "Waystone Tier: 11",
        "--------",
        "Item Level: 79",
      ].join("\n"),
    ).state;
    expect(waystone.category).toBe("map.waystone");
    expect(waystone.mapTier).toEqual({ min: 11, max: 11, enabled: true });
  });

  it("searches an unidentified unique by base and rarity, with the variant list open", () => {
    const { state } = build(fixture("unidentified-unique-bow.txt"));
    expect(state.type).toBe("Crude Bow");
    expect(state.rarity).toBe("unique");
    expect(state.flags.identified).toBe(false);
  });

  it("ticks the gem's level and quality", () => {
    const { state } = build(fixture("gem-support.txt"));
    expect(state.gemLevel).toEqual({ min: 18, enabled: true });
    expect(state.quality).toEqual({ min: 16, enabled: true });
  });
});

describe("complexityHint", () => {
  it("warns before a wide query is sent, not after trade2 refuses it", () => {
    const many = {
      stats: [
        {
          type: "and" as const,
          filters: Array.from({ length: 13 }, (_, index) => ({ id: `explicit.stat_${index}` })),
        },
      ],
    };
    expect(complexityHint(many)).toContain("13 stat filters");
    const wide = {
      stats: [
        {
          type: "count" as const,
          filters: Array.from({ length: 5 }, (_, index) => ({ id: `explicit.stat_${index}` })),
          value: { min: 1 },
        },
      ],
    };
    expect(complexityHint(wide)).toContain("many stat ids");
    expect(complexityHint({ stats: [] })).toBeUndefined();
  });
});

describe("sanitizeQueryState", () => {
  const { state } = build(fixture("rare-ring-resists.txt"));

  it("takes the toggles and bounds the renderer sent", () => {
    const incoming = {
      ...state,
      rows: state.rows.map((entry) => ({ ...entry, enabled: entry.kind === "mod", min: 5 })),
      status: "any",
      indexed: "1day",
    };
    const clean = sanitizeQueryState(incoming, state);
    expect(clean.status).toBe("any");
    expect(clean.indexed).toBe("1day");
    expect(clean.rows.find((entry) => entry.kind === "mod")?.min).toBe(5);
  });

  it("ignores NaN bounds, unknown enums, foreign rows and labels it never built", () => {
    const clean = sanitizeQueryState(
      {
        profile: "not-a-profile",
        rarity: "legendary",
        status: "whenever",
        indexed: "forever",
        priceCurrency: "mirror",
        rows: [
          { key: "mod:4:1", enabled: true, min: Number.NaN, max: "abc" },
          { key: "mod:9:9", enabled: true, min: 1 },
          { key: "pseudo:total_elemental_resistance", enabled: true, label: "anything I like", statIds: ["evil"] },
        ],
        flags: { modifiableOnly: "yes" },
      },
      state,
    );
    expect(clean.profile).toBe(state.profile);
    expect(clean.rarity).toBe(state.rarity);
    expect(clean.status).toBe(state.status);
    expect(clean.indexed).toBe(state.indexed);
    expect(clean.priceCurrency).toBe(state.priceCurrency);
    expect(clean.rows.map((entry) => entry.key)).toEqual(state.rows.map((entry) => entry.key));
    // An unusable bound is no bound at all — never NaN, and never the old
    // one smuggled back in (the user may be widening the search on purpose).
    const life = clean.rows.find((entry) => entry.key === "mod:4:1");
    expect(life?.min).toBeUndefined();
    expect(life?.max).toBeUndefined();
    const pseudo = clean.rows.find((entry) => entry.key === "pseudo:total_elemental_resistance");
    expect(pseudo?.label).toBe(
      state.rows.find((entry) => entry.key === "pseudo:total_elemental_resistance")?.label,
    );
    expect(pseudo?.statIds).toEqual(["pseudo.pseudo_total_elemental_resistance"]);
    expect(clean.flags.modifiableOnly).toBe(false);
  });

  it("cannot enable a row that has no trade2 stat behind it", () => {
    const { state: bare } = build(
      fixture("rare-ring-resists.txt"),
      "quick-price",
      DEFAULT_EVALUATE_SETTINGS,
      false,
    );
    const clean = sanitizeQueryState(
      { rows: bare.rows.map((entry) => ({ key: entry.key, enabled: true })) },
      bare,
    );
    expect(clean.rows.every((entry) => entry.kind === "property" || !entry.enabled)).toBe(true);
  });

  it("lets the user WIDEN a row: a cleared Min box removes the bound", () => {
    const life = state.rows.find((entry) => entry.key === "mod:4:1");
    expect(life?.min).toBe(61);
    const incoming = {
      ...state,
      // What ModFilterRow emits when the box is emptied, plus the shapes a
      // slightly different renderer might send for "nothing here".
      rows: state.rows.map((entry) =>
        entry.key === "mod:4:1"
          ? { ...entry, min: undefined, max: undefined }
          : entry.key === "mod:4:2"
            ? { ...entry, min: "", max: null }
            : entry,
      ),
    };
    const clean = sanitizeQueryState(incoming, state);
    const cleared = clean.rows.find((entry) => entry.key === "mod:4:1");
    expect(cleared?.min).toBeUndefined();
    expect(cleared?.max).toBeUndefined();
    expect(cleared?.enabled).toBe(true);
    const blank = clean.rows.find((entry) => entry.key === "mod:4:2");
    expect(blank?.min).toBeUndefined();
    expect(blank?.max).toBeUndefined();

    // …and the body that goes to trade2 carries no value for that filter.
    const filters = queryStateToTradeQuery(clean).stats.flatMap((group) => group.filters);
    const sent = filters.find((entry) => entry.id === cleared?.statIds[0]);
    expect(sent).toBeDefined();
    expect(sent?.value).toBeUndefined();
  });

  it("only enables the open-affix filter when the catalogue gave it an id", () => {
    const clean = sanitizeQueryState(
      { openAffixes: { count: 3, enabled: true } },
      { ...state, openAffixes: { count: 3, enabled: false } },
    );
    expect(clean.openAffixes.enabled).toBe(false);
  });
});
