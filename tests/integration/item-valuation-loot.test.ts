import {
  CompositeDesirabilityPort,
  FixtureDesirabilityScorer,
  FrozenClock,
  InMemoryTraceSink,
  LootController,
  NoopInputSink,
  QaTraceWriter,
  createAutomationLoop,
  createCapabilities,
  createDesirabilityEngine,
  createFixtureMarketProvider,
  createGameInputController,
  createReplayArming,
  createScenarioScheduler,
  FixtureFrameSource,
  parseItem,
} from "@poe2tc/core";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createTestScenario } from "../helpers/createTestScenario.js";
import { itemFixturePath, marketFixtureDir } from "../helpers/fixturePaths.js";

const PROCESS = {
  value: { name: "PathOfExile.exe", title: "Path of Exile 2", allowlisted: true },
  confidence: 1,
  observedAtMs: 10_000,
  freshness: "fresh" as const,
};

describe("item → quote → valuation → desirability → loot decision", () => {
  it("changes a label-only skip into a market-aware pickup", async () => {
    const clipboard = readFileSync(itemFixturePath("unique-amulet.txt"), "utf8");
    const parsed = parseItem({ rawText: clipboard, source: "fixture", capturedAtMs: 10_000 });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    const scenario = createTestScenario({
      id: "loot-only",
      enabledModules: ["loot", "recovery"],
    });
    const fixture = new FixtureDesirabilityScorer();
    const labelOnly = fixture.score(
      { id: "unique-1", labelText: "Astramentis", screenPoint: { x: 720, y: 380 } },
      { scenario },
    );
    expect(labelOnly.score).toBeLessThan(40);

    const quotes = createFixtureMarketProvider(marketFixtureDir(), () => 10_000);
    const market = await quotes.quote(parsed.item, {
      league: "Standard",
      realm: "poe2",
      maxAgeMs: 3_600_000,
    });
    expect(market.providerId).toBe("fixture");
    expect(market.fair).toBe(15);
    expect(market.confidence).toBe("high");
    expect(market.recommendedListing).toBe(15);
    expect(JSON.stringify(market)).not.toMatch(/guaranteed sale/i);

    const engine = createDesirabilityEngine();
    const marketAware = engine.score(parsed.item, { scenario, quote: market });
    expect(marketAware.score).toBeGreaterThanOrEqual(85);
    expect(labelOnly.score).not.toBe(marketAware.score);

    const clock = new FrozenClock(0);
    const traces = new InMemoryTraceSink();
    const loop = createAutomationLoop({
      frameSource: new FixtureFrameSource([
        {
          tickId: 1,
          capturedAtMs: 10_000,
          width: 1920,
          height: 1080,
          derived: {
            process: PROCESS,
            inventory: {
              value: { occupied: 4, capacity: 60, cells: [], full: false },
              confidence: 0.9,
              observedAtMs: 10_000,
              freshness: "fresh",
            },
            loot: {
              value: [
                { id: "wisdom-1", labelText: "Scroll of Wisdom", screenPoint: { x: 900, y: 500 } },
                {
                  id: "unique-1",
                  labelText: "Astramentis",
                  clipboardText: clipboard,
                  screenPoint: { x: 720, y: 380 },
                },
              ],
              confidence: 0.9,
              observedAtMs: 10_000,
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
      scenario,
      traceWriter: new QaTraceWriter(traces),
      desirability: new CompositeDesirabilityPort({
        engine,
        fixture,
        quotes,
      }),
    });

    const fixtureLoop = createAutomationLoop({
      frameSource: new FixtureFrameSource([
        {
          tickId: 1,
          capturedAtMs: 10_000,
          width: 1920,
          height: 1080,
          derived: {
            process: PROCESS,
            inventory: {
              value: { occupied: 4, capacity: 60, cells: [], full: false },
              confidence: 0.9,
              observedAtMs: 10_000,
              freshness: "fresh",
            },
            loot: {
              value: [
                { id: "wisdom-1", labelText: "Scroll of Wisdom", screenPoint: { x: 900, y: 500 } },
                {
                  id: "unique-1",
                  labelText: "Astramentis",
                  clipboardText: clipboard,
                  screenPoint: { x: 720, y: 380 },
                },
              ],
              confidence: 0.9,
              observedAtMs: 10_000,
              freshness: "fresh",
            },
          },
        },
      ]),
      scheduler: createScenarioScheduler(),
      input: createGameInputController({
        capabilities: createCapabilities("authorized-qa"),
        clock: new FrozenClock(0),
        sink: new NoopInputSink(),
      }),
      clock: new FrozenClock(0),
      capabilities: createCapabilities("authorized-qa"),
      arming: createReplayArming(),
      scenario,
      traceWriter: new QaTraceWriter(new InMemoryTraceSink()),
      desirability: fixture,
    });

    const marketTick = await loop.tick();
    const fixtureTick = await fixtureLoop.tick();
    expect(marketTick.result).toBe("ticked");
    expect(fixtureTick.result).toBe("ticked");
    if (marketTick.result !== "ticked" || fixtureTick.result !== "ticked") {
      return;
    }
    expect(new LootController().module).toBe("loot");
    expect(marketTick.decision.reason).toContain("pick:unique-1");
    expect(fixtureTick.decision.reason).not.toContain("pick:unique-1");
    expect(marketTick.trace.executed).toBe(false);
  });
});
