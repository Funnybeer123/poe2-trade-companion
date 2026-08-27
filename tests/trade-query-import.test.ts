import { describe, expect, it } from "vitest";
import {
  importTradeQueries,
  MAX_TRADE_IMPORT_BYTES,
} from "../src/core/tradeQueryImport.js";

function tradeUrl(query: unknown, league = "Standard"): string {
  return `https://www.pathofexile.com/trade2/search/poe2/${encodeURIComponent(
    league,
  )}?q=${encodeURIComponent(JSON.stringify(query))}`;
}

describe("local trade query import", () => {
  it("preserves raw OR groups and unsupported filters verbatim", () => {
    const unknownGroup = {
      filters: {
        mystery: { option: "kept" },
      },
    };
    const document = {
      query: {
        status: { option: "online" },
        stats: [
          {
            type: "or",
            filters: [
              { id: "explicit.stat_1", value: { min: 20 } },
              { id: "explicit.stat_2", disabled: true },
            ],
          },
        ],
        filters: {
          type_filters: { filters: { category: { option: "accessory.ring" } } },
          future_filters: unknownGroup,
        },
      },
      sort: { price: "asc" },
      futureRoot: { untouched: true },
    };

    const result = importTradeQueries(JSON.stringify(document));

    expect(result.errors).toEqual([]);
    expect(result.queries).toHaveLength(1);
    expect(result.queries[0]?.query).toEqual(document);
    expect(result.queries[0]?.orGroups).toEqual([
      {
        path: "$.query.stats[0]",
        filters: document.query.stats[0].filters,
        raw: document.query.stats[0],
      },
    ]);
    expect(result.queries[0]?.unsupportedFilters).toEqual(
      expect.arrayContaining([
        {
          path: "$.futureRoot",
          reason: "unsupported root field",
          raw: document.futureRoot,
        },
        {
          path: "$.query.filters.future_filters",
          reason: "unsupported filter group",
          raw: unknownGroup,
        },
      ]),
    );
    expect(result.warnings.every((warning) => warning.message.includes("preserved verbatim"))).toBe(
      true,
    );
  });

  it("decodes inline q JSON without fetching", () => {
    const document = {
      query: {
        type: "Ruby Ring",
        stats: [{ type: "and", filters: [] }],
      },
      sort: { price: "asc" },
    };
    const sourceUrl = tradeUrl(document, "Dawn of the Hunt");
    const result = importTradeQueries(sourceUrl);

    expect(result.errors).toEqual([]);
    expect(result.queries[0]).toMatchObject({
      sourceKind: "inline-query",
      sourceIndex: 0,
      league: "Dawn of the Hunt",
      query: document,
      provenance: {
        kind: "inline-query",
        unsupported: false,
      },
    });
  });

  it("keeps manually pasted URL boundaries and opaque IDs as provenance", () => {
    const first = tradeUrl({
      query: { type: "Boots", stats: [] },
      sort: { price: "asc" },
    });
    const second =
      "https://pathofexile.com/trade2/search/poe2/Standard/abcDEF123";
    const third = tradeUrl({
      query: { type: "Helmet", stats: [] },
      sort: { price: "asc" },
    });
    const result = importTradeQueries(
      `Boot search:\n${first}\nSaved official search: ${second}\n${third}`,
    );

    expect(result.errors).toEqual([]);
    expect(result.queries).toHaveLength(3);
    expect(result.queries.map((query) => query.sourceIndex)).toEqual([0, 1, 2]);
    expect(result.queries[1]).toMatchObject({
      sourceKind: "opaque-id",
      searchKey: "opaque:abcDEF123",
      provenance: {
        opaqueId: "abcDEF123",
        unsupported: true,
      },
    });
    expect(result.queries[1]?.query).toBeUndefined();
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "opaque-query-id", sourceIndex: 1 }),
      ]),
    );
  });

  it("rejects non-http protocols, lookalike hosts, credentials, and non-trade paths", () => {
    const result = importTradeQueries(
      [
        "ftp://pathofexile.com/trade2/search/poe2/Standard/id",
        "https://pathofexile.com.evil.example/trade2/search/poe2/Standard/id",
        "https://user:pass@pathofexile.com/trade2/search/poe2/Standard/id",
        "https://pathofexile.com/account/view-profile/someone",
      ].join("\n"),
    );

    expect(result.queries).toEqual([]);
    expect(result.errors.map((error) => error.code)).toEqual([
      "unsupported-protocol",
      "untrusted-host",
      "url-credentials",
      "not-trade-url",
    ]);
  });

  it("rejects malformed encoding, malformed JSON, dangerous keys, and oversized input", () => {
    const malformedEncoding = importTradeQueries(
      "https://pathofexile.com/trade2/search/poe2/Standard?q=%E0%A4%A",
    );
    expect(malformedEncoding.errors[0]?.code).toBe("malformed-encoding");

    const malformedJson = importTradeQueries(
      "https://pathofexile.com/trade2/search/poe2/Standard?q=%7Bbad%7D",
    );
    expect(malformedJson.errors[0]?.code).toBe("malformed-json");

    const hostileJson = importTradeQueries(
      '{"query":{"filters":{"__proto__":{"polluted":true}}}}',
    );
    expect(hostileJson.errors[0]?.code).toBe("hostile-json");

    const oversized = importTradeQueries("x".repeat(MAX_TRADE_IMPORT_BYTES + 1));
    expect(oversized).toMatchObject({
      queries: [],
      errors: [{ code: "input-too-large" }],
    });
  });

  it("accepts query-only JSON with an explicit warning and deduplicates searches", () => {
    const queryOnly = { type: "Amulet", stats: [] };
    const raw = importTradeQueries(JSON.stringify(queryOnly));
    expect(raw.errors).toEqual([]);
    expect(raw.queries[0]?.query).toEqual({ query: queryOnly });
    expect(raw.warnings[0]?.code).toBe("query-only-export");

    const url = tradeUrl({ query: queryOnly });
    const duplicate = importTradeQueries(`${url}\n${url}`);
    expect(duplicate.queries).toHaveLength(1);
    expect(duplicate.warnings.at(-1)?.code).toBe("duplicate-search");
  });
});
