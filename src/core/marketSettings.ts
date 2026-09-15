/**
 * Settings namespace "market" (the in-app trade browser).
 *
 * Kept in core, next to the rest of the Market model, so the sanitizer is
 * one module both main (the settings store) and the renderer (the settings
 * card) import. Pure: no Electron, no DOM, never throws on junk.
 *
 * Rule 4 of the minimal-config brief: these are Market's own defaults, not
 * an app-wide preference page — the everyday fields live on the Market view
 * and the expert ones behind a disclosure.
 */

export type MarketStatus = "online" | "onlineleague" | "any";
export type MarketSaleType = "priced" | "priced_with_price" | "unpriced" | "any";

export interface MarketSettings {
  /** Seeds `status` on a NEW tab; an open tab keeps what it has. */
  defaultStatus: MarketStatus;
  /** Seeds `trade.sale_type` on a new tab. */
  defaultSaleType: MarketSaleType;
  /** trade2 currency id used when a price bound is set without one (""=any). */
  defaultCurrency: string;
  /** Seed the "Instant buyout" box on a new tab (maps to `priced_with_price`; UNVERIFIED). */
  defaultInstantBuyout: boolean;
  /** After a whisper is sent, fold that seller's other rows into one line. */
  collapseAfterOffer: boolean;
  /** Rows older than this are dimmed as stale (1–720 h). */
  staleAfterHours: number;
  /** Chime on a live-search hit. */
  liveSound: boolean;
  /** Windows notification (and an overlay notice) on a live-search hit. */
  liveNotify: boolean;
  /**
   * Re-open every saved live search when the app starts. Default OFF: it
   * opens websockets to pathofexile.com with your POESESSID on every start.
   */
  resumeLiveSearches: boolean;
  /** Fetch slots kept spare for Evaluate/Deals/the shop CLI (0–8). */
  minSpareFetches: number;
  /** Stop live searches automatically after this many hours (0 = never, ≤ 48). */
  stopLiveAfterHours: number;
}

export const DEFAULT_MARKET_SETTINGS: Readonly<MarketSettings> = {
  defaultStatus: "online",
  defaultSaleType: "priced",
  defaultCurrency: "",
  defaultInstantBuyout: false,
  collapseAfterOffer: true,
  staleAfterHours: 24,
  liveSound: true,
  liveNotify: false,
  resumeLiveSearches: false,
  minSpareFetches: 2,
  stopLiveAfterHours: 6,
};

const STATUS_VALUES: readonly MarketStatus[] = ["online", "onlineleague", "any"];
const SALE_TYPE_VALUES: readonly MarketSaleType[] = ["priced", "priced_with_price", "unpriced", "any"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampInt(value: unknown, low: number, high: number, fallback: number, label: string, issues: string[]): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    issues.push(`${label} is not a number; default kept`);
    return fallback;
  }
  const clamped = Math.min(high, Math.max(low, Math.round(parsed)));
  if (clamped !== parsed) issues.push(`${label} clamped to ${clamped}`);
  return clamped;
}

function bool(value: unknown, fallback: boolean, label: string, issues: string[]): boolean {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  issues.push(`${label} is not a boolean; default kept`);
  return fallback;
}

function pick<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
  label: string,
  issues: string[],
): T {
  if (value === undefined) return fallback;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  issues.push(`${label} is not one of ${allowed.join("/")}; default kept`);
  return fallback;
}

/** Sanitize whatever `companion-settings.json` holds; issues say what was dropped. */
export function normalizeMarketSettings(raw: unknown): { value: MarketSettings; issues: string[] } {
  const issues: string[] = [];
  const source = isRecord(raw) ? raw : {};
  const currencyRaw = source.defaultCurrency;
  let defaultCurrency = DEFAULT_MARKET_SETTINGS.defaultCurrency;
  if (currencyRaw !== undefined) {
    if (typeof currencyRaw === "string" && /^[a-z0-9-]{0,40}$/.test(currencyRaw.trim().toLowerCase())) {
      defaultCurrency = currencyRaw.trim().toLowerCase();
    } else {
      issues.push("defaultCurrency is not a trade2 currency id; default kept");
    }
  }
  return {
    value: {
      defaultStatus: pick(source.defaultStatus, STATUS_VALUES, DEFAULT_MARKET_SETTINGS.defaultStatus, "defaultStatus", issues),
      defaultSaleType: pick(
        source.defaultSaleType,
        SALE_TYPE_VALUES,
        DEFAULT_MARKET_SETTINGS.defaultSaleType,
        "defaultSaleType",
        issues,
      ),
      defaultCurrency,
      defaultInstantBuyout: bool(
        source.defaultInstantBuyout,
        DEFAULT_MARKET_SETTINGS.defaultInstantBuyout,
        "defaultInstantBuyout",
        issues,
      ),
      collapseAfterOffer: bool(source.collapseAfterOffer, DEFAULT_MARKET_SETTINGS.collapseAfterOffer, "collapseAfterOffer", issues),
      staleAfterHours: clampInt(source.staleAfterHours, 1, 720, DEFAULT_MARKET_SETTINGS.staleAfterHours, "staleAfterHours", issues),
      liveSound: bool(source.liveSound, DEFAULT_MARKET_SETTINGS.liveSound, "liveSound", issues),
      liveNotify: bool(source.liveNotify, DEFAULT_MARKET_SETTINGS.liveNotify, "liveNotify", issues),
      resumeLiveSearches: bool(
        source.resumeLiveSearches,
        DEFAULT_MARKET_SETTINGS.resumeLiveSearches,
        "resumeLiveSearches",
        issues,
      ),
      minSpareFetches: clampInt(source.minSpareFetches, 0, 8, DEFAULT_MARKET_SETTINGS.minSpareFetches, "minSpareFetches", issues),
      stopLiveAfterHours: clampInt(
        source.stopLiveAfterHours,
        0,
        48,
        DEFAULT_MARKET_SETTINGS.stopLiveAfterHours,
        "stopLiveAfterHours",
        issues,
      ),
    },
    issues,
  };
}
