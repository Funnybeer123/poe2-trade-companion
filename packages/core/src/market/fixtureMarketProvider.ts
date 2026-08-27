import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type {
  MarketProvider,
  MarketQuote,
  NormalizedItem,
  QuoteContext,
} from "../items/types.js";
import { failedQuote } from "./valuation.js";

export interface FixtureMarketRecord {
  match: {
    fingerprint?: string;
    name?: string;
    base?: string;
    class?: string;
  };
  quote: Omit<MarketQuote, "providerId" | "quotedAtMs" | "comparables"> & {
    quotedAtMs?: number;
    comparables?: MarketQuote["comparables"];
    providerId?: string;
  };
}

export interface FixtureMarketProviderOptions {
  records?: FixtureMarketRecord[];
  nowMs?: () => number;
}

function matches(item: NormalizedItem, match: FixtureMarketRecord["match"]): boolean {
  if (match.fingerprint !== undefined && match.fingerprint === item.fingerprint) {
    return true;
  }
  const name = item.name?.toLowerCase();
  const base = item.base?.toLowerCase();
  if (match.name !== undefined && match.name.toLowerCase() === name) {
    return match.class === undefined || match.class.toLowerCase() === item.class?.toLowerCase();
  }
  if (match.base !== undefined && match.base.toLowerCase() === base) {
    return true;
  }
  return false;
}

export class FixtureMarketProvider implements MarketProvider {
  readonly id = "fixture";
  readonly #records: FixtureMarketRecord[];
  readonly #nowMs: () => number;

  constructor(options: FixtureMarketProviderOptions = {}) {
    this.#records = options.records ?? [];
    this.#nowMs = options.nowMs ?? (() => Date.now());
  }

  supports(_item: NormalizedItem): boolean {
    void _item;
    return true;
  }

  lookup(item: NormalizedItem, _context: QuoteContext): MarketQuote | undefined {
    void _context;
    const record = this.#records.find((entry) => matches(item, entry.match));
    if (record === undefined) {
      return undefined;
    }
    return {
      providerId: record.quote.providerId ?? this.id,
      quotedAtMs: record.quote.quotedAtMs ?? this.#nowMs(),
      currency: record.quote.currency,
      low: record.quote.low,
      fair: record.quote.fair,
      high: record.quote.high,
      recommendedListing: record.quote.recommendedListing,
      candidateCount: record.quote.candidateCount,
      comparableCount: record.quote.comparableCount,
      confidence: record.quote.confidence,
      lowConfidenceReason: record.quote.lowConfidenceReason,
      comparables: record.quote.comparables ?? [],
    };
  }

  async quote(item: NormalizedItem, context: QuoteContext): Promise<MarketQuote> {
    return this.lookup(item, context) ?? failedQuote(this.id, this.#nowMs(), "fixture-miss");
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true, detail: `records=${String(this.#records.length)}` };
  }
}

export function parseFixtureMarketFile(jsonText: string): FixtureMarketRecord[] {
  const parsed = JSON.parse(jsonText) as { records?: FixtureMarketRecord[] } | FixtureMarketRecord[];
  if (Array.isArray(parsed)) {
    return parsed;
  }
  return parsed.records ?? [];
}

export function loadFixtureMarketRecords(dir: string): FixtureMarketRecord[] {
  const names = readdirSync(dir)
    .filter((name) => name.endsWith(".json") && !name.includes("currency-exchange"))
    .sort((a, b) => a.localeCompare(b));
  const records: FixtureMarketRecord[] = [];
  for (const name of names) {
    records.push(...parseFixtureMarketFile(readFileSync(join(dir, name), "utf8")));
  }
  return records;
}

export function createFixtureMarketProvider(
  recordsOrDir: FixtureMarketRecord[] | string,
  nowMs?: () => number,
): FixtureMarketProvider {
  const records = typeof recordsOrDir === "string" ? loadFixtureMarketRecords(recordsOrDir) : recordsOrDir;
  return new FixtureMarketProvider({ records, nowMs });
}
