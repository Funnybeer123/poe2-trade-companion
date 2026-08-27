import type { BotDecision } from "../input/types.js";

export const SHADOW_MISMATCH_REASON = "shadow-mismatch";
export const INVENTORY_OBSERVED_REASON = "inventory-observed";
export const INVENTORY_NOT_FULL_REASON = "inventory-not-full";

export function withShadowMismatchReason(decision: BotDecision, mismatch: boolean): BotDecision {
  if (!mismatch || decision.reason.includes(SHADOW_MISMATCH_REASON)) {
    return decision;
  }
  return {
    ...decision,
    reason: `${SHADOW_MISMATCH_REASON};${decision.reason}`,
  };
}
