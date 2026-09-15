import type { PriceLesson, PriceLessonInput, TrainingPriceEstimate } from "../core/priceTraining.js";
import type { CompsSummary } from "../core/tradeComps.js";
import type { FeatureCall } from "./features.js";

export type { PriceLesson, PriceLessonInput, TrainingPriceEstimate };

export interface PriceReviewItem {
  id: string;
  league: string;
  itemText: string;
  fingerprint: string;
  groupKey: string;
  reason: string;
  firstSeen: string;
  lastSeen: string;
  seenCount: number;
}

/** Listing evidence stays separate from a locally taught price. */
export interface TrainingMarketResult {
  ok: boolean;
  summary?: CompsSummary;
  error?: string;
  cached?: boolean;
  league?: string;
  basis?: CompsSummary["basis"];
  fetchedAt?: string;
  expiresAt?: string;
}

export interface PriceTrainingBudget {
  league?: string;
  leagueAmbiguous: boolean;
  lookups: number;
  blockedReason?: string;
  restrictedUntilIso?: string;
  busy: boolean;
}

export interface PriceTrainingOverview {
  lessons: PriceLesson[];
  review: PriceReviewItem[];
  league?: string;
  budget: PriceTrainingBudget;
}

export interface PriceTrainingItemInput { itemText: string; league: string }
export interface PriceTrainingPreview {
  estimate: TrainingPriceEstimate;
  cachedMarket?: TrainingMarketResult;
  budget: PriceTrainingBudget;
}

export interface PriceTrainingContract {
  "price-training:overview": FeatureCall<[league?: string], PriceTrainingOverview>;
  "price-training:preview": FeatureCall<[input: PriceTrainingItemInput], PriceTrainingPreview>;
  "price-training:save": FeatureCall<[input: PriceLessonInput, id?: string], PriceLesson>;
  "price-training:remove": FeatureCall<[id: string], void>;
  "price-training:dismiss-review": FeatureCall<[id: string], void>;
  /** The only training channel permitted to request market listings. */
  "price-training:check-market": FeatureCall<[input: PriceTrainingItemInput], {
    market: TrainingMarketResult;
    budget: PriceTrainingBudget;
  }>;
}
