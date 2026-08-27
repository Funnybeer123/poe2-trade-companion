import {
  FrozenClock,
  InMemoryTraceSink,
  ListingController,
  MemoryListingHistoryStore,
  NoopInputSink,
  QaTraceWriter,
  createAutomationLoop,
  createCapabilities,
  createGameInputController,
  createReplayArming,
  createScenarioScheduler,
  FixtureFrameSource,
} from "@poe2tc/core";
import { describe, expect, it } from "vitest";
import { createTestScenario } from "../helpers/createTestScenario.js";

const PROCESS = {
  value: { name: "PathOfExile.exe", title: "Path of Exile 2", allowlisted: true },
  confidence: 1,
  observedAtMs: 10_000,
  freshness: "fresh" as const,
};

const CATALOG = [
  {
    fingerprint: "astramentis-1",
    screenPoint: { x: 1400, y: 220 },
    quote: {
      providerId: "fixture",
      quotedAtMs: 10_000,
      currency: "divine",
      low: 12,
      fair: 15,
      high: 18,
      candidateCount: 8,
      comparableCount: 7,
      confidence: "high" as const,
    },
  },
];

describe("listing state machine integration", () => {
  it("drives fixture listing UI and persists listing_history on verify", async () => {
    const clock = new FrozenClock(0);
    const traces = new InMemoryTraceSink();
    const history = new MemoryListingHistoryStore();
    const loop = createAutomationLoop({
      frameSource: new FixtureFrameSource([
        {
          tickId: 1,
          capturedAtMs: 10_000,
          width: 1920,
          height: 1080,
          derived: {
            process: PROCESS,
            flags: {
              emergencyStopLatched: false,
              tradeRequested: false,
              stashSessionActive: false,
              listingSessionActive: true,
              highValueInterruptScore: 85,
              listingCatalog: CATALOG,
            },
            listing: {
              value: { open: true, itemFingerprint: "astramentis-1" },
              confidence: 0.95,
              observedAtMs: 10_000,
              freshness: "fresh",
            },
            ui: { value: { kind: "listing" }, confidence: 0.95, observedAtMs: 10_000, freshness: "fresh" },
          },
        },
        {
          tickId: 2,
          capturedAtMs: 10_200,
          width: 1920,
          height: 1080,
          derived: {
            process: { ...PROCESS, observedAtMs: 10_200 },
            listing: {
              value: {
                open: true,
                itemFingerprint: "astramentis-1",
                priceText: "14.55 divine",
                currency: "divine",
              },
              confidence: 0.95,
              observedAtMs: 10_200,
              freshness: "fresh",
            },
            ui: { value: { kind: "listing" }, confidence: 0.95, observedAtMs: 10_200, freshness: "fresh" },
          },
        },
      ]),
      scheduler: createScenarioScheduler(),
      input: createGameInputController({
        capabilities: createCapabilities("authorized-qa"),
        clock,
        sink: new NoopInputSink(),
      }),
      clock,
      capabilities: createCapabilities("authorized-qa"),
      arming: createReplayArming(),
      scenario: createTestScenario({
        id: "list-and-reprice",
        enabledModules: ["listing"],
      }),
      traceWriter: new QaTraceWriter(traces),
      listingHistory: history,
    });

    const first = await loop.tick();
    expect(first.result).toBe("ticked");
    if (first.result !== "ticked") {
      return;
    }
    expect(first.decision.reason).toBe("listing-apply-price");
    expect(first.verdict.code === "dry-run" || first.verdict.allowExecute === false).toBe(true);
    expect(first.decision.intendedActions.some((action) => action.type === "key-tap")).toBe(true);

    const second = await loop.tick();
    expect(second.result).toBe("ticked");
    if (second.result !== "ticked") {
      return;
    }
    expect(second.decision.reason).toContain("listing-verify-match");
    expect(history.latest("astramentis-1")?.result).toBe("applied");
    expect(history.latest("astramentis-1")?.price).toBe(14.55);
    expect(history.latest("astramentis-1")?.currency).toBe("divine");
    expect(new ListingController().module).toBe("listing");
  });

  it("retries a mismatched verify once then FailedOrTimedOut", async () => {
    const clock = new FrozenClock(0);
    const traces = new InMemoryTraceSink();
    const history = new MemoryListingHistoryStore();
    const loop = createAutomationLoop({
      frameSource: new FixtureFrameSource([
        {
          tickId: 1,
          capturedAtMs: 10_000,
          width: 1920,
          height: 1080,
          derived: {
            process: PROCESS,
            flags: {
              emergencyStopLatched: false,
              tradeRequested: false,
              stashSessionActive: false,
              listingSessionActive: true,
              highValueInterruptScore: 85,
              listingCatalog: CATALOG,
            },
            listing: {
              value: { open: true, itemFingerprint: "astramentis-1" },
              confidence: 0.95,
              observedAtMs: 10_000,
              freshness: "fresh",
            },
          },
        },
        {
          tickId: 2,
          capturedAtMs: 10_200,
          width: 1920,
          height: 1080,
          derived: {
            process: { ...PROCESS, observedAtMs: 10_200 },
            listing: {
              value: {
                open: true,
                itemFingerprint: "astramentis-1",
                priceText: "20 divine",
                currency: "divine",
              },
              confidence: 0.95,
              observedAtMs: 10_200,
              freshness: "fresh",
            },
          },
        },
        {
          tickId: 3,
          capturedAtMs: 10_400,
          width: 1920,
          height: 1080,
          derived: {
            process: { ...PROCESS, observedAtMs: 10_400 },
            listing: {
              value: {
                open: true,
                itemFingerprint: "astramentis-1",
                priceText: "20 divine",
                currency: "divine",
              },
              confidence: 0.95,
              observedAtMs: 10_400,
              freshness: "fresh",
            },
          },
        },
      ]),
      scheduler: createScenarioScheduler(),
      input: createGameInputController({
        capabilities: createCapabilities("authorized-qa"),
        clock,
        sink: new NoopInputSink(),
      }),
      clock,
      capabilities: createCapabilities("authorized-qa"),
      arming: createReplayArming(),
      scenario: createTestScenario({
        id: "list-and-reprice",
        enabledModules: ["listing"],
      }),
      traceWriter: new QaTraceWriter(traces),
      listingHistory: history,
    });

    await loop.tick();
    const retry = await loop.tick();
    expect(retry.result).toBe("ticked");
    if (retry.result !== "ticked") {
      return;
    }
    expect(retry.decision.reason).toContain("listing-verify-mismatch");
    expect(retry.decision.recoveryOf).toBe("listing.verify-mismatch");

    const failed = await loop.tick();
    expect(failed.result).toBe("ticked");
    if (failed.result !== "ticked") {
      return;
    }
    expect(failed.decision.reason).toContain("FailedOrTimedOut");
    expect(history.latest("astramentis-1")?.result).toBe("failed");
  });
});
