export function workspaceOk(): true {
  return true;
}

export { FrozenClock, SystemClock } from "./clock.js";
export type { Clock } from "./clock.js";

export {
  createEmptyWorldState,
  DEFAULT_HIGH_VALUE_INTERRUPT_SCORE,
} from "./world-state/createEmptyWorldState.js";
export type { CreateEmptyWorldStateOptions } from "./world-state/createEmptyWorldState.js";

export {
  AGING_MAX_AGE_MS,
  computeFreshness,
  FRESH_MAX_AGE_MS,
  withFreshness,
} from "./world-state/freshness.js";

export type {
  AutomationStateId,
  Confidence,
  ConfidenceBucket,
  Freshness,
  GridCell,
  HexSha256,
  IsoTimestamp,
  ListingUiView,
  LootTarget,
  LowConfidencePolicy,
  ModuleId,
  Observation,
  PixelBox,
  PixelPoint,
  RuntimeMode,
  ScenarioId,
  TargetCue,
  TradeWindowView,
  UiModeState,
  WorldState,
  WorldStateFlags,
} from "./world-state/types.js";

export { AUTOMATION_STATE_IDS, STATE_PRIORITY } from "./scheduler/priorities.js";

export {
  eligibilityReason,
  evaluateInterruptWhen,
  hasHighValueLoot,
  hasPickupLoot,
  highValueInterruptScore,
  isInventoryFull,
  isModuleEnabledForState,
  isPredicateTrue,
  isProcessAllowlisted,
  isStateEligible,
  isTargetAcquired,
  isTargetMissingOrLowConfidence,
  isTradeActive,
  lootTargets,
  STATE_MODULE,
} from "./scheduler/predicates.js";

export {
  createScenarioScheduler,
  PriorityScenarioScheduler,
  selectAutomationState,
} from "./scheduler/scenarioScheduler.js";

export { DEFAULT_INTERRUPT_RULES } from "./scheduler/types.js";
export type {
  AutomationScenario,
  FailureInjection,
  InterruptRule,
  ScenarioScheduler,
  SchedulerSelection,
} from "./scheduler/types.js";

export { createCapabilities } from "./capabilities/createCapabilities.js";
export type { QaArmingState, RuntimeCapabilities } from "./capabilities/createCapabilities.js";
export { armQa, evaluateQaArming } from "./capabilities/armQa.js";
export type { QaArmingEvaluation, QaArmingExtras } from "./capabilities/armQa.js";

export { createInterlockGate, DefaultInterlockGate } from "./interlock/interlockGate.js";
export { TokenBucketRateLimiter } from "./interlock/rateLimiter.js";
export type {
  InterlockCode,
  InterlockContext,
  InterlockGate,
  InterlockIdentity,
  InterlockVerdict,
} from "./interlock/types.js";

export { EmergencyStop } from "./input/emergencyStop.js";
export { createInputSink } from "./input/createInputSink.js";
export {
  createGameInputController,
  createNoopSleeper,
  createSystemSleeper,
  DefaultGameInputController,
} from "./input/gameInputController.js";
export type { CreateGameInputControllerOptions, DecisionRecord } from "./input/gameInputController.js";
export { ForbiddenInputSink, PUBLIC_COMPANION_FORBIDDEN_REASON } from "./input/sinks/forbiddenInputSink.js";
export { NoopInputSink } from "./input/sinks/noopInputSink.js";
export { RecordingInputSink } from "./input/sinks/recordingInputSink.js";
export { hashSeed, mulberry32, timingJitterMs } from "./input/mulberry32.js";
export type { TimingProfile } from "./input/mulberry32.js";
export type {
  BotDecision,
  GameInputController,
  InputAction,
  InputResult,
  InputSink,
  Sleeper,
} from "./input/types.js";
