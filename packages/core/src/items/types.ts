import type { Confidence, ConfidenceBucket } from "../world-state/types.js";

export interface ItemSnapshot {
  rawText: string;
  source: "clipboard" | "ocr" | "fixture" | "api";
  capturedAtMs: number;
}

export interface NormalizedItem {
  fingerprint: string;
  class?: string;
  rarity?: string;
  name?: string;
  base?: string;
  itemLevel?: number;
  quality?: number;
  sockets?: string;
  modifiers: Array<{ text: string; value?: number; tier?: number; kind?: string }>;
  pseudos: Record<string, number>;
  corrupted?: boolean;
  unidentified?: boolean;
}

export interface QuoteContext {
  league: string;
  realm: "poe2";
  maxAgeMs: number;
}

export interface MarketComparable {
  id: string;
  price: number;
  currency: string;
  listedAtMs?: number;
  outlier: boolean;
}

export interface MarketQuote {
  providerId: string;
  quotedAtMs: number;
  currency: string;
  low?: number;
  fair?: number;
  high?: number;
  recommendedListing?: number;
  candidateCount: number;
  comparableCount: number;
  confidence: ConfidenceBucket;
  lowConfidenceReason?: string;
  comparables: MarketComparable[];
}

export interface MarketProvider {
  readonly id: string;
  supports(item: NormalizedItem): boolean;
  quote(item: NormalizedItem, context: QuoteContext): Promise<MarketQuote>;
  health(): Promise<{ ok: boolean; detail?: string }>;
}

export const OUTLIER_METHOD = "tukey-1.5-iqr" as const;
export type OutlierMethod = typeof OUTLIER_METHOD;

/** Every user-visible valuation includes these fields. Never a guaranteed sale price. */
export interface ValuationResult {
  item: NormalizedItem;
  quote: MarketQuote;
  outlierMethod: OutlierMethod;
  isGuaranteedSalePrice: false;
}

export type DesirabilityCategory =
  | "KeepUse"
  | "HighValueSell"
  | "Sell"
  | "BulkCommodity"
  | "CraftCandidate"
  | "VendorLowValue"
  | "Dump"
  | "ManualReview";

export interface DesirabilityFactor {
  id: string;
  weight: number;
  contribution: number;
  detail: string;
}

export interface DesirabilityResult {
  score: number; // 0..100 integer
  category: DesirabilityCategory;
  factors: DesirabilityFactor[];
  reasons: string[];
}

export type { Confidence, ConfidenceBucket };
