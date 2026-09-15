/**
 * Renderer-facing contract for the "pricing-history" package (Tools →
 * Pricing) plus the sanitizer for its settings namespace.
 *
 * Nothing here talks to the game or to trade2: the rows come from the
 * Market trends service's poe2scout cache (paced, 12 h TTL) and from the
 * local price table, and every number is an estimate.
 */
import {
  MAX_FAVORITES,
  normalizeSort,
  type PricingCategory,
  type PricingDisplayCurrency,
  type PricingRow,
  type PricingSort,
} from "../core/pricingHistory.js";
import type { TrendPoint } from "../core/priceTrends.js";
import type { FeatureCall } from "./features.js";

export type { PricingCategory, PricingDisplayCurrency, PricingRow, PricingSort };

export interface PricingSettings {
  /** Series keys the user starred, insertion order, ≤ MAX_FAVORITES. */
  favorites: string[];
  displayCurrency: PricingDisplayCurrency;
  hideLowStock: boolean;
  sort: PricingSort;
  /** Last selected category ("all", "favorites" or a category id). */
  category: string;
  /** Accumulate poe2scout bars locally so the timeline outgrows 7 days. */
  keepHistory: boolean;
}

export const DEFAULT_PRICING_SETTINGS: PricingSettings = {
  favorites: [],
  displayCurrency: "auto",
  hideLowStock: true,
  sort: { key: "change3d", direction: "desc" },
  category: "all",
  keepHistory: true,
};

/**
 * The id space the tool itself renders: poe2scout's `CategoryApiId` values
 * (which categoryLabel() already humanizes through `_` as well as `-`) plus
 * the two synthetic ids. Narrower than this and a category the strip shows
 * would silently snap back to "all" when the user clicks it.
 */
const CATEGORY_PATTERN = /^[a-z0-9_-]{1,60}$/i;

/** Never throws; unknown keys are dropped and every field falls back. */
export function normalizePricingSettings(raw: unknown): PricingSettings {
  const source = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<PricingSettings>;
  const favorites: string[] = [];
  if (Array.isArray(source.favorites)) {
    const seen = new Set<string>();
    for (const entry of source.favorites) {
      if (typeof entry !== "string") continue;
      const key = entry.trim().slice(0, 120);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      favorites.push(key);
      if (favorites.length >= MAX_FAVORITES) break;
    }
  }
  const displayCurrency: PricingDisplayCurrency =
    source.displayCurrency === "exalted" || source.displayCurrency === "divine"
      ? source.displayCurrency
      : "auto";
  const rawCategory = typeof source.category === "string" ? source.category.trim() : "";
  const category = CATEGORY_PATTERN.test(rawCategory) ? rawCategory : "all";
  return {
    favorites,
    displayCurrency,
    hideLowStock: source.hideLowStock !== false,
    sort: normalizeSort(source.sort),
    category,
    keepHistory: source.keepHistory !== false,
  };
}

export interface PricingQuery {
  /** Fetch now (the trends service still applies its 5-minute courtesy). */
  refresh?: boolean;
  /** Serve only what is cached; never touches the network. */
  cachedOnly?: boolean;
}

export interface PricingHistoryStats {
  since: string;
  keys: number;
  bars: number;
  file: string;
  /** Size of the league file on disk, for the expert section. */
  bytes: number;
}

export interface PricingOverviewView {
  /** A cache (any age) served rows. */
  ok: boolean;
  league?: string;
  /** The trends cache stamp = "last updated". */
  fetchedAt?: string;
  /** Older than the trends TTL (12 h). */
  stale: boolean;
  refreshing: boolean;
  source: "cache" | "network" | "none";
  /** Last refresh error (league ambiguity, HTTP), verbatim from the service. */
  error?: string;
  /** Exalted value of one Divine Orb, and where it came from. */
  divineRate: number;
  divineRateSource: "feed" | "price-table" | "fallback";
  categories: PricingCategory[];
  /** Unfiltered and unsorted; the renderer filters, sorts and pages. */
  rows: PricingRow[];
  history?: PricingHistoryStats;
  /** Last history write failure, surfaced instead of thrown. */
  historyError?: string;
  settings: PricingSettings;
  generatedAt: string;
}

export interface PricingHistoryView {
  key: string;
  name: string;
  league: string;
  /** Oldest → newest: the merged local timeline, else the feed's ~7 bars. */
  points: TrendPoint[];
  source: "local-history" | "feed-cache";
  since?: string;
}

export interface PricingLeagueFile {
  league: string;
  since: string;
  keys: number;
  bars: number;
  file: string;
  bytes: number;
}

export interface PricingContract {
  "pricing:overview": FeatureCall<[query?: PricingQuery], PricingOverviewView>;
  "pricing:history": FeatureCall<[key: string], PricingHistoryView | undefined>;
  "pricing:toggle-favorite": FeatureCall<[key: string], PricingSettings>;
  "pricing:configure": FeatureCall<[patch: Partial<PricingSettings>], PricingSettings>;
  /** Local history files present (expert section). */
  "pricing:leagues": FeatureCall<[], PricingLeagueFile[]>;
  /** Removes our own history files; returns how many. Two-click in the UI. */
  "pricing:clear-history": FeatureCall<[league?: string], number>;
}

export interface PricingEvents {
  /** After toggle-favorite / configure / clear-history. */
  "pricing:settings": PricingSettings;
  /** After an overview whose refresh actually fetched and merged new bars. */
  "pricing:refreshed": { league: string; fetchedAt: string; addedBars: number };
}
