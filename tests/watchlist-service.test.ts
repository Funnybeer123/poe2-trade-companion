import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PRICE_TABLE_SCHEMA_VERSION, type PriceTable } from "../src/core/priceTable.js";
import type { StatCatalogue } from "../src/core/statIds.js";
import type { CompListing } from "../src/core/tradeComps.js";
import { parseDealAlerts, parseWatchlist, type Watch } from "../src/core/watchlist.js";
import type { SearchListingsResult } from "../src/main/priceFeedService.js";
import { WatchlistService, type WatchlistFeed } from "../src/main/watchlistService.js";

const START = Date.parse("2026-09-07T10:00:00Z");

const TABLE: PriceTable = {
  schemaVersion: PRICE_TABLE_SCHEMA_VERSION,
  currency: "exalted",
  entries: [
    { id: "feed:poe2scout:temporalis", match: { name: "Temporalis", baseType: "Silk Robe", rarity: "Unique" }, value: 200 },
  ],
};

function listing(id: string, amount: number, whisper?: string): CompListing {
  return {
    id,
    name: "Temporalis",
    baseType: "Silk Robe",
    mods: [],
    priceAmount: amount,
    priceCurrency: "exalted",
    accountName: `seller-${id}`,
    ...(whisper ? { whisper } : {}),
  };
}

/** Four priced listings; the first is a 50% deal. */
const DEAL_SAMPLE = [listing("a", 100, "@seller-a Hi, I would like to buy your Temporalis"), listing("b", 180), listing("c", 190), listing("d", 210)];

function uniqueWatch(partial: Partial<Watch> = {}): Watch {
  return {
    id: "temporalis",
    label: "Temporalis (Silk Robe)",
    enabled: true,
    kind: "unique",
    query: { name: "Temporalis", baseType: "Silk Robe" },
    thresholdPercent: 60,
    minSample: 4,
    intervalMinutes: 10,
    ...partial,
  };
}

interface Harness {
  service: WatchlistService;
  configDir: string;
  feed: WatchlistFeed & { searchListings: ReturnType<typeof vi.fn> };
  notify: ReturnType<typeof vi.fn>;
  clipboard: string[];
  advance: (ms: number) => void;
  nowMs: () => number;
  lookups: { value: number };
  restricted: { value: string | undefined };
}

function harness(options: {
  watches?: Watch[];
  enabled?: boolean;
  notifications?: boolean;
  listings?: CompListing[];
  lookups?: number;
  restricted?: string;
  configDir?: string;
  stats?: StatCatalogue;
  /** Fake clock start (a reopened service continues where the first left off). */
  startAt?: number;
} = {}): Harness {
  const configDir = options.configDir ?? mkdtempSync(path.join(tmpdir(), "watchlist-"));
  let now = options.startAt ?? START;
  const lookups = { value: options.lookups ?? 10 };
  const restricted = { value: options.restricted };
  const searchListings = vi.fn(async (): Promise<SearchListingsResult> => ({
    ok: true,
    league: "Runes of Aldur",
    listings: options.listings ?? DEAL_SAMPLE,
    total: (options.listings ?? DEAL_SAMPLE).length,
  }));
  const feed = {
    searchListings,
    tradeBudget: () => ({ lookups: lookups.value, ...(restricted.value ? { restrictedUntilIso: restricted.value } : {}) }),
    rateLimitedUntilIso: () => restricted.value,
    fetchStats: async () => options.stats,
  };
  const notify = vi.fn();
  const clipboard: string[] = [];
  const service = new WatchlistService({
    configDir,
    feed,
    getPriceTable: () => TABLE,
    now: () => new Date(now),
    notify,
    writeClipboard: (text) => clipboard.push(text),
    manualTicks: true,
  });
  if (options.watches || options.enabled !== undefined || options.notifications !== undefined) {
    service.save({
      ...(options.watches ? { watches: options.watches } : {}),
      enabled: options.enabled ?? true,
      ...(options.notifications !== undefined ? { notifications: options.notifications } : {}),
    });
  }
  return {
    service,
    configDir,
    feed,
    notify,
    clipboard,
    advance: (ms) => (now += ms),
    nowMs: () => now,
    lookups,
    restricted,
  };
}

describe("WatchlistService scheduling gates", () => {
  it("does nothing while the master switch is off", async () => {
    const h = harness({ watches: [uniqueWatch()], enabled: false });
    const outcome = await h.service.tick();
    expect(outcome.skipped).toContain("off");
    expect(h.feed.searchListings).not.toHaveBeenCalled();
    expect(h.service.overview().nextScanEtaMs).toBeUndefined();
  });

  it("waits for three spare lookups before a scheduled scan, but a manual scan needs one", async () => {
    const h = harness({ watches: [uniqueWatch()], lookups: 2 });
    const skipped = await h.service.tick();
    expect(skipped.skipped).toBe("2 trade2 lookups spare — waiting for 3");
    expect(h.feed.searchListings).not.toHaveBeenCalled();
    expect(h.service.overview().lastSkip).toBe("2 trade2 lookups spare — waiting for 3");

    h.lookups.value = 3;
    const scanned = await h.service.tick();
    expect(scanned.ok).toBe(true);
    expect(h.feed.searchListings).toHaveBeenCalledTimes(1);
    expect(h.service.overview().lastSkip).toBeUndefined();

    h.lookups.value = 1;
    expect((await h.service.scanNow("temporalis")).ok).toBe(true);
    h.lookups.value = 0;
    expect((await h.service.scanNow("temporalis")).skipped).toContain("no trade2 lookup spare");
    expect(h.feed.searchListings).toHaveBeenCalledTimes(2);
  });

  it("skips entirely inside a trade2 penalty window", async () => {
    const h = harness({ watches: [uniqueWatch()], restricted: "2026-09-07T10:30:00.000Z" });
    expect((await h.service.tick()).skipped).toContain("penalty window");
    expect((await h.service.scanNow()).skipped).toContain("penalty window");
    expect(h.feed.searchListings).not.toHaveBeenCalled();
    h.restricted.value = undefined;
    expect((await h.service.tick()).ok).toBe(true);
  });

  it("caps scans at twenty per hour, persisted across a restart", async () => {
    const h = harness({ watches: [uniqueWatch({ intervalMinutes: 1 })] });
    for (let i = 0; i < 20; i += 1) {
      expect((await h.service.tick()).ok).toBe(true);
      h.advance(60_000);
    }
    expect(h.feed.searchListings).toHaveBeenCalledTimes(20);
    const capped = await h.service.tick();
    expect(capped.skipped).toBe("hourly cap reached (20 scans)");
    expect((await h.service.scanNow("temporalis")).skipped).toContain("hourly cap");
    expect(h.service.overview().scansThisHour).toBe(20);

    // A fresh process reads the same scan log.
    const reopened = harness({ configDir: h.configDir, startAt: h.nowMs() });
    expect(reopened.service.overview().scansThisHour).toBe(20);
    expect((await reopened.service.tick()).skipped).toContain("hourly cap");

    // An hour after the first scan the oldest entries fall out of the window.
    h.advance(41 * 60_000);
    expect((await h.service.tick()).ok).toBe(true);
    expect(h.feed.searchListings).toHaveBeenCalledTimes(21);
  });

  it("scans one watch per tick, the most overdue first, and honours intervals", async () => {
    const h = harness({
      watches: [uniqueWatch({ id: "first", query: { name: "A" } }), uniqueWatch({ id: "second", query: { name: "B" } })],
    });
    expect((await h.service.tick()).watchId).toBe("first");
    expect((await h.service.tick()).watchId).toBe("second");
    expect((await h.service.tick()).skipped).toBe("no watch is due");
    expect(h.service.overview().nextScanEtaMs).toBe(10 * 60_000);
    h.advance(10 * 60_000 + 1);
    expect((await h.service.tick()).watchId).toBe("first");
    expect(h.feed.searchListings).toHaveBeenCalledTimes(3);
    // The button ignores the interval.
    expect((await h.service.scanNow("second")).watchId).toBe("second");
    expect((await h.service.scanNow()).watchId).toBe("first"); // most overdue enabled watch
  });
});

describe("WatchlistService alerts", () => {
  it("appends new alerts, notifies once, and dedupes on the next pass", async () => {
    const h = harness({ watches: [uniqueWatch()] });
    const outcome = await h.service.tick();
    expect(outcome).toMatchObject({ ok: true, sample: 4, total: 4, referenceExalted: 200, referenceBasis: "feed", newAlerts: 1 });
    const file = path.join(h.configDir, "deal-alerts.jsonl");
    expect(existsSync(file)).toBe(true);
    const alerts = parseDealAlerts(readFileSync(file, "utf8"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      watchId: "temporalis",
      listingId: "a",
      askExalted: 100,
      referenceExalted: 200,
      discountPercent: 50,
      whisper: "@seller-a Hi, I would like to buy your Temporalis",
    });
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0]?.[0]).toEqual({
      title: "Deal: Temporalis 100 exalted (−50%)",
      body: 'Reference 200 ex · Silk Robe · watch "Temporalis (Silk Robe)" · copy the whisper from Tools → Deals',
    });

    // Same listings again: nothing new, no second notification.
    h.advance(11 * 60_000);
    expect((await h.service.tick()).newAlerts).toBe(0);
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(parseDealAlerts(readFileSync(file, "utf8"))).toHaveLength(1);

    // The overview lists it newest first; watches carry their bookkeeping.
    const overview = h.service.overview();
    expect(overview.alerts.map((alert) => alert.listingId)).toEqual(["a"]);
    expect(overview.watches[0]).toMatchObject({ lastScanAt: "2026-09-07T10:11:00.000Z", lastReferenceExalted: 200 });
    expect(overview.lastScanAt).toBe("2026-09-07T10:11:00.000Z");
    const stored = parseWatchlist(readFileSync(path.join(h.configDir, "watchlist.json"), "utf8"));
    expect(stored.watches[0]).toMatchObject({ lastScanAt: "2026-09-07T10:11:00.000Z", lastReferenceExalted: 200 });
  });

  it("stays quiet when notifications are off, and reloads history on restart", async () => {
    const h = harness({ watches: [uniqueWatch()], notifications: false });
    await h.service.tick();
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.service.overview().alerts).toHaveLength(1);

    const reopened = harness({ configDir: h.configDir, startAt: h.nowMs() });
    const overview = reopened.service.overview();
    expect(overview.enabled).toBe(true);
    expect(overview.notifications).toBe(false);
    expect(overview.watches).toHaveLength(1);
    expect(overview.alerts).toHaveLength(1);
    // The reloaded history still dedupes.
    reopened.advance(11 * 60_000);
    expect((await reopened.service.tick()).newAlerts).toBe(0);
  });

  it("copies the whisper to the clipboard and dismisses alerts", async () => {
    const h = harness({ watches: [uniqueWatch()] });
    await h.service.tick();
    const [alert] = h.service.overview().alerts;
    expect(h.service.copyWhisper(alert!.id)).toEqual({ ok: true });
    expect(h.clipboard).toEqual(["@seller-a Hi, I would like to buy your Temporalis"]);
    expect(h.service.copyWhisper("missing")).toMatchObject({ ok: false });

    const after = h.service.dismiss(alert!.id);
    expect(after.alerts).toEqual([]);
    // Dismissal persists; the history line stays for dedupe.
    const reopened = harness({ configDir: h.configDir, startAt: h.nowMs() });
    expect(reopened.service.overview().alerts).toEqual([]);
    expect(parseDealAlerts(readFileSync(path.join(h.configDir, "deal-alerts.jsonl"), "utf8"))).toHaveLength(1);
  });

  it("reports a failed search without an alert and keeps the watch's schedule", async () => {
    const h = harness({ watches: [uniqueWatch()] });
    h.feed.searchListings.mockResolvedValueOnce({ ok: false, listings: [], error: "trade2 search → HTTP 400" });
    const outcome = await h.service.tick();
    expect(outcome).toMatchObject({ ok: false, newAlerts: 0 });
    expect(outcome.error).toContain("HTTP 400");
    expect(h.service.overview().lastError).toContain("HTTP 400");
    // Stamped, so the next tick does not hammer the same failing search.
    expect((await h.service.tick()).skipped).toBe("no watch is due");
  });

  it("stamps a stat watch it cannot express instead of spinning on it", async () => {
    const stat = uniqueWatch({
      id: "stat",
      kind: "stat-filtered",
      query: { baseType: "Ruby Ring", stats: [{ familyId: "life", min: 100 }] },
    });
    const h = harness({ watches: [stat] }); // fetchStats resolves undefined
    const outcome = await h.service.tick();
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("stats catalogue is unavailable");
    expect(h.feed.searchListings).not.toHaveBeenCalled();
    expect((await h.service.tick()).skipped).toBe("no watch is due");
  });
});

describe("WatchlistService save", () => {
  it("sanitizes the incoming list and keeps scan bookkeeping the payload omits", async () => {
    const h = harness({ watches: [uniqueWatch()] });
    await h.service.tick();
    const edited = h.service.save({
      watches: [
        { ...uniqueWatch(), label: "Renamed", lastScanAt: undefined, lastReferenceExalted: undefined },
        { kind: "nonsense" },
        { id: "base", kind: "base-type", query: { baseType: "Ruby Ring" }, thresholdPercent: 999 },
      ],
      notifications: false,
    });
    expect(edited.watches).toHaveLength(2);
    expect(edited.watches[0]).toMatchObject({
      id: "temporalis",
      label: "Renamed",
      lastScanAt: "2026-09-07T10:00:00.000Z",
      lastReferenceExalted: 200,
    });
    expect(edited.watches[1]).toMatchObject({ id: "base", thresholdPercent: 100, minSample: 4 });
    expect(edited.notifications).toBe(false);
    expect(edited.enabled).toBe(true);
    // Turning the switch off clears the ETA and the tick does nothing.
    const off = h.service.save({ enabled: false });
    expect(off.enabled).toBe(false);
    expect(off.nextScanEtaMs).toBeUndefined();
    expect((await h.service.tick()).skipped).toContain("off");
  });
});
