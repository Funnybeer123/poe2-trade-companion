import { assessBatch, assessRow } from "./batchTriage.js";
import { knowledgeForReport } from "./leagueKnowledge.js";
import { validateSavedStashReport, type SavedStashPricingOptions, type SavedStashPricingReport } from "./savedStashPricing.js";
import { unavailableStashQuote, type StashValuationRow } from "./stashValuation.js";
const signature = (row: StashValuationRow, league: string, patch: string) => JSON.stringify([league, patch, row.rawText.replace(/\r/g, "").trim()]);
/** Persisted bounded queue. Only exact copies share quotes; different rolls/state never inherit a price. */
export async function priceBatch(options: SavedStashPricingOptions): Promise<SavedStashPricingReport> {
  const issues = validateSavedStashReport(options.saved);
  if (issues.length) throw new Error(issues.join(" "));
  const now = options.now ?? (() => new Date().toISOString());
  const original = structuredClone(options.saved);
  const report: SavedStashPricingReport = original.rows.every(row => row.assessment) ? original : assessBatch(original, original.settings, now());
  const budget = report.settings.searchBudget ?? 10;
  const knowledge = knowledgeForReport(report);
  const keyFor = (row: StashValuationRow) => signature(row, report.league, knowledge.patch);
  if (!report.pricingQueue) {
    const selected = report.settings.selectedPriceIds;
    const candidates = selected ? selected.map(id => {
      const row = report.rows.find(row => row.id === id);
      if (!row) throw new Error("A selected pricing item is not in this capture.");
      return row;
    }) : [...report.rows].filter(row => row.assessment?.outcome !== "low-priority" && row.status !== "moved")
      .sort((a, b) => (b.assessment?.components.generalUsefulness ?? 0) - (a.assessment?.components.generalUsefulness ?? 0));
    const unique = new Map<string, string>();
    for (const row of candidates) if (!unique.has(keyFor(row))) unique.set(keyFor(row), row.id);
    report.pricingQueue = { ids: [...unique.values()].slice(0, selected ? undefined : budget), cursor: 0, budget, attempts: 0,
      searches: 0, listingFetches: 0, metadata: 0, economy: 0, state: "ready" };
  }
  const queue = report.pricingQueue;
  queue.budget = budget;
  report.pricingResume = { startedAt: now(), pendingOnly: options.pendingOnly ?? false, total: queue.ids.length,
    completed: queue.cursor, retained: report.rows.length - queue.ids.length, previousStatus: original.status, previousErrors: [...original.errors] };
  const save = () => options.onReport(structuredClone(report));
  save();
  if (queue.state === "complete") return report;
  const restriction = report.rows.map(row => row.quote.retryAfter).filter((date): date is string => !!date && Date.parse(date) > Date.parse(now()))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  if (restriction) queue.retryAfter = restriction;
  if (queue.retryAfter && Date.parse(queue.retryAfter) > Date.parse(now())) { queue.state = "paused"; queue.reason = "Retry-After is active."; save(); return report; }
  queue.state = "running"; delete queue.retryAfter; delete queue.reason;
  try {
    while (queue.cursor < queue.ids.length) {
      if (queue.searches >= budget) { queue.state = "paused"; queue.reason = "Search budget reached; increase the saved budget to continue."; break; }
      await options.checkpoint?.("Price selected item " + (queue.cursor + 1) + "/" + queue.ids.length);
      const row = report.rows.find(row => row.id === queue.ids[queue.cursor]);
      if (!row) throw new Error("Pricing queue identity is missing.");
      // Reserve one search before awaiting. A process termination cannot bypass its budget on resume.
      queue.searches += 1; queue.attempts += 1; save();
      let quote;
      try { quote = await options.quote(row.rawText, report.league); }
      catch (error) {
        if (error instanceof Error && ["AbortError", "SortStop"].includes(error.name)) throw error;
        quote = unavailableStashQuote(report.league, "Market request failed; queue paused.", now());
      }
      const requests = quote.requests ?? { searches: 1, listingFetches: 0, metadata: 0, economy: 0 };
      if (Object.values(requests).some(n => !Number.isInteger(n) || n < 0) || requests.searches > 1 || requests.listingFetches > 1) throw new Error("Provider violated bounded request contract.");
      queue.searches += requests.searches - 1; queue.listingFetches += requests.listingFetches;
      queue.metadata += requests.metadata; queue.economy += requests.economy;
      const key = keyFor(row);
      report.rows = report.rows.map(candidate => keyFor(candidate) === key ?
        assessRow({ ...candidate, quote }, report.settings, now(), knowledge) : candidate);
      if (quote.state === "unavailable") {
        queue.state = "paused"; queue.retryAfter = quote.retryAfter;
        queue.reason = quote.retryAfter ? "Market throttled; resume after " + quote.retryAfter : "Market unavailable; explicit resume required.";
        save(); break;
      }
      queue.cursor += 1; report.pricingResume!.completed = queue.cursor; save();
    }
    if (queue.cursor === queue.ids.length) queue.state = "complete";
  } catch (error) {
    queue.state = "paused"; queue.reason = error instanceof Error ? error.message : "Pricing interrupted.";
  }
  report.pricingResume.finishedAt = now();
  // Assessment status is independent of pricing availability.
  save(); return report;
}
