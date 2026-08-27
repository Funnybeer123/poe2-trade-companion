import { CLASS_SIZE_DEFAULTS, sizeKey } from "./itemSizeCatalog.js";
import type { NormalizedItem } from "./types.js";

const CLASS_ALIASES: Record<string, string> = {
  belt: "Belts",
  belts: "Belts",
  body: "Body Armours",
  "body armour": "Body Armours",
  "body armor": "Body Armours",
  "body armours": "Body Armours",
  "body armors": "Body Armours",
};

function aliasKey(raw: string): string {
  return sizeKey(raw);
}

function knownClassName(key: string): string | undefined {
  return CLASS_SIZE_DEFAULTS.find((row) => sizeKey(row.itemClass) === key)?.itemClass;
}

export function normalizeItemClass(raw: string): string {
  const key = aliasKey(raw);
  if (!key) return "";
  return CLASS_ALIASES[key] ?? knownClassName(key) ?? raw.trim().replace(/\s+/g, " ");
}

export function parseWantedClasses(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const canonical = normalizeItemClass(part);
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
  }
  return out;
}

export function readClassFlag(argv: string[]): string[] {
  const idx = argv.findIndex((arg) => arg === "--class" || arg.startsWith("--class="));
  if (idx < 0) return [];
  const hit = argv[idx]!;
  const parts: string[] = [];
  if (hit.startsWith("--class=") && hit.length > 8) parts.push(hit.slice(8));
  for (let i = idx + 1; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token.startsWith("-")) break;
    parts.push(token);
  }
  return parseWantedClasses(parts.join(" "));
}

export function itemMatchesWantedClass(
  parsed: Pick<NormalizedItem, "itemClass"> | string,
  wanted: string[],
): boolean {
  if (wanted.length === 0) return true;
  const itemClass = typeof parsed === "string" ? parsed : parsed.itemClass;
  const canonical = normalizeItemClass(itemClass);
  if (!canonical) return false;
  return wanted.some((entry) => normalizeItemClass(entry) === canonical);
}

export function noMatchReason(wanted: string[]): string {
  if (wanted.length === 1) return `stash-no-unused-${wanted[0]!.toLowerCase().replace(/\s+/g, "-")}`;
  return "no-matching-items";
}

export function isClassFilterReason(reason: string): boolean {
  return reason === "no-matching-items" || (reason.startsWith("stash-no-unused-") && reason !== "stash-no-unused-items");
}

const SEARCH_QUERY: Record<string, string> = {
  Currency: '"class: (currency|stackable currency)"',
  "Stackable Currency": '"class: stackable currency"',
};

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function searchQueryForClass(itemClass: string): string {
  const canonical = normalizeItemClass(itemClass);
  if (!canonical) return "";
  return SEARCH_QUERY[canonical] ?? `"class: ${escapeRegex(canonical)}"`;
}

export function searchQueriesForClasses(wanted: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const itemClass of wanted) {
    const query = searchQueryForClass(itemClass);
    if (!query || seen.has(query.toLowerCase())) continue;
    seen.add(query.toLowerCase());
    out.push(query);
  }
  return out;
}

/** Stable memory key for a request that may execute several class searches. */
export function searchScenarioQuery(wanted: string[]): string {
  return searchQueriesForClasses(wanted).join(" | ");
}
