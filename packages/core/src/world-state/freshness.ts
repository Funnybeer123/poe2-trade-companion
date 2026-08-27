import type { Freshness, Observation } from "./types.js";

/** Age strictly below this is `fresh`. */
export const FRESH_MAX_AGE_MS = 250;
/** Age strictly below this (and at least `FRESH_MAX_AGE_MS`) is `aging`. */
export const AGING_MAX_AGE_MS = 1000;

/**
 * `fresh < 250ms`, `aging < 1000ms`, `stale >= 1000ms`,
 * `missing` if never observed (`observedAtMs` omitted/NaN).
 */
export function computeFreshness(observedAtMs: number | undefined, nowMs: number): Freshness {
  if (observedAtMs === undefined || !Number.isFinite(observedAtMs)) {
    return "missing";
  }
  const ageMs = nowMs - observedAtMs;
  if (ageMs < FRESH_MAX_AGE_MS) {
    return "fresh";
  }
  if (ageMs < AGING_MAX_AGE_MS) {
    return "aging";
  }
  return "stale";
}

export function withFreshness<T>(
  observation: Observation<T>,
  nowMs: number,
  neverObserved = false,
): Observation<T> {
  return {
    ...observation,
    freshness: neverObserved ? "missing" : computeFreshness(observation.observedAtMs, nowMs),
  };
}
