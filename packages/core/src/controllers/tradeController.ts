import type { BotDecision, InputAction } from "../input/types.js";
import type { AutomationScenario } from "../scheduler/types.js";
import { DEFAULT_INVENTORY_GRID, cellCenter } from "../stash/geometry.js";
import {
  tradeAcceptActions,
  tradeCleanupActions,
  tradeInviteActions,
  tradeNavigateActions,
  tradeOpenActions,
  tradePlaceItemActions,
  tradePrepareItemActions,
  tradeRejectActions,
} from "../trade/geometry.js";
import { evaluateTradeOffer, resolveObservedOffer } from "../trade/offerMatch.js";
import { tradeEvidence } from "../trade/reasons.js";
import { currentTradeSession } from "../trade/session.js";
import type { TradeEventPort } from "../trade/types.js";
import {
  DEFAULT_TRADE_WAIT_TIMEOUT_MS,
  TRADE_WAIT_STATES,
  type TradeMachineEvent,
  type TradeObservation,
} from "../trade/types.js";
import { stepTradeMachine } from "../trade/tradeStateMachine.js";
import type {
  ExpectedTrade,
  PixelPoint,
  TradeEvent,
  TradeSession,
  WorldState,
} from "../world-state/types.js";
import type { Controller } from "./types.js";

export interface TradeControllerOptions {
  events?: TradeEventPort;
  strict?: boolean;
}

function inventoryHasFingerprint(world: WorldState, fingerprint: string | undefined): boolean {
  if (fingerprint === undefined || fingerprint.length === 0) {
    return false;
  }
  return world.inventory.value.cells.some((cell) => cell.itemFingerprint === fingerprint);
}

function itemPoint(world: WorldState, fingerprint: string | undefined): PixelPoint {
  const cell = world.inventory.value.cells.find((entry) => entry.itemFingerprint === fingerprint);
  if (cell !== undefined) {
    return cellCenter(cell, DEFAULT_INVENTORY_GRID);
  }
  return { x: 1400, y: 220 };
}

function placedFingerprint(world: WorldState): string | undefined {
  const view = world.trade.value;
  if (view?.ourItemFingerprint !== undefined) {
    return view.ourItemFingerprint;
  }
  return view?.ourSlots.find((cell) => cell.itemFingerprint !== undefined)?.itemFingerprint;
}

function resolveExpected(world: WorldState, session: TradeSession, event: TradeEvent | undefined): ExpectedTrade | undefined {
  if (session.state !== "Idle" && session.expected !== undefined) {
    return session.expected;
  }
  return event?.expected ?? world.flags.tradeExpected;
}

export class TradeController implements Controller {
  readonly module = "trade" as const;
  readonly #events?: TradeEventPort;
  readonly #strict: boolean;

  constructor(options: TradeControllerOptions = {}) {
    this.#events = options.events;
    this.#strict = options.strict === true;
  }

  decide(world: WorldState, scenario: AutomationScenario): BotDecision {
    const evidenceIds = world.trade.evidenceId ? [world.trade.evidenceId] : [];
    const session = currentTradeSession(world);
    const portEvent = this.#events?.nextEvent();
    const event = world.flags.tradeEvent ?? portEvent;
    const expected = resolveExpected(world, session, event);
    const nowMs = world.clockMs;

    if (world.flags.emergencyStopLatched) {
      return this.decision(
        world,
        "EmergencyStop",
        "emergency-stop",
        [{ type: "noop", reason: "emergency-stop" }],
        [
          ...evidenceIds,
          tradeEvidence({
            event: "emergency-stop",
            nextState: session.state,
            sessionId: session.id || `trade:${world.activeScenarioId}:${String(nowMs)}`,
            failAfterCleanup: session.failAfterCleanup === true,
            enteredAtMs: session.enteredAtMs,
            fingerprint: expected?.itemFingerprint,
            currency: expected?.currency,
            amount: expected?.amount,
          }),
        ],
      );
    }

    const view = world.trade.value;
    const offer = resolveObservedOffer(view?.observedOffer, view?.counterOfferText);
    const tolerance = expected?.amountTolerance ?? scenario.tradeAmountTolerance ?? 0;
    const evaluation = evaluateTradeOffer(expected, offer, tolerance);
    const requestedFingerprint = event?.requestedItemFingerprint ?? expected?.itemFingerprint;
    const itemPresent = inventoryHasFingerprint(world, requestedFingerprint);
    const itemValid = requestedFingerprint !== undefined && requestedFingerprint === expected?.itemFingerprint && itemPresent;
    const placed = placedFingerprint(world);
    const timeoutMs = scenario.tradeWaitTimeoutMs ?? DEFAULT_TRADE_WAIT_TIMEOUT_MS;
    const enteredAtMs = session.enteredAtMs || nowMs;
    const timedOut =
      (TRADE_WAIT_STATES as readonly string[]).includes(session.state) && nowMs - enteredAtMs >= timeoutMs;
    const partyJoined =
      world.flags.tradePartyState === "joined" ||
      event?.partyState === "joined" ||
      session.partyState === "joined";
    const inTradeContext =
      world.flags.tradeInContext === true || world.ui.value.kind === "trade" || view?.open === true;
    const cancelled = world.flags.tradeCancelled === true || event?.kind === "cancelled";
    const disconnected = world.flags.tradeDisconnected === true || event?.kind === "disconnected";
    const uiDesync = view?.desynced === true || event?.kind === "ui-desync";
    const cleanupDone = world.flags.tradePartyState === "none";

    const obs: TradeObservation = {
      emergencyStop: world.flags.emergencyStopLatched,
      hasRequest:
        world.flags.tradeRequested === true ||
        event !== undefined ||
        expected !== undefined ||
        view?.open === true,
      requestedItemValid: itemValid,
      requestedItemPresent: itemPresent,
      partyJoined,
      itemPrepared: itemPresent,
      inTradeContext,
      tradeWindowOpen: view?.open === true,
      itemPlaced: placed !== undefined,
      placedItemMatches: expected !== undefined && placed === expected.itemFingerprint,
      counterOfferObserved: offer !== undefined,
      offerMatches: evaluation.matches,
      offerCurrencyMatches: evaluation.currencyMatches,
      offerAmountSufficient: evaluation.amountSufficient,
      offerStackComplete: evaluation.stackComplete,
      acceptEnabled: view?.acceptEnabled === true,
      completed: view?.completed === true,
      cancelled,
      disconnected,
      uiDesync,
      timedOut,
      cleanupDone,
      failAfterCleanup: session.failAfterCleanup === true || disconnected,
    };

    const rejectDetail = evaluation.matches ? undefined : evaluation.reason;
    const stepped = stepTradeMachine(session.state, obs, { strict: this.#strict }, rejectDetail);
    const sessionId = session.id || `trade:${world.activeScenarioId}:${String(nowMs)}`;
    const nextEntered = stepped.next === session.state ? enteredAtMs : nowMs;
    const failAfterCleanup = disconnected || session.failAfterCleanup === true || stepped.event === "disconnect";

    return this.decision(
      world,
      stepped.next === "FailedOrTimedOut" ? "SafetyHold" : world.selectedState,
      stepped.reason,
      this.actionsForEvent(stepped.event, stepped.reason, world, expected),
      [
        ...evidenceIds,
        tradeEvidence({
          event: stepped.event,
          nextState: stepped.next,
          sessionId,
          failAfterCleanup,
          enteredAtMs: nextEntered,
          fingerprint: expected?.itemFingerprint ?? requestedFingerprint,
          currency: expected?.currency,
          amount: expected?.amount,
        }),
      ],
      stepped.event === "timeout" ? "trade.timeout" : undefined,
      stepped.event === "timeout" ? 1 : undefined,
    );
  }

  private actionsForEvent(
    event: TradeMachineEvent,
    reason: string,
    world: WorldState,
    expected: ExpectedTrade | undefined,
  ): InputAction[] {
    const fingerprint = expected?.itemFingerprint;
    switch (event) {
      case "invite-party":
        return tradeInviteActions();
      case "prepare-item":
        return tradePrepareItemActions(itemPoint(world, fingerprint));
      case "navigate-to-context":
        return tradeNavigateActions();
      case "open-trade":
        return tradeOpenActions();
      case "place-item":
        return tradePlaceItemActions(itemPoint(world, fingerprint));
      case "accept":
        return tradeAcceptActions();
      case "reject":
        return tradeRejectActions();
      case "cleanup":
        return tradeCleanupActions();
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
      confidence: world.trade.confidence || 1,
      intendedActions,
      evidenceIds,
      recoveryOf,
      retryIndex,
    };
  }
}
