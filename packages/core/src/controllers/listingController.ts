import type { BotDecision, InputAction } from "../input/types.js";
import type { QuoteLookup } from "../items/compositeDesirability.js";
import {
  DEFAULT_LISTING_MAX_OPEN_ATTEMPTS,
  DEFAULT_LISTING_MAX_VERIFY_ATTEMPTS,
  isTerminalListingEvent,
  stepListingMachine,
} from "../listing/listingStateMachine.js";
import { listingApplyActions, listingOpenUiActions, listingSelectActions } from "../listing/geometry.js";
import {
  isMarketThrottled,
  listingPriceMatchesText,
  meetsMinConfidence,
  isListingStale,
  isRecommendedSkip,
  recommendListingPrice,
  resolvePricePolicy,
  type RecommendListingResult,
} from "../listing/pricePolicy.js";
import { resolveListingQuote } from "../listing/quoteResolve.js";
import { listingEvidence } from "../listing/reasons.js";
import type { ListingEvent, ListingObservation, PricePolicy } from "../listing/types.js";
import type { MarketCachePort } from "../market/marketCache.js";
import { DEFAULT_RECOVERY } from "../recovery/defaultRecovery.js";
import type { AutomationScenario } from "../scheduler/types.js";
import { DEFAULT_INVENTORY_GRID, cellCenter } from "../stash/geometry.js";
import type { QuoteContext } from "../items/types.js";
import type {
  ListingCatalogItem,
  ListingSession,
  PixelPoint,
  WorldState,
} from "../world-state/types.js";
import type { Controller } from "./types.js";

export interface ListingControllerOptions {
  policy?: Partial<PricePolicy>;
  quotes?: QuoteLookup;
  cache?: MarketCachePort;
  quoteContext?: QuoteContext;
}

function currentSession(world: WorldState): ListingSession {
  return (
    world.flags.listingSession ?? {
      state: "Idle",
      verifyAttempts: 0,
      openAttempts: 0,
    }
  );
}

function firstCandidate(world: WorldState): ListingCatalogItem | undefined {
  const catalog = world.flags.listingCatalog ?? [];
  const sessionFingerprint = world.flags.listingSession?.fingerprint;
  if (sessionFingerprint !== undefined) {
    return catalog.find((item) => item.fingerprint === sessionFingerprint) ?? catalog[0];
  }
  return catalog[0];
}

function candidatePoint(world: WorldState, item: ListingCatalogItem | undefined): PixelPoint {
  if (item?.screenPoint !== undefined) {
    return item.screenPoint;
  }
  const cell = world.inventory.value.cells.find((entry) => entry.itemFingerprint === item?.fingerprint);
  if (cell !== undefined) {
    return cellCenter(cell, DEFAULT_INVENTORY_GRID);
  }
  return { x: 1400, y: 220 };
}

function recommendedFrom(result: RecommendListingResult): { price?: number; currency?: string } {
  if (isRecommendedSkip(result)) {
    return {};
  }
  return { price: result.price, currency: result.currency };
}

export class ListingController implements Controller {
  readonly module = "listing" as const;
  readonly #policy: PricePolicy;
  readonly #quotes?: QuoteLookup;
  readonly #cache?: MarketCachePort;
  readonly #quoteContext?: QuoteContext;

  constructor(options: ListingControllerOptions = {}) {
    this.#policy = resolvePricePolicy(options.policy);
    this.#quotes = options.quotes;
    this.#cache = options.cache;
    this.#quoteContext = options.quoteContext;
  }

  decide(world: WorldState, scenario: AutomationScenario): BotDecision {
    const evidenceIds = world.listing.evidenceId ? [world.listing.evidenceId] : [];
    const session = currentSession(world);

    if (world.flags.emergencyStopLatched) {
      return this.decision(world, "EmergencyStop", "emergency-stop", [{ type: "noop", reason: "emergency-stop" }], evidenceIds);
    }

    const candidate = firstCandidate(world);
    const resolved = resolveListingQuote({
      item: candidate,
      quotes: this.#quotes,
      cache: this.#cache,
      context: this.#quoteContext,
      nowMs: world.clockMs,
    });
    const quote = resolved.quote;
    const recommended = quote === undefined ? undefined : recommendListingPrice(quote, this.#policy);
    const recommendedPrice = recommended === undefined ? undefined : recommendedFrom(recommended);
    const listingView = world.listing.value;
    const maxVerifyAttempts =
      scenario.retryLimits.listing ??
      DEFAULT_RECOVERY["listing.verify-mismatch"]?.maxAttempts ??
      DEFAULT_LISTING_MAX_VERIFY_ATTEMPTS;

    const obs: ListingObservation = {
      emergencyStop: world.flags.emergencyStopLatched,
      hasCandidate: candidate !== undefined,
      confidenceOk:
        quote !== undefined && meetsMinConfidence(quote.confidence, this.#policy.minConfidence),
      quoteAvailable: quote !== undefined && recommended !== undefined && !("skip" in recommended && recommended.skip),
      marketThrottled: isMarketThrottled(quote) && !resolved.fromCache,
      cachedQuoteAvailable: resolved.fromCache,
      listingUiOpen: listingView?.open === true,
      priceMatches: listingPriceMatchesText(
        listingView?.priceText,
        recommendedPrice?.price ?? session.recommendedPrice,
        recommendedPrice?.currency ?? listingView?.currency ?? session.currency,
      ),
      currentListingStale: isListingStale(
        candidate?.listedAtMs,
        world.clockMs,
        this.#policy.staleAfterMs,
      ),
      verifyAttempts: session.verifyAttempts,
      maxVerifyAttempts,
      openAttempts: session.openAttempts ?? 0,
      maxOpenAttempts: DEFAULT_LISTING_MAX_OPEN_ATTEMPTS,
    };

    const stepped = stepListingMachine(session.state, obs, quote?.lowConfidenceReason);
    const fingerprint = candidate?.fingerprint ?? session.fingerprint ?? "";
    const price = recommendedPrice?.price ?? session.recommendedPrice;
    const currency = recommendedPrice?.currency ?? session.currency;
    const verifyAttempts = this.nextVerifyAttempts(session, stepped.event);
    const historyResult = isTerminalListingEvent(stepped.event) ? stepped.event : "pending";

    const intendedActions = this.actionsForEvent(stepped.event, stepped.reason, world, candidate, price);
    const automationState = stepped.next === "FailedOrTimedOut" ? "SafetyHold" : world.selectedState;

    return this.decision(
      world,
      automationState,
      stepped.reason,
      intendedActions,
      [
        ...evidenceIds,
        listingEvidence(
          stepped.event,
          fingerprint,
          price,
          currency,
          stepped.next,
          verifyAttempts,
          historyResult,
        ),
      ],
      stepped.event === "verify-mismatch-retry" || stepped.event === "verify-mismatch-fail"
        ? "listing.verify-mismatch"
        : undefined,
      stepped.event === "verify-mismatch-retry" || stepped.event === "verify-mismatch-fail"
        ? verifyAttempts
        : undefined,
    );
  }

  private nextVerifyAttempts(session: ListingSession, event: ListingEvent): number {
    if (event === "apply-price" || event === "stale-reprice" || event === "verify-mismatch-retry") {
      return session.verifyAttempts + 1;
    }
    return session.verifyAttempts;
  }

  private actionsForEvent(
    event: ListingEvent,
    reason: string,
    world: WorldState,
    candidate: ListingCatalogItem | undefined,
    price: number | undefined,
  ): InputAction[] {
    switch (event) {
      case "select-item":
        return listingSelectActions(candidatePoint(world, candidate));
      case "open-listing-ui":
        return listingOpenUiActions();
      case "apply-price":
      case "stale-reprice":
      case "verify-mismatch-retry":
        if (price === undefined) {
          return [{ type: "noop", reason: "listing-skip:no-fair" }];
        }
        return listingApplyActions(price);
      default:
        return [{ type: "noop", reason }];
    }
  }

  private decision(
    world: WorldState,
    state: BotDecision["state"],
    reason: string,
    intendedActions: InputAction[],
    evidenceIds: string[],
    recoveryOf?: string,
    retryIndex?: number,
  ): BotDecision {
    return {
      module: this.module,
      state,
      reason,
      confidence: world.listing.confidence || 1,
      intendedActions,
      evidenceIds,
      recoveryOf,
      retryIndex,
    };
  }
}
