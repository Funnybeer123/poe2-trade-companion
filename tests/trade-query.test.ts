import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { appraiseItem } from "../src/core/appraisal.js";
import { MOD_FAMILIES } from "../src/core/modKnowledge.js";
import { parseItemText } from "../src/core/parseItem.js";
import { buildStatCatalogue } from "../src/core/statIds.js";
import {
  EVALUATE_PROFILES,
  exchangeQueryFromBody,
  exchangeUrl,
  parseTradeUrl,
  toExchangeBody,
  toTradeSearchBody,
  tradeQueryFromBody,
  tradeQueryFromItem,
  tradeQueryUrl,
  tradeSearchUrl,
  waystoneTierOf,
  type ExchangeQuery,
  type TradeQuery,
} from "../src/core/tradeQuery.js";

const STATS: unknown = JSON.parse(
  readFileSync(new URL("../fixtures/trade/stats-subset.json", import.meta.url), "utf8"),
);
const CATALOGUE = buildStatCatalogue(STATS, MOD_FAMILIES);
const LIFE_ID = "explicit.stat_3299347043";
const FIRE_ID = "explicit.stat_3372524247";
const LIGHTNING_ID = "explicit.stat_1671376347";
const MOVE_ID = "explicit.stat_2250533757";
const SPIRIT_ID = "explicit.stat_3981240776";

describe("toTradeSearchBody", () => {
  it("emits the minimal body: online status and price ascending", () => {
    expect(toTradeSearchBody({ stats: [] })).toEqual({
      query: { status: { option: "online" } },
      sort: { price: "asc" },
    });
  });

  it("maps every filter family to the trade2 wire shape", () => {
    const query: TradeQuery = {
      name: " Temporalis ",
      type: "Silk Robe",
      term: "robe",
      category: "armour.chest",
      rarity: "unique",
      status: "onlineleague",
      stats: [
        {
          type: "and",
          filters: [
            { id: LIFE_ID, value: { min: 100 } },
            { id: FIRE_ID, value: { min: 20, max: 45 }, disabled: true },
          ],
        },
        { type: "not", filters: [{ id: MOVE_ID }] },
        { type: "count", filters: [{ id: FIRE_ID }, { id: LIGHTNING_ID }], value: { min: 1 } },
        {
          type: "weight",
          filters: [
            { id: FIRE_ID, value: { weight: 1 } },
            { id: LIGHTNING_ID, value: { weight: 1.5 } },
          ],
          value: { min: 60 },
        },
        {
          type: "weight2",
          filters: [{ id: LIFE_ID, value: { weight: 2, min: 50 } }],
          value: { min: 100, max: 400 },
          disabled: true,
        },
        // Empty and blank-id groups vanish; NaN bounds are dropped.
        { type: "and", filters: [] },
        { type: "and", filters: [{ id: "  " }, { id: SPIRIT_ID, value: { min: Number.NaN } }] },
      ],
      equipment: { pdps: { min: 300 }, aps: { min: 1.2, max: 1.8 }, es: {} },
      misc: {
        ilvl: { min: 78 },
        quality: { max: 20 },
        map_tier: { min: 15, max: 16 },
        corrupted: false,
        mirrored: true,
        identified: true,
      },
      trade: {
        price: { option: "exalted", min: 1, max: 50 },
        indexed: "1week",
        sale_type: "priced",
        account: "Seller",
        collapse: true,
      },
      sort: { key: "indexed", direction: "desc" },
    };
    expect(toTradeSearchBody(query)).toEqual({
      query: {
        status: { option: "onlineleague" },
        name: "Temporalis",
        type: "Silk Robe",
        term: "robe",
        stats: [
          {
            type: "and",
            filters: [
              { id: LIFE_ID, value: { min: 100 } },
              { id: FIRE_ID, value: { min: 20, max: 45 }, disabled: true },
            ],
          },
          { type: "not", filters: [{ id: MOVE_ID }] },
          { type: "count", filters: [{ id: FIRE_ID }, { id: LIGHTNING_ID }], value: { min: 1 } },
          {
            type: "weight",
            filters: [
              { id: FIRE_ID, value: { weight: 1 } },
              { id: LIGHTNING_ID, value: { weight: 1.5 } },
            ],
            value: { min: 60 },
          },
          {
            type: "weight2",
            filters: [{ id: LIFE_ID, value: { min: 50, weight: 2 } }],
            value: { min: 100, max: 400 },
            disabled: true,
          },
          { type: "and", filters: [{ id: SPIRIT_ID }] },
        ],
        filters: {
          type_filters: { filters: { category: { option: "armour.chest" }, rarity: { option: "unique" } } },
          equipment_filters: { filters: { pdps: { min: 300 }, aps: { min: 1.2, max: 1.8 } } },
          misc_filters: {
            filters: {
              ilvl: { min: 78 },
              quality: { max: 20 },
              map_tier: { min: 15, max: 16 },
              corrupted: { option: "false" },
              mirrored: { option: "true" },
              identified: { option: "true" },
            },
          },
          trade_filters: {
            filters: {
              price: { option: "exalted", min: 1, max: 50 },
              indexed: { option: "1week" },
              sale_type: { option: "priced" },
              account: { input: "Seller" },
              collapse: { option: "true" },
            },
          },
        },
      },
      sort: { indexed: "desc" },
    });
  });

  it("omits sale_type any, collapse false and empty trade filters", () => {
    const body = toTradeSearchBody({
      stats: [],
      trade: { sale_type: "any", collapse: false, price: {} },
    });
    expect(body).toEqual({ query: { status: { option: "online" } }, sort: { price: "asc" } });
  });
});

describe("toExchangeBody", () => {
  it("builds the bulk-exchange body the site posts", () => {
    expect(toExchangeBody({ have: ["divine", " divine ", ""], want: ["exalted"], minimum: 5.7 })).toEqual({
      query: { status: { option: "online" }, have: ["divine"], want: ["exalted"], minimum: 5 },
      sort: { have: "asc" },
      engine: "new",
    });
    expect(toExchangeBody({ have: ["chaos"], want: ["exalted"], status: "onlineleague", collapse: true, fulfillable: true, minimum: 0 })).toEqual({
      query: { status: { option: "onlineleague" }, have: ["chaos"], want: ["exalted"], collapse: true, fulfillable: true },
      sort: { have: "asc" },
      engine: "new",
    });
  });
});

describe("trade URLs", () => {
  it("builds the id, exchange and encoded-query forms", () => {
    expect(tradeSearchUrl("Runes of Aldur", "abcDEF")).toBe(
      "https://www.pathofexile.com/trade2/search/poe2/Runes%20of%20Aldur/abcDEF",
    );
    expect(exchangeUrl("Standard", "x1")).toBe("https://www.pathofexile.com/trade2/exchange/poe2/Standard/x1");
    const body = toTradeSearchBody({ type: "Ruby Ring", stats: [] });
    const url = tradeQueryUrl("Runes of Aldur", body);
    expect(url.startsWith("https://www.pathofexile.com/trade2/search/poe2/Runes%20of%20Aldur?q=")).toBe(true);
    expect(parseTradeUrl(url)).toEqual({ kind: "search", league: "Runes of Aldur", query: body });
  });

  it("parses the id form for searches and exchanges", () => {
    expect(parseTradeUrl("https://www.pathofexile.com/trade2/search/poe2/Runes%20of%20Aldur/abcDEF")).toEqual({
      kind: "search",
      league: "Runes of Aldur",
      searchId: "abcDEF",
    });
    expect(parseTradeUrl(" https://pathofexile.com/trade2/exchange/poe2/Standard/x1 ")).toEqual({
      kind: "exchange",
      league: "Standard",
      searchId: "x1",
    });
  });

  it("wraps a query-only export and refuses untrusted or malformed input", () => {
    const queryOnly = encodeURIComponent(JSON.stringify({ type: "Amulet", stats: [] }));
    expect(parseTradeUrl(`https://www.pathofexile.com/trade2/search/poe2/Standard?q=${queryOnly}`)).toEqual({
      kind: "search",
      league: "Standard",
      query: { query: { type: "Amulet", stats: [] } },
    });
    expect(parseTradeUrl("https://pathofexile.com.evil.example/trade2/search/poe2/Standard/id")).toBeUndefined();
    expect(parseTradeUrl("ftp://www.pathofexile.com/trade2/search/poe2/Standard/id")).toBeUndefined();
    expect(parseTradeUrl("https://user:pw@www.pathofexile.com/trade2/search/poe2/Standard/id")).toBeUndefined();
    expect(parseTradeUrl("https://www.pathofexile.com/account/view-profile/x")).toBeUndefined();
    expect(parseTradeUrl("https://www.pathofexile.com/trade2/search/poe2/Standard")).toBeUndefined();
    expect(parseTradeUrl("https://www.pathofexile.com/trade2/search/poe2/Standard?q=%7Bbad%7D")).toBeUndefined();
    expect(
      parseTradeUrl(
        `https://www.pathofexile.com/trade2/search/poe2/Standard?q=${encodeURIComponent('{"query":{"__proto__":{"x":1}}}')}`,
      ),
    ).toBeUndefined();
    expect(parseTradeUrl("not a url")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// tradeQueryFromItem
// ---------------------------------------------------------------------------

const UNIQUE = [
  "Item Class: Body Armours",
  "Rarity: Unique",
  "Temporalis",
  "Silk Robe",
  "--------",
  "Item Level: 80",
  "--------",
  "+20% to Fire Resistance",
].join("\n");

const RARE_RING = [
  "Item Class: Rings",
  "Rarity: Rare",
  "Doom Loop",
  "Ruby Ring",
  "--------",
  "Item Level: 81",
  "--------",
  "+120 to maximum Life",
  "+38% to Fire Resistance",
  "+31% to Lightning Resistance",
  "+15 to Strength",
  "--------",
  "Corrupted",
].join("\n");

const MAGIC_MACE = [
  "Item Class: One Hand Maces",
  "Rarity: Magic",
  "Entombing Bandit Mace of the Champion",
  "--------",
  "Item Level: 60",
  "--------",
  "+40 to maximum Life",
].join("\n");

const WAYSTONE = [
  "Item Class: Waystones",
  "Rarity: Magic",
  "Waystone (Tier 11)",
  "--------",
  "Waystone Tier: 11",
  "Magic Monsters: +30% (augmented)",
].join("\n");

const CURRENCY = [
  "Item Class: Stackable Currency",
  "Rarity: Currency",
  "Divine Orb",
  "--------",
  "Stack Size: 3/10",
].join("\n");

function appraised(text: string) {
  const parsed = parseItemText(text);
  return { parsed, appraisal: appraiseItem(text, { parsed, statIds: CATALOGUE }) };
}

describe("tradeQueryFromItem", () => {
  it("searches a unique by name and base", () => {
    expect(tradeQueryFromItem(parseItemText(UNIQUE))).toEqual({
      status: "online",
      stats: [],
      sort: { key: "price", direction: "asc" },
      name: "Temporalis",
      type: "Silk Robe",
    });
  });

  it("filters a rare by its strongest notable mods at 85% (Quick Price)", () => {
    const { parsed, appraisal } = appraised(RARE_RING);
    const query = tradeQueryFromItem(parsed, appraisal, CATALOGUE);
    expect(query.type).toBe("Ruby Ring");
    expect(query.rarity).toBe("nonunique");
    expect(query.misc).toEqual({ ilvl: { min: 78 }, corrupted: true });
    expect(query.stats).toHaveLength(1);
    const group = query.stats[0]!;
    expect(group.type).toBe("and");
    expect(group.filters).toHaveLength(3);
    expect(group.filters.map((filter) => filter.id)).toContain(LIFE_ID);
    expect(group.filters.find((filter) => filter.id === LIFE_ID)).toEqual({ id: LIFE_ID, value: { min: 102 } });
    expect(group.filters.find((filter) => filter.id === FIRE_ID)).toEqual({ id: FIRE_ID, value: { min: 32 } });
    // The wire body is what fetchComps' stat stage sends today.
    const body = toTradeSearchBody(query) as { query: { filters: unknown; type: string } };
    expect(body.query.type).toBe("Ruby Ring");
    expect(body.query.filters).toEqual({
      type_filters: { filters: { rarity: { option: "nonunique" } } },
      misc_filters: { filters: { ilvl: { min: 78 }, corrupted: { option: "true" } } },
    });
  });

  it("Exact Match keeps every resolvable affix at its full roll; Broad and Crafting Base keep none", () => {
    const { parsed, appraisal } = appraised(RARE_RING);
    const exact = tradeQueryFromItem(parsed, appraisal, CATALOGUE, EVALUATE_PROFILES["exact-match"]);
    const ids = exact.stats.flatMap((group) => group.filters.map((filter) => filter.id));
    expect(ids).toEqual(expect.arrayContaining([LIFE_ID, FIRE_ID, LIGHTNING_ID, "explicit.stat_4080418644"]));
    expect(exact.stats[0]!.filters.find((filter) => filter.id === LIFE_ID)?.value).toEqual({ min: 120 });

    const broad = tradeQueryFromItem(parsed, appraisal, CATALOGUE, EVALUATE_PROFILES.broad);
    expect(broad.stats).toEqual([]);
    expect(broad.misc).toEqual({ ilvl: { min: 78 } }); // no corrupted flag for a broad look

    const base = tradeQueryFromItem(parsed, appraisal, CATALOGUE, EVALUATE_PROFILES["crafting-base"]);
    expect(base.stats).toEqual([]);
    expect(base.misc).toEqual({ ilvl: { min: 81 } });
  });

  it("returns no stat filters without a catalogue (the caller shows why)", () => {
    const { parsed, appraisal } = appraised(RARE_RING);
    const query = tradeQueryFromItem(parsed, appraisal);
    expect(query.type).toBe("Ruby Ring");
    expect(query.stats).toEqual([]);
  });

  it("derives a magic item's base; a low roll is not notable for Quick Price but Exact Match keeps it", () => {
    const { parsed, appraisal } = appraised(MAGIC_MACE);
    const query = tradeQueryFromItem(parsed, appraisal, CATALOGUE);
    expect(query.type).toBe("Bandit Mace");
    expect(query.rarity).toBe("nonunique");
    expect(query.misc).toBeUndefined(); // ilvl 60: no floor, not corrupted
    expect(query.stats).toEqual([]); // +40 life is a tier-0 roll: nothing notable to filter on
    const exact = tradeQueryFromItem(parsed, appraisal, CATALOGUE, EVALUATE_PROFILES["exact-match"]);
    expect(exact.stats).toEqual([{ type: "and", filters: [{ id: LIFE_ID, value: { min: 40 } }] }]);
  });

  it("searches waystones by category and tier, and currency by name", () => {
    const waystone = parseItemText(WAYSTONE);
    expect(waystoneTierOf(waystone)).toBe(11);
    expect(tradeQueryFromItem(waystone)).toEqual({
      status: "online",
      stats: [],
      sort: { key: "price", direction: "asc" },
      category: "map.waystone",
      misc: { map_tier: { min: 11, max: 11 } },
    });
    expect(tradeQueryFromItem(parseItemText(CURRENCY))).toEqual({
      status: "online",
      stats: [],
      sort: { key: "price", direction: "asc" },
      type: "Divine Orb",
    });
  });

  it("searches an unidentified unique by base and rarity only", () => {
    const text = ["Item Class: Amulets", "Rarity: Unique", "Stellar Amulet", "--------", "Item Level: 70", "--------", "Unidentified"].join("\n");
    expect(tradeQueryFromItem(parseItemText(text))).toMatchObject({ type: "Stellar Amulet", rarity: "unique", stats: [] });
  });
});

// ---------------------------------------------------------------------------
// Body → model (the inverses)
// ---------------------------------------------------------------------------

/** Every filter family at once — the same shape the builder test pins. */
const FULL_QUERY: TradeQuery = {
  name: "Temporalis",
  type: "Silk Robe",
  term: "robe",
  category: "armour.chest",
  rarity: "unique",
  status: "onlineleague",
  stats: [
    {
      type: "and",
      filters: [
        { id: LIFE_ID, value: { min: 100 } },
        { id: FIRE_ID, value: { min: 20, max: 45 }, disabled: true },
      ],
    },
    { type: "not", filters: [{ id: MOVE_ID }] },
    { type: "count", filters: [{ id: FIRE_ID }, { id: LIGHTNING_ID }], value: { min: 1 } },
    {
      type: "weight",
      filters: [
        { id: FIRE_ID, value: { weight: 1 } },
        { id: LIGHTNING_ID, value: { weight: 1.5 } },
      ],
      value: { min: 60 },
    },
    {
      type: "weight2",
      filters: [{ id: LIFE_ID, value: { min: 50, weight: 2 } }],
      value: { min: 100, max: 400 },
      disabled: true,
    },
  ],
  equipment: { pdps: { min: 300 }, aps: { min: 1.2, max: 1.8 } },
  misc: {
    ilvl: { min: 78 },
    quality: { max: 20 },
    map_tier: { min: 15, max: 16 },
    corrupted: false,
    mirrored: true,
    identified: true,
  },
  trade: {
    price: { option: "exalted", min: 1, max: 50 },
    indexed: "1week",
    sale_type: "priced",
    account: "Seller",
    collapse: true,
  },
  sort: { key: "indexed", direction: "desc" },
};

describe("tradeQueryFromBody", () => {
  it("round-trips every body this module builds", () => {
    const bodies = [
      toTradeSearchBody(FULL_QUERY),
      toTradeSearchBody({ stats: [] }),
      toTradeSearchBody(tradeQueryFromItem(parseItemText(UNIQUE))),
      toTradeSearchBody(tradeQueryFromItem(parseItemText(WAYSTONE))),
      toTradeSearchBody(tradeQueryFromItem(parseItemText(CURRENCY))),
      toTradeSearchBody(
        tradeQueryFromItem(appraised(RARE_RING).parsed, appraised(RARE_RING).appraisal, CATALOGUE),
      ),
      toTradeSearchBody(
        tradeQueryFromItem(
          appraised(RARE_RING).parsed,
          appraised(RARE_RING).appraisal,
          CATALOGUE,
          EVALUATE_PROFILES["exact-match"],
        ),
      ),
    ];
    for (const body of bodies) {
      const { query, unsupported } = tradeQueryFromBody(body);
      expect(unsupported).toEqual([]);
      expect(toTradeSearchBody(query)).toEqual(body);
    }
  });

  it("rebuilds the typed model, not just the wire shape", () => {
    const { query } = tradeQueryFromBody(toTradeSearchBody(FULL_QUERY));
    expect(query).toEqual(FULL_QUERY);
  });

  it("lists what it cannot map and never throws", () => {
    const { query, unsupported } = tradeQueryFromBody({
      query: {
        status: { option: "wishlist" },
        name: 7,
        stats: [
          { type: "nonsense", filters: [] },
          { type: "and", filters: [{ id: LIFE_ID, value: { avg: 3 } }, { nope: true }] },
        ],
        filters: {
          armour_filters: { filters: { ar: { min: 1 } } },
          equipment_filters: { filters: { pdps: { min: 300 }, unknown_stat: { min: 1 } } },
          misc_filters: { filters: { ilvl: { min: 78 }, gem_sockets: "nope", veiled: { option: "maybe" } } },
          trade_filters: { filters: { price: { option: "ex" }, mystery: { option: "x" } } },
        },
        mystery: 1,
      },
      sort: { price: "asc", indexed: "desc" },
      extra: true,
    });
    expect(unsupported).toEqual([
      "extra",
      "query.status",
      "query.name",
      "query.stats[0].type",
      "query.stats[1].filters[0].value.avg",
      "query.stats[1].filters[1]",
      "query.filters.armour_filters",
      "query.filters.equipment_filters.filters.unknown_stat",
      "query.filters.misc_filters.filters.gem_sockets",
      "query.filters.misc_filters.filters.veiled",
      "query.filters.trade_filters.filters.mystery",
      "query.mystery",
      "sort.indexed",
    ]);
    // Everything it did understand survives.
    expect(query.equipment).toEqual({ pdps: { min: 300 } });
    expect(query.misc).toEqual({ ilvl: { min: 78 } });
    expect(query.trade).toEqual({ price: { option: "ex" } });
    expect(query.stats).toEqual([{ type: "and", filters: [{ id: LIFE_ID }] }]);
    expect(query.sort).toEqual({ key: "price", direction: "asc" });
  });

  it("returns an empty model for anything that is not a body", () => {
    expect(tradeQueryFromBody(null)).toEqual({ query: { stats: [] }, unsupported: [] });
    expect(tradeQueryFromBody("nope")).toEqual({ query: { stats: [] }, unsupported: [] });
    expect(tradeQueryFromBody({ query: 5 }).unsupported).toEqual(["query"]);
  });
});

describe("exchangeQueryFromBody", () => {
  it("round-trips the bulk-exchange bodies", () => {
    const queries: ExchangeQuery[] = [
      { have: ["divine"], want: ["exalted"], minimum: 5 },
      { have: ["chaos"], want: ["exalted"], status: "onlineleague", collapse: true, fulfillable: true },
      { have: [], want: [] },
    ];
    for (const source of queries) {
      const body = toExchangeBody(source);
      const { query, unsupported } = exchangeQueryFromBody(body);
      expect(unsupported).toEqual([]);
      expect(toExchangeBody(query)).toEqual(body);
    }
    expect(exchangeQueryFromBody(toExchangeBody(queries[1]!)).query).toEqual(queries[1]);
  });

  it("flags a foreign engine, sort or query key", () => {
    const { query, unsupported } = exchangeQueryFromBody({
      query: { status: { option: "any" }, have: ["divine", 3], want: "exalted", minimum: 0, weird: 1 },
      sort: { item: "desc" },
      engine: "old",
      extra: 1,
    });
    expect(unsupported).toEqual([
      "sort",
      "engine",
      "extra",
      "query.status",
      "query.have[1]",
      "query.want",
      "query.minimum",
      "query.weird",
    ]);
    expect(query).toEqual({ have: ["divine"], want: [] });
    expect(exchangeQueryFromBody(undefined)).toEqual({ query: { have: [], want: [] }, unsupported: [] });
  });
});
