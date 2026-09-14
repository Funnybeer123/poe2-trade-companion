import { describe, expect, it, vi } from "vitest";
import { runSavedStashPricing, validateSavedStashReport, type SavedStashPricingReport } from "../src/core/savedStashPricing.js";
import { defaultStashValuationSettings, evaluateStashItem, STASH_SCORING_VERSION,
  type StashMarketQuote, type StashValuationReport, type StashValuationRow } from "../src/core/stashValuation.js";

const now = "2026-09-14T12:00:00.000Z";
const settings = { ...defaultStashValuationSettings(), league: "Forbidden Rites", routingMode: "purpose" as const };
const text = (name: string) => `Item Class: Rings\nRarity: Rare\n${name}\nRuby Ring\n--------\nItem Level: 81\n--------\n+60 to maximum Life`;
const priced = (): StashMarketQuote => ({ state: "priced", league: settings.league, provider: "pathofexile-trade2", fetchedAt: now,
  validUntil: "2026-09-14T12:15:00.000Z", currency: "chaos", low: 3, fair: 4, high: 5,
  sampleSize: 5, candidateCount: 10, confidence: 80, reasons: ["Preserved original market evidence."], cached: true });
const unpriced = (state: "unavailable" | "no-comparables" | "unsupported" = "unavailable"): StashMarketQuote => ({
  state, league: settings.league, provider: "pathofexile-trade2", fetchedAt: now, currency: "chaos",
  sampleSize: 0, candidateCount: 0, confidence: 0, reasons: [state === "unavailable" ? "Earlier outage." : "Original lookup result."],
});
function row(id: string, quote = unpriced(), fields: Partial<StashValuationRow> = {}): StashValuationRow {
  return { ...evaluateStashItem(text(id), quote, settings, { id, row: 2, col: 3, at: now }), ...fields };
}
function report(rows: StashValuationRow[]): StashValuationReport {
  return { schemaVersion: 1, id: "original-capture", startedAt: "2026-09-14T11:00:00.000Z", finishedAt: "2026-09-14T11:30:00.000Z",
    league: settings.league, settings: structuredClone(settings), scoreVersion: STASH_SCORING_VERSION,
    mode: "move", status: "incomplete", sourceTab: "Dump", scannedItems: rows.length, unreadCells: [], rows,
    errors: ["Historical transfer warning."] };
}

describe("saved stash pricing", () => {
  it("requeries only unavailable rows and preserves resolved evidence, saved identity and movement receipts", async () => {
    const expired = { ...priced(), fetchedAt: "2026-09-14T11:00:00.000Z", validUntil: "2026-09-14T11:15:00.000Z" };
    const saved = report([
      row("fresh", priced()), row("expired", expired), row("empty", unpriced("no-comparables")), row("unsupported", unpriced("unsupported")),
      row("pending"), row("moved", unpriced(), { status: "moved", destination: "Amulets", actualDestination: "Amulets", reasons: ["Verified destination quantity +1."] }),
      row("failed", unpriced(), { status: "failed", destination: "Rings", actualDestination: "inventory (unconfirmed)", reasons: ["Withdrawal receipt was not confirmed."] }),
    ]);
    const original = structuredClone(saved);
    const quote = vi.fn(async () => priced());
    const snapshots: SavedStashPricingReport[] = [];
    const result = await runSavedStashPricing({ saved, pendingOnly: true, quote, now: () => now, onReport: value => snapshots.push(value) });
    expect(quote.mock.calls).toHaveLength(3);
    expect(quote).toHaveBeenNthCalledWith(1, saved.rows[4]!.rawText, "Forbidden Rites");
    expect(quote).toHaveBeenNthCalledWith(2, saved.rows[5]!.rawText, "Forbidden Rites");
    expect(quote).toHaveBeenNthCalledWith(3, saved.rows[6]!.rawText, "Forbidden Rites");
    expect(result.rows.slice(0, 4).map(item => item.quote)).toEqual(original.rows.slice(0, 4).map(item => item.quote));
    expect(result.rows[0]!.decision).toBe("valuable");
    expect(result.rows[1]).toMatchObject({ decision: "review", status: "stay", destination: "Dump" });
    expect(result.rows[5]).toMatchObject({ status: "moved", destination: "Amulets", actualDestination: "Amulets" });
    expect(result.rows[5]!.reasons).toContain("Verified destination quantity +1.");
    expect(result.rows[6]).toMatchObject({ status: "failed", destination: "Rings", actualDestination: "inventory (unconfirmed)" });
    expect(result.rows[6]!.reasons).toContain("Withdrawal receipt was not confirmed.");
    expect(result).toMatchObject({ id: original.id, startedAt: original.startedAt, settings: original.settings, league: original.league,
      mode: "move", sourceTab: original.sourceTab, scannedItems: 7, status: "incomplete" });
    const identity = (item: StashValuationRow) => ({ id: item.id, rawText: item.rawText, sourceTab: item.sourceTab, row: item.row, col: item.col, fingerprint: item.fingerprint });
    expect(result.rows.map(identity)).toEqual(original.rows.map(identity));
    expect(result.pricingResume).toMatchObject({ total: 3, completed: 3, retained: 4, previousErrors: original.errors, previousStatus: original.status });
    expect(snapshots[0]!.rows.map(item => item.quote)).toEqual(original.rows.map(item => item.quote));
    expect(saved).toEqual(original);
  });

  it("keeps identical physical items separate and does not invent missing coordinates", async () => {
    const first = row("copy-a", unpriced(), { rawText: text("Identical Ring"), row: undefined, col: undefined });
    const second = { ...structuredClone(first), id: "copy-b", row: 5, col: 8 };
    const saved = report([first, second]);
    const quote = vi.fn(async () => priced());
    const result = await runSavedStashPricing({ saved, pendingOnly: true, quote, now: () => now, onReport: () => undefined });
    expect(quote).toHaveBeenCalledTimes(2);
    expect(result.rows.map(item => [item.id, item.row, item.col])).toEqual([["copy-a", undefined, undefined], ["copy-b", 5, 8]]);
  });

  it("checkpoints every original row before cancellation at the first lookup", async () => {
    const saved = report([row("one"), row("two", priced()), row("three")]);
    const snapshots: SavedStashPricingReport[] = [];
    const quote = vi.fn(async () => priced());
    const stopped = Object.assign(new Error("Cancelled by user."), { name: "SortStop" });
    const result = await runSavedStashPricing({ saved, pendingOnly: true, quote, now: () => now,
      onReport: value => snapshots.push(value), checkpoint: async () => { expect(snapshots[0]!.rows).toHaveLength(3); throw stopped; } });
    expect(quote).not.toHaveBeenCalled();
    expect(result.status).toBe("stopped");
    expect(result.rows.map(item => item.quote)).toEqual(saved.rows.map(item => item.quote));
    expect(result.pricingResume?.completed).toBe(0);
    expect(snapshots.every(snapshot => snapshot.rows.length === 3)).toBe(true);
  });

  it("preserves rows when a checkpoint fails or an in-flight lookup is aborted", async () => {
    const saved = report([row("one"), row("two")]);
    const abort = Object.assign(new Error("Provider cancelled."), { name: "AbortError" });
    const aborted = await runSavedStashPricing({ saved, pendingOnly: true, now: () => now, quote: async () => { throw abort; }, onReport: () => undefined });
    expect(aborted.status).toBe("stopped");
    expect(aborted.rows.map(item => item.quote)).toEqual(saved.rows.map(item => item.quote));
    const failed = await runSavedStashPricing({ saved, pendingOnly: true, now: () => now, quote: async () => priced(),
      checkpoint: async () => { throw new Error("Checkpoint failure."); }, onReport: () => undefined });
    expect(failed.status).toBe("failed");
    expect(failed.rows.map(item => item.quote)).toEqual(saved.rows.map(item => item.quote));
  });

  it("persists the throttled row and preserves all later evidence without retrying", async () => {
    const saved = report([row("one"), row("resolved", priced()), row("two"), row("three")]);
    const denied = { ...unpriced(), retryAfter: "2026-09-14T12:10:00.000Z", reasons: ["HTTP 429"] };
    const quote = vi.fn(async () => denied);
    const snapshots: SavedStashPricingReport[] = [];
    const result = await runSavedStashPricing({ saved, pendingOnly: true, quote, now: () => now, onReport: value => snapshots.push(value) });
    expect(quote).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("stopped");
    expect(result.rows[0]!.quote).toEqual(denied);
    expect(result.rows.slice(1).map(item => item.quote)).toEqual(saved.rows.slice(1).map(item => item.quote));
    expect(snapshots.some(snapshot => snapshot.rows[0]!.quote.retryAfter === denied.retryAfter && snapshot.rows.length === 4)).toBe(true);
    const resumeQuote = vi.fn(async () => priced());
    const paused = await runSavedStashPricing({ saved: result, pendingOnly: true, quote: resumeQuote, now: () => now, onReport: () => undefined });
    expect(paused.status).toBe("stopped");
    expect(resumeQuote).not.toHaveBeenCalled();
    const resumed = await runSavedStashPricing({ saved: paused, pendingOnly: true, quote: resumeQuote,
      now: () => "2026-09-14T12:10:01.000Z", onReport: () => undefined });
    expect(resumeQuote).toHaveBeenCalledTimes(3);
    expect(resumed.rows[1]!.quote).toEqual(saved.rows[1]!.quote);
  });

  it("respects the latest future saved restriction even when it belongs to a later row", async () => {
    const saved = report([row("one"), row("two", { ...unpriced(), retryAfter: "2026-09-14T12:05:00Z" }),
      row("three", { ...unpriced(), retryAfter: "2026-09-14T12:10:00Z" })]);
    const quote = vi.fn(async () => priced());
    const result = await runSavedStashPricing({ saved, pendingOnly: true, quote, now: () => now, onReport: () => undefined });
    expect(quote).not.toHaveBeenCalled();
    expect(result.errors.join(" ")).toContain("12:10:00Z");
    expect(result.rows.map(item => item.quote)).toEqual(saved.rows.map(item => item.quote));
  });

  it("does not let checkpoint consumers mutate the input report or later checkpoints", async () => {
    const saved = report([row("one"), row("two", priced())]);
    const original = structuredClone(saved);
    const result = await runSavedStashPricing({ saved, pendingOnly: true, quote: async () => priced(), now: () => now, onReport: snapshot => {
      snapshot.rows[0]!.rawText = "Changed by consumer";
      snapshot.rows[1]!.quote.reasons.push("Changed by consumer");
      snapshot.settings.league = "Other League";
    } });
    expect(saved).toEqual(original);
    expect(result.rows[0]!.rawText).toBe(original.rows[0]!.rawText);
    expect(result.rows[1]!.quote).toEqual(original.rows[1]!.quote);
    expect(result.league).toBe("Forbidden Rites");
    expect(result.settings.league).toBe("Forbidden Rites");
  });

  it("re-evaluates retained quotes at the finish time after a slow pending lookup", async () => {
    let at = now;
    const saved = report([row("resolved", priced()), row("pending")]);
    const result = await runSavedStashPricing({ saved, pendingOnly: true, now: () => at, onReport: () => undefined,
      quote: async () => { at = "2026-09-14T12:16:00.000Z"; return { ...priced(), fetchedAt: at, validUntil: "2026-09-14T12:31:00.000Z" }; } });
    expect(result.rows[0]!.quote).toEqual(saved.rows[0]!.quote);
    expect(result.rows[0]).toMatchObject({ decision: "review", status: "stay" });
    expect(result.rows[1]).toMatchObject({ decision: "valuable", status: "planned" });
  });

  it("retains failed inventory receipts even when no row needs a lookup", async () => {
    const saved = report([row("failed", priced(), { status: "failed", actualDestination: "inventory", reasons: ["Original inventory receipt."] })]);
    const quote = vi.fn(async () => priced());
    const result = await runSavedStashPricing({ saved, pendingOnly: true, quote, now: () => now, onReport: () => undefined });
    expect(quote).not.toHaveBeenCalled();
    expect(result.rows[0]).toMatchObject({ status: "failed", actualDestination: "inventory" });
    expect(result.rows[0]!.reasons).toContain("Original inventory receipt.");
    expect(result.status).toBe("incomplete");
  });

  it("validates original league, capture metadata and unique row identities before checkpointing", async () => {
    const valid = report([row("one")]);
    expect(validateSavedStashReport(valid)).toEqual([]);
    const invalid: unknown[] = [null, {}, { ...valid, league: "Standard" }, { ...valid, sourceTab: "Other" },
      { ...valid, startedAt: "invalid" }, { ...valid, rows: [valid.rows[0], valid.rows[0]] },
      { ...valid, rows: [{ ...valid.rows[0], row: -1 }] }, { ...valid, rows: [{ ...valid.rows[0], quote: { ...priced(), state: "unknown" } }] }];
    for (const value of invalid) {
      expect(validateSavedStashReport(value).length).toBeGreaterThan(0);
      const quote = vi.fn(async () => priced()), onReport = vi.fn();
      await expect(runSavedStashPricing({ saved: value as StashValuationReport, pendingOnly: true, quote, onReport })).rejects.toThrow();
      expect(quote).not.toHaveBeenCalled();
      expect(onReport).not.toHaveBeenCalled();
    }
  });
});
