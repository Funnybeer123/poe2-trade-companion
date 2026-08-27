import type { ConfidenceBucket } from "../world-state/types.js";
import {
  OUTLIER_METHOD,
  type MarketComparable,
  type MarketQuote,
  type NormalizedItem,
  type ValuationResult,
} from "../items/types.js";

export const LOCKED_OUTLIER_METHOD = OUTLIER_METHOD;

export interface PricePoint {
  id: string;
  price: number;
  currency: string;
  listedAtMs?: number;
}

function sortedPrices(values: number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

/** Linear-interpolation quantile on a sorted ascending array. */
export function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return Number.NaN;
  }
  const clamped = Math.min(1, Math.max(0, p));
  const idx = (sorted.length - 1) * clamped;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const low = sorted[lo] ?? Number.NaN;
  const high = sorted[hi] ?? low;
  if (lo === hi) {
    return low;
  }
  return low + (high - low) * (idx - lo);
}

export function median(sorted: number[]): number {
  return quantile(sorted, 0.5);
}

/**
 * Tukey 1.5 IQR. Locked Phase 08 outlier method.
 * Fewer than 4 samples: no outliers (IQR is unstable).
 */
export function tukeyInliers(values: number[]): { inliers: number[]; outlierFlags: boolean[] } {
  if (values.length < 4) {
    return { inliers: [...values], outlierFlags: values.map(() => false) };
  }
  const sorted = sortedPrices(values);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const iqr = q3 - q1;
  const lowFence = q1 - 1.5 * iqr;
  const highFence = q3 + 1.5 * iqr;
  const outlierFlags = values.map((value) => value < lowFence || value > highFence);
  return {
    inliers: values.filter((_, index) => outlierFlags[index] !== true),
    outlierFlags,
  };
}

export function confidenceFromCounts(comparableCount: number): ConfidenceBucket {
  if (comparableCount <= 0) {
    return "none";
  }
  if (comparableCount < 3) {
    return "low";
  }
  if (comparableCount < 8) {
    return "medium";
  }
  return "high";
}

export function lowConfidenceReasonFor(
  confidence: ConfidenceBucket,
  comparableCount: number,
): string | undefined {
  if (confidence === "none") {
    return "no-comparables";
  }
  if (confidence === "low") {
    return comparableCount < 3 ? "small-sample" : "low-confidence";
  }
  return undefined;
}

export function summarizeInliers(
  inliers: number[],
): Pick<MarketQuote, "low" | "fair" | "high" | "recommendedListing"> {
  if (inliers.length === 0) {
    return {};
  }
  const sorted = sortedPrices(inliers);
  const fair = median(sorted);
  if (sorted.length < 4) {
    return {
      low: sorted[0],
      fair,
      high: sorted[sorted.length - 1],
      recommendedListing: fair,
    };
  }
  return {
    low: quantile(sorted, 0.25),
    fair,
    high: quantile(sorted, 0.75),
    recommendedListing: fair,
  };
}

export function valueFromPrices(
  item: NormalizedItem,
  input: {
    providerId: string;
    quotedAtMs: number;
    currency: string;
    points: PricePoint[];
    lowConfidenceReason?: string;
  },
): ValuationResult {
  const { inliers, outlierFlags } = tukeyInliers(input.points.map((point) => point.price));
  const comparables: MarketComparable[] = input.points.map((point, index) => ({
    id: point.id,
    price: point.price,
    currency: point.currency,
    listedAtMs: point.listedAtMs,
    outlier: outlierFlags[index] === true,
  }));
  const summary = summarizeInliers(inliers);
  const comparableCount = inliers.length;
  const confidence = confidenceFromCounts(comparableCount);
  const quote: MarketQuote = {
    providerId: input.providerId,
    quotedAtMs: input.quotedAtMs,
    currency: input.currency,
    ...summary,
    candidateCount: input.points.length,
    comparableCount,
    confidence,
    lowConfidenceReason: input.lowConfidenceReason ?? lowConfidenceReasonFor(confidence, comparableCount),
    comparables,
  };
  return {
    item,
    quote,
    outlierMethod: LOCKED_OUTLIER_METHOD,
    isGuaranteedSalePrice: false,
  };
}

export function failedQuote(
  providerId: string,
  quotedAtMs: number,
  reason: string,
  currency = "exalted",
): MarketQuote {
  return {
    providerId,
    quotedAtMs,
    currency,
    candidateCount: 0,
    comparableCount: 0,
    confidence: "none",
    lowConfidenceReason: reason,
    comparables: [],
  };
}

export function failedValuation(
  item: NormalizedItem,
  providerId: string,
  quotedAtMs: number,
  reason: string,
): ValuationResult {
  return {
    item,
    quote: failedQuote(providerId, quotedAtMs, reason),
    outlierMethod: LOCKED_OUTLIER_METHOD,
    isGuaranteedSalePrice: false,
  };
}
