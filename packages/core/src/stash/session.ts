import type { BotDecision } from "../input/types.js";
import { locationKey } from "../inventory/types.js";
import type { PendingStashTransfer, WorldState, WorldStateFlags } from "../world-state/types.js";
import {
  STASH_FAILED_MOVE_KEY,
  STASH_FAILED_OR_TIMED_OUT_REASON,
  STASH_PLAN_EMPTY_REASON,
  STASH_WRONG_TAB_KEY,
} from "./reasons.js";
import type { TransferPlanStep } from "./types.js";

export function isStashRecovery(recoveryOf: string | undefined): boolean {
  return recoveryOf === STASH_FAILED_MOVE_KEY || recoveryOf === STASH_WRONG_TAB_KEY;
}

export function pendingMoveFromStep(
  step: TransferPlanStep,
  nowMs: number,
  attempts: number,
): PendingStashTransfer {
  return {
    fingerprint: step.fingerprint,
    from: step.from,
    to: step.to,
    kind: "move",
    attempts,
    lastAttemptMs: nowMs,
    destTabId: step.to.tabId ?? "",
    reason: step.reason,
  };
}

export function pendingTabClick(
  step: TransferPlanStep,
  nowMs: number,
  attempts: number,
): PendingStashTransfer {
  return {
    fingerprint: step.fingerprint,
    from: step.from,
    to: step.to,
    kind: "tab-click",
    attempts,
    lastAttemptMs: nowMs,
    destTabId: step.to.tabId ?? "",
    reason: step.reason,
  };
}

export function locationEvidenceKey(location: PendingStashTransfer["from"]): string {
  return locationKey(location);
}

export function stashEffectsFromDecision(
  world: WorldState,
  decision: BotDecision,
  nowMs: number,
): Partial<WorldStateFlags> {
  const flags: Partial<WorldStateFlags> = {};
  if (decision.module !== "stash" && decision.state !== "InventoryFull" && decision.state !== "StashSort") {
    return flags;
  }

  const emptyPlan = decision.reason.includes(STASH_PLAN_EMPTY_REASON);
  if (emptyPlan && !world.inventory.value.full) {
    flags.stashSessionActive = false;
    flags.pendingStashTransfer = null;
  }

  if (
    (decision.state === "SafetyHold" || decision.reason.includes(STASH_FAILED_OR_TIMED_OUT_REASON)) &&
    isStashRecovery(decision.recoveryOf)
  ) {
    flags.stashSafetyHold = true;
    flags.stashSessionActive = false;
    flags.pendingStashTransfer = null;
    return flags;
  }

  const pending = pendingFromDecision(decision, nowMs);
  if (pending !== undefined) {
    flags.pendingStashTransfer = pending;
  }

  return flags;
}

function pendingFromDecision(decision: BotDecision, nowMs: number): PendingStashTransfer | undefined {
  const moveId = decision.evidenceIds.find((id) => id.startsWith("stash-move|"));
  if (moveId !== undefined) {
    const [, fingerprint, fromKey, toKey, attemptText] = moveId.split("|");
    if (fingerprint !== undefined && fromKey !== undefined && toKey !== undefined) {
      const attempts = Number(attemptText ?? decision.retryIndex ?? 1);
      const to = parseLocationKey(toKey);
      return {
        fingerprint,
        from: parseLocationKey(fromKey),
        to,
        kind: "move",
        attempts: Number.isFinite(attempts) ? attempts : 1,
        lastAttemptMs: nowMs,
        destTabId: to.tabId ?? "",
        reason: decision.reason,
      };
    }
  }

  const tabId = decision.evidenceIds.find((id) => id.startsWith("stash-tab|"));
  if (tabId !== undefined) {
    const [, destTabId, fingerprint, fromKey, toKey, attemptText] = tabId.split("|");
    const attempts = Number(attemptText ?? decision.retryIndex ?? 1);
    return {
      fingerprint: fingerprint ?? "",
      from: parseLocationKey(fromKey ?? "inventory::0:0"),
      to: parseLocationKey(toKey ?? `stash:${destTabId ?? ""}:0:0`),
      kind: "tab-click",
      attempts: Number.isFinite(attempts) ? attempts : 1,
      lastAttemptMs: nowMs,
      destTabId: destTabId ?? "",
      reason: decision.reason,
    };
  }

  return undefined;
}

function parseLocationKey(key: string): PendingStashTransfer["from"] {
  const [kind, tabId, x, y] = key.split(":");
  return {
    kind: kind === "stash" ? "stash" : "inventory",
    tabId: tabId === undefined || tabId.length === 0 ? undefined : tabId,
    x: Number(x ?? 0),
    y: Number(y ?? 0),
  };
}
