import type { BotDecision } from "../input/types.js";
import type {
  ExpectedTrade,
  TradeSession,
  TradeSessionRecord,
  TradeState,
  WorldState,
  WorldStateFlags,
} from "../world-state/types.js";
import { parseTradeEvidence } from "./reasons.js";
import { isTerminalTradeEvent, tradeSessionResult } from "./tradeStateMachine.js";
import { TRADE_STATES, type TradeMachineEvent } from "./types.js";

function asTradeState(value: string): TradeState {
  return (TRADE_STATES as readonly string[]).includes(value) ? (value as TradeState) : "FailedOrTimedOut";
}

function asTradeEvent(value: string): TradeMachineEvent {
  return value as TradeMachineEvent;
}

export function currentTradeSession(world: WorldState): TradeSession {
  return (
    world.flags.tradeSession ?? {
      id: "",
      state: "Idle",
      enteredAtMs: world.clockMs,
      expected: world.flags.tradeExpected,
    }
  );
}

export function tradeSessionRecordFrom(input: {
  id: string;
  scenarioId: string;
  state: TradeState;
  updatedAtMs: number;
  payload: Record<string, unknown>;
}): TradeSessionRecord {
  return {
    id: input.id,
    scenarioId: input.scenarioId,
    state: input.state,
    payloadJson: JSON.stringify(input.payload),
    updatedAtMs: input.updatedAtMs,
  };
}

export function tradeEffectsFromDecision(
  world: WorldState,
  decision: BotDecision,
  nowMs: number,
): Partial<WorldStateFlags> {
  if (decision.module !== "trade" && decision.state !== "TradeSession") {
    return {};
  }

  const evidence = decision.evidenceIds.map(parseTradeEvidence).find((row) => row !== undefined);
  const previous = currentTradeSession(world);
  const expected: ExpectedTrade | undefined = previous.expected ?? world.flags.tradeExpected;

  if (decision.reason === "emergency-stop" || decision.state === "EmergencyStop") {
    const sessionId = evidence?.sessionId || previous.id || `trade:${world.activeScenarioId}:${String(nowMs)}`;
    const session: TradeSession = {
      ...previous,
      id: sessionId,
      expected,
      lastEvent: "emergency-stop",
      lastReason: "emergency-stop",
    };
    return {
      tradeSession: session,
      pendingTradeSessionWrite: tradeSessionRecordFrom({
        id: sessionId,
        scenarioId: world.activeScenarioId,
        state: session.state,
        updatedAtMs: nowMs,
        payload: {
          state: session.state,
          event: "emergency-stop",
          reason: "emergency-stop",
          expected,
        },
      }),
    };
  }

  if (evidence === undefined) {
    return {};
  }

  const event = asTradeEvent(evidence.event);
  const nextState = asTradeState(evidence.nextState);
  const terminal = isTerminalTradeEvent(event) || (nextState === "Idle" && event === "cleaned");
  const failAfterCleanup = evidence.failAfterCleanup || event === "disconnect" || previous.failAfterCleanup === true;
  const enteredAtMs = nextState === previous.state ? previous.enteredAtMs : nowMs;
  const sessionId = evidence.sessionId.length > 0 ? evidence.sessionId : previous.id || `trade:${world.activeScenarioId}:${String(nowMs)}`;

  const tradeSession: TradeSession | null = terminal && nextState !== "FailedOrTimedOut"
    ? null
    : {
        id: sessionId,
        state: nextState,
        enteredAtMs,
        expected,
        lastEvent: event,
        lastReason: decision.reason,
        partyState:
          event === "prepare-item"
            ? "joined"
            : event === "invite-party"
              ? "invited"
              : previous.partyState ?? world.flags.tradePartyState,
        requestedItemFingerprint: evidence.fingerprint ?? previous.requestedItemFingerprint ?? expected?.itemFingerprint,
        failAfterCleanup,
      };

  const partyState =
    event === "cleaned" || event === "failed"
      ? "none"
      : event === "prepare-item"
        ? "joined"
        : world.flags.tradePartyState;

  return {
    tradeRequested: !terminal,
    tradeSession,
    tradePartyState: partyState,
    pendingTradeSessionWrite: tradeSessionRecordFrom({
      id: sessionId,
      scenarioId: world.activeScenarioId,
      state: nextState,
      updatedAtMs: nowMs,
      payload: {
        state: nextState,
        event,
        reason: decision.reason,
        result: tradeSessionResult(event),
        expected,
        failAfterCleanup,
      },
    }),
  };
}
