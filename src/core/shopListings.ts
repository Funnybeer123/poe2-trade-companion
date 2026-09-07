/**
 * Shop listings: manage what is for sale in the ONE designated public stash
 * tab (docs/HANDOFF-shop-listings.md).
 *
 * Ground truth: a listed item's Ctrl+C copy carries its price as a
 * `Note: ~price N currency` line — that line is the listing's state, the
 * same way `Item Class:` is the sorter's classifier. No pixels ever price
 * anything.
 *
 * This module is pure: note parsing, the shop config schema, scan snapshots,
 * the append-only listings ledger, and the scan→ledger reconciliation
 * (including heuristic sold detection). File I/O and screen driving live in
 * the adapter/CLI layers.
 */

import { orbCosts, type OrbId } from "./crafting.js";
import { parseItemText } from "./parseItem.js";
import { tradeCurrencyToOrb } from "./tradeComps.js";
import { lookupPrice, type PriceTable } from "./priceTable.js";

export const SHOP_CONFIG_SCHEMA_VERSION = 1 as const;
export const LISTING_LEDGER_SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Note-line ground truth
// ---------------------------------------------------------------------------

export interface PriceNote {
  /** `price` = exact price, `bo` = buyout/negotiable, `other` = unrecognized. */
  kind: "price" | "bo" | "other";
  amount?: number;
  currency?: string;
  /** The note text exactly as copied, for display and write-back checks. */
  raw: string;
}

const NOTE_LINE = /^Note:\s*(.+?)\s*$/m;
const PRICE_NOTE = /^~(price|b\/o)\s+(\d+(?:[./]\d+)?)\s+([a-z][a-z' -]*[a-z])\s*$/i;

/** Fold a note currency token to its canonical orb word ("exalt" → "exalted"). */
export function normalizeNoteCurrency(token: string): string {
  const folded = token.trim().toLowerCase();
  const orb = tradeCurrencyToOrb(folded);
  return orb ?? folded;
}

/**
 * Extract the price note from a full Ctrl+C item copy (or from a bare note
 * string). Returns undefined when the text carries no Note line at all;
 * an unparseable note comes back as kind "other" so callers can treat it as
 * a user-priced listing they must not touch.
 */
export function parsePriceNote(itemText: string): PriceNote | undefined {
  const line = NOTE_LINE.exec(itemText)?.[1] ?? (itemText.trimStart().startsWith("~") ? itemText.trim() : undefined);
  if (!line) return undefined;
  const match = PRICE_NOTE.exec(line);
  if (!match) return { kind: "other", raw: line };
  const rawAmount = match[2]!;
  const amount = rawAmount.includes("/")
    ? Number(rawAmount.split("/")[0]) / Number(rawAmount.split("/")[1])
    : Number(rawAmount);
  if (!Number.isFinite(amount) || amount <= 0) return { kind: "other", raw: line };
  return {
    kind: match[1]!.toLowerCase() === "price" ? "price" : "bo",
    amount: Math.round(amount * 10_000) / 10_000,
    currency: normalizeNoteCurrency(match[3]!),
    raw: line,
  };
}

/** The note text the price dialog should produce for an exact price. */
export function formatPriceNote(amount: number, currency: string): string {
  return `~price ${amount} ${currency}`;
}

/** A note's value in exalted orbs, via the crafting economy's rates. */
export function noteExalted(
  note: PriceNote | undefined,
  priceTable?: PriceTable,
): number | undefined {
  if (!note || note.amount === undefined || !note.currency) return undefined;
  const orb = tradeCurrencyToOrb(note.currency);
  if (!orb) return undefined;
  const rate = orbCosts(priceTable)[orb as OrbId];
  if (!Number.isFinite(rate) || rate <= 0) return undefined;
  return Math.round(note.amount * rate * 100) / 100;
}

/** Two notes agree when kind, amount and currency all match. */
export function notesEqual(a: PriceNote | undefined, b: PriceNote | undefined): boolean {
  if (!a || !b) return a === b;
  return a.kind === b.kind && a.amount === b.amount && a.currency === b.currency;
}

// ---------------------------------------------------------------------------
// Shop config (artifacts/tab-admin/shop.json)
// ---------------------------------------------------------------------------

export interface ShopLadderStep {
  /** Days since listing (or the last reprice) before this step applies. */
  afterDays: number;
  /** Percent knocked off the CURRENT listing price at this step. */
  stepPercent: number;
}

export interface ListingPrice {
  amount: number;
  currency: string;
  /** Value in exalted at the time the record was made. */
  exalted?: number;
}

export interface ShopConfig {
  schemaVersion: typeof SHOP_CONFIG_SCHEMA_VERSION;
  /**
   * The ONE public tab the shop feature may touch, matched with
   * labelsEqualFolded only. Empty = the feature refuses to run (the user
   * has not answered open question 1).
   */
  shopTab: string;
  /** Where delisted items go (junk semantics keep them there for re-triage). */
  returnTab: string;
  /** Percent under the comps anchor a new listing is priced at. */
  undercutPercent: number;
  /** Low percentile of comps used as the anchor (never the minimum). */
  compsPercentile: number;
  /** Age in days after which a listing counts as stale. */
  staleDays: number;
  /** Comps this % above the listing flag it UNDERPRICED. */
  underpricedPercent: number;
  /** Stale listings step down on this schedule. */
  ladder: ShopLadderStep[];
  /** Below this value the ladder delists to the return tab instead. */
  delistFloorExalted: number;
  /** Listings above this need per-item confirmation (mispriced-mirror rail). */
  maxAutoList: { amount: number; currency: string };
  /** Appraisal confidence a bag item needs before auto-listing. */
  minListConfidence: number;
  /** Comps sample size below which no listing decision is made. */
  minCompsCount: number;
  /** median/lowest above this = spread too wide to trust. */
  maxCompsSpread: number;
  /** Suggestions below this many exalted refuse (not worth a shop slot). */
  minListExalted: number;
  /** Phase 2 item sources. */
  sources: Array<"bag" | "review">;
  /** Hard cap on live actions per run. */
  maxActionsPerRun: number;
  /** Set when the tab prices itself via its `~price ...` name. */
  tabWidePrice?: ListingPrice;
  /**
   * The price-bucket merchant tabs ("1Ex", "5Ex", "1D" …). Unioned with
   * whatever the strip OCR reads: the ACTIVE tab's label never reads, so a
   * run that relied on the strip alone could silently lose a bucket.
   */
  bucketTabs: string[];
  /**
   * Bucket ladder without comps: when no usable comps are supplied for a
   * stale app listing, age alone steps it down a bucket (true, default) or
   * the listing holds until comps say the market moved (false).
   */
  ladderWithoutComps: boolean;
  /**
   * How the SET ITEM PRICE dialog prices a currency STACK — UNVERIFIED
   * live (docs/HANDOFF-shop-listings.md). "whole": the typed amount buys the
   * whole stack, so a stack is bucketed at unit × count; "per-unit": the
   * amount is per orb, so a stack is bucketed at its unit value.
   */
  stackPricing: "whole" | "per-unit";
}

export type StackPricingMode = ShopConfig["stackPricing"];

export function defaultShopConfig(): ShopConfig {
  return {
    schemaVersion: SHOP_CONFIG_SCHEMA_VERSION,
    shopTab: "",
    returnTab: "Dump",
    undercutPercent: 5,
    compsPercentile: 25,
    staleDays: 3,
    underpricedPercent: 30,
    ladder: [
      { afterDays: 3, stepPercent: 8 },
      { afterDays: 6, stepPercent: 12 },
    ],
    delistFloorExalted: 1,
    maxAutoList: { amount: 1, currency: "divine" },
    minListConfidence: 60,
    minCompsCount: 3,
    maxCompsSpread: 4,
    minListExalted: 1,
    sources: ["bag"],
    maxActionsPerRun: 10,
    bucketTabs: [],
    ladderWithoutComps: true,
    stackPricing: "whole",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown, fallback: number, min = 0, max = Number.POSITIVE_INFINITY): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

/** Accepts unknown JSON and returns a safe config plus what was wrong. */
export function parseShopConfig(input: unknown): { config: ShopConfig; issues: string[] } {
  const issues: string[] = [];
  const base = defaultShopConfig();
  if (!isRecord(input)) {
    if (input !== undefined && input !== null) issues.push("shop config must be an object");
    return { config: base, issues };
  }
  const config: ShopConfig = {
    ...base,
    shopTab: typeof input.shopTab === "string" ? input.shopTab.trim() : base.shopTab,
    returnTab:
      typeof input.returnTab === "string" && input.returnTab.trim()
        ? input.returnTab.trim()
        : base.returnTab,
    undercutPercent: num(input.undercutPercent, base.undercutPercent, 0, 90),
    compsPercentile: num(input.compsPercentile, base.compsPercentile, 1, 50),
    staleDays: num(input.staleDays, base.staleDays, 0.5, 60),
    underpricedPercent: num(input.underpricedPercent, base.underpricedPercent, 5, 500),
    delistFloorExalted: num(input.delistFloorExalted, base.delistFloorExalted, 0),
    minListConfidence: num(input.minListConfidence, base.minListConfidence, 0, 100),
    minCompsCount: Math.round(num(input.minCompsCount, base.minCompsCount, 1, 20)),
    maxCompsSpread: num(input.maxCompsSpread, base.maxCompsSpread, 1.1),
    minListExalted: num(input.minListExalted, base.minListExalted, 0),
    maxActionsPerRun: Math.round(num(input.maxActionsPerRun, base.maxActionsPerRun, 1, 200)),
    ladderWithoutComps:
      typeof input.ladderWithoutComps === "boolean" ? input.ladderWithoutComps : base.ladderWithoutComps,
    stackPricing:
      input.stackPricing === "whole" || input.stackPricing === "per-unit"
        ? input.stackPricing
        : base.stackPricing,
  };
  if (input.stackPricing !== undefined && input.stackPricing !== config.stackPricing) {
    issues.push(`stackPricing must be "whole" or "per-unit" — using "${config.stackPricing}"`);
  }
  if (Array.isArray(input.ladder)) {
    const steps = input.ladder
      .filter(isRecord)
      .map((step) => ({
        afterDays:
          typeof step.afterDays === "number" && Number.isFinite(step.afterDays)
            ? step.afterDays
            : 0,
        stepPercent: num(step.stepPercent, 0, 1, 90),
      }))
      .filter((step) => step.afterDays > 0 && step.stepPercent > 0)
      .sort((a, b) => a.afterDays - b.afterDays);
    if (steps.length > 0) config.ladder = steps;
    else issues.push("ladder has no valid steps — using defaults");
  }
  if (isRecord(input.maxAutoList)) {
    const amount = num(input.maxAutoList.amount, base.maxAutoList.amount, 0);
    const currency =
      typeof input.maxAutoList.currency === "string" && input.maxAutoList.currency.trim()
        ? normalizeNoteCurrency(input.maxAutoList.currency)
        : base.maxAutoList.currency;
    config.maxAutoList = { amount, currency };
  }
  if (Array.isArray(input.bucketTabs)) {
    config.bucketTabs = input.bucketTabs
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      .map((entry) => entry.trim());
  }
  if (Array.isArray(input.sources)) {
    const sources = input.sources.filter(
      (entry): entry is "bag" | "review" => entry === "bag" || entry === "review",
    );
    if (sources.length > 0) config.sources = [...new Set(sources)];
  }
  if (isRecord(input.tabWidePrice)) {
    const amount = num(input.tabWidePrice.amount, 0, 0);
    const currency =
      typeof input.tabWidePrice.currency === "string"
        ? normalizeNoteCurrency(input.tabWidePrice.currency)
        : "";
    if (amount > 0 && currency) config.tabWidePrice = { amount, currency };
  }
  if (!config.shopTab) {
    issues.push("shopTab is not set — the shop feature refuses to run until it is");
  }
  return { config, issues };
}

/** The cap in exalted, using the live economy (a "1 divine" cap follows the rate). */
export function maxAutoListExalted(config: ShopConfig, priceTable?: PriceTable): number {
  const orb = tradeCurrencyToOrb(config.maxAutoList.currency);
  const rate = orb ? orbCosts(priceTable)[orb as OrbId] : undefined;
  if (!rate || !Number.isFinite(rate) || rate <= 0) return config.maxAutoList.amount;
  return Math.round(config.maxAutoList.amount * rate * 100) / 100;
}

// ---------------------------------------------------------------------------
// Scan snapshot
// ---------------------------------------------------------------------------

export interface ShopCell {
  row: number;
  col: number;
}

export interface ShopScanItemInput {
  text: string;
  cells: ShopCell[];
  /**
   * The price read from the item's hover tooltip ("Asking Price: Nx …").
   * The merchant's Ctrl+C text carries no price, so this is the ground
   * truth when present; without it the text's Note line is consulted.
   */
  askingPrice?: { amount: number; currency: string };
}

export interface ShopSnapshotItem {
  fingerprint: string;
  name: string;
  baseType: string;
  itemClass: string;
  rarity: string;
  identified: boolean;
  text: string;
  cells: ShopCell[];
  note?: PriceNote;
  /** The note's value in exalted, when the currency converts. */
  priceExalted?: number;
}

export interface ShopSnapshot {
  at: string;
  tab: string;
  items: ShopSnapshotItem[];
  unreadCells: number;
  /** Items with no per-item note and no tab-wide price. */
  unpricedCount: number;
}

/** Turn identified reads into the listing snapshot the reconciler consumes. */
export function buildShopSnapshot(
  inputs: readonly ShopScanItemInput[],
  options: { at: string; tab: string; unreadCells?: number; priceTable?: PriceTable },
): ShopSnapshot {
  const items: ShopSnapshotItem[] = inputs.map((input) => {
    const parsed = parseItemText(input.text);
    const note: PriceNote | undefined = input.askingPrice
      ? {
          kind: "price",
          amount: input.askingPrice.amount,
          currency: normalizeNoteCurrency(input.askingPrice.currency),
          raw: `Asking Price: ${input.askingPrice.amount}x ${input.askingPrice.currency}`,
        }
      : parsePriceNote(input.text);
    const exalted = noteExalted(note, options.priceTable);
    return {
      fingerprint: parsed.fingerprint,
      name: parsed.name,
      baseType: parsed.baseType,
      itemClass: parsed.itemClass,
      rarity: parsed.rarity,
      identified: parsed.identified,
      text: input.text,
      cells: input.cells.map((cell) => ({ row: cell.row, col: cell.col })),
      ...(note ? { note } : {}),
      ...(exalted !== undefined ? { priceExalted: exalted } : {}),
    };
  });
  return {
    at: options.at,
    tab: options.tab,
    items,
    unreadCells: options.unreadCells ?? 0,
    unpricedCount: items.filter((item) => !item.note || item.note.kind === "other").length,
  };
}

// ---------------------------------------------------------------------------
// Listings ledger (artifacts/tab-admin/listings.jsonl, append-only)
// ---------------------------------------------------------------------------

export type ListingEventKind = "listed" | "repriced" | "delisted" | "sold";

export interface CompsSnapshot {
  at: string;
  basis: string;
  sampleSize: number;
  candidateCount: number;
  lowest?: number;
  median?: number;
  /** The anchor the pricing policy actually used, in exalted. */
  anchorExalted?: number;
}

export interface ListingEvent {
  at: string;
  kind: ListingEventKind;
  fingerprint: string;
  name: string;
  itemClass: string;
  /** How many copies of this exact item the event covers (duplicates). */
  count: number;
  /** Who made the change: the app's flow, the user's hand, or unknown. */
  by: "app" | "user" | "unknown";
  /** "verified" = a Note re-read (or app action) proved it; "heuristic" =
   * inferred from scan deltas — sold-vs-removed is never guessed silently. */
  certainty: "verified" | "heuristic";
  price?: ListingPrice;
  previousPrice?: ListingPrice;
  /** sold: the last known listing price = the realized price estimate. */
  realized?: ListingPrice;
  cell?: ShopCell;
  comps?: CompsSnapshot;
  reason?: string;
}

export function parseListingEvents(jsonl: string): ListingEvent[] {
  const events: ListingEvent[] = [];
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as ListingEvent;
      if (
        parsed &&
        typeof parsed.at === "string" &&
        typeof parsed.fingerprint === "string" &&
        ["listed", "repriced", "delisted", "sold"].includes(parsed.kind)
      ) {
        events.push({ ...parsed, count: typeof parsed.count === "number" && parsed.count > 0 ? Math.floor(parsed.count) : 1 });
      }
    } catch {
      // A truncated trailing line from a killed run is expected; skip it.
    }
  }
  return events;
}

export interface ActiveListing {
  fingerprint: string;
  name: string;
  itemClass: string;
  count: number;
  price?: ListingPrice;
  /** First listed timestamp still standing (age drives staleness). */
  listedAt: string;
  /** Timestamp of the most recent price event (listing age resets on reprice). */
  pricedAt: string;
  lastEventAt: string;
  by: "app" | "user" | "unknown";
  comps?: CompsSnapshot;
}

/**
 * Fold the ledger into the current shop state. listed adds count, sold and
 * delisted subtract, repriced replaces the price and resets the ladder clock.
 */
export function deriveShopState(events: readonly ListingEvent[]): ActiveListing[] {
  const state = new Map<string, ActiveListing>();
  for (const event of events) {
    const existing = state.get(event.fingerprint);
    if (event.kind === "listed") {
      if (existing) {
        existing.count += event.count;
        existing.lastEventAt = event.at;
        if (event.price) {
          existing.price = event.price;
          existing.pricedAt = event.at;
        }
        if (event.comps) existing.comps = event.comps;
      } else {
        state.set(event.fingerprint, {
          fingerprint: event.fingerprint,
          name: event.name,
          itemClass: event.itemClass,
          count: event.count,
          ...(event.price ? { price: event.price } : {}),
          listedAt: event.at,
          pricedAt: event.at,
          lastEventAt: event.at,
          by: event.by,
          ...(event.comps ? { comps: event.comps } : {}),
        });
      }
      continue;
    }
    if (!existing) continue; // reprice/delist/sold for something we never saw listed
    if (event.kind === "repriced") {
      if (event.price) existing.price = event.price;
      existing.pricedAt = event.at;
      existing.lastEventAt = event.at;
      if (event.comps) existing.comps = event.comps;
      // Whoever priced it last owns it: a user reprice takes the listing
      // out of the app's hands, and an app price write (first pricing of a
      // hand-listed item, or a per-item override) hands it to the ladder.
      if (event.by !== "unknown") existing.by = event.by;
      continue;
    }
    existing.count -= event.count;
    existing.lastEventAt = event.at;
    if (existing.count <= 0) state.delete(event.fingerprint);
  }
  return [...state.values()];
}

export interface ReconcileArgs {
  state: readonly ActiveListing[];
  snapshot: ShopSnapshot;
  /** Fingerprints known to be OUTSIDE the shop tab right now (bag scan etc.)
   * — a gone listing found here was removed by the user, not sold. */
  knownElsewhere?: ReadonlySet<string>;
  priceTable?: PriceTable;
}

export interface ReconcileResult {
  events: ListingEvent[];
  /** Human-readable lines for everything heuristic — report, never guess silently. */
  report: string[];
}

function listingPriceOf(item: ShopSnapshotItem): ListingPrice | undefined {
  if (!item.note || item.note.kind === "other" || item.note.amount === undefined || !item.note.currency) {
    return undefined;
  }
  return {
    amount: item.note.amount,
    currency: item.note.currency,
    ...(item.priceExalted !== undefined ? { exalted: item.priceExalted } : {}),
  };
}

/**
 * Diff a fresh scan against the ledger-derived state and produce the events
 * that reconcile them. Everything inferred here is marked heuristic:
 *   - a fingerprint gone from the tab and not seen elsewhere = SOLD (the
 *     most valuable data in the feature — realized price + date);
 *   - gone but seen elsewhere = the user removed it;
 *   - a new fingerprint we never listed = the user listed it (read-only for
 *     automation until they opt in per item);
 *   - a changed note we did not write = the user repriced it.
 */
export function reconcileShopScan(args: ReconcileArgs): ReconcileResult {
  const events: ListingEvent[] = [];
  const report: string[] = [];
  const at = args.snapshot.at;
  const scanByPrint = new Map<string, { item: ShopSnapshotItem; count: number }>();
  for (const item of args.snapshot.items) {
    const existing = scanByPrint.get(item.fingerprint);
    if (existing) existing.count += 1;
    else scanByPrint.set(item.fingerprint, { item, count: 1 });
  }

  for (const listing of args.state) {
    const seen = scanByPrint.get(listing.fingerprint);
    const seenCount = seen?.count ?? 0;
    if (seenCount < listing.count) {
      const gone = listing.count - seenCount;
      const removedByUser = args.knownElsewhere?.has(listing.fingerprint) ?? false;
      events.push({
        at,
        kind: removedByUser ? "delisted" : "sold",
        fingerprint: listing.fingerprint,
        name: listing.name,
        itemClass: listing.itemClass,
        count: gone,
        by: removedByUser ? "user" : "unknown",
        certainty: "heuristic",
        ...(listing.price ? { realized: listing.price } : {}),
        reason: removedByUser
          ? "gone from the shop tab but present elsewhere — the user moved it"
          : "gone from the shop tab and nowhere else we looked — presumed sold",
      });
      report.push(
        removedByUser
          ? `removed by hand: ${gone}x ${listing.name} (found outside the shop tab)`
          : `presumed SOLD: ${gone}x ${listing.name}` +
              (listing.price ? ` at ${listing.price.amount} ${listing.price.currency}` : " (price unknown)") +
              " — heuristic; correct the ledger if you moved it yourself",
      );
    }
    if (seen && listing.price && seenCount > 0) {
      const scanned = listingPriceOf(seen.item);
      if (
        scanned &&
        (scanned.amount !== listing.price.amount || scanned.currency !== listing.price.currency)
      ) {
        events.push({
          at,
          kind: "repriced",
          fingerprint: listing.fingerprint,
          name: listing.name,
          itemClass: listing.itemClass,
          count: seenCount,
          by: "user",
          certainty: "heuristic",
          price: scanned,
          previousPrice: listing.price,
          reason: "the note changed and this flow did not change it",
        });
        report.push(
          `user reprice: ${listing.name} ${listing.price.amount} ${listing.price.currency} → ${scanned.amount} ${scanned.currency} (now read-only for automation)`,
        );
      } else if (!scanned && seen.item.note?.kind !== "other") {
        report.push(
          `note vanished: ${listing.name} was priced ${listing.price.amount} ${listing.price.currency} but now carries no note — check it by hand`,
        );
      }
    }
  }

  for (const { item, count } of scanByPrint.values()) {
    const known = args.state.find((listing) => listing.fingerprint === item.fingerprint);
    const knownCount = known?.count ?? 0;
    if (count > knownCount) {
      const added = count - knownCount;
      const price = listingPriceOf(item);
      events.push({
        at,
        kind: "listed",
        fingerprint: item.fingerprint,
        name: item.name,
        itemClass: item.itemClass,
        count: added,
        by: "user",
        certainty: "heuristic",
        ...(price ? { price } : {}),
        ...(item.cells[0] ? { cell: item.cells[0] } : {}),
        reason: "found in the shop tab without a ledger record — listed by hand",
      });
      report.push(
        `hand-listed: ${added}x ${item.name}` +
          (price ? ` at ${price.amount} ${price.currency}` : " (no readable price note)") +
          " — automation treats it as read-only",
      );
    }
  }

  return { events, report };
}

/** Days between two ISO timestamps, for staleness math. */
export function ageDays(fromIso: string, nowMs: number): number {
  const from = Date.parse(fromIso);
  if (!Number.isFinite(from)) return 0;
  return Math.max(0, (nowMs - from) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Earnings (Remove-only) sub-tab: sale proceeds land here as currency stacks
// (user demonstration 2026-09-02). Its delta between two scans is the ONLY
// ground truth for "sold" — the gone-from-tab heuristic stays the fallback.
// ---------------------------------------------------------------------------

export interface EarningsStack {
  /** The currency's item name as copied ("Exalted Orb"). */
  name: string;
  /** Orbs in the stack (the Stack Size property's current value). */
  count: number;
  /** The stack's value in exalted when the currency is priced. */
  exalted?: number;
}

export interface EarningsSnapshot {
  at: string;
  stacks: EarningsStack[];
}

export interface EarningsCurrencyDelta {
  name: string;
  before: number;
  after: number;
  /** after − before; negative when stacks were collected to the bag. */
  delta: number;
  unitExalted?: number;
  /** delta × unit, when the currency is priced. */
  deltaExalted?: number;
}

export interface EarningsDelta {
  at: string;
  previousAt?: string;
  perCurrency: EarningsCurrencyDelta[];
  /** Sum of the POSITIVE deltas in exalted (proceeds that arrived). */
  totalExalted: number;
  /** Currencies that arrived but could not be valued. */
  unpriced: string[];
}

/**
 * One unit of a currency in exalted: the price table by item name first
 * (the poe2scout feed prices every currency by name), else the crafting
 * economy's orb rates by the folded orb word.
 */
export function currencyUnitExalted(name: string, priceTable?: PriceTable): number | undefined {
  if (priceTable) {
    const hit = lookupPrice(priceTable, {
      name,
      baseType: name,
      itemClass: "Stackable Currency",
      rarity: "Currency",
    });
    if (hit && hit.entry.match.name !== undefined && hit.value > 0) return hit.value;
  }
  const word = name
    .trim()
    .toLowerCase()
    .replace(/^orb of\s+/, "")
    .replace(/\s+orbs?$/, "");
  const orb = tradeCurrencyToOrb(word);
  const rate = orb ? orbCosts(priceTable)[orb as OrbId] : undefined;
  return rate && Number.isFinite(rate) && rate > 0 ? rate : undefined;
}

/** Sum the stacks of one snapshot per currency name. */
function countsByName(snapshot: EarningsSnapshot | undefined): Map<string, number> {
  const counts = new Map<string, number>();
  for (const stack of snapshot?.stacks ?? []) {
    const key = stack.name.trim();
    if (!key || !Number.isFinite(stack.count)) continue;
    counts.set(key, (counts.get(key) ?? 0) + Math.max(0, Math.floor(stack.count)));
  }
  return counts;
}

/** Per-currency deltas between two Earnings scans and the proceeds total. */
export function diffEarnings(
  previous: EarningsSnapshot | undefined,
  current: EarningsSnapshot,
  priceTable?: PriceTable,
): EarningsDelta {
  const before = countsByName(previous);
  const after = countsByName(current);
  const names = [...new Set([...before.keys(), ...after.keys()])].sort();
  const perCurrency: EarningsCurrencyDelta[] = [];
  const unpriced: string[] = [];
  let totalExalted = 0;
  for (const name of names) {
    const was = before.get(name) ?? 0;
    const now = after.get(name) ?? 0;
    const delta = now - was;
    const unit = currencyUnitExalted(name, priceTable);
    const entry: EarningsCurrencyDelta = {
      name,
      before: was,
      after: now,
      delta,
      ...(unit !== undefined ? { unitExalted: unit } : {}),
      ...(unit !== undefined ? { deltaExalted: Math.round(delta * unit * 100) / 100 } : {}),
    };
    perCurrency.push(entry);
    if (delta > 0) {
      if (unit === undefined) unpriced.push(name);
      else totalExalted += delta * unit;
    }
  }
  return {
    at: current.at,
    ...(previous ? { previousAt: previous.at } : {}),
    perCurrency,
    totalExalted: Math.round(totalExalted * 100) / 100,
    unpriced,
  };
}

export interface GoneListing {
  fingerprint: string;
  name: string;
  count: number;
  price?: ListingPrice;
}

/** Relative tolerance under which two exalted values count as "exact". */
const EXACT_TOLERANCE = 0.005;
/** Relative tolerance for a SUM of several gone listings. */
const SUM_TOLERANCE = 0.05;

function within(value: number, target: number, tolerance: number): boolean {
  if (target <= 0) return value <= 0;
  return Math.abs(value - target) / target <= tolerance;
}

/**
 * The realized price a matched delta implies: a single-currency delta keeps
 * its own denomination, a mixed one is expressed in exalted.
 */
function realizedFromDelta(delta: EarningsDelta): ListingPrice {
  const arrived = delta.perCurrency.filter((entry) => entry.delta > 0);
  if (arrived.length === 1 && arrived[0]!.deltaExalted !== undefined) {
    const only = arrived[0]!;
    return {
      amount: only.delta,
      currency: normalizeNoteCurrency(
        only.name.toLowerCase().replace(/^orb of\s+/, "").replace(/\s+orbs?$/, ""),
      ),
      exalted: only.deltaExalted,
    };
  }
  return { amount: delta.totalExalted, currency: "exalted", exalted: delta.totalExalted };
}

/**
 * Upgrade heuristic "sold" events to VERIFIED when the Earnings delta backs
 * them: the delta equals one gone listing's price (exact), or the sum of
 * several gone listings within 5%; a delta that matches nothing while
 * exactly one listing is gone is that listing's real sale price. Anything
 * else stays heuristic, with a report line saying why.
 */
export function verifySalesWithEarnings(args: {
  events: readonly ListingEvent[];
  goneListings: readonly GoneListing[];
  earningsDelta: EarningsDelta;
}): { events: ListingEvent[]; report: string[] } {
  const report: string[] = [];
  const delta = args.earningsDelta;
  const total = delta.totalExalted;
  const sold = args.events.filter((event) => event.kind === "sold" && event.certainty === "heuristic");
  const valueOf = (event: ListingEvent): number | undefined => {
    const gone = args.goneListings.find((entry) => entry.fingerprint === event.fingerprint);
    const price = event.realized ?? gone?.price;
    return price?.exalted !== undefined ? price.exalted * event.count : undefined;
  };
  const upgrade = (event: ListingEvent, realized: ListingPrice, reason: string): ListingEvent => ({
    ...event,
    certainty: "verified",
    realized,
    reason,
  });

  if (sold.length === 0) {
    if (total > 0) {
      report.push(
        `Earnings grew by ≈${total} ex but no listing left the shop — proceeds from an earlier, already-recorded sale, or a listing this ledger never held`,
      );
    }
    return { events: [...args.events], report };
  }
  if (total <= 0) {
    report.push(
      `Earnings unchanged (${delta.perCurrency.length === 0 ? "empty" : "no proceeds arrived"}) — ${sold.length} presumed sale(s) stay heuristic (removed by hand?)`,
    );
    return { events: [...args.events], report };
  }
  if (delta.unpriced.length > 0) {
    report.push(`Earnings: ${delta.unpriced.join(", ")} arrived but cannot be valued — the total ignores it`);
  }

  const verified = new Map<ListingEvent, ListingEvent>();
  const priced = sold.filter((event) => valueOf(event) !== undefined);
  // 1. One gone listing whose price IS the delta.
  const exact = priced.find((event) => within(valueOf(event)!, total, EXACT_TOLERANCE));
  if (exact && sold.length === 1) {
    verified.set(exact, upgrade(exact, exact.realized!, `verified by the Earnings tab: +${total} ex arrived`));
  } else if (sold.length === 1) {
    // 2. Exactly one listing gone, delta says something else: that IS the sale.
    const only = sold[0]!;
    const realized = realizedFromDelta(delta);
    verified.set(
      only,
      upgrade(
        only,
        realized,
        `verified by the Earnings tab: +${total} ex arrived` +
          (valueOf(only) !== undefined ? ` (listed at ${valueOf(only)} ex)` : " (listing price unknown)"),
      ),
    );
  } else {
    // 3. Several gone: an exact single match first, else the subset whose
    //    sum lands within 5% (small n — the ledger's gone set is a handful).
    if (exact) {
      verified.set(exact, upgrade(exact, exact.realized!, `verified by the Earnings tab: +${total} ex arrived`));
    } else {
      const pool = priced.slice(0, 14);
      let best: { subset: ListingEvent[]; error: number } | undefined;
      for (let mask = 1; mask < 1 << pool.length; mask += 1) {
        let sum = 0;
        const subset: ListingEvent[] = [];
        for (let bit = 0; bit < pool.length; bit += 1) {
          if (mask & (1 << bit)) {
            subset.push(pool[bit]!);
            sum += valueOf(pool[bit]!)!;
          }
        }
        if (!within(sum, total, SUM_TOLERANCE)) continue;
        const error = Math.abs(sum - total);
        if (!best || error < best.error) best = { subset, error };
      }
      if (best) {
        for (const event of best.subset) {
          verified.set(
            event,
            upgrade(
              event,
              event.realized!,
              `verified by the Earnings tab: ${best.subset.length} sale(s) sum to ≈${total} ex`,
            ),
          );
        }
      }
    }
  }

  const events = args.events.map((event) => verified.get(event) ?? event);
  const stillHeuristic = sold.filter((event) => !verified.has(event));
  if (verified.size > 0) {
    report.push(
      `Earnings +${total} ex verified ${verified.size} sale(s): ${[...verified.values()].map((event) => `${event.count}x ${event.name}`).join(", ")}`,
    );
  }
  if (stillHeuristic.length > 0) {
    report.push(
      `Earnings +${total} ex does not account for ${stillHeuristic.map((event) => `${event.count}x ${event.name}`).join(", ")} — left heuristic; correct the ledger by hand if you moved them`,
    );
  }
  return { events, report };
}

// ---------------------------------------------------------------------------
// Price-bucket tabs: the merchant tab's NAME is the price of everything in it
// ("1Ex", "5Ex", "10Ex", "1D", "2D", "3D", "5D" — user's layout, 2026-09-02).
// ---------------------------------------------------------------------------

export interface BucketPrice {
  amount: number;
  currency: string;
  /** The tab label exactly as configured/read. */
  label: string;
}

const BUCKET_LABEL = /^\s*(\d+(?:[.,]\d+)?)\s*(ex|exa|exalt|exalted|d|div|divine|c|chaos)\s*$/i;

/**
 * "1Ex" → 1 exalted, "5D" → 5 divine, "10Ex" → 10 exalted; anything else
 * undefined. OCR confusables in the digits ("IOEx", "lEx") fold to digits
 * first — the raw label is kept for clicking, the price comes from the fold.
 */
export function priceFromTabLabel(label: string): BucketPrice | undefined {
  const folded = label.replace(/^(\s*)([0-9lIO|]+)(?=\s*[a-z])/i, (_m, pad: string, digits: string) =>
    pad + digits.replace(/[lI|]/g, "1").replace(/O/g, "0"),
  );
  const match = BUCKET_LABEL.exec(folded);
  if (!match) return undefined;
  const amount = Number(match[1]!.replace(",", "."));
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const unit = match[2]!.toLowerCase();
  const currency = unit.startsWith("e") ? "exalted" : unit.startsWith("d") ? "divine" : "chaos";
  return { amount, currency, label: label.trim() };
}

export interface BucketTab extends BucketPrice {
  /** The bucket's value in exalted at the live rate. */
  exalted: number;
}

/** The bucket tabs among a set of strip labels, cheapest first. */
export function bucketTabs(labels: readonly string[], priceTable?: PriceTable): BucketTab[] {
  const costs = orbCosts(priceTable);
  const out: BucketTab[] = [];
  for (const label of labels) {
    const bucket = priceFromTabLabel(label);
    if (!bucket) continue;
    const orb = tradeCurrencyToOrb(bucket.currency);
    const rate = orb ? costs[orb as OrbId] : undefined;
    if (!rate || !Number.isFinite(rate) || rate <= 0) continue;
    out.push({ ...bucket, exalted: Math.round(bucket.amount * rate * 100) / 100 });
  }
  return out.sort((a, b) => a.exalted - b.exalted);
}

/**
 * The bucket a suggested value belongs in: the dearest bucket at or BELOW
 * the value. Never rounds up — a bucket above the estimate would overprice
 * the item; undefined when even the cheapest bucket is above it.
 */
export function bucketFor(
  exalted: number,
  buckets: readonly BucketTab[],
): BucketTab | undefined {
  let best: BucketTab | undefined;
  for (const bucket of buckets) {
    if (bucket.exalted <= exalted && (!best || bucket.exalted > best.exalted)) best = bucket;
  }
  return best;
}
