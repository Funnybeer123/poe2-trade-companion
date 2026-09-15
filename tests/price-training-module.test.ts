import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createPriceTrainingModule } from "../src/main/features/priceTraining/index.js";
import type { FeatureContext } from "../src/main/features/types.js";
import type { PriceLesson, PriceLessonInput, PriceReviewItem } from "../src/shared/priceTraining.js";
import type { CompsResult } from "../src/main/priceFeedService.js";

const RAW = readFileSync(new URL("../fixtures/evaluate/rare-ring-resists.txt", import.meta.url), "utf8");
const NOW = "2026-09-14T12:00:00.000Z";
const INPUT: PriceLessonInput = { itemText: RAW, league: "Forbidden Rites", amount: 1, currency: "divine", evidence: "estimate", scope: "exact" };
const LESSON: PriceLesson = { ...INPUT, id: "lesson-1", createdAt: NOW, updatedAt: NOW };
const MARKET: CompsResult = {
  ok: true, cached: true, league: INPUT.league, fetchedAt: NOW, expiresAt: "2026-09-14T13:00:00.000Z",
  summary: { sampleSize: 3, candidateCount: 5, lowest: 50, median: 80, currency: "exalted", basis: "stat-filtered", comps: [] },
};

async function harness() {
  let lessons: PriceLesson[] = [LESSON];
  let review: PriceReviewItem[] = [{ id: "review-1", itemText: RAW, league: INPUT.league, fingerprint: "f", groupKey: "g", reason: "Price uncertain", firstSeen: NOW, lastSeen: NOW, seenCount: 1 }];
  const store = {
    list: vi.fn((league?: string) => lessons.filter((lesson) => !league || lesson.league === league)),
    save: vi.fn((input: PriceLessonInput, id?: string) => {
      const lesson = { ...input, id: id ?? "new-lesson", createdAt: NOW, updatedAt: NOW };
      lessons = [...lessons.filter((value) => value.id !== lesson.id), lesson];
      return lesson;
    }),
    remove: vi.fn((id: string) => { lessons = lessons.filter((lesson) => lesson.id !== id); }),
    review: vi.fn((league?: string) => review.filter((item) => !league || item.league === league)),
    dismissReview: vi.fn((id: string) => { review = review.filter((item) => item.id !== id); }),
  };
  const status = { resolvedLeague: INPUT.league as string | undefined, leagueAmbiguous: false };
  const trade = { lookups: 3, searchesSpare: 3, fetchesSpare: 3, restrictedUntilIso: undefined as string | undefined };
  const feed = {
    status: vi.fn(() => status), tradeBudget: vi.fn(() => trade),
    peekCompsResult: vi.fn<(raw: string) => CompsResult | undefined>(() => undefined),
    fetchTrainingComps: vi.fn<(raw: string) => Promise<CompsResult>>(async () => MARKET),
    statCatalogue: vi.fn(), tradeSearch: vi.fn(), tradeFetch: vi.fn(), fetchComps: vi.fn(),
  };
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ctx = {
    configDir: "unused-test-store",
    core: { priceFeed: feed },
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler),
  } as unknown as FeatureContext;
  await createPriceTrainingModule({ store, now: () => new Date(NOW) }).register(ctx);
  async function invoke(channel: string, ...args: unknown[]) {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`missing ${channel}`);
    return await handler(...args);
  }
  return { store, feed, status, trade, handlers, invoke };
}

describe("price training feature", () => {
  it("registers six channels and keeps overview, preview, edits, removal and review local", async () => {
    const rig = await harness();
    rig.feed.peekCompsResult.mockReturnValue(MARKET);
    expect([...rig.handlers.keys()].sort()).toEqual([
      "price-training:check-market", "price-training:dismiss-review", "price-training:overview",
      "price-training:preview", "price-training:remove", "price-training:save",
    ]);
    expect(await rig.invoke("price-training:overview")).toMatchObject({ league: INPUT.league, lessons: [LESSON], review: [{ id: "review-1" }] });
    expect(await rig.invoke("price-training:preview", INPUT)).toMatchObject({ estimate: { status: "matched", amount: 1, confidence: 40 }, cachedMarket: MARKET });
    await rig.invoke("price-training:save", { ...INPUT, amount: 2 }, LESSON.id);
    expect(rig.store.save).toHaveBeenCalledWith({ ...INPUT, amount: 2 }, LESSON.id);
    await rig.invoke("price-training:remove", LESSON.id);
    await rig.invoke("price-training:dismiss-review", "review-1");
    expect(await rig.invoke("price-training:overview")).toMatchObject({ lessons: [], review: [] });
    expect(await rig.invoke("price-training:preview", INPUT)).toMatchObject({ estimate: { status: "unknown" } });
    for (const fn of [rig.feed.fetchTrainingComps, rig.feed.statCatalogue, rig.feed.tradeSearch, rig.feed.tradeFetch, rig.feed.fetchComps]) expect(fn).not.toHaveBeenCalled();
  });

  it("validates the trust boundary before saving or requesting anything", async () => {
    const rig = await harness();
    for (const patch of [{ amount: 0 }, { amount: Number.NaN }, { currency: "dollars" }, { evidence: "guaranteed" }, { scope: "all" }, { league: "auto" }, { itemText: "hello" }]) {
      await expect(rig.invoke("price-training:save", { ...INPUT, ...patch })).rejects.toThrow();
    }
    for (const input of [{ ...INPUT, itemText: "not an item" }, { ...INPUT, league: "" }, { ...INPUT, league: "auto" }]) {
      await expect(rig.invoke("price-training:check-market", input)).rejects.toThrow();
    }
    expect(rig.store.save).not.toHaveBeenCalled();
    expect(rig.feed.fetchTrainingComps).not.toHaveBeenCalled();
  });

  it("never attaches a different league's cached market evidence", async () => {
    const rig = await harness();
    expect(await rig.invoke("price-training:preview", { ...INPUT, league: "Standard" })).not.toHaveProperty("cachedMarket");
    expect(rig.feed.peekCompsResult).not.toHaveBeenCalled();
    rig.feed.peekCompsResult.mockReturnValue({ ...MARKET, league: "Standard" });
    expect(await rig.invoke("price-training:preview", INPUT)).not.toHaveProperty("cachedMarket");
  });

  it("rejects market checks for unpinned, mismatched, ambiguous or exhausted league budgets", async () => {
    const rig = await harness();
    expect(await rig.invoke("price-training:check-market", { ...INPUT, league: "Standard" })).toMatchObject({ market: { ok: false } });
    rig.status.resolvedLeague = undefined;
    expect(await rig.invoke("price-training:check-market", INPUT)).toMatchObject({ market: { ok: false } });
    rig.status.resolvedLeague = INPUT.league;
    rig.status.leagueAmbiguous = true;
    expect(await rig.invoke("price-training:check-market", INPUT)).toMatchObject({ market: { ok: false } });
    rig.status.leagueAmbiguous = false;
    rig.trade.lookups = 0;
    expect(await rig.invoke("price-training:check-market", INPUT)).toMatchObject({ market: { ok: false } });
    rig.trade.lookups = 3;
    rig.trade.restrictedUntilIso = "2026-09-14T12:10:00Z";
    expect(await rig.invoke("price-training:check-market", INPUT)).toMatchObject({ market: { ok: false } });
    expect(rig.feed.fetchTrainingComps).not.toHaveBeenCalled();
  });

  it("checks exactly one item and never saves asking prices automatically", async () => {
    const rig = await harness();
    const result = await rig.invoke("price-training:check-market", INPUT);
    expect(result).toMatchObject({ market: MARKET, budget: { busy: false, lookups: 3 } });
    expect(result).not.toHaveProperty("budget.blockedReason");
    expect(rig.feed.fetchTrainingComps).toHaveBeenCalledExactlyOnceWith(RAW.trim());
    expect(rig.store.save).not.toHaveBeenCalled();
  });

  it("refuses overlapping checks and releases its gate on success or failure", async () => {
    const rig = await harness();
    let resolve!: (value: CompsResult) => void;
    rig.feed.fetchTrainingComps.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const first = rig.invoke("price-training:check-market", INPUT);
    expect(await rig.invoke("price-training:check-market", INPUT)).toMatchObject({ market: { ok: false, error: expect.stringContaining("already running") } });
    expect(rig.feed.fetchTrainingComps).toHaveBeenCalledTimes(1);
    resolve(MARKET);
    await first;
    rig.feed.fetchTrainingComps.mockRejectedValueOnce(new Error("offline"));
    await expect(rig.invoke("price-training:check-market", INPUT)).rejects.toThrow("offline");
    expect(await rig.invoke("price-training:overview")).toMatchObject({ budget: { busy: false } });
    expect(await rig.invoke("price-training:check-market", INPUT)).toMatchObject({ market: MARKET });
  });

  it("rejects a result labeled with the wrong league", async () => {
    const rig = await harness();
    rig.feed.fetchTrainingComps.mockResolvedValueOnce({ ...MARKET, league: "Standard" });
    expect(await rig.invoke("price-training:check-market", INPUT)).toMatchObject({ market: { ok: false, error: expect.stringContaining("league changed") } });
  });

  it("returns a warm cache during cooldown without entering the network path", async () => {
    const rig = await harness();
    rig.trade.lookups = 0;
    rig.trade.restrictedUntilIso = "2026-09-14T12:10:00Z";
    rig.feed.peekCompsResult.mockReturnValue(MARKET);
    expect(await rig.invoke("price-training:check-market", INPUT)).toMatchObject({ market: MARKET });
    expect(rig.feed.fetchTrainingComps).not.toHaveBeenCalled();
  });
});
