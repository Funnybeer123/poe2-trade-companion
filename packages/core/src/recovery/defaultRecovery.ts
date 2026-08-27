export interface RecoveryPolicy {
  maxAttempts: number;
  backoffMs: number[];
  suppressMs: number;
  terminalState: "FailedOrTimedOut" | "Idle" | "SafetyHold";
}

export const DEFAULT_RECOVERY: Record<string, RecoveryPolicy> = {
  "follow.lost-target": {
    maxAttempts: 5,
    backoffMs: [250, 500, 1000, 2000, 4000],
    suppressMs: 0,
    terminalState: "Idle",
  },
  "follow.stuck": {
    maxAttempts: 3,
    backoffMs: [400, 800, 1600],
    suppressMs: 5000,
    terminalState: "SafetyHold",
  },
  "loot.unreachable": {
    maxAttempts: 2,
    backoffMs: [300, 800],
    suppressMs: 15000,
    terminalState: "Idle",
  },
  "stash.failed-move": {
    maxAttempts: 3,
    backoffMs: [200, 400, 800],
    suppressMs: 0,
    terminalState: "FailedOrTimedOut",
  },
  "stash.wrong-tab": {
    maxAttempts: 3,
    backoffMs: [200, 400, 800],
    suppressMs: 0,
    terminalState: "FailedOrTimedOut",
  },
  "listing.verify-mismatch": {
    maxAttempts: 2,
    backoffMs: [0],
    suppressMs: 0,
    terminalState: "FailedOrTimedOut",
  },
  "trade.timeout": {
    maxAttempts: 1,
    backoffMs: [0],
    suppressMs: 0,
    terminalState: "FailedOrTimedOut",
  },
};

export function recoveryPolicy(key: string): RecoveryPolicy {
  const policy = DEFAULT_RECOVERY[key];
  if (policy === undefined) {
    throw new Error(`unknown-recovery-policy:${key}`);
  }
  return policy;
}
