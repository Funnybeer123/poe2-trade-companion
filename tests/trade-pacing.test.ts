import { describe, expect, it } from "vitest";
import {
  DEFAULT_RULES,
  FETCH_POLICY,
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
    expect(wait).toBeLessThanOrEqual(10_000 + 1000);
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
    expect(pacer.available(SEARCH_POLICY, T0 + 20)).toBe(6 - 4);
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
    pacer.observe(SEARCH_POLICY, { rules: "100:10:60", state: "9:10:45" }, T0);
    expect(pacer.restrictedUntil(SEARCH_POLICY, T0)).toBe(T0 + 45_000);
    expect(pacer.delayFor(SEARCH_POLICY, T0 + 1000)).toBe(44_000);
    expect(pacer.available(SEARCH_POLICY, T0 + 1000)).toBe(0);
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

  it("reserves 20% of the learned search budget and spreads requests across its short windows", () => {
    const pacer = new TradePacer();
    pacer.observe(SEARCH_POLICY, { rules: "5:10:60,15:60:300,30:300:1800,600:21600:3600" }, T0);
    expect(pacer.spacingFor(SEARCH_POLICY)).toBe(12_500);
    pacer.record(SEARCH_POLICY, T0);
    expect(pacer.spacingDelayFor(SEARCH_POLICY, T0 + 500)).toBe(12_000);
    expect(pacer.spacingDelayFor(SEARCH_POLICY, T0 + 12_500)).toBe(0);
    for (let i = 1; i < 24; i += 1) pacer.record(SEARCH_POLICY, T0 + i * 100);
    expect(pacer.delayFor(SEARCH_POLICY, T0 + 60_000)).toBe(241_000);
  });

  it("merges concurrent persisted reservations without multiplying synthetic history", () => {
    const rule = [{ max: 30, periodSec: 300, penaltySec: 1800 }];
    const pacer = new TradePacer({ p: { rules: rule, hits: [T0, T0, T0 + 100], restrictedUntil: 0 } });
    const snapshot = { p: { rules: rule, hits: [T0, T0, T0 + 200], restrictedUntil: T0 + 1000 } };
    pacer.merge(snapshot); pacer.merge(snapshot);
    expect(pacer.toJSON().p?.hits.sort((a, b) => a - b)).toEqual([T0, T0, T0 + 100, T0 + 200]);
    expect(pacer.restrictedUntil("p", T0)).toBe(T0 + 1000);
  });

  it("paces all server-declared scopes and records each known scope", () => {
    const pacer = new TradePacer();
    pacer.observe(SEARCH_POLICY, { rules: "30:300:1800" }, T0);
    pacer.observe(`${SEARCH_POLICY}:account`, { rules: "2:10:60", state: "1:10:0" }, T0);
    expect(pacer.available(SEARCH_POLICY, T0)).toBe(0);
    expect(pacer.delayFor(SEARCH_POLICY, T0)).toBeGreaterThan(10_000);
    pacer.record(SEARCH_POLICY, T0 + 20_000);
    expect(pacer.toJSON()[`${SEARCH_POLICY}:account`]?.hits).toContain(T0 + 20_000);
  });
});
