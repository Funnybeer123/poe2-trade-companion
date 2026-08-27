import type { QuoteContext } from "./types.js";
import type { MarketQuote, NormalizedItem } from "./types.js";
import type { LootTarget } from "../world-state/types.js";
import { createDesirabilityEngine, type DesirabilityEngine } from "./desirabilityEngine.js";
import { isLootTarget, type DesirabilityPort } from "./desirabilityPort.js";
import type { DesirabilityContext } from "./desirabilityPort.js";
import { createFixtureDesirabilityScorer, type FixtureDesirabilityScorer } from "./fixtureDesirabilityScorer.js";
import { parseItem } from "./parseItem.js";
import type { DesirabilityResult } from "./types.js";

export interface QuoteLookup {
  lookup(item: NormalizedItem, context: QuoteContext): MarketQuote | undefined;
}

export interface CompositeDesirabilityOptions {
  engine?: DesirabilityEngine;
  fixture?: FixtureDesirabilityScorer;
  quotes?: QuoteLookup;
  quoteContext?: Omit<QuoteContext, "maxAgeMs"> & { maxAgeMs?: number };
}

export class CompositeDesirabilityPort implements DesirabilityPort {
  readonly #engine: DesirabilityEngine;
  readonly #fixture: FixtureDesirabilityScorer;
  readonly #quotes?: QuoteLookup;
  readonly #quoteContext: QuoteContext;

  constructor(options: CompositeDesirabilityOptions = {}) {
    this.#engine = options.engine ?? createDesirabilityEngine();
    this.#fixture = options.fixture ?? createFixtureDesirabilityScorer();
    this.#quotes = options.quotes;
    this.#quoteContext = {
      league: options.quoteContext?.league ?? "Standard",
      realm: "poe2",
      maxAgeMs: options.quoteContext?.maxAgeMs ?? 3_600_000,
    };
  }

  score(item: NormalizedItem | LootTarget, ctx: DesirabilityContext): DesirabilityResult {
    const adversarial = ctx.scenario.lowConfidencePolicy === "adversarial-execute";
    if (isLootTarget(item)) {
      if (adversarial || item.clipboardText === undefined || item.clipboardText.trim().length === 0) {
        return this.#fixture.score(item, ctx);
      }
      const parsed = parseItem({
        rawText: item.clipboardText,
        source: "clipboard",
        capturedAtMs: 0,
      });
      if (!parsed.ok) {
        return this.#fixture.score(item, ctx);
      }
      return this.scoreNormalized(parsed.item, ctx);
    }
    return this.scoreNormalized(item, ctx);
  }

  scoreNormalized(item: NormalizedItem, ctx: DesirabilityContext): DesirabilityResult {
    const quote = ctx.quote ?? this.#quotes?.lookup(item, this.#quoteContext);
    return this.#engine.score(item, { ...ctx, quote });
  }
}

export function createCompositeDesirability(
  options: CompositeDesirabilityOptions = {},
): CompositeDesirabilityPort {
  return new CompositeDesirabilityPort(options);
}
