import { computeFreshness } from "../world-state/freshness.js";
import type { Observation, UiModeState } from "../world-state/types.js";
import type { PerceptionFrame, PerceptionFrameInput } from "./types.js";

export function unknownUiMode(details?: string): UiModeState {
  return details === undefined ? { kind: "unknown" } : { kind: "unknown", details };
}

export function unknownUiObservation(nowMs: number, details?: string): Observation<UiModeState> {
  return {
    value: unknownUiMode(details),
    confidence: 0,
    observedAtMs: nowMs,
    freshness: computeFreshness(nowMs, nowMs),
  };
}

export function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Analyze failures become an unknown UI with confidence 0. Process is missing /
 * not allowlisted so SafetyHold is eligible. The loop must not throw.
 */
export function analyzeFailureFrame(
  frame: Pick<PerceptionFrameInput, "tickId" | "capturedAtMs">,
  error: unknown,
): PerceptionFrame {
  const details = errorDetail(error);
  return {
    tickId: frame.tickId,
    capturedAtMs: frame.capturedAtMs,
    evidenceId: `analyze-error:${String(frame.tickId)}`,
    ui: unknownUiObservation(frame.capturedAtMs, details),
    process: {
      value: { allowlisted: false },
      confidence: 0,
      observedAtMs: frame.capturedAtMs,
      freshness: "missing",
    },
  };
}
