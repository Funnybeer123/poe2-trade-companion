/**
 * Inventory ledger: every item the sorter identifies by Ctrl+C, wherever it
 * saw it, as one JSON line per fingerprint per location per run
 * (artifacts/tab-admin/inventory.jsonl). This module is pure — record
 * shaping, parsing, the superseding/retiring model, pricing, and the
 * sell-list/search helpers the Wealth view runs.
 *
 * Model:
 *   - A location's LATEST FULL RUN defines its current contents. When a
 *     newer full scan of a location lacks a fingerprint, that fingerprint is
 *     retired there (sold, vendored, moved, or never re-seen).
 *   - A later observation of the same NON-STACKABLE fingerprint at another
 *     location supersedes the earlier one — the item moved. Currency stacks
 *     share one fingerprint regardless of size (fingerprintItem excludes the
 *     stack count), so stacks coexist per location and are only retired by
 *     their own location's rescan.
 *   - A PARTIAL observation (a verified deposit into a tab) adds to that
 *     tab's contents without retiring anything; a later full scan of the
 *     tab outranks it.
 */

import type { IdentifiedItem } from "./gearSort.js";
import { looksLikePoeItemText, parseItemText } from "./parseItem.js";
import { lookupPrice, type PriceTable } from "./priceTable.js";
import type { ParsedItem } from "./types.js";
import type { TierVerdict } from "./valueTiers.js";

export interface InventoryEstimate {
  amount: number;
  currency: string;
  basis: string;
}

export interface InventoryRecord {
  at: string;
  /** Tab key ("Rings", "Rings#1") or "bag". */
  location: string;
  cells: Array<{ row: number; col: number }>;
  fingerprint: string;
  name: string;
  itemClass: string;
  rarity: string;
  itemLevel?: number;
  identified: boolean;
  /** The triage evaluator's appraisal, when it ran (summed over grouped stacks). */
  estimate?: InventoryEstimate;
  valueScore?: number;
  confidence?: number;
  runId: string;
  baseType?: string;
  /** Tier verdict at observation time, when the evaluator ran. */
  tier?: string;
  /** Distinct items sharing this fingerprint at this location (default 1). */
  count?: number;
  /** Total units across the grouped currency stacks (stackables only). */
  stackCount?: number;
  /** True for a verified deposit — covers part of the location, never all of it. */
  partial?: boolean;
}

/** A record that survived superseding/retiring: the item's current whereabouts. */
export type InventoryObservation = InventoryRecord;

function stackSize(parsed: ParsedItem): number | undefined {
  if (!/currency/i.test(parsed.itemClass)) return undefined;
  const property = parsed.properties.find((entry) => /^stack size$/i.test(entry.name));
  const count = property?.rolls?.[0]?.value;
  return typeof count === "number" && Number.isFinite(count) && count > 0
    ? Math.floor(count)
    : 1;
}

export interface InventoryRecordContext {
  location: string;
  runId: string;
  at: string;
  /** The triage evaluator, when the run has one — supplies the estimate. */
  evaluate?: (itemText: string) => TierVerdict;
  partial?: boolean;
}

/**
 * Shape identified items into ledger records: one per fingerprint at the
 * location, cells merged, identical items counted, stacks summed. Items
 * whose text does not parse are skipped — the ledger only holds ground
 * truth.
 */
export function inventoryRecordsFor(
  items: readonly IdentifiedItem[],
  context: InventoryRecordContext,
): InventoryRecord[] {
  const grouped = new Map<string, InventoryRecord>();
  for (const item of items) {
    if (!looksLikePoeItemText(item.text)) continue;
    let parsed: ParsedItem;
    try {
      parsed = parseItemText(item.text);
    } catch {
      continue;
    }
    const cells = item.cells.map((cell) => ({ row: cell.row, col: cell.col }));
    const stack = stackSize(parsed);
    let verdict: TierVerdict | undefined;
    try {
      verdict = context.evaluate?.(item.text);
    } catch {
      verdict = undefined;
    }
    const appraisal = verdict?.appraisal;
    const existing = grouped.get(parsed.fingerprint);
    if (existing) {
      existing.cells.push(...cells);
      existing.count = (existing.count ?? 1) + 1;
      if (stack !== undefined) existing.stackCount = (existing.stackCount ?? 0) + stack;
      if (existing.estimate && appraisal?.estimatedValue) {
        existing.estimate.amount =
          Math.round((existing.estimate.amount + appraisal.estimatedValue.amount) * 100) / 100;
      }
      continue;
    }
    grouped.set(parsed.fingerprint, {
      at: context.at,
      location: context.location,
      cells,
      fingerprint: parsed.fingerprint,
      name: parsed.name || parsed.baseType,
      itemClass: parsed.itemClass,
      rarity: parsed.rarity,
      ...(parsed.itemLevel !== undefined ? { itemLevel: parsed.itemLevel } : {}),
      identified: parsed.identified,
      ...(appraisal?.estimatedValue
        ? {
            estimate: {
              amount: appraisal.estimatedValue.amount,
              currency: appraisal.estimatedValue.currency,
              basis: appraisal.estimatedValue.basis,
            },
          }
        : {}),
      ...(appraisal ? { valueScore: appraisal.valueScore, confidence: appraisal.confidence } : {}),
      runId: context.runId,
      ...(parsed.baseType ? { baseType: parsed.baseType } : {}),
      ...(verdict ? { tier: verdict.tier } : {}),
      count: 1,
      ...(stack !== undefined ? { stackCount: stack } : {}),
      ...(context.partial ? { partial: true } : {}),
    });
  }
  return [...grouped.values()];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseInventoryRecords(jsonl: string): InventoryRecord[] {
  const records: InventoryRecord[] = [];
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) continue;
      if (
        typeof parsed.at !== "string" ||
        typeof parsed.location !== "string" ||
        typeof parsed.fingerprint !== "string" ||
        typeof parsed.runId !== "string" ||
        typeof parsed.name !== "string"
      ) {
        continue;
      }
      const cells = Array.isArray(parsed.cells)
        ? parsed.cells.filter(
            (cell): cell is { row: number; col: number } =>
              isRecord(cell) && typeof cell.row === "number" && typeof cell.col === "number",
          )
        : [];
      records.push({
        ...(parsed as unknown as InventoryRecord),
        cells,
        itemClass: typeof parsed.itemClass === "string" ? parsed.itemClass : "Unknown",
        rarity: typeof parsed.rarity === "string" ? parsed.rarity : "",
        identified: parsed.identified !== false,
      });
    } catch {
      // A truncated trailing line from a killed run is expected; skip it.
    }
  }
  return records;
}

function timeOf(at: string): number {
  const time = Date.parse(at);
  return Number.isFinite(time) ? time : 0;
}

function later(a: string, b: string): boolean {
  const ta = timeOf(a);
  const tb = timeOf(b);
  return ta === tb ? a > b : ta > tb;
}

/** Stackables share fingerprints across stacks — they never supersede each other. */
function stackable(record: InventoryRecord): boolean {
  return record.stackCount !== undefined;
}

/**
 * Reduce the journal to each item's current whereabouts. See the module
 * header for the model; the result is sorted by location, then name.
 */
export function latestObservations(records: readonly InventoryRecord[]): InventoryObservation[] {
  const byLocation = new Map<string, InventoryRecord[]>();
  for (const record of records) {
    byLocation.set(record.location, [...(byLocation.get(record.location) ?? []), record]);
  }
  const current: InventoryObservation[] = [];
  for (const [, located] of byLocation) {
    // The latest full run: the run whose newest full record is the newest.
    const runLatest = new Map<string, string>();
    for (const record of located) {
      if (record.partial) continue;
      const seen = runLatest.get(record.runId);
      if (!seen || later(record.at, seen)) runLatest.set(record.runId, record.at);
    }
    let fullRunId: string | undefined;
    let fullRunAt: string | undefined;
    for (const [runId, at] of runLatest) {
      if (!fullRunAt || later(at, fullRunAt)) {
        fullRunId = runId;
        fullRunAt = at;
      }
    }
    // The run's own first record marks when the scan began; partials from
    // that run land after it and still count.
    const fullRunStart = fullRunId
      ? located
          .filter((record) => record.runId === fullRunId && !record.partial)
          .reduce((earliest, record) => (later(earliest, record.at) ? record.at : earliest), fullRunAt!)
      : undefined;
    const contents = new Map<string, InventoryObservation>();
    for (const record of located) {
      const counts = record.partial
        ? fullRunStart === undefined || !later(fullRunStart, record.at)
        : record.runId === fullRunId;
      if (!counts) continue;
      const existing = contents.get(record.fingerprint);
      if (!existing || later(record.at, existing.at)) contents.set(record.fingerprint, record);
    }
    current.push(...contents.values());
  }
  // Cross-location superseding for non-stackables: the item is wherever it
  // was seen LAST, judged over EVERY record rather than only the survivors.
  // A sighting that was later retired at its newest location (read in the
  // bag, then missing from the bag's next full scan) must not resurrect an
  // older tab sighting — the item left that tab when the bag saw it.
  const newestLocation = new Map<string, InventoryRecord>();
  for (const record of records) {
    if (stackable(record)) continue;
    const seen = newestLocation.get(record.fingerprint);
    if (!seen || later(record.at, seen.at)) newestLocation.set(record.fingerprint, record);
  }
  return current
    .filter((observation) => {
      if (stackable(observation)) return true;
      const newest = newestLocation.get(observation.fingerprint);
      return newest === undefined || newest.location === observation.location;
    })
    .sort((a, b) => a.location.localeCompare(b.location) || a.name.localeCompare(b.name));
}

/* ---------------- pricing ---------------- */

export interface ValuedObservation {
  observation: InventoryObservation;
  /** Total worth in exalted for every unit/copy the observation covers. */
  valueExalted?: number;
  source: "price-table" | "estimate" | "none";
}

export interface LocationWorth {
  location: string;
  items: number;
  priced: number;
  unpriced: number;
  valueExalted: number;
  /** Newest observation at the location (its latest scan). */
  lastScanAt: string;
  runId: string;
}

export interface NetWorthSummary {
  totalExalted: number;
  totalDivine: number;
  /** Exalted per divine, from the price table ("Divine Orb" entry). */
  divineRate: number;
  items: number;
  priced: number;
  unpriced: number;
  locations: LocationWorth[];
  valued: ValuedObservation[];
}

export const FALLBACK_DIVINE_RATE = 40;

export function divineRateOf(table: PriceTable): number {
  const hit = lookupPrice(table, { name: "Divine Orb" });
  return hit && hit.value > 0 ? hit.value : FALLBACK_DIVINE_RATE;
}

function toExalted(amount: number, currency: string, table: PriceTable): number {
  const unit = currency.trim().toLowerCase();
  if (unit === "" || unit.startsWith("ex")) return amount;
  if (unit.startsWith("div")) return amount * divineRateOf(table);
  if (unit.startsWith("chaos") || unit === "c") {
    const hit = lookupPrice(table, { name: "Chaos Orb" });
    return amount * (hit && hit.value > 0 ? hit.value : 0.5);
  }
  return amount;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Price one observation: the table (stack-aware) first, else its stored estimate. */
export function valueObservation(
  observation: InventoryObservation,
  table: PriceTable,
): ValuedObservation {
  const hit = lookupPrice(table, {
    name: observation.name,
    ...(observation.baseType ? { baseType: observation.baseType } : {}),
    itemClass: observation.itemClass,
    ...(observation.itemLevel !== undefined ? { itemLevel: observation.itemLevel } : {}),
    rarity: observation.rarity,
  });
  if (hit) {
    const units = observation.stackCount ?? observation.count ?? 1;
    return {
      observation,
      valueExalted: round2(toExalted(hit.value * units, hit.currency, table)),
      source: "price-table",
    };
  }
  if (observation.estimate) {
    return {
      observation,
      valueExalted: round2(
        toExalted(observation.estimate.amount, observation.estimate.currency, table),
      ),
      source: "estimate",
    };
  }
  return { observation, source: "none" };
}

export function netWorth(
  observations: readonly InventoryObservation[],
  table: PriceTable,
): NetWorthSummary {
  const valued = observations.map((observation) => valueObservation(observation, table));
  const byLocation = new Map<string, LocationWorth>();
  let totalExalted = 0;
  let priced = 0;
  let unpriced = 0;
  for (const entry of valued) {
    const { observation } = entry;
    const count = observation.count ?? 1;
    const worth =
      byLocation.get(observation.location) ??
      {
        location: observation.location,
        items: 0,
        priced: 0,
        unpriced: 0,
        valueExalted: 0,
        lastScanAt: observation.at,
        runId: observation.runId,
      };
    worth.items += count;
    if (entry.valueExalted !== undefined) {
      worth.priced += count;
      worth.valueExalted = round2(worth.valueExalted + entry.valueExalted);
      totalExalted += entry.valueExalted;
      priced += count;
    } else {
      worth.unpriced += count;
      unpriced += count;
    }
    if (later(observation.at, worth.lastScanAt)) {
      worth.lastScanAt = observation.at;
      worth.runId = observation.runId;
    }
    byLocation.set(observation.location, worth);
  }
  const divineRate = divineRateOf(table);
  totalExalted = round2(totalExalted);
  return {
    totalExalted,
    totalDivine: divineRate > 0 ? round2(totalExalted / divineRate) : 0,
    divineRate,
    items: priced + unpriced,
    priced,
    unpriced,
    locations: [...byLocation.values()].sort((a, b) => b.valueExalted - a.valueExalted),
    valued,
  };
}

/* ---------------- sell list, search, staleness ---------------- */

export interface SellCandidateOptions {
  priceTable: PriceTable;
  /** Inclusive bounds in exalted for ONE copy of the item. */
  minExalted?: number;
  maxExalted?: number;
  /** Locations to leave alone (case-insensitive; e.g. the shop tab, Review). */
  excludeLocations?: readonly string[];
}

/**
 * Items worth listing in the given band, priciest first. Currency never
 * lists (it IS the price), and unidentified items stay off the list — the
 * shop flow prices by mods.
 */
export function sellCandidates(
  observations: readonly InventoryObservation[],
  options: SellCandidateOptions,
): ValuedObservation[] {
  const min = options.minExalted ?? 1;
  const max = options.maxExalted ?? 5;
  const excluded = new Set((options.excludeLocations ?? []).map((label) => label.trim().toLowerCase()));
  const out: ValuedObservation[] = [];
  for (const observation of observations) {
    if (excluded.has(observation.location.trim().toLowerCase())) continue;
    if (/currency/i.test(observation.itemClass)) continue;
    if (!observation.identified) continue;
    const valued = valueObservation(observation, options.priceTable);
    if (valued.valueExalted === undefined) continue;
    const each = valued.valueExalted / (observation.count ?? 1);
    if (each < min || each > max) continue;
    out.push(valued);
  }
  return out.sort(
    (a, b) =>
      (b.valueExalted ?? 0) - (a.valueExalted ?? 0) ||
      a.observation.name.localeCompare(b.observation.name),
  );
}

/** Every whitespace-separated query term must appear in some field (case-insensitive). */
export function searchObservations(
  observations: readonly InventoryObservation[],
  query: string,
): InventoryObservation[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...observations];
  return observations.filter((observation) => {
    const haystack = [
      observation.name,
      observation.baseType ?? "",
      observation.itemClass,
      observation.rarity,
      observation.location,
      observation.fingerprint,
      observation.tier ?? "",
    ]
      .join("\n")
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

export interface LocationStaleness {
  location: string;
  /** Newest full-scan record at the location. */
  lastScanAt: string;
  runId: string;
  ageMs: number;
}

/** How old each location's last full scan is, oldest first. */
export function locationStaleness(
  records: readonly InventoryRecord[],
  now: string | number = Date.now(),
): LocationStaleness[] {
  const nowMs = typeof now === "number" ? now : timeOf(now);
  const latest = new Map<string, LocationStaleness>();
  for (const record of records) {
    if (record.partial) continue;
    const seen = latest.get(record.location);
    if (!seen || later(record.at, seen.lastScanAt)) {
      latest.set(record.location, {
        location: record.location,
        lastScanAt: record.at,
        runId: record.runId,
        ageMs: Math.max(0, nowMs - timeOf(record.at)),
      });
    }
  }
  return [...latest.values()].sort((a, b) => b.ageMs - a.ageMs);
}

/** "3h", "2d", "just now" — for the per-location table. */
export function describeAge(ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs < 60_000) return "just now";
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
