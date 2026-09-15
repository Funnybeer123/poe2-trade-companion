/**
 * Pure trade-history logic: sanitize what is on disk, prune by retention,
 * apply a manual edit, add up the totals, render the CSV, and fold the app's
 * own verified shop sales in. No I/O and no clock of its own — the store
 * passes `now` so every test is deterministic.
 *
 * WHY totals are recomputed at view time: entries keep the raw amount and
 * currency the trade actually used; the exalted figure beside them is an
 * ESTIMATE at today's divine rate, so it must move when the feed moves. The
 * stored `price.exalted` is only a snapshot for the CSV and for the session
 * recap that reads this file.
 */
import { normalizeTradeCurrency, priceInExalted } from "./tradeListings.js";
import type { PriceTable } from "./priceTable.js";
import type { ListingEvent } from "./shopListings.js";
import type {
  TradeHistoryEdit,
  TradeHistoryEntry,
  TradeHistoryKind,
  TradeHistoryMatched,
  TradeHistoryTotals,
  TradeSecure,
} from "../shared/trade.js";

export const MAX_HISTORY = 5_000;
export const MAX_IGNORED_IDS = 2_000;
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,80}$/;
const KINDS: readonly TradeHistoryKind[] = ["sale", "purchase", "unknown"];
const MATCHED: readonly TradeHistoryMatched[] = ["offer", "manual", "unmatched", "shop-ledger"];

function atSlug(at: string): string {
  return at.replace(/[:.]/g, "-");
}

export function newHistoryId(at: string, rand?: () => string): string {
  const suffix = (rand?.() ?? Math.random().toString(36).slice(2)).replace(/[^A-Za-z0-9]/g, "").slice(0, 4);
  return `th_${atSlug(at)}_${suffix || "0000"}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function isoOrUndefined(value: unknown): string | undefined {
  const raw = text(value, 40);
  if (!raw) return undefined;
  return Number.isFinite(Date.parse(raw)) ? raw : undefined;
}

export function sanitizeHistoryEntry(raw: unknown): TradeHistoryEntry | undefined {
  if (!isRecord(raw)) return undefined;
  const id = text(raw.id, 80);
  const at = isoOrUndefined(raw.at);
  if (!id || !ID_PATTERN.test(id) || !at) return undefined;
  const kind = KINDS.find((entry) => entry === raw.kind);
  if (!kind) return undefined;
  const itemSource = isRecord(raw.item) ? raw.item : {};
  const name = text(itemSource.name, 120);
  if (!name) return undefined;
  const priceSource = isRecord(raw.price) ? raw.price : {};
  const amount = typeof priceSource.amount === "number" && Number.isFinite(priceSource.amount) ? priceSource.amount : undefined;
  if (amount === undefined || amount < 0) return undefined;
  const entry: TradeHistoryEntry = {
    id,
    at,
    kind,
    player: text(raw.player, 120) ?? "",
    item: { name },
    price: { amount, currency: text(priceSource.currency, 40) ?? "" },
    secure: raw.secure === "yes" ? "yes" : raw.secure === "maybe" ? "maybe" : "no",
    matched: MATCHED.find((entryKind) => entryKind === raw.matched) ?? "manual",
  };
  const baseType = text(itemSource.baseType, 120);
  if (baseType) entry.item.baseType = baseType;
  const itemClass = text(itemSource.itemClass, 60);
  if (itemClass) entry.item.itemClass = itemClass;
  const quantity =
    typeof itemSource.quantity === "number" && Number.isFinite(itemSource.quantity) && itemSource.quantity > 0
      ? Math.round(itemSource.quantity)
      : undefined;
  if (quantity !== undefined) entry.item.quantity = quantity;
  const currencyId = text(priceSource.currencyId, 40);
  if (currencyId) entry.price.currencyId = currencyId;
  if (typeof priceSource.exalted === "number" && Number.isFinite(priceSource.exalted)) {
    entry.price.exalted = priceSource.exalted;
  }
  const league = text(raw.league, 60);
  if (league) entry.league = league;
  const offerId = text(raw.offerId, 80);
  if (offerId) entry.offerId = offerId;
  const note = text(raw.note, 500);
  if (note) entry.note = note;
  const editedAt = isoOrUndefined(raw.editedAt);
  if (editedAt) entry.editedAt = editedAt;
  return entry;
}

export function parseHistoryFile(text_: string | undefined): {
  entries: TradeHistoryEntry[];
  ignoredIds: string[];
  issues: string[];
} {
  const issues: string[] = [];
  if (!text_) return { entries: [], ignoredIds: [], issues };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text_);
  } catch {
    return { entries: [], ignoredIds: [], issues: ["trade-history.json is not valid JSON; starting empty"] };
  }
  if (!isRecord(parsed)) return { entries: [], ignoredIds: [], issues: ["trade-history.json is not an object"] };
  const rawEntries = Array.isArray(parsed.entries) ? parsed.entries : [];
  if (!Array.isArray(parsed.entries)) issues.push("entries must be an array");
  const seen = new Set<string>();
  const entries: TradeHistoryEntry[] = [];
  let dropped = 0;
  for (const raw of rawEntries) {
    const entry = sanitizeHistoryEntry(raw);
    if (!entry) {
      dropped += 1;
      continue;
    }
    if (seen.has(entry.id)) {
      dropped += 1;
      continue;
    }
    seen.add(entry.id);
    entries.push(entry);
  }
  if (dropped > 0) issues.push(`${dropped} history row(s) dropped as unreadable or duplicated`);
  const ignoredIds = Array.isArray(parsed.ignoredIds)
    ? parsed.ignoredIds
        .map((value) => text(value, 80))
        .filter((value): value is string => Boolean(value) && ID_PATTERN.test(value as string))
        .slice(0, MAX_IGNORED_IDS)
    : [];
  return { entries: sortHistory(entries), ignoredIds, issues };
}

export function serializeHistoryFile(
  entries: readonly TradeHistoryEntry[],
  ignoredIds: readonly string[],
  now: string,
): string {
  return `${JSON.stringify(
    { version: 1, savedAt: now, entries, ignoredIds: ignoredIds.slice(0, MAX_IGNORED_IDS) },
    null,
    2,
  )}\n`;
}

/** `at` desc, then id, so the table order is stable across reloads. */
export function sortHistory(entries: readonly TradeHistoryEntry[]): TradeHistoryEntry[] {
  return [...entries].sort((a, b) => {
    if (a.at !== b.at) return a.at < b.at ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export function pruneHistory(
  entries: readonly TradeHistoryEntry[],
  now: string,
  retentionDays: number,
): TradeHistoryEntry[] {
  const cutoff = Date.parse(now) - Math.max(1, retentionDays) * 24 * 60 * 60_000;
  const kept = entries.filter((entry) => {
    const at = Date.parse(entry.at);
    return !Number.isFinite(at) || at >= cutoff;
  });
  return sortHistory(kept).slice(0, MAX_HISTORY);
}

/** Add (no id) or edit one row. The error string is the channel's `Error` message. */
export function applyHistoryEdit(
  entries: readonly TradeHistoryEntry[],
  edit: TradeHistoryEdit,
  now: string,
  table?: PriceTable,
  rand?: () => string,
): { entries: TradeHistoryEntry[]; entry: TradeHistoryEntry } | { error: string } {
  if (typeof edit !== "object" || edit === null || Array.isArray(edit)) {
    return { error: "trade-history-invalid:edit" };
  }
  const existing = edit.id ? entries.find((entry) => entry.id === edit.id) : undefined;
  if (edit.id && !existing) return { error: "trade-history-invalid:id" };
  const at = edit.at !== undefined ? isoOrUndefined(edit.at) : existing?.at ?? now;
  if (!at) return { error: "trade-history-invalid:at" };
  const kind = edit.kind !== undefined ? KINDS.find((entry) => entry === edit.kind) : existing?.kind ?? "sale";
  if (!kind) return { error: "trade-history-invalid:kind" };
  const itemName =
    edit.item?.name !== undefined ? text(edit.item.name, 120) : existing?.item.name ?? undefined;
  if (!itemName) return { error: "trade-history-invalid:item.name" };
  const amountRaw = edit.price?.amount !== undefined ? edit.price.amount : existing?.price.amount ?? 0;
  const amount = typeof amountRaw === "number" && Number.isFinite(amountRaw) && amountRaw >= 0 ? amountRaw : undefined;
  if (amount === undefined) return { error: "trade-history-invalid:price.amount" };
  const currency =
    edit.price?.currency !== undefined ? text(edit.price.currency, 40) ?? "" : existing?.price.currency ?? "";
  const secure: TradeSecure =
    edit.secure === "yes" || edit.secure === "maybe" || edit.secure === "no" ? edit.secure : existing?.secure ?? "no";

  const entry: TradeHistoryEntry = {
    id: existing?.id ?? newHistoryId(at, rand),
    at,
    kind,
    player: edit.player !== undefined ? text(edit.player, 120) ?? "" : existing?.player ?? "",
    item: { name: itemName },
    price: { amount, currency },
    secure,
    matched: existing?.matched ?? "manual",
  };
  const baseType = edit.item?.baseType !== undefined ? text(edit.item.baseType, 120) : existing?.item.baseType;
  if (baseType) entry.item.baseType = baseType;
  if (existing?.item.itemClass) entry.item.itemClass = existing.item.itemClass;
  const quantitySource = edit.item?.quantity !== undefined ? edit.item.quantity : existing?.item.quantity;
  if (typeof quantitySource === "number" && Number.isFinite(quantitySource) && quantitySource > 0) {
    entry.item.quantity = Math.round(quantitySource);
  }
  const league = edit.league !== undefined ? text(edit.league, 60) : existing?.league;
  if (league) entry.league = league;
  if (existing?.offerId) entry.offerId = existing.offerId;
  const note = edit.note !== undefined ? text(edit.note, 500) : existing?.note;
  if (note) entry.note = note;
  const exalted = currency ? priceInExalted(amount, currency, table) : undefined;
  if (exalted !== undefined) entry.price.exalted = exalted;
  const currencyId = currency ? normalizeTradeCurrency(currency) : undefined;
  if (currencyId) entry.price.currencyId = currencyId;
  if (existing) entry.editedAt = now;

  const next = existing
    ? entries.map((row) => (row.id === existing.id ? entry : row))
    : [entry, ...entries];
  return { entries: sortHistory(next), entry };
}

export function historyTotals(
  entries: readonly TradeHistoryEntry[],
  table?: PriceTable,
): TradeHistoryTotals {
  const divineRate = priceInExalted(1, "divine", table) ?? 0;
  const divineRateSource: TradeHistoryTotals["divineRateSource"] =
    table && lookupDivine(table) ? "price-table" : "fallback";
  const totals: TradeHistoryTotals = {
    count: entries.length,
    sales: 0,
    purchases: 0,
    unknown: 0,
    earningsExalted: 0,
    spendingsExalted: 0,
    profitExalted: 0,
    byCurrency: {},
    divineRate,
    divineRateSource,
    unpriced: 0,
  };
  for (const entry of entries) {
    if (entry.kind === "sale") totals.sales += 1;
    else if (entry.kind === "purchase") totals.purchases += 1;
    else totals.unknown += 1;
    const currency = entry.price.currency || "—";
    const bucket = totals.byCurrency[currency] ?? { sales: 0, purchases: 0 };
    if (entry.kind === "sale") bucket.sales += entry.price.amount;
    else if (entry.kind === "purchase") bucket.purchases += entry.price.amount;
    totals.byCurrency[currency] = bucket;
    const exalted = entry.price.currency
      ? priceInExalted(entry.price.amount, entry.price.currency, table)
      : undefined;
    if (exalted === undefined) {
      totals.unpriced += 1;
      continue;
    }
    if (entry.kind === "sale") totals.earningsExalted += exalted;
    else if (entry.kind === "purchase") totals.spendingsExalted += exalted;
  }
  totals.earningsExalted = round2(totals.earningsExalted);
  totals.spendingsExalted = round2(totals.spendingsExalted);
  totals.profitExalted = round2(totals.earningsExalted - totals.spendingsExalted);
  return totals;
}

function lookupDivine(table: PriceTable): boolean {
  return table.entries.some(
    (entry) => entry.match.name?.toLowerCase() === "divine orb" && entry.value > 0,
  );
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

const CSV_HEADER =
  "at,kind,player,item,base_type,quantity,amount,currency,exalted_estimate,league,secure,matched,note";

/**
 * Excel and LibreOffice treat a cell that starts with one of these as a
 * FORMULA, and item names, notes and player names are written by the
 * counterparty. Such a value is prefixed with an apostrophe (the spreadsheet
 * convention for "this is text") and always quoted, so it can never execute.
 */
const CSV_FORMULA_START = /^[=+\-@\t\r]/;

function csvField(value: string | number | undefined): string {
  if (value === undefined) return "";
  let raw = String(value);
  // Numbers come from our own sanitizers and are never formulas.
  const neutralized = typeof value === "string" && CSV_FORMULA_START.test(raw);
  if (neutralized) raw = `'${raw}`;
  return neutralized || /[",\r\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

/** RFC 4180, CRLF line ends, UTF-8 BOM so Excel opens it without an import wizard. */
export function historyToCsv(entries: readonly TradeHistoryEntry[]): string {
  const rows = sortHistory(entries).map((entry) =>
    [
      entry.at,
      entry.kind,
      entry.player,
      entry.item.name,
      entry.item.baseType,
      entry.item.quantity,
      entry.price.amount,
      entry.price.currency,
      entry.price.exalted,
      entry.league,
      entry.secure,
      entry.matched,
      entry.note,
    ]
      .map(csvField)
      .join(","),
  );
  return `\ufeff${[CSV_HEADER, ...rows].join("\r\n")}\r\n`;
}

/**
 * Verified sales the app's own shop flow recorded (Earnings tab re-read) become
 * history rows with a deterministic id, so re-importing the same journal is a
 * no-op. Heuristic rows are ignored: a guess must never become an earning.
 */
export function shopLedgerEntries(
  events: readonly ListingEvent[],
  now: string,
  retentionDays: number,
): TradeHistoryEntry[] {
  const cutoff = Date.parse(now) - Math.max(1, retentionDays) * 24 * 60 * 60_000;
  const rows: TradeHistoryEntry[] = [];
  for (const event of events) {
    if (event.kind !== "sold" || event.certainty !== "verified") continue;
    const realized = event.realized;
    if (!realized || !(realized.amount > 0)) continue;
    const at = Date.parse(event.at);
    if (Number.isFinite(at) && at < cutoff) continue;
    const entry: TradeHistoryEntry = {
      id: `shop_${event.fingerprint}_${atSlug(event.at)}`,
      at: event.at,
      kind: "sale",
      player: "",
      item: { name: event.name },
      price: { amount: realized.amount, currency: realized.currency },
      secure: "yes",
      matched: "shop-ledger",
    };
    if (event.itemClass) entry.item.itemClass = event.itemClass;
    if (event.count > 1) entry.item.quantity = event.count;
    if (realized.exalted !== undefined) entry.price.exalted = realized.exalted;
    if (event.reason) entry.note = event.reason.slice(0, 500);
    // `parseListingEvents` only checks at/fingerprint/kind, so a line written
    // by an older CLI run can have no name at all. Every other path into
    // trade-history.json is sanitized; this one must be too, or a nameless row
    // lands in the file and vanishes again on the next start.
    const clean = sanitizeHistoryEntry(entry);
    if (clean) rows.push(clean);
  }
  return rows;
}

/** Ledger rows never overwrite an edited row, and a deleted one stays deleted. */
export function mergeShopLedger(
  entries: readonly TradeHistoryEntry[],
  ledger: readonly TradeHistoryEntry[],
  ignoredIds: ReadonlySet<string>,
): { entries: TradeHistoryEntry[]; imported: number } {
  const known = new Set(entries.map((entry) => entry.id));
  const added: TradeHistoryEntry[] = [];
  for (const row of ledger) {
    if (known.has(row.id) || ignoredIds.has(row.id)) continue;
    known.add(row.id);
    added.push(row);
  }
  if (added.length === 0) return { entries: [...entries], imported: 0 };
  return { entries: sortHistory([...entries, ...added]), imported: added.length };
}
