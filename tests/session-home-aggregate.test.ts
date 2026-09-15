import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { TrendReport } from "../src/core/priceTrends.js";
import {
  FALLBACK_DIVINE_RATE,
  FEED_STALE_AFTER_HOURS,
  feedIsStale,
  marketMovers,
  parseStashSnapshotPoints,
  parseStashSummaryFile,
  parseTradeHistoryPoints,
  recommendations,
  stashGains,
  tradeEarnings,
  type HomeSignals,
  type MarketMovers,
  type StashGains,
} from "../src/core/sessionHome.js";

const ROOT = path.resolve(__dirname, "..");
const fixture = (name: string): string =>
  readFileSync(path.join(ROOT, "fixtures", "session", name), "utf8");

const SUMMARY = fixture("stash-tracker-summary.json");
const SNAPSHOTS = fixture("stash-snapshots.jsonl");
const TRADES = fixture("trade-history.json");
const TRENDS = JSON.parse(fixture("price-trends-result.json")) as {
  ok: boolean;
  league: string;
  fetchedAt: string;
  stale: boolean;
  trends: TrendReport[];
};

const SIGNALS: HomeSignals = {
  clientLog: { watching: true, source: "steam", file: "C:/poe/Client.txt" },
  poeDetected: true,
  priceFeed: {
    resolvedLeague: "Rise of the Abyssal",
    leagueAmbiguous: false,
    configLeague: "Rise of the Abyssal",
    feedEntryCount: 900,
    feedAgeHours: 2,
    hasSession: true,
  },
  hotkeys: [{ id: "session.recap", accelerator: "Alt+R", registered: true }],
  overlayAvailable: true,
};

const HEALTHY_MARKET: MarketMovers = {
  available: true,
  stale: false,
  rising: [],
  falling: [],
};

const HEALTHY_STASH: StashGains = { available: true, snapshots: 3, deltaExalted: 10 };

describe("stash files", () => {
  it("reads the tracker summary", () => {
    const summary = parseStashSummaryFile(SUMMARY);
    expect(summary?.sessionStart?.totalExalted).toBe(12400.5);
    expect(summary?.latest?.totalExalted).toBe(13210.5);
    expect(summary?.sessionGainExalted).toBe(810);
    expect(summary?.divineRate).toBe(405);
  });

  it("refuses junk and a summary with nothing in it", () => {
    expect(parseStashSummaryFile("{not json")).toBeUndefined();
    expect(parseStashSummaryFile("[]")).toBeUndefined();
    expect(parseStashSummaryFile(JSON.stringify({ version: 1, updatedAt: "x" }))).toBeUndefined();
  });

  it("parses the snapshot journal tolerantly and skips the torn line", () => {
    const points = parseStashSnapshotPoints(SNAPSHOTS);
    expect(points).toHaveLength(3);
    expect(points[0].kind).toBe("session-start");
    expect(points[1].totalDivine).toBeUndefined();
    expect(points.at(-1)?.totalExalted).toBe(13210.5);
  });

  it("reads P3's trade history", () => {
    const points = parseTradeHistoryPoints(TRADES);
    expect(points).toHaveLength(5);
    expect(points[1]).toEqual({ at: "2026-09-11T21:10:00.000Z", kind: "sale", exalted: 405 });
    expect(parseTradeHistoryPoints("nope")).toEqual([]);
  });
});

describe("stash gains", () => {
  const now = "2026-09-11T22:00:00.000Z";

  it("prefers the tracker summary", () => {
    const gains = stashGains({
      summary: parseStashSummaryFile(SUMMARY),
      points: parseStashSnapshotPoints(SNAPSHOTS),
      sessionStartedAt: "2026-09-11T21:00:00.000Z",
      now,
    });
    expect(gains.source).toBe("session-file");
    expect(gains.deltaExalted).toBe(810);
    expect(gains.deltaDivine).toBe(2);
    expect(gains.perHourExalted).toBe(810);
    expect(gains.snapshots).toBe(3);
  });

  it("falls back to the session-start snapshot", () => {
    const gains = stashGains({ points: parseStashSnapshotPoints(SNAPSHOTS), now });
    expect(gains.source).toBe("snapshots");
    expect(gains.baselineExalted).toBe(12400.5);
    expect(gains.latestExalted).toBe(13210.5);
    expect(gains.deltaExalted).toBe(810);
    expect(gains.deltaDivine).toBe(2);
  });

  it("falls back to the newest point before the session start", () => {
    const points = parseStashSnapshotPoints(SNAPSHOTS).map((point) => ({ ...point, kind: "auto" as const }));
    const gains = stashGains({ points, sessionStartedAt: "2026-09-11T21:45:00.000Z", now });
    expect(gains.baselineAt).toBe("2026-09-11T21:30:00.000Z");
    expect(gains.deltaExalted).toBe(410.5);
  });

  it("flags the fallback divine rate when no point carries one", () => {
    const gains = stashGains({
      points: [
        { at: "2026-09-11T20:00:00.000Z", totalExalted: 100 },
        { at: "2026-09-11T21:00:00.000Z", totalExalted: 505 },
      ],
      now,
    });
    expect(gains.deltaExalted).toBe(405);
    expect(gains.deltaDivine).toBe(1);
    // The rate is a guess, and the payload says so: the card must not print
    // "1 div" as if the feed had supplied the rate.
    expect(gains.divineRate).toBe(FALLBACK_DIVINE_RATE);
    expect(gains.rateAssumed).toBe(true);
  });

  it("does not flag a rate a snapshot really carried", () => {
    const gains = stashGains({ points: parseStashSnapshotPoints(SNAPSHOTS), now });
    expect(gains.divineRate).toBe(405);
    expect(gains.rateAssumed).toBeUndefined();
  });

  /**
   * The stash tracker rewrites its summary on every launch and always emits
   * `sessionGainExalted`, so the field alone must never be read as "there are
   * gains" — see the summary-branch comment in sessionHome.ts.
   */
  describe("a tracker summary with no session started", () => {
    const sessionless = JSON.stringify({
      version: 1,
      updatedAt: "2026-09-11T22:05:00.000Z",
      sessionId: "stash-2026-09-11",
      divineRate: 405,
      latest: { id: "snap-3", at: "2026-09-11T22:00:00.000Z", totalExalted: 13210.5 },
      sessionGainExalted: 0,
      sessionGainDivine: 0,
      snapshotCount: 3,
      excludedCount: 0,
    });

    it("falls through to the snapshot journal instead of reporting +0 ex", () => {
      const gains = stashGains({
        summary: parseStashSummaryFile(sessionless),
        points: parseStashSnapshotPoints(SNAPSHOTS),
        now,
      });
      expect(gains.source).toBe("snapshots");
      expect(gains.deltaExalted).toBe(810);
    });

    it("is unavailable when there is no journal either", () => {
      const gains = stashGains({ summary: parseStashSummaryFile(sessionless), points: [], now });
      expect(gains.available).toBe(false);
      expect(gains.deltaExalted).toBeUndefined();
      expect(gains.reason).toMatch(/Start session/);
    });

    it("still asks the user to start a stash session", () => {
      const gains = stashGains({ summary: parseStashSummaryFile(sessionless), points: [], now });
      const rows = recommendations({
        ...SIGNALS,
        stash: gains,
        stashFileExists: true,
        market: HEALTHY_MARKET,
        recentRuns: [],
        deathsRecent: 0,
      });
      expect(rows.some((row) => row.id === "stash-session")).toBe(true);
    });
  });

  it("says so when there is nothing at all", () => {
    const gains = stashGains({ points: [], now });
    expect(gains.available).toBe(false);
    expect(gains.reason).toMatch(/Stash tracker/);
    expect(gains.snapshots).toBe(0);
  });
});

describe("trade earnings", () => {
  it("sums sales and purchases since the session started", () => {
    const earnings = tradeEarnings(parseTradeHistoryPoints(TRADES), "2026-09-11T21:00:00.000Z");
    expect(earnings.sales).toBe(2);
    expect(earnings.purchases).toBe(1);
    expect(earnings.earnedExalted).toBe(405);
    expect(earnings.spentExalted).toBe(20);
    expect(earnings.netExalted).toBe(385);
    expect(earnings.partial).toBe(true);
    // The window travels with the numbers so the card can label it.
    expect(earnings.window).toBe("session");
    expect(earnings.sinceIso).toBe("2026-09-11T21:00:00.000Z");
  });

  it("counts everything when there is no session yet, and says so", () => {
    const earnings = tradeEarnings(parseTradeHistoryPoints(TRADES), undefined);
    expect(earnings.sales).toBe(3);
    expect(earnings.earnedExalted).toBe(410);
    expect(earnings.window).toBe("all");
    expect(earnings.sinceIso).toBeUndefined();
  });

  it("treats an unparseable session start as the whole file", () => {
    expect(tradeEarnings(parseTradeHistoryPoints(TRADES), "not-a-date").window).toBe("all");
  });

  it("reports unavailable with no file", () => {
    expect(tradeEarnings([], "2026-09-11T21:00:00.000Z")).toMatchObject({
      available: false,
      sales: 0,
      window: "session",
    });
  });
});

describe("market movers", () => {
  it("keeps only rows with enough bars and a three-day change", () => {
    const movers = marketMovers({ ...TRENDS, trends: TRENDS.trends });
    expect(movers.available).toBe(true);
    expect(movers.rising).toHaveLength(4);
    expect(movers.falling).toHaveLength(5);
    expect(movers.rising[0].change3d).toBeGreaterThan(movers.rising[1].change3d!);
    expect(movers.falling[0].change3d).toBeLessThan(movers.falling[1].change3d!);
    expect([...movers.rising, ...movers.falling].every((row) => row.sampleSize >= 3)).toBe(true);
  });

  it("caps each side at the limit", () => {
    const movers = marketMovers({ ...TRENDS, trends: TRENDS.trends }, 2);
    expect(movers.rising).toHaveLength(2);
    expect(movers.falling).toHaveLength(2);
  });

  it("explains an empty or failed cache", () => {
    expect(marketMovers({ ok: false, stale: true, trends: [], error: "no cache" })).toMatchObject({
      available: false,
      reason: "no cache",
    });
    expect(marketMovers({ ok: true, stale: false, trends: [] }).reason).toMatch(/Tools → Market/);
  });

  it("passes the stale flag through", () => {
    expect(marketMovers({ ...TRENDS, stale: true, trends: TRENDS.trends }).stale).toBe(true);
  });
});

describe("recommendations", () => {
  const base = {
    ...SIGNALS,
    stash: HEALTHY_STASH,
    stashFileExists: true,
    market: HEALTHY_MARKET,
    recentRuns: [],
    deathsRecent: 0,
  };

  it("returns a single suggestion when everything is healthy", () => {
    const rows = recommendations(base);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("evaluate");
  });

  it("puts the blocking rows first and caps at five", () => {
    const rows = recommendations({
      ...base,
      clientLog: { watching: false, source: "none", error: "Client.txt was not found." },
      priceFeed: { ...base.priceFeed, leagueAmbiguous: true, feedEntryCount: 0, feedAgeHours: undefined },
      stash: { available: false, snapshots: 0 },
      stashFileExists: false,
      market: { available: false, stale: true, rising: [], falling: [] },
      deathsRecent: 3,
    });
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => row.id)).toEqual(["client-log", "league", "feed", "stash-files", "market"]);
    expect(rows[0].tone).toBe("warning");
    expect(rows[0].detail).toContain("Client.txt was not found.");
  });

  it("points a session-less stash tracker at its own tool", () => {
    const rows = recommendations({ ...base, stash: { available: false, snapshots: 2 } });
    const row = rows.find((entry) => entry.id === "stash-session");
    expect(row?.route).toBe("/tools/stash-tracker");
  });

  it("warns about deaths in the recent runs", () => {
    const rows = recommendations({ ...base, deathsRecent: 2 });
    expect(rows.find((entry) => entry.id === "deaths")?.tone).toBe("warning");
  });

  it("treats an old or missing feed as stale", () => {
    expect(feedIsStale(undefined)).toBe(true);
    expect(feedIsStale(FEED_STALE_AFTER_HOURS + 1)).toBe(true);
    expect(feedIsStale(1)).toBe(false);
  });
});
