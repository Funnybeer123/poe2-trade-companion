import {
  evaluateStashItem, STASH_SCORING_VERSION, unavailableStashQuote, validateStashValuationSettings,
  type StashMarketQuote, type StashValuationReport, type StashValuationRow,
} from "./stashValuation.js";

export interface SavedStashPricingReport extends StashValuationReport {
  pricingResume?: {
    startedAt: string;
    finishedAt?: string;
    pendingOnly: boolean;
    total: number;
    completed: number;
    retained: number;
    previousStatus: StashValuationReport["status"];
    previousErrors: string[];
  };
}

export interface SavedStashPricingOptions {
  saved: StashValuationReport;
  pendingOnly?: boolean;
  quote: (rawText: string, league: string) => Promise<StashMarketQuote>;
  onReport: (report: SavedStashPricingReport) => void;
  checkpoint?: (message: string) => Promise<void>;
  now?: () => string;
}

/** Validate the saved capture itself; another currently selected league must not reinterpret it. */
export function validateSavedStashReport(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["Invalid saved stash report."];
  const report = value as StashValuationReport;
  const issues = validateStashValuationSettings(report.settings);
  if (report.schemaVersion !== 1 || typeof report.id !== "string" || !Number.isFinite(Date.parse(report.startedAt)) ||
      report.league !== report.settings?.league || report.sourceTab !== report.settings?.sourceTab ||
      !["scan", "move"].includes(report.mode) || !["running", "complete", "incomplete", "stopped", "failed"].includes(report.status) ||
      !Number.isInteger(report.scannedItems) || report.scannedItems < 0 || !Array.isArray(report.rows) ||
      !Array.isArray(report.unreadCells) || !Array.isArray(report.errors)) issues.push("The saved report lacks its original capture metadata.");
  if (Array.isArray(report.rows)) {
    const ids = new Set<string>();
    for (const row of report.rows) {
      if (!row || typeof row !== "object" || typeof row.id !== "string" || !row.id || ids.has(row.id) ||
          typeof row.rawText !== "string" || typeof row.name !== "string" || typeof row.baseType !== "string" ||
          typeof row.itemClass !== "string" || row.sourceTab !== report.sourceTab ||
          !Array.isArray(row.reasons) || !Array.isArray(row.mods) ||
          !["stay", "planned", "moved", "failed"].includes(row.status) ||
          ![row.row, row.col].every(n => n === undefined || (Number.isInteger(n) && n >= 0)) ||
          !row.quote || !["priced", "unavailable", "no-comparables", "unsupported"].includes(row.quote.state) ||
          typeof row.quote.league !== "string" || typeof row.quote.fetchedAt !== "string" || !Array.isArray(row.quote.reasons)) {
        issues.push("A saved item is missing its identity, position, movement history, or quote.");
        break;
      }
      ids.add(row.id);
    }
  }
  return issues;
}

function reassess(original: StashValuationRow, quote: StashMarketQuote, report: StashValuationReport, at: string): StashValuationRow {
  const evaluated = evaluateStashItem(original.rawText, quote, report.settings,
    { id: original.id, row: original.row, col: original.col, at });
  const row = { ...original, ...evaluated, id: original.id, rawText: original.rawText, name: original.name,
    baseType: original.baseType, itemClass: original.itemClass, itemLevel: original.itemLevel,
    sourceTab: original.sourceTab, row: original.row, col: original.col, fingerprint: original.fingerprint };
  if (original.status === "moved" || original.status === "failed") {
    row.status = original.status;
    row.destination = original.destination;
    row.actualDestination = original.actualDestination;
    row.reasons = [...new Set([
      ...evaluated.reasons,
      "Saved pricing does not verify present location or perform transfers. The recorded movement outcome and prior receipt notes are retained.",
      ...original.reasons,
    ])];
  } else delete row.actualDestination;
  return row;
}

function usableQuote(row: StashValuationRow, report: StashValuationReport, at: string): boolean {
  const quote = row.quote, age = Date.parse(at) - Date.parse(quote.fetchedAt);
  return quote.state === "priced" && quote.league === report.league && quote.currency === "chaos" &&
    Number.isFinite(age) && age >= -60_000 && age <= report.settings.maxAgeMinutes * 60_000 &&
    (quote.validUntil === undefined || (typeof quote.validUntil === "string" && Date.parse(quote.validUntil) > Date.parse(at))) &&
    quote.sampleSize >= 3 && Number.isFinite(quote.confidence) && quote.confidence >= report.settings.minMarketConfidence &&
    [quote.low, quote.fair, quote.high].every(n => typeof n === "number" && Number.isFinite(n) && n > 0) &&
    quote.low! <= quote.fair! && quote.fair! <= quote.high!;
}

/** A saved pricing pass has no sorter or game-input dependency, and never reconstructs a new scan. */
export async function runSavedStashPricing(options: SavedStashPricingOptions): Promise<SavedStashPricingReport> {
  const issues = validateSavedStashReport(options.saved);
  if (issues.length) throw new Error(issues.join(" "));
  const now = options.now ?? (() => new Date().toISOString());
  const original = structuredClone(options.saved);
  const selected = original.rows.flatMap((row, index) => !options.pendingOnly || row.quote.state === "unavailable" ? [index] : []);
  const report: SavedStashPricingReport = {
    ...original, status: "running", finishedAt: undefined, errors: [], scoreVersion: STASH_SCORING_VERSION,
    rows: original.rows.map(row => reassess(row, row.quote, original, now())),
    pricingResume: { startedAt: now(), pendingOnly: options.pendingOnly ?? false, total: selected.length,
      completed: 0, retained: original.rows.length - selected.length, previousStatus: original.status, previousErrors: [...original.errors] },
  };
  const progress = report.pricingResume!;
  const save = () => options.onReport(structuredClone(report));
  // Checkpoint all identities, prior quotes and receipts before the first await,
  // including when the report is also the input file.
  save();
  try {
    const restrictedUntil = selected.map(index => original.rows[index]!.quote.retryAfter)
      .filter((value): value is string => typeof value === "string" && Date.parse(value) > Date.parse(now()))
      .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
    if (restrictedUntil) {
      report.status = "stopped";
      report.errors.push("Saved pricing remains paused until " + restrictedUntil + " because of the recorded market restriction.");
    } else {
      for (const index of selected) {
        await options.checkpoint?.("price saved item " + (progress.completed + 1) + "/" + selected.length);
        let quote: StashMarketQuote;
        try { quote = await options.quote(original.rows[index]!.rawText, original.league); }
        catch (error) {
          if (error instanceof Error && ["SortStop", "AbortError"].includes(error.name)) throw error;
          quote = unavailableStashQuote(original.league, "Market lookup failed; the saved item remains available for a later retry.", now());
        }
        report.rows[index] = reassess(original.rows[index]!, quote, original, now());
        progress.completed += 1;
        save();
        if (quote.state === "unavailable" && quote.retryAfter) {
          report.status = "stopped";
          report.errors.push("Saved pricing paused by the market service until " + quote.retryAfter + "; remaining item copies and previous quotes are preserved.");
          break;
        }
      }
    }
  } catch (error) {
    report.status = error instanceof Error && ["SortStop", "AbortError"].includes(error.name) ? "stopped" : "failed";
    report.errors.push(error instanceof Error ? error.message : "Saved pricing failed.");
  }
  const finishedAt = now();
  // Long runs may outlive retained evidence; never leave expired price plans active.
  report.rows = report.rows.map(row => reassess(row, row.quote, original, finishedAt));
  if (report.status === "running") report.status = report.unreadCells.length || report.scannedItems !== report.rows.length ||
    report.rows.some(row => row.status === "failed" || !usableQuote(row, report, finishedAt)) ? "incomplete" : "complete";
  report.finishedAt = finishedAt;
  progress.finishedAt = finishedAt;
  save();
  return report;
}
