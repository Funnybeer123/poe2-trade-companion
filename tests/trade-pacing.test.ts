import { describe, expect, it } from "vitest";
import {
  DEFAULT_RULES,
  FETCH_POLICY,
  HOUSE_COMBINED_RULE,
  HOUSE_LOOKUPS_PER_WINDOW,
  HOUSE_RULES,
  SEARCH_POLICY,
  TradePacer,
  parseRateRules,
  parseRateState,
  policyForUrl,
} from "../src/core/tradePacing.js";

const T0 = 1_800_000_000_000;

describe("rate-limit header parsing", () => {
  it("reads max:period:penalty triples and skips junk", () => {
    expect(parseRateRules("8:10:60,15:60:120, 60:300:1800")).toEqual([
      { max: 8, periodSec: 10, penaltySec: 60 },
      { max: 15, periodSec: 60, penaltySec: 120 },
      { max: 60, periodSec: 300, penaltySec: 1800 },
    ]);
    expect(parseRateRules("garbage,0:10:0")).toEqual([]);
    expect(parseRateRules(null)).toEqual([]);
  });

  it("reads hits:period:restricted state", () => {
    expect(parseRateState("3:10:0,7:60:45")).toEqual([
      { hits: 3, periodSec: 10, restrictedSec: 0 },
      { hits: 7, periodSec: 60, restrictedSec: 45 },
    ]);
  });

  it("maps trade2 URLs to policies", () => {
    expect(policyForUrl("https://www.pathofexile.com/api/trade2/search/poe2/Standard")).toBe(
      SEARCH_POLICY,
    );
    expect(policyForUrl("https://www.pathofexile.com/api/trade2/fetch/a,b?query=x")).toBe(
      FETCH_POLICY,
    );
  });
});

describe("TradePacer", () => {
  it("lets requests through while every window has a spare slot", () => {
    const pacer = new TradePacer();
    expect(pacer.delayFor(SEARCH_POLICY, T0)).toBe(0);
    expect(pacer.available(SEARCH_POLICY, T0)).toBe(DEFAULT_RULES[SEARCH_POLICY]![0]!.max - 1);
    pacer.record(SEARCH_POLICY, T0);
    pacer.record(SEARCH_POLICY, T0 + 1000);
    expect(pacer.delayFor(SEARCH_POLICY, T0 + 2000)).toBe(0);
  });

  it("holds the last slot of a window and waits for the oldest hit to age out", () => {
    const pacer = new TradePacer({
      p: { rules: [{ max: 3, periodSec: 10, penaltySec: 60 }], hits: [], restrictedUntil: 0 },
    });
    pacer.record("p", T0);
    expect(pacer.delayFor("p", T0 + 100)).toBe(0);
    pacer.record("p", T0 + 100);
    // Two hits in a 3-per-10s window: only 2 are allowed, so the next waits
    // until the first hit leaves the window (10s after T0).
    const wait = pacer.delayFor("p", T0 + 200);
    expect(wait).toBeGreaterThan(9_000);
    expect(wait).toBeLessThanOrEqual(10_000 + 250);
    expect(pacer.available("p", T0 + 200)).toBe(0);
    expect(pacer.delayFor("p", T0 + 10_300)).toBe(0);
  });

  it("applies the tightest of several windows", () => {
    const pacer = new TradePacer({
      p: {
        rules: [
          { max: 10, periodSec: 10, penaltySec: 60 },
          { max: 3, periodSec: 60, penaltySec: 120 },
        ],
        hits: [],
        restrictedUntil: 0,
      },
    });
    pacer.record("p", T0);
    pacer.record("p", T0 + 1000);
    expect(pacer.delayFor("p", T0 + 2000)).toBeGreaterThan(50_000);
  });

  it("learns the real rules and unseen traffic from response headers", () => {
    const pacer = new TradePacer();
    pacer.record(SEARCH_POLICY, T0);
    pacer.observe(
      SEARCH_POLICY,
      { rules: "8:10:60,15:60:120", state: "4:10:0,4:60:0" },
      T0 + 10,
    );
    expect(pacer.rules(SEARCH_POLICY)).toEqual([
      { max: 8, periodSec: 10, penaltySec: 60 },
      { max: 15, periodSec: 60, penaltySec: 120 },
    ]);
    // Server counted 4, we knew of 1: three foreign hits are now on the log.
    expect(pacer.available(SEARCH_POLICY, T0 + 20)).toBe(7 - 4);
  });

  it("stamps hits from a long window outside the shorter windows", () => {
    // The real trade2 rules: 5/10s, 15/60s, 30/300s, 600/6h.
    const pacer = new TradePacer();
    pacer.record(SEARCH_POLICY, T0);
    pacer.observe(
      SEARCH_POLICY,
      {
        rules: "5:10:60,15:60:300,30:300:1800,600:21600:3600",
        state: "1:10:0,1:60:0,40:300:0,42:21600:0",
      },
      T0 + 10,
    );
    // The 39 older hits sit in the 300s window only: the 10s and 60s
    // windows stay open, the 300s one (29 allowed) is full until they age out.
    const rules = pacer.rules(SEARCH_POLICY);
    expect(rules).toHaveLength(4);
    expect(pacer.available(SEARCH_POLICY, T0 + 20)).toBe(0);
    const wait = pacer.delayFor(SEARCH_POLICY, T0 + 20);
    expect(wait).toBeGreaterThan(230_000);
    expect(wait).toBeLessThan(241_000);
    // Once those leave the 300s window the 10s/60s windows are what remain.
    expect(pacer.available(SEARCH_POLICY, T0 + 242_000)).toBe(4);
  });

  it("honours a server restriction and Retry-After", () => {
    const pacer = new TradePacer();
    pacer.observe(SEARCH_POLICY, { state: "3:10:45" }, T0);
    expect(pacer.restrictedUntil(SEARCH_POLICY, T0)).toBe(T0 + 45_000);
    expect(pacer.delayFor(SEARCH_POLICY, T0 + 1000)).toBe(44_000);
    expect(pacer.available(SEARCH_POLICY, T0 + 1000)).toBe(0);
    // Nine server-counted hits fill the five-minute house window as well:
    // foreign traffic counts toward the unlisted lockout like our own.
    const busy = new TradePacer();
    busy.observe(SEARCH_POLICY, { state: "9:10:45" }, T0);
    expect(busy.delayFor(SEARCH_POLICY, T0 + 1000)).toBe(300_000 - 1 - 1000 + 250);
    pacer.observe(FETCH_POLICY, { retryAfter: "120" }, T0);
    expect(pacer.restrictedUntil(undefined, T0)).toBe(T0 + 120_000);
    expect(pacer.restrictedUntil(undefined, T0 + 121_000)).toBe(0);
  });

  it("round-trips through JSON so separate processes share the budget", () => {
    const pacer = new TradePacer();
    pacer.record(SEARCH_POLICY, T0);
    pacer.record(SEARCH_POLICY, T0 + 500);
    pacer.observe(SEARCH_POLICY, { rules: "3:10:60" }, T0 + 600);
    const revived = new TradePacer(JSON.parse(JSON.stringify(pacer.toJSON())) as never);
    expect(revived.delayFor(SEARCH_POLICY, T0 + 700)).toBeGreaterThan(9_000);
    expect(new TradePacer({ bad: { nope: true } } as never).delayFor(SEARCH_POLICY, T0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// House rules: the unlisted lockout layer (2026-09-07: 429 + Retry-After 600
// with no rate headers at 17/300 searches + 14/300 fetches).
// ---------------------------------------------------------------------------

/** The rules trade2 advertised on 2026-09-07 (artifacts/tab-admin/trade-pacing.json). */
const LIVE_SEARCH_RULES = "5:10:60,15:60:300,30:300:1800,600:21600:3600";
const LIVE_FETCH_RULES = "12:4:10,16:12:300,50:300:300,1000:21600:1800";

describe("house rules", () => {
  it("are ten per policy and eighteen combined per five minutes, nine and seventeen usable", () => {
    expect(HOUSE_RULES[SEARCH_POLICY]).toEqual([{ max: 10, periodSec: 300, penaltySec: 600 }]);
    expect(HOUSE_RULES[FETCH_POLICY]).toEqual([{ max: 10, periodSec: 300, penaltySec: 600 }]);
    expect(HOUSE_COMBINED_RULE).toEqual({ max: 18, periodSec: 300, penaltySec: 600 });
    // 9 searches, 9 fetches, 17 combined → 8 search+fetch pairs per window.
    expect(HOUSE_LOOKUPS_PER_WINDOW).toBe(8);
  });

  it("cap a policy at nine per five minutes even when the server advertises thirty", () => {
    const pacer = new TradePacer();
    pacer.observe(SEARCH_POLICY, { rules: LIVE_SEARCH_RULES }, T0 - 1);
    // Nine searches spread over 160 s: every advertised window has room.
    for (let i = 0; i < 9; i += 1) pacer.record(SEARCH_POLICY, T0 + i * 20_000);
    const at = T0 + 170_000;
    expect(pacer.rules(SEARCH_POLICY).map((rule) => rule.max)).toEqual([5, 15, 30, 600]);
    expect(pacer.available(SEARCH_POLICY, at)).toBe(0);
    // The oldest hit leaves the five-minute window at T0 + 300 s.
    expect(pacer.delayFor(SEARCH_POLICY, at)).toBe(300_000 - 170_000 + 250);
    expect(pacer.available(SEARCH_POLICY, T0 + 301_000)).toBe(1);
    expect(pacer.delayFor(SEARCH_POLICY, T0 + 301_000)).toBe(0);
  });

  it("guard searches and fetches together", () => {
    const pacer = new TradePacer();
    pacer.observe(SEARCH_POLICY, { rules: LIVE_SEARCH_RULES }, T0 - 1);
    pacer.observe(FETCH_POLICY, { rules: LIVE_FETCH_RULES }, T0 - 1);
    for (let i = 0; i < 9; i += 1) pacer.record(SEARCH_POLICY, T0 + i * 20_000);
    for (let i = 0; i < 8; i += 1) pacer.record(FETCH_POLICY, T0 + 10_000 + i * 20_000);
    const at = T0 + 170_000;
    // Fetch has one house slot left, but the combined guard (17) is full.
    expect(pacer.available(FETCH_POLICY, at)).toBe(0);
    expect(pacer.delayFor(FETCH_POLICY, at)).toBe(300_000 - 170_000 + 250);
    expect(pacer.lookupsAvailable(at)).toBe(0);
    // A policy outside the guard is untouched by it.
    expect(pacer.available("other", at)).toBeGreaterThan(0);
  });

  it("count lookups as search+fetch pairs under the combined guard", () => {
    const pacer = new TradePacer();
    // Generous advertised windows so only the house rules bind.
    pacer.observe(SEARCH_POLICY, { rules: "60:10:60" }, T0 - 1);
    pacer.observe(FETCH_POLICY, { rules: "60:4:10" }, T0 - 1);
    expect(pacer.lookupsAvailable(T0)).toBe(HOUSE_LOOKUPS_PER_WINDOW);
    for (let i = 0; i < 4; i += 1) {
      pacer.record(SEARCH_POLICY, T0 + i * 2_000);
      pacer.record(FETCH_POLICY, T0 + i * 2_000 + 1_000);
    }
    expect(pacer.lookupsAvailable(T0 + 10_000)).toBe(4);
    for (let i = 4; i < 8; i += 1) {
      pacer.record(SEARCH_POLICY, T0 + i * 2_000);
      pacer.record(FETCH_POLICY, T0 + i * 2_000 + 1_000);
    }
    // One search and one fetch slot remain, but the combined guard has one.
    expect(pacer.available(SEARCH_POLICY, T0 + 20_000)).toBe(1);
    expect(pacer.lookupsAvailable(T0 + 20_000)).toBe(0);
  });

  it("keep five minutes of hits in the snapshot even when the advertised windows are short", () => {
    const pacer = new TradePacer();
    pacer.observe(FETCH_POLICY, { rules: "12:4:10,16:12:300" }, T0 - 1);
    for (let i = 0; i < 9; i += 1) pacer.record(FETCH_POLICY, T0 + i * 2_000);
    expect(pacer.available(FETCH_POLICY, T0 + 100_000)).toBe(0);
    const snapshot = JSON.parse(JSON.stringify(pacer.toJSON())) as { [k: string]: { hits: number[] } };
    expect(snapshot[FETCH_POLICY]!.hits).toHaveLength(9);
    const revived = new TradePacer(snapshot as never);
    expect(revived.available(FETCH_POLICY, T0 + 100_000)).toBe(0);
    // The last of the nine (T0 + 16 s) leaves the five-minute window at T0 + 316 s.
    expect(revived.available(FETCH_POLICY, T0 + 301_000)).toBe(1);
    expect(revived.available(FETCH_POLICY, T0 + 317_000)).toBe(9);
  });

  it("are never lifted by a later header read", () => {
    const pacer = new TradePacer();
    for (let i = 0; i < 9; i += 1) pacer.record(SEARCH_POLICY, T0 + i * 20_000);
    pacer.observe(SEARCH_POLICY, { rules: "100:300:1", state: "9:300:0" }, T0 + 161_000);
    expect(pacer.available(SEARCH_POLICY, T0 + 170_000)).toBe(0);
  });
});
