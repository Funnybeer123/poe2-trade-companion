import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MarketTrendsService,
  currentSoftcoreLeagues,
  resolveTrendLeague,
} from "../src/main/marketTrendsService.js";

const TWO_CURRENT = [
  { Value: "Forbidden Rites", IsCurrent: true },
  { Value: "HC Forbidden Rites", IsCurrent: true },
  { Value: "Runes of Aldur", IsCurrent: true },
  { Value: "HC Runes of Aldur", IsCurrent: true },
  { Value: "Standard", IsCurrent: false },
];
const ONE_CURRENT = [
  { Value: "HC Runes of Aldur", IsCurrent: true },
  { Value: "Runes of Aldur", IsCurrent: true },
  { Value: "Standard", IsCurrent: false },
];

function bar(day: string, price: number, quantity = 100) {
  return { Price: price, Time: `2026-09-${day}T00:00:00.0000000Z`, Quantity: quantity };
}

function page(items: unknown[], pages = 1, current = 1) {
  return { CurrentPage: current, Pages: pages, Total: items.length, Items: items };
}

const DIVINE = {
  ApiId: "divine",
  Text: "Divine Orb",
  CategoryApiId: "currency",
  CurrentPrice: 649,
  PriceLogs: [bar("07", 588), bar("06", 558), bar("05", 513), bar("04", 462), bar("03", 410), bar("02", 387), bar("01", 368)],
};
const CHAOS = {
  ApiId: "chaos",
  Text: "Chaos Orb",
  CategoryApiId: "currency",
  CurrentPrice: 44.8,
  PriceLogs: [bar("07", 41), bar("06", 38), bar("05", 45), bar("04", 46), bar("03", 41), bar("02", 38), bar("01", 37)],
};

function jsonResponse(payload: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => payload } as unknown as Response;
}

function makeService(options: {
  league?: string;
  leagues?: unknown;
  pages?: Record<string, unknown[]>;
  now?: () => Date;
  configDir?: string;
  categories?: string[];
}) {
  const configDir = options.configDir ?? mkdtempSync(path.join(tmpdir(), "trends-"));
  if (options.league !== undefined) {
    writeFileSync(path.join(configDir, "price-feed.json"), JSON.stringify({ league: options.league }));
  }
  const calls: string[] = [];
  const service = new MarketTrendsService({
    configDir,
    requestGapMs: 0,
    categories: options.categories ?? ["currency"],
    now: options.now ?? (() => new Date("2026-09-07T12:00:00Z")),
    fetchImpl: (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/Leagues")) return jsonResponse(options.leagues ?? ONE_CURRENT);
      const match = url.match(/category=([^&]+)&page=(\d+)/);
      const category = decodeURIComponent(match?.[1] ?? "");
      const pageNo = Number(match?.[2] ?? 1);
      const pages = options.pages?.[category];
      if (!pages) return jsonResponse(page([], 0));
      return jsonResponse(page(pages[pageNo - 1] as unknown[], pages.length, pageNo));
    }) as typeof fetch,
  });
  return { service, calls, configDir };
}

describe("league resolution", () => {
  it("lists current softcore leagues only", () => {
    expect(currentSoftcoreLeagues(TWO_CURRENT)).toEqual(["Forbidden Rites", "Runes of Aldur"]);
    expect(currentSoftcoreLeagues([])).toEqual([]);
  });

  it("refuses auto while two softcore leagues are current", () => {
    expect(resolveTrendLeague("auto", ONE_CURRENT)).toBe("Runes of Aldur");
    expect(() => resolveTrendLeague("auto", TWO_CURRENT)).toThrow(/2 current softcore leagues/);
    expect(() => resolveTrendLeague("auto", [])).toThrow(/no current softcore league/);
    expect(resolveTrendLeague("Runes of Aldur", TWO_CURRENT)).toBe("Runes of Aldur");
  });
});

describe("MarketTrendsService", () => {
  it("fetches paged categories, paces through the league lookup, and caches to disk", async () => {
    const { service, calls, configDir } = makeService({
      pages: { currency: [[DIVINE], [CHAOS]] },
    });
    const result = await service.getTrends();
    expect(result.ok).toBe(true);
    expect(result.league).toBe("Runes of Aldur");
    expect(result.source).toBe("network");
    expect(result.stale).toBe(false);
    expect(result.trends.map((trend) => trend.key).sort()).toEqual(["chaos", "divine"]);
    expect(result.trends.find((trend) => trend.key === "divine")?.trend).toBe("rising");
    expect(calls).toHaveLength(3); // Leagues + 2 pages
    expect(calls[1]).toContain("category=currency&page=1&perPage=100");
    expect(calls[1]).toContain("Runes%20of%20Aldur");
    expect(calls.every((url) => !url.endsWith("/Leagues") || url === calls[0])).toBe(true);
    expect(existsSync(path.join(configDir, "price-trends.json"))).toBe(true);
    const cached = JSON.parse(readFileSync(path.join(configDir, "price-trends.json"), "utf8")) as {
      league: string;
      series: unknown[];
    };
    expect(cached.league).toBe("Runes of Aldur");
    expect(cached.series).toHaveLength(2);
  });

  it("serves the cache without a request while fresh, and refetches on refresh", async () => {
    const { service, calls } = makeService({ league: "Runes of Aldur", pages: { currency: [[DIVINE]] } });
    await service.getTrends();
    expect(calls).toHaveLength(1); // explicit league: no /Leagues call
    const again = await service.getTrends();
    expect(again.source).toBe("network");
    expect(calls).toHaveLength(1);
    const forced = await service.getTrends({ refresh: true });
    expect(forced.ok).toBe(true);
    // Courtesy interval: a second refresh right away does not hammer the API.
    expect(calls).toHaveLength(1);
  });

  it("never fetches for cachedOnly, and a new process reads the disk cache", async () => {
    const cold = makeService({ league: "Runes of Aldur" });
    const nothing = await cold.service.getTrends({ cachedOnly: true });
    expect(nothing.ok).toBe(false);
    expect(nothing.source).toBe("none");
    expect(nothing.trends).toEqual([]);
    expect(cold.calls).toHaveLength(0);

    const warm = makeService({ league: "Runes of Aldur", pages: { currency: [[DIVINE]] } });
    await warm.service.getTrends();
    const reopened = makeService({ league: "Runes of Aldur", configDir: warm.configDir });
    const fromDisk = await reopened.service.getTrends({ cachedOnly: true });
    expect(fromDisk.ok).toBe(true);
    expect(fromDisk.source).toBe("cache");
    expect(fromDisk.trends.map((trend) => trend.key)).toEqual(["divine"]);
    expect(reopened.calls).toHaveLength(0);
  });

  it("refuses auto with two current leagues but keeps serving a stale cache", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "trends-"));
    const seeded = makeService({
      configDir: dir,
      league: "Runes of Aldur",
      pages: { currency: [[DIVINE]] },
      now: () => new Date("2026-09-06T12:00:00Z"),
    });
    await seeded.service.getTrends();
    // Later, the league setting goes back to auto while two leagues overlap.
    const { service, calls } = makeService({
      configDir: dir,
      league: "auto",
      leagues: TWO_CURRENT,
      pages: { currency: [[DIVINE]] },
      now: () => new Date("2026-09-07T12:00:00Z"),
    });
    const result = await service.getTrends();
    expect(result.error).toMatch(/2 current softcore leagues \(Forbidden Rites, Runes of Aldur\)/);
    expect(result.ok).toBe(true); // yesterday's cache still serves
    expect(result.stale).toBe(true);
    expect(result.league).toBe("Runes of Aldur");
    expect(calls).toEqual(["https://api.poe2scout.com/poe2/Leagues"]);
  });

  it("does not serve a cache fetched for a different league", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "trends-"));
    const first = makeService({ configDir: dir, league: "Runes of Aldur", pages: { currency: [[DIVINE]] } });
    await first.service.getTrends();
    const other = makeService({ configDir: dir, league: "Forbidden Rites", pages: { currency: [[CHAOS]] } });
    const result = await other.service.getTrends();
    expect(result.league).toBe("Forbidden Rites");
    expect(result.trends.map((trend) => trend.key)).toEqual(["chaos"]);
    expect(other.calls).toHaveLength(1);
  });

  it("tolerates categories the API does not serve", async () => {
    const { service, calls } = makeService({
      league: "Runes of Aldur",
      categories: ["currency", "waystones"],
      pages: { currency: [[DIVINE]] },
    });
    const result = await service.getTrends();
    expect(result.ok).toBe(true);
    expect(result.trends).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });
});
