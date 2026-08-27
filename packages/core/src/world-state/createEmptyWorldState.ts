import type { Clock } from "../clock.js";
import type {
  AutomationStateId,
  Observation,
  RuntimeMode,
  ScenarioId,
  WorldState,
} from "./types.js";

export const DEFAULT_HIGH_VALUE_INTERRUPT_SCORE = 85;

export interface CreateEmptyWorldStateOptions {
  clock?: Clock;
  runtimeMode?: RuntimeMode;
  activeScenarioId?: ScenarioId;
  selectedState?: AutomationStateId;
  previousState?: AutomationStateId;
  tickId?: number;
}

function missingObservation<T>(value: T, observedAtMs: number): Observation<T> {
  return {
    value,
    confidence: 0,
    observedAtMs,
    freshness: "missing",
  };
}

export function createEmptyWorldState(options: CreateEmptyWorldStateOptions = {}): WorldState {
  const nowMs = options.clock?.nowMs() ?? 0;
  return {
    tickId: options.tickId ?? 0,
    capturedAtMs: nowMs,
    clockMs: nowMs,
    runtimeMode: options.runtimeMode ?? "authorized-qa",
    selectedState: options.selectedState ?? "Idle",
    previousState: options.previousState ?? "Idle",
    activeScenarioId: options.activeScenarioId ?? "",
    process: missingObservation({ allowlisted: false }, nowMs),
    target: missingObservation(null, nowMs),
    loot: missingObservation([], nowMs),
    inventory: missingObservation({ occupied: 0, capacity: 0, cells: [], full: false }, nowMs),
    stash: missingObservation({ cells: [], tabFull: false }, nowMs),
    trade: missingObservation(null, nowMs),
    listing: missingObservation(null, nowMs),
    ui: missingObservation({ kind: "unknown" }, nowMs),
    stuck: missingObservation({ isStuck: false }, nowMs),
    flags: {
      emergencyStopLatched: false,
      tradeRequested: false,
      stashSessionActive: false,
      listingSessionActive: false,
      highValueInterruptScore: DEFAULT_HIGH_VALUE_INTERRUPT_SCORE,
    },
  };
}
