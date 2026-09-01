/**
 * Local, user-editable price table.
 *
 * The live trade provider is deliberately disabled (see market.ts), so any
 * automation that reasons about value must NOT read ValuationResult numbers —
 * those come from fixtures. This table is the only price signal automation is
 * allowed to trust: deterministic, local, and owned by the user.
 */

export const PRICE_TABLE_SCHEMA_VERSION = 1 as const;

export interface PriceEntryMatch {
  /** Exact item name, case-insensitive (uniques, currency). */
  name?: string;
  /** Exact base type, case-insensitive. */
  baseType?: string;
  /** Exact item class, case-insensitive. */
  itemClass?: string;
  /** Only match at or above this item level. */
  minItemLevel?: number;
  /** Exact rarity, case-insensitive (Normal/Magic/Rare/Unique/Currency). */
  rarity?: string;
}

export interface PriceEntry {
  id: string;
  match: PriceEntryMatch;
  /** Value in the table's currency (exalted by default). */
  value: number;
  note?: string;
}

export interface PriceTable {
  schemaVersion: typeof PRICE_TABLE_SCHEMA_VERSION;
  currency: string;
  updatedAt?: string;
  entries: PriceEntry[];
}

export interface PriceLookupInput {
  name?: string;
  baseType?: string;
  itemClass?: string;
  itemLevel?: number;
  rarity?: string;
}

export interface PriceLookupResult {
  entry: PriceEntry;
  value: number;
  currency: string;
  /** Higher wins when several entries match. */
  specificity: number;
}

export function emptyPriceTable(currency = "exalted"): PriceTable {
  return { schemaVersion: PRICE_TABLE_SCHEMA_VERSION, currency, entries: [] };
}

/**
 * A deliberately small starter set: entries whose value is stable in kind
 * (currency, obviously-good bases) rather than league-priced numbers. The
 * user is expected to edit everything here.
 */
export function starterPriceTable(): PriceTable {
  const entries: Array<{ id: string; match: PriceEntryMatch; value: number; note?: string }> = [
    { id: "divine-orb", match: { name: "Divine Orb" }, value: 40, note: "Edit to the current rate." },
    { id: "perfect-jewellers-orb", match: { name: "Perfect Jeweller's Orb" }, value: 20 },
    { id: "greater-jewellers-orb", match: { name: "Greater Jeweller's Orb" }, value: 2 },
    { id: "exalted-orb", match: { name: "Exalted Orb" }, value: 1 },
    { id: "chaos-orb", match: { name: "Chaos Orb" }, value: 0.5 },
    { id: "any-unique", match: { rarity: "Unique" }, value: 1, note: "Floor for unreviewed uniques." },
  ];
  return {
    schemaVersion: PRICE_TABLE_SCHEMA_VERSION,
    currency: "exalted",
    entries,
  };
}

function ciEquals(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined) return false;
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

export function entrySpecificity(match: PriceEntryMatch): number {
  let score = 0;
  if (match.name) score += 8;
  if (match.baseType) score += 4;
  if (match.itemClass) score += 2;
  if (match.minItemLevel !== undefined) score += 1;
  if (match.rarity) score += 1;
  return score;
}

export function entryMatches(match: PriceEntryMatch, input: PriceLookupInput): boolean {
  if (entrySpecificity(match) === 0) return false;
  if (match.name && !ciEquals(match.name, input.name)) return false;
  if (match.baseType && !ciEquals(match.baseType, input.baseType)) return false;
  if (match.itemClass && !ciEquals(match.itemClass, input.itemClass)) return false;
  if (match.rarity && !ciEquals(match.rarity, input.rarity)) return false;
  if (match.minItemLevel !== undefined && (input.itemLevel ?? 0) < match.minItemLevel) return false;
  return true;
}

export function lookupPrice(
  table: PriceTable,
  input: PriceLookupInput,
): PriceLookupResult | undefined {
  let best: PriceLookupResult | undefined;
  for (const entry of table.entries) {
    if (!entryMatches(entry.match, input)) continue;
    const specificity = entrySpecificity(entry.match);
    if (
      !best ||
      specificity > best.specificity ||
      (specificity === best.specificity && entry.value > best.value)
    ) {
      best = { entry, value: entry.value, currency: table.currency, specificity };
    }
  }
  return best;
}

export interface PriceTableIssue {
  path: string;
  message: string;
}

export interface PriceTableValidation {
  valid: boolean;
  table?: PriceTable;
  issues: PriceTableIssue[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Accepts unknown JSON (imports, IPC payloads) and returns a safe table. */
export function validatePriceTable(input: unknown): PriceTableValidation {
  const issues: PriceTableIssue[] = [];
  if (!isRecord(input)) {
    return { valid: false, issues: [{ path: "", message: "The price table must be an object." }] };
  }
  const currency = optionalString(input.currency) ?? "exalted";
  const rawEntries = Array.isArray(input.entries) ? input.entries : undefined;
  if (!rawEntries) {
    return { valid: false, issues: [{ path: "entries", message: "The price table needs an entries array." }] };
  }
  if (rawEntries.length > 5_000) {
    return { valid: false, issues: [{ path: "entries", message: "Price tables are limited to 5000 entries." }] };
  }
  const entries: PriceEntry[] = [];
  const seenIds = new Set<string>();
  rawEntries.forEach((raw, index) => {
    const path = `entries[${index}]`;
    if (!isRecord(raw)) {
      issues.push({ path, message: "Each entry must be an object." });
      return;
    }
    const match = isRecord(raw.match) ? raw.match : undefined;
    if (!match) {
      issues.push({ path: `${path}.match`, message: "Each entry needs a match object." });
      return;
    }
    const minItemLevel =
      typeof match.minItemLevel === "number" && Number.isFinite(match.minItemLevel)
        ? Math.max(0, Math.floor(match.minItemLevel))
        : undefined;
    const parsedMatch: PriceEntryMatch = {
      ...(optionalString(match.name) ? { name: optionalString(match.name) } : {}),
      ...(optionalString(match.baseType) ? { baseType: optionalString(match.baseType) } : {}),
      ...(optionalString(match.itemClass) ? { itemClass: optionalString(match.itemClass) } : {}),
      ...(optionalString(match.rarity) ? { rarity: optionalString(match.rarity) } : {}),
      ...(minItemLevel !== undefined ? { minItemLevel } : {}),
    };
    if (entrySpecificity(parsedMatch) === 0) {
      issues.push({ path: `${path}.match`, message: "An entry must match on at least one field." });
      return;
    }
    const value = typeof raw.value === "number" && Number.isFinite(raw.value) ? raw.value : undefined;
    if (value === undefined || value < 0) {
      issues.push({ path: `${path}.value`, message: "Each entry needs a non-negative numeric value." });
      return;
    }
    let id = optionalString(raw.id) ?? `entry-${index}`;
    while (seenIds.has(id)) id = `${id}-dup`;
    seenIds.add(id);
    entries.push({
      id,
      match: parsedMatch,
      value,
      ...(optionalString(raw.note) ? { note: optionalString(raw.note) } : {}),
    });
  });
  const table: PriceTable = {
    schemaVersion: PRICE_TABLE_SCHEMA_VERSION,
    currency,
    ...(optionalString(input.updatedAt) ? { updatedAt: optionalString(input.updatedAt) } : {}),
    entries,
  };
  return { valid: issues.length === 0, table, issues };
}
