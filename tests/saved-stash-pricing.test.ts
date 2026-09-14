import { describe, expect, it, vi } from "vitest";
import { runSavedStashPricing, validateSavedStashReport } from "../src/core/savedStashPricing.js";
import type { StashMarketQuote, StashValuationReport } from "../src/core/stashValuation.js";
import { BUNDLED_KNOWLEDGE, assessBatch } from "../src/core/batchTriage.js";
import { batch, text, strongText, AT } from "./support/batchFixtures.js";
const quote = (): StashMarketQuote => ({ state: "priced", league: "Forbidden Rites", patch: BUNDLED_KNOWLEDGE.patch, provider: "fixture",
  fetchedAt: AT, validUntil: "2026-09-14T12:15:00Z", currency: "chaos", low: 2, fair: 3, high: 4, confidence: 80, sampleSize: 5, candidateCount: 10,
  reasons: [], requests: { searches: 1, listingFetches: 1, metadata: 0, economy: 0 } });
const many = (count = 276) => batch(Array.from({ length: count }, (_, i) => strongText().replace("Fixture Ring", "Fixture " + i)));
const run = (saved: StashValuationReport, provider = vi.fn(async () => quote())) => runSavedStashPricing({ saved, quote: provider, now: () => AT, onReport: () => undefined });
describe("selected budgeted saved pricing", () => {
  it("selects at most ten searches by default and never appends all unpriced rows on resume", async () => {
    const provider = vi.fn(async () => quote());
    const first = await run(many(), provider);
    expect(provider).toHaveBeenCalledTimes(10); expect(first.rows).toHaveLength(276);
    expect(first.pricingQueue).toMatchObject({ searches: 10, listingFetches: 10, cursor: 10, state: "complete" });
    expect(first.pricingQueue!.ids).toHaveLength(10);
    const resumed = await run(first, provider);
    expect(provider).toHaveBeenCalledTimes(10); expect(resumed.rows).toHaveLength(276);
    expect(resumed.status).toBe("complete");
  });
  it("checkpoints a selected queue at its budget and resumes only its remaining identities after a budget increase", async () => {
    const saved = many(13), provider = vi.fn(async () => quote());
    saved.settings.selectedPriceIds = saved.rows.map(row => row.id);
    const first = await run(saved, provider);
    expect(first.pricingQueue).toMatchObject({ state: "paused", cursor: 10, searches: 10 });
    first.settings.searchBudget = 13;
    const next = await run(first, provider);
    expect(provider).toHaveBeenCalledTimes(13); expect(next.pricingQueue).toMatchObject({ state: "complete", cursor: 13, searches: 13 });
    expect(provider).toHaveBeenNthCalledWith(11, saved.rows[10]!.rawText, saved.league);
  });
  it("deduplicates exact physical copies without giving different rolls their price", async () => {
    const saved = batch([strongText(), strongText(), strongText().replace("+110", "+111")]);
    const provider = vi.fn(async () => quote());
    const result = await run(saved, provider);
    expect(provider).toHaveBeenCalledTimes(2); expect(result.rows).toHaveLength(3);
    expect(new Set(result.rows.map(row => row.id)).size).toBe(3);
    expect(result.rows.every(row => row.quote.state === "priced")).toBe(true);
  });
  it("pauses on throttle, honors its deadline, and resumes the throttled identity without refreshing completed ones", async () => {
    const saved = many(5), provider = vi.fn(async () => quote());
    provider.mockResolvedValueOnce(quote()).mockResolvedValueOnce({ ...quote(), state: "unavailable", retryAfter: "2026-09-14T12:01:00Z", requests: { searches: 1, listingFetches: 0, metadata: 0, economy: 0 } });
    const first = await run(saved, provider);
    expect(first.pricingQueue).toMatchObject({ state: "paused", cursor: 1, searches: 2 });
    expect(first.rows).toHaveLength(5);
    await run(first, provider); expect(provider).toHaveBeenCalledTimes(2);
    const resumed = await runSavedStashPricing({ saved: first, quote: provider, now: () => "2026-09-14T12:02:00Z", onReport: () => undefined });
    expect(provider).toHaveBeenNthCalledWith(3, saved.rows[1]!.rawText, saved.league);
    expect(resumed.pricingQueue).toMatchObject({ cursor: 5, searches: 6, state: "complete" });
  });
  it("retains every row and reserves interrupted requests on cancellation", async () => {
    const saved = many(12), snapshots: StashValuationReport[] = [];
    const provider = vi.fn(async () => { throw Object.assign(new Error("cancel"), { name: "AbortError" }); });
    const result = await runSavedStashPricing({ saved, quote: provider, now: () => AT, onReport: report => snapshots.push(report) });
    expect(result.pricingQueue).toMatchObject({ cursor: 0, searches: 1, state: "paused" });
    expect(result.rows).toHaveLength(12); expect(snapshots[0]!.rows).toHaveLength(12);
    expect(result.status).toBe("complete");
    const complete = await run(result);
    expect(complete.pricingQueue).toMatchObject({ cursor: 9, searches: 10, state: "paused" });
  });
  it("checkpoints before the first cancellable boundary and performs zero requests for a zero budget", async () => {
    const saved = many(4); saved.settings.searchBudget = 0;
    const provider = vi.fn(async () => quote());
    expect((await run(saved, provider)).rows).toHaveLength(4); expect(provider).not.toHaveBeenCalled();
    saved.settings.searchBudget = 10;
    const result = await runSavedStashPricing({ saved, quote: provider, now: () => AT, onReport: () => undefined,
      checkpoint: async () => { throw Object.assign(new Error("stop"), { name: "SortStop" }); } });
    expect(provider).not.toHaveBeenCalled(); expect(result.pricingQueue!.state).toBe("paused");
  });
  it("preserves historical transfer receipts and unrelated quotes", async () => {
    const saved = many(4);
    saved.rows[0]!.status = "moved"; saved.rows[0]!.actualDestination = "Amulets"; saved.rows[0]!.reasons.push("Verified source, bag and destination.");
    saved.rows[1]!.status = "failed"; saved.rows[1]!.actualDestination = "inventory (unconfirmed)";
    saved.settings.selectedPriceIds = [saved.rows[2]!.id];
    const original = structuredClone(saved), result = await run(saved);
    expect(result.rows[0]).toMatchObject({ status: "moved", actualDestination: "Amulets", quote: original.rows[0]!.quote });
    expect(result.rows[0]!.reasons).toContain("Verified source, bag and destination.");
    expect(result.rows[1]).toMatchObject({ status: "failed", actualDestination: "inventory (unconfirmed)" });
    expect(saved).toEqual(original);
  });
  it("empty and unavailable results never become zero-value items", async () => {
    const saved = batch([text(["Unknown effect"])]);
    const result = await run(saved, vi.fn(async () => ({ ...quote(), state: "no-comparables" as const, low: undefined, fair: undefined, high: undefined, sampleSize: 0, confidence: 0 })));
    expect(result.rows[0]!.assessment!.outcome).toBe("review"); expect(result.rows[0]!.quote.low).toBeUndefined();
  });
  it("requires fresh matching patch/league and a strictly greater than one-chaos lower estimate", () => {
    const saved = batch([text(["Unknown effect"])]);
    saved.rows[0]!.quote = { ...quote(), low: 1 };
    expect(assessBatch(saved, saved.settings, AT).rows[0]!.status).toBe("stay");
    saved.rows[0]!.quote.low = 2;
    expect(assessBatch(saved, saved.settings, AT).rows[0]!.status).toBe("planned");
    saved.rows[0]!.quote.patch = "0.4";
    expect(assessBatch(saved, saved.settings, AT).rows[0]!.status).toBe("stay");
    saved.rows[0]!.quote = { ...quote(), league: "Hardcore Forbidden Rites" };
    expect(assessBatch(saved, saved.settings, AT).rows[0]!.status).toBe("stay");
  });
  it("rejects malformed reports and duplicate identities without calling the provider", async () => {
    const saved = many(2); saved.rows[1]!.id = saved.rows[0]!.id;
    const provider = vi.fn(async () => quote());
    expect(validateSavedStashReport(saved)).not.toEqual([]);
    await expect(run(saved, provider)).rejects.toThrow(); expect(provider).not.toHaveBeenCalled();
    await expect(run({ bad: true } as unknown as StashValuationReport, provider)).rejects.toThrow();
  });
});
