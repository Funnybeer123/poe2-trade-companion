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

export type {
  FrameSource,
  PerceptionAdapter,
  PerceptionFrame,
  PerceptionFrameInput,
  StateEstimator,
} from "./perception/types.js";

export type { Controller } from "./controllers/types.js";
export { IdleController } from "./controllers/idleController.js";
export { FollowController } from "./controllers/followController.js";
export { createPhase04ControllerMap } from "./controllers/controllerMap.js";

export type { QaActionTrace, RedactionSettings, TraceSink } from "./trace/types.js";
export { InMemoryTraceSink } from "./trace/inMemoryTraceSink.js";
export { QaTraceWriter } from "./trace/qaTraceWriter.js";
export type { QaTraceWriterOptions } from "./trace/qaTraceWriter.js";
export {
  redactIdentifiersInText,
  redactQaActionTrace,
  redactSecrets,
} from "./trace/redact.js";

export {
  identityEstimate,
  isoTimestampFromMs,
  summarizeWorld,
} from "./loop/identityEstimator.js";
export { AutomationLoop, createAutomationLoop } from "./loop/automationLoop.js";
export type { AutomationLoopOptions, AutomationTickResult } from "./loop/automationLoop.js";

export type {
  ReplayManifest,
  ReplayManifestExpect,
  ReplayManifestFrame,
} from "./replay/types.js";
export { parseReplayManifest } from "./replay/parseReplayManifest.js";
export { loadReplayManifestFile } from "./replay/loadReplayManifest.js";
export { loadAutomationScenarioFile, parseAutomationScenario } from "./replay/loadAutomationScenario.js";
export {
  DEFAULT_REPLAY_FRAME_HEIGHT,
  DEFAULT_REPLAY_FRAME_WIDTH,
  FixtureFrameSource,
  manifestFrameToInput,
} from "./replay/fixtureFrameSource.js";
export { createReplayArming } from "./replay/replayArming.js";
export { createReplayRunner, ReplayRunner, runReplay } from "./replay/replayRunner.js";
export type { ReplayRunResult, ReplayRunnerOptions } from "./replay/replayRunner.js";
