/**
 * Stash tracker — the snapshot model (package "stash-tracker").
 *
 * The Wealth page prices the sorter's Ctrl+C ledger into a net worth "now";
 * this module adds TIME. A snapshot freezes the priced ledger into one JSON
 * line so two points in time can be compared (added / removed / changed /
 * moved), summed per tab, excluded from, and drawn on a timeline.
 *
 * Pure: no Electron, no fs, no clock of its own — every entry point takes
 * the values it needs. Everything read back from disk goes through
 * `parseSnapshotJournal`, which never throws on a torn tail (a crash mid
 * append is expected) and drops records it cannot vouch for.
 *
 * Values are ESTIMATES: they come from the user's price table and the
 * triage evaluator's appraisals, never from a sale.
 */
import {
  latestObservations,
  netWorth,
  type InventoryRecord,
  type LocationWorth,
} from "./inventoryLedger.js";
import type { PriceTable } from "./priceTable.js";

export const SNAPSHOT_VERSION = 1 as const;

/**
 * How the snapshot came to be. FROZEN: `stash-tracker-summary.json` and
 * this enum are the contract the Session/Home package reads — renaming a
 * kind silently empties its stash-gains card.
 */
export type SnapshotKind = "manual" | "auto" | "session-start";

export interface SnapshotItem {
  /** The ledger's item fingerprint (16 hex chars). */
  fingerprint: string;
  /** Tab key ("Rings", "Rings#1") or "bag". */
  location: string;
  name: string;
  itemClass: string;
  rarity: string;
  baseType?: string;
  itemLevel?: number;
  identified: boolean;
  /** Distinct copies sharing the fingerprint at this location. */
  count: number;
  /** Units: stack size for stackables, else `count`. */
  units: number;
  stackable: boolean;
  /** Worth of every unit/copy the row covers, in exalted. Absent = unpriced. */
  valueExalted?: number;
  source: "price-table" | "estimate" | "none";
  /** When the ledger last saw it. */
  at: string;
  runId: string;
}

export interface WealthSnapshot {
  version: typeof SNAPSHOT_VERSION;
  id: string;
  at: string;
  kind: SnapshotKind;
  label?: string;
  sessionId: string;
  /** Newest ledger record at snapshot time — the auto-snapshot dedupe key. */
  ledgerAt: string;
  recordCount: number;
  divineRate: number;
  /** RAW totals (no exclusions), so the file is self-describing. */
  totalExalted: number;
  totalDivine: number;
  items: SnapshotItem[];
  locations: LocationWorth[];
  /** Old auto snapshots keep their totals but lose the item list (see pruneSnapshots). */
  itemsTrimmed?: boolean;
}

export interface SnapshotMeta extends Omit<WealthSnapshot, "items" | "locations"> {
  itemCount: number;
  locationCount: number;
  /** Totals with the user's exclusions applied — what the UI shows. */
  effectiveExalted: number;
  effectiveDivine: number;
}

export const MAX_AUTO_SNAPSHOTS = 100;
export const MAX_SNAPSHOT_LABEL = 60;
export const MAX_EXCLUDED = 2_000;
/** Auto snapshots older than this keep their totals and lose their items. */
export const TRIM_ITEMS_AFTER_MS = 7 * 24 * 60 * 60_000;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function timeOf(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function laterIso(a: string | undefined, b: string | undefined): string {
  if (!a) return b ?? "";
  if (!b) return a;
  return timeOf(a) >= timeOf(b) ? a : b;
}

/** Deterministic id from the instant; the kind travels in the record. */
export function snapshotId(at: string, _kind?: SnapshotKind): string {
  return `snap-${String(at).replace(/[:.]/g, "-")}`;
}

/**
 * Trim, collapse whitespace, drop control characters, cap the length.
 * Empty after cleaning → undefined (an unnamed snapshot shows its time).
 */
export function sanitizeLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!cleaned) return undefined;
  return cleaned.slice(0, MAX_SNAPSHOT_LABEL);
}

/* ---------------- building ---------------- */

export function snapshotFromLedger(
  records: readonly InventoryRecord[],
  table: PriceTable,
  input: { at: string; kind: SnapshotKind; sessionId: string; label?: string },
): WealthSnapshot {
  const observations = latestObservations(records);
  const worth = netWorth(observations, table);
  const items: SnapshotItem[] = worth.valued.map((entry) => {
    const observation = entry.observation;
    const count = observation.count ?? 1;
    return {
      fingerprint: observation.fingerprint,
      location: observation.location,
      name: observation.name,
      itemClass: observation.itemClass,
      rarity: observation.rarity,
      ...(observation.baseType ? { baseType: observation.baseType } : {}),
      ...(observation.itemLevel !== undefined ? { itemLevel: observation.itemLevel } : {}),
      identified: observation.identified === true,
      count,
      units: observation.stackCount ?? count,
      stackable: observation.stackCount !== undefined,
      ...(entry.valueExalted !== undefined ? { valueExalted: round2(entry.valueExalted) } : {}),
      source: entry.source,
      at: observation.at,
      runId: observation.runId,
    };
  });
  let ledgerAt = "";
  for (const record of records) ledgerAt = laterIso(ledgerAt, record.at);
  const label = sanitizeLabel(input.label);
  return {
    version: SNAPSHOT_VERSION,
    id: snapshotId(input.at, input.kind),
    at: input.at,
    kind: input.kind,
    ...(label ? { label } : {}),
    sessionId: input.sessionId,
    ledgerAt: ledgerAt || input.at,
    recordCount: records.length,
    divineRate: worth.divineRate,
    totalExalted: worth.totalExalted,
    totalDivine: worth.totalDivine,
    items,
    locations: worth.locations,
  };
}

/* ---------------- exclusions ---------------- */

export interface LocationTotal extends LocationWorth {
  excludedExalted: number;
  excludedItems: number;
}

export interface AppliedExclusions {
  totalExalted: number;
  totalDivine: number;
  excludedExalted: number;
  items: SnapshotItem[];
  locations: LocationTotal[];
}

/**
 * Worth after exclusions. A trimmed snapshot (items dropped by pruning)
 * has no rows left to filter, so its recorded raw total stands — the UI
 * says so rather than pretending the stash was empty.
 */
export function effectiveTotal(snapshot: WealthSnapshot, excluded: ReadonlySet<string>): number {
  if (snapshot.itemsTrimmed) return snapshot.totalExalted;
  let total = 0;
  for (const item of snapshot.items) {
    if (excluded.has(item.fingerprint)) continue;
    total += item.valueExalted ?? 0;
  }
  return round2(total);
}

export function locationTotals(
  items: readonly SnapshotItem[],
  excluded: ReadonlySet<string>,
): LocationTotal[] {
  const byLocation = new Map<string, LocationTotal>();
  for (const item of items) {
    const entry =
      byLocation.get(item.location) ??
      {
        location: item.location,
        items: 0,
        priced: 0,
        unpriced: 0,
        valueExalted: 0,
        lastScanAt: item.at,
        runId: item.runId,
        excludedExalted: 0,
        excludedItems: 0,
      };
    if (excluded.has(item.fingerprint)) {
      entry.excludedItems += item.count;
      entry.excludedExalted = round2(entry.excludedExalted + (item.valueExalted ?? 0));
    } else {
      entry.items += item.count;
      if (item.valueExalted === undefined) entry.unpriced += item.count;
      else {
        entry.priced += item.count;
        entry.valueExalted = round2(entry.valueExalted + item.valueExalted);
      }
    }
    if (timeOf(item.at) > timeOf(entry.lastScanAt)) {
      entry.lastScanAt = item.at;
      entry.runId = item.runId;
    }
    byLocation.set(item.location, entry);
  }
  return [...byLocation.values()].sort((a, b) => b.valueExalted - a.valueExalted);
}

export function applyExclusions(
  snapshot: WealthSnapshot,
  excluded: ReadonlySet<string>,
): AppliedExclusions {
  const items = snapshot.items.filter((item) => !excluded.has(item.fingerprint));
  const totalExalted = effectiveTotal(snapshot, excluded);
  const rate = snapshot.divineRate;
  return {
    totalExalted,
    totalDivine: rate > 0 ? round2(totalExalted / rate) : 0,
    excludedExalted: round2(snapshot.totalExalted - totalExalted),
    items,
    locations: locationTotals(snapshot.items, excluded),
  };
}

export function snapshotMeta(snapshot: WealthSnapshot, excluded: ReadonlySet<string>): SnapshotMeta {
  const effectiveExalted = effectiveTotal(snapshot, excluded);
  const rate = snapshot.divineRate;
  const { items: _items, locations, ...rest } = snapshot;
  return {
    ...rest,
    itemCount: snapshot.items.length,
    locationCount: locations.length,
    effectiveExalted,
    effectiveDivine: rate > 0 ? round2(effectiveExalted / rate) : 0,
  };
}

/* ---------------- view filters (renderer-only, never persisted) ---------------- */

export interface ItemViewFilter {
  /** Minimum worth of ONE unit/copy. */
  minUnitExalted?: number;
  /** Minimum worth of the whole row. */
  minTotalExalted?: number;
  location?: string;
  query?: string;
  includeExcluded?: boolean;
}

function unitValue(item: SnapshotItem): number | undefined {
  if (item.valueExalted === undefined) return undefined;
  const divisor = Math.max(1, item.stackable ? item.units : item.count);
  return item.valueExalted / divisor;
}

export function filterSnapshotItems(
  items: readonly SnapshotItem[],
  filter: ItemViewFilter,
  excluded: ReadonlySet<string>,
): SnapshotItem[] {
  const terms = (filter.query ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
  return items.filter((item) => {
    if (!filter.includeExcluded && excluded.has(item.fingerprint)) return false;
    if (filter.location && item.location !== filter.location) return false;
    if (filter.minTotalExalted !== undefined && (item.valueExalted ?? 0) < filter.minTotalExalted) {
      return false;
    }
    if (filter.minUnitExalted !== undefined && (unitValue(item) ?? 0) < filter.minUnitExalted) {
      return false;
    }
    if (terms.length) {
      const haystack = `${item.name} ${item.itemClass} ${item.rarity} ${item.baseType ?? ""} ${item.location}`
        .toLowerCase();
      if (!terms.every((term) => haystack.includes(term))) return false;
    }
    return true;
  });
}

/* ---------------- diff ---------------- */

export type SnapshotDeltaKind = "added" | "removed" | "changed" | "moved";

export interface SnapshotDeltaSide {
  location: string;
  units: number;
  valueExalted?: number;
}

export interface SnapshotDelta {
  kind: SnapshotDeltaKind;
  key: string;
  fingerprint: string;
  name: string;
  itemClass: string;
  rarity: string;
  stackable: boolean;
  before?: SnapshotDeltaSide;
  after?: SnapshotDeltaSide;
  unitsDelta: number;
  valueDelta: number;
}

export interface SnapshotDiff {
  fromId: string;
  toId: string;
  fromAt: string;
  toAt: string;
  totalDelta: number;
  totalDeltaDivine: number;
  divineRate: number;
  added: number;
  removed: number;
  changed: number;
  moved: number;
  deltas: SnapshotDelta[];
  /** True when one side lost its item list to pruning: totals only. */
  trimmed: boolean;
}

/** Stacks coexist per tab, so a stackable's identity includes its location. */
function deltaKey(item: SnapshotItem): string {
  return item.stackable ? `${item.fingerprint}|${item.location}` : item.fingerprint;
}

function indexItems(
  snapshot: WealthSnapshot,
  excluded: ReadonlySet<string>,
): Map<string, SnapshotItem> {
  const map = new Map<string, SnapshotItem>();
  for (const item of snapshot.items) {
    if (excluded.has(item.fingerprint)) continue;
    const key = deltaKey(item);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, item);
      continue;
    }
    map.set(key, {
      ...existing,
      count: existing.count + item.count,
      units: existing.units + item.units,
      valueExalted:
        existing.valueExalted === undefined && item.valueExalted === undefined
          ? undefined
          : round2((existing.valueExalted ?? 0) + (item.valueExalted ?? 0)),
    });
  }
  return map;
}

function side(item: SnapshotItem): SnapshotDeltaSide {
  return {
    location: item.location,
    units: item.units,
    ...(item.valueExalted !== undefined ? { valueExalted: item.valueExalted } : {}),
  };
}

export function diffSnapshots(
  from: WealthSnapshot,
  to: WealthSnapshot,
  excluded: ReadonlySet<string> = new Set(),
): SnapshotDiff {
  const rate = to.divineRate > 0 ? to.divineRate : from.divineRate;
  const trimmed = Boolean(from.itemsTrimmed || to.itemsTrimmed);
  const base = {
    fromId: from.id,
    toId: to.id,
    fromAt: from.at,
    toAt: to.at,
    divineRate: rate,
  };
  if (trimmed) {
    const totalDelta = round2(effectiveTotal(to, excluded) - effectiveTotal(from, excluded));
    return {
      ...base,
      totalDelta,
      totalDeltaDivine: rate > 0 ? round2(totalDelta / rate) : 0,
      added: 0,
      removed: 0,
      changed: 0,
      moved: 0,
      deltas: [],
      trimmed: true,
    };
  }
  const before = indexItems(from, excluded);
  const after = indexItems(to, excluded);
  const deltas: SnapshotDelta[] = [];
  for (const [key, item] of after) {
    const previous = before.get(key);
    if (!previous) {
      deltas.push({
        kind: "added",
        key,
        fingerprint: item.fingerprint,
        name: item.name,
        itemClass: item.itemClass,
        rarity: item.rarity,
        stackable: item.stackable,
        after: side(item),
        unitsDelta: item.units,
        valueDelta: round2(item.valueExalted ?? 0),
      });
      continue;
    }
    const unitsDelta = item.units - previous.units;
    const valueDelta = round2((item.valueExalted ?? 0) - (previous.valueExalted ?? 0));
    const movedTab = !item.stackable && item.location !== previous.location;
    if (!movedTab && unitsDelta === 0 && valueDelta === 0) continue;
    deltas.push({
      kind: movedTab ? "moved" : "changed",
      key,
      fingerprint: item.fingerprint,
      name: item.name,
      itemClass: item.itemClass,
      rarity: item.rarity,
      stackable: item.stackable,
      before: side(previous),
      after: side(item),
      unitsDelta,
      valueDelta,
    });
  }
  for (const [key, item] of before) {
    if (after.has(key)) continue;
    deltas.push({
      kind: "removed",
      key,
      fingerprint: item.fingerprint,
      name: item.name,
      itemClass: item.itemClass,
      rarity: item.rarity,
      stackable: item.stackable,
      before: side(item),
      unitsDelta: -item.units,
      valueDelta: round2(-(item.valueExalted ?? 0)),
    });
  }
  deltas.sort(
    (a, b) =>
      Math.abs(b.valueDelta) - Math.abs(a.valueDelta) ||
      Math.abs(b.unitsDelta) - Math.abs(a.unitsDelta) ||
      a.name.localeCompare(b.name),
  );
  let totalDelta = 0;
  const counts = { added: 0, removed: 0, changed: 0, moved: 0 };
  for (const delta of deltas) {
    totalDelta += delta.valueDelta;
    counts[delta.kind] += 1;
  }
  totalDelta = round2(totalDelta);
  return {
    ...base,
    totalDelta,
    totalDeltaDivine: rate > 0 ? round2(totalDelta / rate) : 0,
    ...counts,
    deltas,
    trimmed: false,
  };
}

/* ---------------- session gains ---------------- */

export interface SessionGains {
  sessionId: string;
  start?: SnapshotMeta;
  latest?: SnapshotMeta;
  deltaExalted: number;
  deltaDivine: number;
  divineRate: number;
  elapsedMs: number;
  topGains: SnapshotDelta[];
  topLosses: SnapshotDelta[];
}

export function sessionGains(
  snapshots: readonly WealthSnapshot[],
  sessionId: string,
  current: WealthSnapshot | undefined,
  excluded: ReadonlySet<string>,
  now: number,
): SessionGains {
  const mine = snapshots.filter((snapshot) => snapshot.sessionId === sessionId);
  const anchors = mine.filter((snapshot) => snapshot.kind === "session-start");
  const start =
    [...anchors].sort((a, b) => timeOf(b.at) - timeOf(a.at))[0] ??
    [...mine].sort((a, b) => timeOf(a.at) - timeOf(b.at))[0];
  const latest =
    current ?? [...snapshots].sort((a, b) => timeOf(b.at) - timeOf(a.at))[0];
  const rate = latest?.divineRate ?? start?.divineRate ?? 0;
  if (!start || !latest) {
    return {
      sessionId,
      ...(start ? { start: snapshotMeta(start, excluded) } : {}),
      ...(latest ? { latest: snapshotMeta(latest, excluded) } : {}),
      deltaExalted: 0,
      deltaDivine: 0,
      divineRate: rate,
      elapsedMs: 0,
      topGains: [],
      topLosses: [],
    };
  }
  const diff = diffSnapshots(start, latest, excluded);
  const gains = diff.deltas.filter((delta) => delta.valueDelta > 0).slice(0, 5);
  const losses = diff.deltas.filter((delta) => delta.valueDelta < 0).slice(0, 5);
  return {
    sessionId,
    start: snapshotMeta(start, excluded),
    latest: snapshotMeta(latest, excluded),
    deltaExalted: diff.totalDelta,
    deltaDivine: diff.totalDeltaDivine,
    divineRate: rate,
    elapsedMs: Math.max(0, now - timeOf(start.at)),
    topGains: gains,
    topLosses: losses,
  };
}

/* ---------------- journal I/O ---------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, max = 200): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.slice(0, max);
  return trimmed.length ? trimmed : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sanitizeItem(raw: unknown): SnapshotItem | undefined {
  if (!isRecord(raw)) return undefined;
  const fingerprint = str(raw.fingerprint, 64);
  const location = str(raw.location, 120);
  const name = str(raw.name, 200);
  if (!fingerprint || !location || !name) return undefined;
  const count = num(raw.count);
  const units = num(raw.units);
  if (count === undefined || count < 1) return undefined;
  if (units === undefined || units < 0) return undefined;
  const value = num(raw.valueExalted);
  const source = raw.source;
  return {
    fingerprint,
    location,
    name,
    itemClass: str(raw.itemClass, 120) ?? "",
    rarity: str(raw.rarity, 60) ?? "",
    ...(str(raw.baseType, 200) ? { baseType: str(raw.baseType, 200)! } : {}),
    ...(num(raw.itemLevel) !== undefined ? { itemLevel: num(raw.itemLevel)! } : {}),
    identified: raw.identified === true,
    count: Math.floor(count),
    units,
    stackable: raw.stackable === true,
    ...(value !== undefined ? { valueExalted: value } : {}),
    source: source === "price-table" || source === "estimate" ? source : "none",
    at: str(raw.at, 40) ?? "",
    runId: str(raw.runId, 120) ?? "",
  };
}

function sanitizeLocation(raw: unknown): LocationWorth | undefined {
  if (!isRecord(raw)) return undefined;
  const location = str(raw.location, 120);
  if (!location) return undefined;
  return {
    location,
    items: num(raw.items) ?? 0,
    priced: num(raw.priced) ?? 0,
    unpriced: num(raw.unpriced) ?? 0,
    valueExalted: num(raw.valueExalted) ?? 0,
    lastScanAt: str(raw.lastScanAt, 40) ?? "",
    runId: str(raw.runId, 120) ?? "",
  };
}

function sanitizeSnapshot(raw: unknown): WealthSnapshot | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.version !== SNAPSHOT_VERSION) return undefined;
  const id = str(raw.id, 120);
  const at = str(raw.at, 40);
  const sessionId = str(raw.sessionId, 120);
  const kind = raw.kind;
  const totalExalted = num(raw.totalExalted);
  if (!id || !at || !sessionId || totalExalted === undefined) return undefined;
  if (kind !== "manual" && kind !== "auto" && kind !== "session-start") return undefined;
  const label = sanitizeLabel(raw.label);
  const divineRate = num(raw.divineRate) ?? 0;
  const items = Array.isArray(raw.items)
    ? raw.items.map(sanitizeItem).filter((item): item is SnapshotItem => item !== undefined)
    : [];
  const locations = Array.isArray(raw.locations)
    ? raw.locations
        .map(sanitizeLocation)
        .filter((entry): entry is LocationWorth => entry !== undefined)
    : [];
  return {
    version: SNAPSHOT_VERSION,
    id,
    at,
    kind,
    ...(label ? { label } : {}),
    sessionId,
    ledgerAt: str(raw.ledgerAt, 40) ?? at,
    recordCount: num(raw.recordCount) ?? 0,
    divineRate,
    totalExalted,
    totalDivine: num(raw.totalDivine) ?? (divineRate > 0 ? round2(totalExalted / divineRate) : 0),
    items,
    locations,
    ...(raw.itemsTrimmed === true ? { itemsTrimmed: true as const } : {}),
  };
}

/** JSONL loop: junk lines and a torn tail are skipped; duplicate ids keep the first. */
export function parseSnapshotJournal(text: string): WealthSnapshot[] {
  const out: WealthSnapshot[] = [];
  const seen = new Set<string>();
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // torn tail from a crash mid-append
    }
    const snapshot = sanitizeSnapshot(parsed);
    if (!snapshot || seen.has(snapshot.id)) continue;
    seen.add(snapshot.id);
    out.push(snapshot);
  }
  return out;
}

/** One line; JSON.stringify escapes any newline that reached a string field. */
export function serializeSnapshot(snapshot: WealthSnapshot): string {
  return JSON.stringify(snapshot);
}

export interface PruneResult {
  kept: WealthSnapshot[];
  dropped: string[];
  /** Ids whose item list was replaced by totals only. */
  trimmed: string[];
}

/**
 * Bound the journal. Named (manual) snapshots are never dropped — they are
 * the user's bookmarks. Auto and session-start snapshots beyond the cap go
 * oldest-first, and auto snapshots older than a week keep their totals but
 * lose their item lists (a full list is ~100-300 KB).
 */
export function pruneSnapshots(
  snapshots: readonly WealthSnapshot[],
  maxAuto: number,
  options: { now?: number; trimItemsAfterMs?: number } = {},
): PruneResult {
  const cap = Math.max(1, Math.floor(maxAuto));
  const disposable = snapshots.filter((snapshot) => snapshot.kind !== "manual");
  const excess = Math.max(0, disposable.length - cap);
  const dropIds = new Set(
    [...disposable]
      .sort((a, b) => timeOf(a.at) - timeOf(b.at))
      .slice(0, excess)
      .map((snapshot) => snapshot.id),
  );
  const now = options.now ?? Date.now();
  const trimAfter = options.trimItemsAfterMs ?? TRIM_ITEMS_AFTER_MS;
  const kept: WealthSnapshot[] = [];
  const trimmed: string[] = [];
  for (const snapshot of snapshots) {
    if (dropIds.has(snapshot.id)) continue;
    const stale = snapshot.kind === "auto" && now - timeOf(snapshot.at) > trimAfter;
    if (stale && !snapshot.itemsTrimmed && snapshot.items.length) {
      trimmed.push(snapshot.id);
      kept.push({ ...snapshot, items: [], itemsTrimmed: true });
      continue;
    }
    kept.push(snapshot);
  }
  return { kept, dropped: [...dropIds], trimmed };
}

/**
 * A sort run appends for minutes: snapshot only once the ledger file has
 * been quiet for `settleMs`, and never twice for the same `ledgerAt`.
 */
export function shouldAutoSnapshot(input: {
  ledgerAt?: string;
  latest?: Pick<WealthSnapshot, "ledgerAt" | "at">;
  fileChangedAt?: number;
  now: number;
  settleMs: number;
  recordCount: number;
}): boolean {
  if (!Number.isFinite(input.recordCount) || input.recordCount <= 0) return false;
  if (!input.ledgerAt) return false;
  if (input.latest && input.latest.ledgerAt === input.ledgerAt) return false;
  if (input.fileChangedAt !== undefined && input.now - input.fileChangedAt < input.settleMs) {
    return false;
  }
  return true;
}

/* ---------------- the summary mirror (the session/home handoff) ---------------- */

/**
 * FROZEN SHAPE. `stash-tracker/summary.json` (and its `stash-tracker-summary.json`
 * mirror) is what the Session/Home package reads; these field names and
 * `SnapshotKind` must not change without updating that package.
 */
export interface TrackerSummaryFile {
  version: 1;
  updatedAt: string;
  sessionId: string;
  divineRate: number;
  sessionStart?: { id: string; at: string; totalExalted: number };
  latest?: { id: string; at: string; kind: SnapshotKind; totalExalted: number; ledgerAt: string };
  sessionGainExalted: number;
  sessionGainDivine: number;
  snapshotCount: number;
  excludedCount: number;
}

export function trackerSummary(
  snapshots: readonly WealthSnapshot[],
  sessionId: string,
  current: WealthSnapshot | undefined,
  excluded: ReadonlySet<string>,
  now: string,
): TrackerSummaryFile {
  const gains = sessionGains(snapshots, sessionId, current, excluded, timeOf(now) || Date.now());
  return {
    version: 1,
    updatedAt: now,
    sessionId,
    divineRate: gains.divineRate,
    ...(gains.start
      ? {
          sessionStart: {
            id: gains.start.id,
            at: gains.start.at,
            totalExalted: gains.start.effectiveExalted,
          },
        }
      : {}),
    ...(gains.latest
      ? {
          latest: {
            id: gains.latest.id,
            at: gains.latest.at,
            kind: gains.latest.kind,
            totalExalted: gains.latest.effectiveExalted,
            ledgerAt: gains.latest.ledgerAt,
          },
        }
      : {}),
    sessionGainExalted: gains.deltaExalted,
    sessionGainDivine: gains.deltaDivine,
    snapshotCount: snapshots.length,
    excludedCount: excluded.size,
  };
}
