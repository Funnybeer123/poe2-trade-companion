import type { Clock } from "../clock.js";
import type { RuntimeCapabilities, QaArmingState } from "../capabilities/createCapabilities.js";
import type { Controller } from "../controllers/types.js";
import type { DefaultGameInputController } from "../input/gameInputController.js";
import type { BotDecision } from "../input/types.js";
import type { InterlockVerdict } from "../interlock/types.js";
import type { InventorySnapshotStore } from "../inventory/snapshots.js";
import type { ShadowState } from "../inventory/shadowState.js";
import type { DesirabilityPort } from "../items/desirabilityPort.js";
import type { PerceptionAdapter, StateEstimator, FrameSource } from "../perception/types.js";
import type { ListingHistoryStore } from "../listing/types.js";
import type { TradeSessionStore } from "../trade/types.js";
import type { AutomationScenario, ScenarioScheduler } from "../scheduler/types.js";
import type { QaActionTrace } from "../trace/types.js";
import type { QaTraceWriter } from "../trace/qaTraceWriter.js";
import type { AutomationStateId, WorldState } from "../world-state/types.js";
import type { ActionBudget } from "./actionBudget.js";

export type AutomationTickResult =
  | { result: "end-of-stream" }
  | {
      result: "ticked";
      trace: QaActionTrace;
      world: WorldState;
      decision: BotDecision;
      verdict: InterlockVerdict;
    };

export interface AutomationLoopOptions {
  frameSource: FrameSource;
  scheduler: ScenarioScheduler;
  input: DefaultGameInputController;
  clock: Clock;
  capabilities: RuntimeCapabilities;
  arming: QaArmingState;
  scenario: AutomationScenario;
  traceWriter: QaTraceWriter;
  controllers?: Map<AutomationStateId, Controller>;
  perception?: PerceptionAdapter;
  estimator?: StateEstimator;
  desirability?: DesirabilityPort;
  snapshotStore?: InventorySnapshotStore;
  shadowState?: ShadowState;
  listingHistory?: ListingHistoryStore;
  tradeSessions?: TradeSessionStore;
  actionBudget?: ActionBudget;
}
