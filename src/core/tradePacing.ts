/**
 * trade2 request pacing from the server's own rate-limit headers.
 *
 * Every trade2 response names the policy that governs it and where we stand:
 *   X-Rate-Limit-Policy:   trade-search-request-limit
 *   X-Rate-Limit-Ip:       8:10:60,15:60:120,60:300:1800   max:period:penalty
 *   X-Rate-Limit-Ip-State: 3:10:0,7:60:0,21:300:0          hits:period:restricted
 * and a 429 carries Retry-After. The pacer keeps our own hit log per policy,
 * reconciles it with the server's counts (traffic from another process or
 * the browser shows up there), and says how long to wait so that no rule's
 * window ever fills — one slot per rule is always left unused. Snapshots
 * are plain JSON so consecutive CLI processes share ONE budget: on
 * 2026-09-03 eleven items at a fixed 2s gap were double the 60s tier and
 * earned a penalty window every run.
 */

export interface RateRule {
  /** Requests allowed inside the window. */
  max: number;
  periodSec: number;
  /** Seconds of restriction when the window overflows. */
  penaltySec: number;
}

export interface RateState {
  hits: number;
  periodSec: number;
  restrictedSec: number;
}

export interface PolicyRecord {
  rules: RateRule[];
  /** Epoch ms of our own requests, newest last. */
  hits: number[];
  /** Epoch ms until which the server has restricted us (0 = not). */
  restrictedUntil: number;
}

export type PacerSnapshot = Record<string, PolicyRecord>;

export const SEARCH_POLICY = "trade-search";
export const FETCH_POLICY = "trade-fetch";

/**
 * Conservative rules used until the first response teaches the real ones.
 * Being wrong on the slow side only costs seconds.
 */
export const DEFAULT_RULES: Record<string, RateRule[]> = {
  [SEARCH_POLICY]: [
    { max: 5, periodSec: 10, penaltySec: 60 },
    { max: 12, periodSec: 60, penaltySec: 120 },
    { max: 45, periodSec: 300, penaltySec: 1800 },
  ],
  [FETCH_POLICY]: [
    { max: 4, periodSec: 4, penaltySec: 10 },
    { max: 10, periodSec: 12, penaltySec: 60 },
  ],
};

/** Extra guard after a window frees a slot, to absorb clock skew. */
const RELEASE_SLACK_MS = 250;

function triples(header: string | null | undefined): Array<[number, number, number]> {
  if (!header) return [];
  const out: Array<[number, number, number]> = [];
  for (const part of header.split(",")) {
    const match = /^\s*(\d+):(\d+):(\d+)\s*$/.exec(part);
    if (!match) continue;
    out.push([Number(match[1]), Number(match[2]), Number(match[3])]);
  }
  return out;
}

/** "8:10:60,15:60:120" → rules. Malformed parts are skipped. */
export function parseRateRules(header: string | null | undefined): RateRule[] {
  const rules: RateRule[] = [];
  for (const [max, periodSec, penaltySec] of triples(header)) {
    if (max > 0 && periodSec > 0) rules.push({ max, periodSec, penaltySec });
  }
  return rules;
}

/** "3:10:0,7:60:0" → current state per window. */
export function parseRateState(header: string | null | undefined): RateState[] {
  const states: RateState[] = [];
  for (const [hits, periodSec, restrictedSec] of triples(header)) {
    if (periodSec > 0) states.push({ hits, periodSec, restrictedSec });
  }
  return states;
}

/** Which policy a trade2 URL falls under. */
export function policyForUrl(url: string): string {
  return /\/fetch\//.test(url) ? FETCH_POLICY : SEARCH_POLICY;
}

function isRule(value: unknown): value is RateRule {
  if (typeof value !== "object" || value === null) return false;
  const rule = value as Partial<RateRule>;
  return (
    typeof rule.max === "number" &&
    rule.max > 0 &&
    typeof rule.periodSec === "number" &&
    rule.periodSec > 0 &&
    typeof rule.penaltySec === "number"
  );
}

function isRecord(value: unknown): value is PolicyRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<PolicyRecord>;
  return (
    Array.isArray(record.rules) &&
    record.rules.every(isRule) &&
    Array.isArray(record.hits) &&
    record.hits.every((hit) => typeof hit === "number") &&
    typeof record.restrictedUntil === "number"
  );
}

export class TradePacer {
  private readonly policies = new Map<string, PolicyRecord>();

  constructor(snapshot?: PacerSnapshot | null) {
    if (!snapshot || typeof snapshot !== "object") return;
    for (const [name, record] of Object.entries(snapshot)) {
      if (isRecord(record) && record.rules.length > 0) {
        this.policies.set(name, {
          rules: record.rules.map((rule) => ({ ...rule })),
          hits: [...record.hits],
          restrictedUntil: record.restrictedUntil,
        });
      }
    }
  }

  private policy(name: string): PolicyRecord {
    let record = this.policies.get(name);
    if (!record) {
      const defaults = DEFAULT_RULES[name] ?? DEFAULT_RULES[SEARCH_POLICY]!;
      record = { rules: defaults.map((rule) => ({ ...rule })), hits: [], restrictedUntil: 0 };
      this.policies.set(name, record);
    }
    return record;
  }

  private prune(record: PolicyRecord, now: number): void {
    const horizonMs = Math.max(...record.rules.map((rule) => rule.periodSec)) * 1000;
    record.hits = record.hits.filter((hit) => now - hit < horizonMs && hit <= now);
  }

  /** Requests allowed in a rule's window; the last slot is never used. */
  private allowed(rule: RateRule): number {
    return Math.max(1, rule.max - 1);
  }

  /** Milliseconds to wait before one request under `name` may go out. */
  delayFor(name: string, now: number = Date.now()): number {
    const record = this.policy(name);
    this.prune(record, now);
    let wait = Math.max(0, record.restrictedUntil - now);
    const sorted = [...record.hits].sort((a, b) => a - b);
    for (const rule of record.rules) {
      const windowMs = rule.periodSec * 1000;
      const inWindow = sorted.filter((hit) => now - hit < windowMs);
      const allowed = this.allowed(rule);
      if (inWindow.length >= allowed) {
        // Enough of the oldest hits must leave the window first.
        const releasing = inWindow[inWindow.length - allowed]!;
        wait = Math.max(wait, releasing + windowMs - now + RELEASE_SLACK_MS);
      }
    }
    return wait;
  }

  /** How many requests under `name` could go out right now without waiting. */
  available(name: string, now: number = Date.now()): number {
    const record = this.policy(name);
    this.prune(record, now);
    if (record.restrictedUntil > now) return 0;
    let slots = Number.POSITIVE_INFINITY;
    for (const rule of record.rules) {
      const windowMs = rule.periodSec * 1000;
      const inWindow = record.hits.filter((hit) => now - hit < windowMs).length;
      slots = Math.min(slots, this.allowed(rule) - inWindow);
    }
    return Number.isFinite(slots) ? Math.max(0, slots) : 0;
  }

  /** Note that a request under `name` just went out. */
  record(name: string, now: number = Date.now()): void {
    const record = this.policy(name);
    record.hits.push(now);
    this.prune(record, now);
  }

  /** Learn the real rules and our standing from a response's headers. */
  observe(
    name: string,
    headers: { rules?: string | null; state?: string | null; retryAfter?: string | null },
    now: number = Date.now(),
  ): void {
    const record = this.policy(name);
    const rules = parseRateRules(headers.rules);
    if (rules.length > 0) record.rules = rules;
    // Windows are cumulative (a hit in the 10s window is also in the 60s
    // one), so reconcile shortest first: hits the server counts in a window
    // that we did not see, and that the next-shorter window did not count,
    // are at least that old — stamp them just outside the shorter window.
    // Stamping them "now" would jam every shorter window with old traffic
    // (2026-09-03: 42 hits from the 6h window blocked the 5-minute one).
    const states = parseRateState(headers.state).sort((a, b) => a.periodSec - b.periodSec);
    let shorterPeriodSec = 0;
    for (const state of states) {
      const windowMs = state.periodSec * 1000;
      const ours = record.hits.filter((hit) => now - hit < windowMs).length;
      const stamp = now - shorterPeriodSec * 1000 - 1;
      for (let extra = ours; extra < state.hits; extra += 1) record.hits.push(stamp);
      if (state.restrictedSec > 0) {
        record.restrictedUntil = Math.max(record.restrictedUntil, now + state.restrictedSec * 1000);
      }
      shorterPeriodSec = state.periodSec;
    }
    const retryAfter = Number(headers.retryAfter);
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      record.restrictedUntil = Math.max(record.restrictedUntil, now + retryAfter * 1000);
    }
    this.prune(record, now);
  }

  /** Epoch ms until which any (or the named) policy is restricted; 0 if none. */
  restrictedUntil(name?: string, now: number = Date.now()): number {
    const records = name ? [this.policy(name)] : [...this.policies.values()];
    let until = 0;
    for (const record of records) {
      if (record.restrictedUntil > now) until = Math.max(until, record.restrictedUntil);
    }
    return until;
  }

  rules(name: string): readonly RateRule[] {
    return this.policy(name).rules;
  }

  toJSON(): PacerSnapshot {
    const snapshot: PacerSnapshot = {};
    for (const [name, record] of this.policies) {
      snapshot[name] = {
        rules: record.rules.map((rule) => ({ ...rule })),
        hits: [...record.hits],
        restrictedUntil: record.restrictedUntil,
      };
    }
    return snapshot;
  }
}
