import { describe, expect, it } from "vitest";
import {
  MARKET_SORT_KEYS,
  defaultColour,
  defaultTabLabel,
  draftBody,
  draftFingerprint,
  emptyExchangeDraft,
  emptySearchDraft,
  isTwiceCorruptedExclusive,
  sanitizeDraft,
  tradeQueryFromBody,
  type MarketDraft,
} from "../src/core/marketQuery.js";
import { toTradeSearchBody, type TradeQuery } from "../src/core/tradeQuery.js";

function search(query: Partial<TradeQuery>): MarketDraft {
  return { kind: "search", query: { stats: [], ...query } };
}

describe("market drafts", () => {
  it("seeds a new search from the Market defaults", () => {
    const draft = emptySearchDraft({ defaultStatus: "any", defaultSaleType: "unpriced" });
    expect(draft.kind).toBe("search");
    if (draft.kind !== "search") throw new Error("unreachable");
    expect(draft.query.status).toBe("any");
    expect(draft.query.trade?.sale_type).toBe("unpriced");
    expect(draft.query.sort).toEqual({ key: "price", direction: "asc" });
  });

  it("maps the instant-buyout default onto priced_with_price", () => {
    const draft = emptySearchDraft({ defaultInstantBuyout: true });
    if (draft.kind !== "search") throw new Error("unreachable");
    expect(draft.query.trade?.sale_type).toBe("priced_with_price");
  });

  it("builds the right body for each kind", () => {
    expect(draftBody(search({ type: "Ruby Ring" })).query).toMatchObject({ type: "Ruby Ring" });
    expect(draftBody(emptyExchangeDraft())).toMatchObject({ engine: "new" });
  });

  it("fingerprints the body, not the object identity", () => {
    const a = search({ type: "Ruby Ring", name: undefined });
    const b = search({ type: "Ruby Ring" });
    expect(draftFingerprint(a)).toBe(draftFingerprint(b));
    expect(draftFingerprint(a)).not.toBe(draftFingerprint(search({ type: "Sapphire Ring" })));
    expect(draftFingerprint(emptyExchangeDraft())).not.toBe(draftFingerprint(a));
  });
});

describe("defaultTabLabel", () => {
  it("shows a unique by name only", () => {
    expect(defaultTabLabel(search({ name: "Doom Loop", type: "Ruby Ring" }))).toBe("Doom Loop");
  });

  it("falls back to the base type, then the category, then the term", () => {
    expect(defaultTabLabel(search({ type: "Ruby Ring" }))).toBe("Ruby Ring");
    expect(defaultTabLabel(search({ category: "accessory.ring" }), { categories: { "accessory.ring": "Ring" } })).toBe(
      "Ring",
    );
    expect(defaultTabLabel(search({ category: "map.waystone" }))).toBe("Waystone");
    expect(defaultTabLabel(search({ term: "free text" }))).toBe("free text");
    expect(defaultTabLabel(search({}))).toBe("New search");
  });

  it("names an exchange by its two sides", () => {
    expect(defaultTabLabel({ kind: "exchange", query: { have: ["divine"], want: ["exalted"] } })).toBe(
      "divine → exalted",
    );
  });
});

describe("defaultColour", () => {
  it("is deterministic per kind and rarity", () => {
    expect(defaultColour(search({ rarity: "unique" }))).toBe("amber");
    expect(defaultColour(search({ rarity: "rare" }))).toBe("gold");
    expect(defaultColour(emptyExchangeDraft())).toBe("teal");
    expect(defaultColour(search({}))).toBe("grey");
  });
});

describe("isTwiceCorruptedExclusive", () => {
  it("implies corrupted", () => {
    expect(isTwiceCorruptedExclusive({ twice_corrupted: true })).toEqual({ twice_corrupted: true, corrupted: true });
    expect(isTwiceCorruptedExclusive({ corrupted: false })).toEqual({ corrupted: false });
    expect(isTwiceCorruptedExclusive(undefined)).toBeUndefined();
  });
});

describe("sanitizeDraft", () => {
  it("refuses anything that is not a draft", () => {
    expect(sanitizeDraft(undefined)).toBeUndefined();
    expect(sanitizeDraft({ kind: "search" })).toBeUndefined();
    expect(sanitizeDraft({ kind: "nope", query: {} })).toBeUndefined();
  });

  it("clamps numbers and drops junk filters", () => {
    const draft = sanitizeDraft({
      kind: "search",
      query: {
        type: "x".repeat(400),
        stats: [
          { type: "nope", filters: [] },
          { type: "and", filters: [{ id: "NOT AN ID" }, { id: "explicit.stat_1", value: { min: Number.NaN } }] },
        ],
        misc: { ilvl: { min: -5, max: 900 }, corrupted: "yes" },
        sort: { key: "definitely_not_a_key", direction: "desc" },
      },
    });
    if (!draft || draft.kind !== "search") throw new Error("expected a search draft");
    expect(draft.query.type).toHaveLength(120);
    expect(draft.query.stats).toHaveLength(1);
    expect(draft.query.stats[0]!.filters).toEqual([{ id: "explicit.stat_1" }]);
    expect(draft.query.misc?.ilvl).toEqual({ min: 1, max: 100 });
    expect(draft.query.misc?.corrupted).toBeUndefined();
    expect(draft.query.sort).toBeUndefined();
  });

  it("caps stat groups at twenty and filters at forty", () => {
    const draft = sanitizeDraft({
      kind: "search",
      query: {
        stats: Array.from({ length: 30 }, () => ({
          type: "and",
          filters: Array.from({ length: 50 }, (_entry, index) => ({ id: `explicit.stat_${index}` })),
        })),
      },
    });
    if (!draft || draft.kind !== "search") throw new Error("expected a search draft");
    expect(draft.query.stats).toHaveLength(20);
    expect(draft.query.stats[0]!.filters).toHaveLength(40);
  });

  it("never lets a prototype key through", () => {
    const draft = sanitizeDraft(JSON.parse('{"kind":"search","query":{"__proto__":{"polluted":true},"type":"Ring"}}'));
    if (!draft || draft.kind !== "search") throw new Error("expected a search draft");
    expect(draft.query.type).toBe("Ring");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("normalises exchange ids and caps each side", () => {
    const draft = sanitizeDraft({
      kind: "exchange",
      query: { have: ["Divine", "divine", "BAD ID"], want: Array.from({ length: 40 }, (_x, i) => `c${i}`), minimum: -3 },
    });
    if (!draft || draft.kind !== "exchange") throw new Error("expected an exchange draft");
    expect(draft.query.have).toEqual(["divine"]);
    expect(draft.query.want).toHaveLength(20);
    expect(draft.query.minimum).toBeUndefined();
  });
});

describe("MARKET_SORT_KEYS", () => {
  it("are all accepted by toTradeSearchBody and survive the sanitizer", () => {
    for (const entry of MARKET_SORT_KEYS) {
      const body = toTradeSearchBody({ stats: [], sort: { key: entry.key, direction: "desc" } });
      expect(body.sort).toEqual({ [entry.key]: "desc" });
      const draft = sanitizeDraft({ kind: "search", query: { stats: [], sort: { key: entry.key, direction: "desc" } } });
      if (!draft || draft.kind !== "search") throw new Error("expected a search draft");
      expect(draft.query.sort?.key).toBe(entry.key);
    }
  });
});

describe("tradeQueryFromBody re-export", () => {
  it("round-trips the bodies this builder produces", () => {
    const queries: TradeQuery[] = [
      { stats: [], type: "Ruby Ring", status: "online" },
      { stats: [{ type: "and", filters: [{ id: "explicit.stat_3299347043", value: { min: 100 } }] }], status: "any" },
      { stats: [], name: "Doom Loop", rarity: "unique", category: "accessory.ring", status: "online" },
      { stats: [], equipment: { dps: { min: 200 } }, misc: { ilvl: { min: 80 }, corrupted: false }, status: "online" },
      {
        stats: [],
        trade: { price: { option: "exalted", min: 1, max: 40 }, indexed: "1day", sale_type: "priced", collapse: true },
        status: "online",
      },
      { stats: [], term: "free text", sort: { key: "indexed", direction: "desc" }, status: "online" },
    ];
    for (const query of queries) {
      const body = toTradeSearchBody(query);
      const back = tradeQueryFromBody(body);
      expect(back.unsupported).toEqual([]);
      expect(toTradeSearchBody(back.query)).toEqual(body);
    }
  });
});
