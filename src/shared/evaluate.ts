/**
 * Evaluate — the price-check overlay (feature package "evaluate", channels
 * `evaluate:*`, settings namespace `evaluate`).
 *
 * One hotkey copies the hovered item with a single audited Ctrl+C (through
 * the chat-commands service — Evaluate never touches the input host itself),
 * parses it, builds an EDITABLE trade2 query from the item's substance, runs
 * ONE paced search plus ONE paced fetch and shows the listings, an estimated
 * band with its sample size, and — for currency — the bulk exchange price.
 *
 * Everything here is pure (no Electron, no DOM, no fs) so main, the renderer
 * and the tests share one source of truth for the payloads and the settings
 * sanitizer. Every number the UI renders from these shapes is an ESTIMATE:
 * listings are other players' asks, never guaranteed sale prices.
 */
import type { FeatureCall } from "./features.js";
import type { EvaluateProfileId } from "../core/tradeQuery.js";
import type { ConfidenceBucket, ValuationResult } from "../core/types.js";

export type { EvaluateProfileId } from "../core/tradeQuery.js";

/** Which query defaults an item gets (§7.4 of the design). */
export type EvaluateItemKind =
  | "rare"
  | "magic"
  | "normal"
  | "unique"
  | "unidentified-unique"
  | "currency"
  | "waystone"
  | "gem"
  | "flask"
  | "charm"
  | "jewel"
  | "tablet"
  | "relic"
  | "other";

/** Kinds that share one auto-search switch. */
export type EvaluateAutoSearchKey =
  | "rare"
  | "magic"
  | "normal"
  | "unique"
  | "currency"
  | "waystone"
  | "gem"
  | "other";

export type EvaluateSource = "hotkey" | "clipboard" | "item-log" | "paste";

export type EvaluateStaleness = "fresh" | "aging" | "stale";

export interface EvaluateProfileSettings {
  /** Fraction of our roll a listing must reach on a selected mod (0.5–1). */
  slack: number;
  /** How many notable mods the profile ticks; 99 = every searchable line. */
  maxMods: number;
}

export type EvaluateAutoSearch = Record<EvaluateAutoSearchKey, boolean>;

export interface EvaluateSettings {
  defaultProfile: EvaluateProfileId;
  profiles: Record<EvaluateProfileId, EvaluateProfileSettings>;
  autoSearch: EvaluateAutoSearch;
  defaultStatus: "online" | "onlineleague" | "any";
  defaultIndexed: "" | "1day" | "3days" | "1week" | "2weeks" | "1month" | "3months";
  defaultCurrency: "" | "exalted" | "divine" | "chaos";
  /** "clipboard-only" never asks for a Ctrl+C: the clipboard text is used. */
  captureMode: "auto" | "clipboard-only";
  pseudoMods: boolean;
  exchangeForCurrency: boolean;
  groupBySeller: boolean;
  /** Ids fetched per page; 10 = one trade2 fetch, which is also the cap. */
  pageSize: number;
}

export const EVALUATE_PROFILE_IDS: readonly EvaluateProfileId[] = [
  "quick-price",
  "exact-match",
  "crafting-base",
  "broad",
];

export const EVALUATE_PROFILE_LABELS: Readonly<Record<EvaluateProfileId, string>> = {
  "quick-price": "Quick Price",
  "exact-match": "Exact Match",
  "crafting-base": "Crafting Base",
  broad: "Broad",
};

export const EVALUATE_AUTO_SEARCH_KEYS: readonly EvaluateAutoSearchKey[] = [
  "rare",
  "magic",
  "normal",
  "unique",
  "currency",
  "waystone",
  "gem",
  "other",
];

const INDEXED_OPTIONS: readonly EvaluateSettings["defaultIndexed"][] = [
  "",
  "1day",
  "3days",
  "1week",
  "2weeks",
  "1month",
  "3months",
];

const CURRENCY_OPTIONS: readonly EvaluateSettings["defaultCurrency"][] = [
  "",
  "exalted",
  "divine",
  "chaos",
];

const STATUS_OPTIONS: readonly EvaluateSettings["defaultStatus"][] = ["online", "onlineleague", "any"];

/**
 * `quick-price.maxMods` is 4 (PoE Overlay's "top four scored mods"), which
 * deliberately overrides the foundation's EVALUATE_PROFILES default of 3;
 * `profileOf()` in src/core/evaluateQuery.ts applies these over it.
 */
export const DEFAULT_EVALUATE_SETTINGS: Readonly<EvaluateSettings> = Object.freeze({
  defaultProfile: "quick-price" as EvaluateProfileId,
  profiles: {
    "quick-price": { slack: 0.85, maxMods: 4 },
    "exact-match": { slack: 1, maxMods: 99 },
    "crafting-base": { slack: 1, maxMods: 0 },
    broad: { slack: 0.7, maxMods: 2 },
  },
  autoSearch: {
    rare: true,
    magic: true,
    normal: false,
    unique: true,
    currency: true,
    waystone: false,
    gem: true,
    other: false,
  },
  defaultStatus: "online",
  defaultIndexed: "",
  defaultCurrency: "",
  captureMode: "auto",
  pseudoMods: true,
  exchangeForCurrency: true,
  groupBySeller: false,
  pageSize: 10,
});

function record(raw: unknown): Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

function clamp(value: unknown, min: number, max: number, fallback: number, label: string, issues: string[]): number {
  const parsed = Number(value);
  if (value === undefined) return fallback;
  if (!Number.isFinite(parsed)) {
    issues.push(`${label}: not a number, kept ${fallback}`);
    return fallback;
  }
  const clamped = Math.min(max, Math.max(min, parsed));
  if (clamped !== parsed) issues.push(`${label}: ${parsed} clamped to ${clamped}`);
  return clamped;
}

function enumOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
  label: string,
  issues: string[],
): T {
  if (value === undefined) return fallback;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  issues.push(`${label}: "${String(value)}" is not one of ${allowed.join(", ")} — kept ${fallback}`);
  return fallback;
}

function boolOf(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Settings namespace "evaluate". Anything read from disk goes through here,
 * so a hand-edited file can never widen a search past the profile bounds the
 * budget assumes (slack under 0.5 or a page bigger than one trade2 fetch).
 */
export function normalizeEvaluateSettings(raw: unknown): { value: EvaluateSettings; issues: string[] } {
  const issues: string[] = [];
  const source = record(raw);
  const profilesRaw = record(source.profiles);
  const profiles = {} as Record<EvaluateProfileId, EvaluateProfileSettings>;
  for (const id of EVALUATE_PROFILE_IDS) {
    const fallback = DEFAULT_EVALUATE_SETTINGS.profiles[id];
    const entry = record(profilesRaw[id]);
    profiles[id] = {
      slack: clamp(entry.slack, 0.5, 1, fallback.slack, `profiles.${id}.slack`, issues),
      maxMods: Math.round(
        clamp(entry.maxMods, 0, 99, fallback.maxMods, `profiles.${id}.maxMods`, issues),
      ),
    };
  }
  const autoSearchRaw = record(source.autoSearch);
  const autoSearch = {} as EvaluateAutoSearch;
  for (const key of EVALUATE_AUTO_SEARCH_KEYS) {
    autoSearch[key] = boolOf(autoSearchRaw[key], DEFAULT_EVALUATE_SETTINGS.autoSearch[key]);
  }
  const value: EvaluateSettings = {
    defaultProfile: enumOf(
      source.defaultProfile,
      EVALUATE_PROFILE_IDS,
      DEFAULT_EVALUATE_SETTINGS.defaultProfile,
      "defaultProfile",
      issues,
    ),
    profiles,
    autoSearch,
    defaultStatus: enumOf(
      source.defaultStatus,
      STATUS_OPTIONS,
      DEFAULT_EVALUATE_SETTINGS.defaultStatus,
      "defaultStatus",
      issues,
    ),
    defaultIndexed: enumOf(
      source.defaultIndexed,
      INDEXED_OPTIONS,
      DEFAULT_EVALUATE_SETTINGS.defaultIndexed,
      "defaultIndexed",
      issues,
    ),
    defaultCurrency: enumOf(
      source.defaultCurrency,
      CURRENCY_OPTIONS,
      DEFAULT_EVALUATE_SETTINGS.defaultCurrency,
      "defaultCurrency",
      issues,
    ),
    captureMode: enumOf(
      source.captureMode,
      ["auto", "clipboard-only"] as const,
      DEFAULT_EVALUATE_SETTINGS.captureMode,
      "captureMode",
      issues,
    ),
    pseudoMods: boolOf(source.pseudoMods, DEFAULT_EVALUATE_SETTINGS.pseudoMods),
    exchangeForCurrency: boolOf(
      source.exchangeForCurrency,
      DEFAULT_EVALUATE_SETTINGS.exchangeForCurrency,
    ),
    groupBySeller: boolOf(source.groupBySeller, DEFAULT_EVALUATE_SETTINGS.groupBySeller),
    pageSize: Math.round(clamp(source.pageSize, 1, 10, DEFAULT_EVALUATE_SETTINGS.pageSize, "pageSize", issues)),
  };
  return { value, issues };
}

// ---------------------------------------------------------------------------
// The query builder's state
// ---------------------------------------------------------------------------

export type EvaluateRowKind = "mod" | "pseudo" | "property" | "fractured";

export type EvaluateEquipmentKey =
  | "pdps"
  | "edps"
  | "dps"
  | "aps"
  | "crit"
  | "ar"
  | "ev"
  | "es"
  | "block"
  | "spirit"
  | "rune_sockets"
  | "empty_rune_sockets"
  | "gem_sockets"
  | "ward";

/** One selectable line of the builder: a mod, a pseudo total, or a property. */
export interface EvaluateFilterRow {
  /** Stable: "mod:<block>:<order>" | "pseudo:<id>" | "prop:<equipmentKey>". */
  key: string;
  kind: EvaluateRowKind;
  label: string;
  /** trade2 stat ids; empty = not searchable (the row is disabled). */
  statIds: string[];
  /** Mod family (appraisal), used to keep one row per family per profile. */
  familyId?: string;
  equipmentKey?: EvaluateEquipmentKey;
  /** Our roll (Q20-normalised for properties). */
  value?: number;
  lowerIsBetter: boolean;
  min?: number;
  max?: number;
  enabled: boolean;
  affix?: "prefix" | "suffix" | "implicit" | "enchant" | "rune" | "desecrated" | "crafted" | "unknown";
  tier?: number;
  tierSource?: "copy" | "learned";
  modName?: string;
  /** Appraisal points, shown as the score tooltip. */
  score?: number;
  /** Set when a pseudo row absorbs this line ("in pseudo"). */
  consumedBy?: string;
  /** The mod texts a pseudo row summed. */
  sources?: string[];
  unsearchableReason?: string;
  /** "(Q20 est.)" and friends: why the number is not the printed one. */
  note?: string;
}

export interface EvaluateRangeToggle {
  min?: number;
  max?: number;
  enabled: boolean;
}

export interface EvaluateQueryState {
  profile: EvaluateProfileId;
  name?: string;
  type?: string;
  category?: string;
  rarity: "nonunique" | "unique" | "rare" | "magic" | "normal" | "any";
  status: "online" | "onlineleague" | "any";
  indexed: EvaluateSettings["defaultIndexed"];
  priceCurrency: EvaluateSettings["defaultCurrency"];
  rows: EvaluateFilterRow[];
  ilvl: EvaluateRangeToggle;
  quality: EvaluateRangeToggle;
  gemLevel: EvaluateRangeToggle;
  mapTier: EvaluateRangeToggle;
  runeSockets: EvaluateRangeToggle;
  emptyRuneSockets: EvaluateRangeToggle;
  gemSockets: EvaluateRangeToggle;
  flags: {
    corrupted?: boolean;
    mirrored?: boolean;
    sanctified?: boolean;
    fractured?: boolean;
    desecrated?: boolean;
    identified?: boolean;
    modifiableOnly: boolean;
  };
  openAffixes: { count: number; enabled: boolean; statId?: string };
  /** The unidentified-unique name the user picked. */
  uniqueVariant?: string;
}

// ---------------------------------------------------------------------------
// The item, the listings, the estimate
// ---------------------------------------------------------------------------

export interface EvaluateItemSummary {
  fingerprint: string;
  itemClass: string;
  rarity: string;
  name: string;
  baseType: string;
  kind: EvaluateItemKind;
  itemLevel?: number;
  quality?: number;
  identified: boolean;
  corrupted: boolean;
  mirrored: boolean;
  sanctified: boolean;
  requiredLevel?: number;
  runeSockets?: number;
  gemLevel?: number;
  stackCount?: number;
  waystoneTier?: number;
  dps?: {
    pdps: number;
    edps: number;
    chaos: number;
    total: number;
    aps: number;
    crit?: number;
    pdpsQ20?: number;
    totalQ20?: number;
  };
  defences?: {
    ar?: number;
    ev?: number;
    es?: number;
    ward?: number;
    block?: number;
    arQ20?: number;
    evQ20?: number;
    esQ20?: number;
  };
  affixCount: number;
  maxAffixes: number;
  openAffixes: number;
  /** Candidate unique names for an unidentified unique (price-table rows). */
  uniqueVariants: string[];
  /** trade2 exchange id, when this item is a currency we know one for. */
  currencyId?: string;
}

export interface EvaluateListingMods {
  enchant: string[];
  implicit: string[];
  explicit: string[];
  fractured: string[];
  desecrated: string[];
  rune: string[];
}

export interface EvaluateListingRow {
  id: string;
  price?: { amount: number; currency: string };
  priceText: string;
  priceExalted?: number;
  /** "1 div + 203 ex" when a fractional price splits cleanly. */
  fractional?: string;
  seller: string;
  character?: string;
  presence: "online" | "afk" | "offline" | "unknown";
  indexedAt?: string;
  ageMs?: number;
  stale: EvaluateStaleness;
  listingType: "whisper" | "secure";
  whisper?: string;
  name?: string;
  typeLine: string;
  itemLevel?: number;
  requiredLevel?: number;
  quality?: number;
  gemLevel?: number;
  sockets?: number;
  runeSockets?: number;
  stackSize?: number;
  dps?: { total?: number; pdps?: number; edps?: number };
  defences?: { arQ20?: number; evQ20?: number; esQ20?: number; wardQ20?: number };
  flags: string[];
  /** "~price 5 exalted" — copied to the clipboard, never typed in-game. */
  stashNote: string;
  buyoutNote: string;
  /** For the eye popover; the raw trade2 payload is never kept. */
  mods: EvaluateListingMods;
  properties: Array<{ name: string; value: string }>;
  requirements: Array<{ name: string; value: string }>;
}

export interface EvaluateEstimate {
  valuation: ValuationResult;
  sampleSize: number;
  candidateCount: number;
  confidence: ConfidenceBucket;
  basis: "stat-filtered" | "base-type" | "unique-name";
  caution?: string;
}

export interface EvaluateExchangeOfferRow {
  id: string;
  seller: string;
  online: boolean;
  /** "5 exalted : 1 divine" as printed. */
  ratio: string;
  stock: number;
  /** In `EvaluateExchange.quoteCurrency` — NOT always exalted. */
  perUnitQuoted?: number;
  whisper?: string;
}

/**
 * Every number here is expressed in `quoteCurrency` (the have-side currency),
 * which is divine when the item itself is exalted — hence "Quoted" in the
 * field names rather than a unit that would be wrong half the time.
 */
export interface EvaluateExchange {
  offers: EvaluateExchangeOfferRow[];
  bestAskQuoted?: number;
  medianAskQuoted?: number;
  stockTotal: number;
  /** The have-side currency the per-unit numbers are quoted in. */
  quoteCurrency: string;
  /** A successful cross-check that disagrees with the feed — not an error. */
  caution?: string;
  url: string;
  fetchedAt: string;
}

export interface EvaluateHistory {
  points: Array<{ time: string; price: number; quantity: number }>;
  current?: number;
  change3d?: number;
  change7d?: number;
  volume7d: number;
  fetchedAt?: string;
  stale: boolean;
}

export interface EvaluateResults {
  searchId: string;
  url: string;
  queryUrl: string;
  league: string;
  total: number;
  fetched: number;
  remainingIds: number;
  rows: EvaluateListingRow[];
  estimate: EvaluateEstimate;
  cached: boolean;
  fetchedAt: string;
  complexityError?: string;
}

export interface EvaluateBudgetView {
  lookups: number;
  searchesSpare: number;
  fetchesSpare: number;
  restrictedUntilIso?: string;
  hasSession: boolean;
  league?: string;
  leagueAmbiguous: boolean;
}

export type EvaluateCaptureStatus = "copied" | "clipboard" | "blocked" | "dry-run" | "timeout";

/**
 * Settings the RESULT surfaces need at render time. They are copied onto the
 * session when it opens so a preference the user set in Tools → Settings
 * reaches the overlay without a second settings read from the renderer.
 */
export interface EvaluateSessionPrefs {
  groupBySeller: boolean;
}

export interface EvaluateSession {
  id: string;
  source: EvaluateSource;
  openedAt: string;
  item: EvaluateItemSummary;
  query: EvaluateQueryState;
  results?: EvaluateResults;
  /** Saved price evidence available before a deliberate market search. */
  localEstimate?: EvaluateEstimate;
  exchange?: EvaluateExchange;
  history?: EvaluateHistory;
  busy: "idle" | "capturing" | "searching" | "fetching" | "exchanging";
  /** Last request error (rate limit, league, HTTP); never a stack. */
  error?: string;
  capture?: { status: EvaluateCaptureStatus; reason: string };
  /** False when the trade2 stat catalogue is missing: base-type search only. */
  catalogueReady: boolean;
  budget: EvaluateBudgetView;
  prefs: EvaluateSessionPrefs;
}

export interface EvaluateOpenInput {
  text?: string;
  source: EvaluateSource;
  autoSearch?: boolean;
  showOverlay?: boolean;
}

export type EvaluateOpenFailure = {
  error: string;
  reason: "empty" | "not-item-text" | "blocked" | "timeout" | "disabled";
};

export type EvaluateCopyKind = "note" | "b/o" | "whisper" | "query-url" | "item";

export interface EvaluateContract {
  "evaluate:open": FeatureCall<[input: EvaluateOpenInput], EvaluateSession | EvaluateOpenFailure>;
  "evaluate:current": FeatureCall<[], EvaluateSession | null>;
  "evaluate:search": FeatureCall<[sessionId: string, query: EvaluateQueryState], EvaluateSession>;
  "evaluate:more": FeatureCall<[sessionId: string], EvaluateSession>;
  "evaluate:exchange": FeatureCall<[sessionId: string], EvaluateSession>;
  "evaluate:set-profile": FeatureCall<[sessionId: string, profile: EvaluateProfileId], EvaluateSession>;
  "evaluate:copy": FeatureCall<
    [sessionId: string, what: { kind: EvaluateCopyKind; listingId?: string }],
    { ok: boolean; text?: string; error?: string }
  >;
  "evaluate:open-site": FeatureCall<[sessionId: string], { ok: boolean; url?: string; error?: string }>;
  "evaluate:watch": FeatureCall<[sessionId: string], { ok: boolean; watchId?: string; error?: string }>;
  "evaluate:close": FeatureCall<[sessionId: string], void>;
  "evaluate:budget": FeatureCall<[], EvaluateBudgetView>;
}

export interface EvaluateEvents {
  "evaluate:session": EvaluateSession;
}

export const EVALUATE_PANEL_ID = "evaluate";
export const EVALUATE_HOTKEY_ID = "evaluate";
export const EVALUATE_CLIPBOARD_HOTKEY_ID = "evaluate.clipboard";
export const EVALUATE_SETTINGS_ID = "evaluate";

/** The sentence ItemDetail prints under every band; kept identical on purpose. */
export const EVALUATE_DISCLAIMER =
  "This is an estimate, not a guaranteed sale price. Confirm current listings before acting.";

/** Which auto-search switch an item kind reads. */
export function autoSearchKeyFor(kind: EvaluateItemKind): EvaluateAutoSearchKey {
  switch (kind) {
    case "rare":
    case "magic":
    case "normal":
    case "currency":
    case "waystone":
    case "gem":
      return kind;
    case "unique":
    case "unidentified-unique":
      return "unique";
    default:
      return "other";
  }
}
