import type { Confidence, ConfidenceBucket } from "../world-state/types.js";

export function clampConfidence(value: number): Confidence {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return value;
}

export function confidenceBucket(value: Confidence): ConfidenceBucket {
  const confidence = clampConfidence(value);
  if (confidence === 0) {
    return "none";
  }
  if (confidence < 0.4) {
    return "low";
  }
  if (confidence < 0.75) {
    return "medium";
  }
  return "high";
}
