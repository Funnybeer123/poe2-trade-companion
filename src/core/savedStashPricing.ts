import {
  validateStashValuationSettings,
  type StashMarketQuote, type StashValuationReport,
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
          typeof row.itemClass !== "string" || ![report.sourceTab, ...(report.settings?.captureSource === "inventory" || report.settings?.captureSource === "both" ? ["Inventory"] : [])].includes(row.sourceTab) ||
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
  if (report.pricingQueue) {
    const q = report.pricingQueue;
    if (!Array.isArray(q.ids) || q.ids.length > 10000 || new Set(q.ids).size !== q.ids.length ||
      q.ids.some(id => !report.rows?.some(row => row.id === id)) ||
      ![q.cursor, q.budget, q.attempts, q.searches, q.listingFetches, q.metadata, q.economy].every(n => Number.isInteger(n) && n >= 0) ||
      q.budget > 100 || q.cursor > q.ids.length || !["ready", "running", "paused", "complete"].includes(q.state) ||
      q.retryAfter !== undefined && !Number.isFinite(Date.parse(q.retryAfter))) issues.push("Invalid saved pricing queue.");
  }
  if (report.capture && (typeof report.capture.id !== "string" || typeof report.capture.complete !== "boolean" ||
    !Array.isArray(report.capture.completedSources) || report.capture.completedSources.some(source => typeof source !== "string"))) issues.push("Invalid capture progress.");
  return issues;
}

/** Backwards-compatible entry point for the independently resumed bounded queue. */
export { priceBatch as runSavedStashPricing } from "./batchPricing.js";
