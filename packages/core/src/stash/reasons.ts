export const STASH_PLAN_EMPTY_REASON = "stash-plan-empty";
export const STASH_MOVE_PREFIX = "stash-move:";
export const STASH_TAB_PREFIX = "stash-tab:";
export const STASH_BACKOFF_REASON = "stash-backoff";
export const STASH_FAILED_MOVE_REASON = "stash.failed-move";
export const STASH_WRONG_TAB_REASON = "stash.wrong-tab";
export const STASH_FALLBACK_TAB_FULL_REASON = "stash-fallback-tab-full";
export const STASH_FAILED_OR_TIMED_OUT_REASON = "FailedOrTimedOut";
export const STASH_FAILED_MOVE_KEY = "stash.failed-move";
export const STASH_WRONG_TAB_KEY = "stash.wrong-tab";

export function stashMoveReason(step: {
  fingerprint: string;
  from: { kind: string; tabId?: string; x: number; y: number };
  to: { kind: string; tabId?: string; x: number; y: number };
  reason: string;
}): string {
  const from = `${step.from.kind}:${step.from.tabId ?? ""}:${String(step.from.x)},${String(step.from.y)}`;
  const to = `${step.to.kind}:${step.to.tabId ?? ""}:${String(step.to.x)},${String(step.to.y)}`;
  return `${STASH_MOVE_PREFIX}${step.fingerprint}:${from}->${to}:${step.reason}`;
}

export function stashTabReason(tabId: string): string {
  return `${STASH_TAB_PREFIX}${tabId}`;
}

export function stashMoveEvidence(
  fingerprint: string,
  fromKey: string,
  toKey: string,
  attempt: number,
): string {
  return ["stash-move", fingerprint, fromKey, toKey, String(attempt)].join("|");
}

export function stashTabEvidence(
  tabId: string,
  fingerprint: string,
  fromKey: string,
  toKey: string,
  attempt: number,
): string {
  return ["stash-tab", tabId, fingerprint, fromKey, toKey, String(attempt)].join("|");
}
