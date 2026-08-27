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
  StuckObservationValue,
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
export {
  DEFAULT_ALLOWLISTED_PROCESS_NAMES,
  DEFAULT_ALLOWLISTED_WINDOW_TITLE_INCLUDES,
  isProcessAllowlistedByArming,
} from "./perception/allowlist.js";
export type { ProcessIdentity } from "./perception/allowlist.js";
export { clampConfidence, confidenceBucket } from "./perception/confidence.js";
export {
  createFixturePerceptionAdapter,
  derivedToPerceptionFrame,
  FixturePerceptionAdapter,
} from "./perception/fixturePerceptionAdapter.js";
export { createStateEstimator, DefaultStateEstimator } from "./perception/stateEstimator.js";
export type { StateEstimatorOptions } from "./perception/stateEstimator.js";
export {
  normalizedCorrelation,
  scoreToUnitInterval,
  templateMatch,
  templateMatchScoreAt,
  toGrayscale,
} from "./perception/templateMatch.js";
export type { RgbaImage, TemplateMatchHit } from "./perception/templateMatch.js";
export {
  analyzeFailureFrame,
  errorDetail,
  unknownUiMode,
  unknownUiObservation,
} from "./perception/uiMode.js";

export type { Controller } from "./controllers/types.js";
export { IdleController } from "./controllers/idleController.js";
export { FollowController } from "./controllers/followController.js";
export { RecoveryController } from "./controllers/recoveryController.js";
export { createControllerMap } from "./controllers/controllerMap.js";

export { DEFAULT_RECOVERY, recoveryPolicy } from "./recovery/defaultRecovery.js";
export type { RecoveryPolicy } from "./recovery/defaultRecovery.js";

export { DEFAULT_FOLLOW_CONFIG, resolveFollowConfig } from "./navigation/followConfig.js";
export type { FollowConfig } from "./navigation/followConfig.js";
export {
  DEFAULT_SCREEN_HEIGHT,
  DEFAULT_SCREEN_WIDTH,
  followDirection,
  screenCenter,
  vectorToTarget,
} from "./navigation/direction.js";
export type { FollowDirectionInput, FollowDirectionResult } from "./navigation/direction.js";
export {
  DEFAULT_MIN_PROGRESS_PX,
  detectStuck,
  pointDistance,
  stuckRecoveryAttempt,
} from "./navigation/stuckDetector.js";
export type { StuckDetectorInput, StuckDetectorResult } from "./navigation/stuckDetector.js";
export { nextLostTargetTicks } from "./navigation/lostTargetTicks.js";
export { RECOVERY_SCAN_ANGLES_DEG, RECOVERY_SCAN_RADIUS_PX, recoveryScanPoint } from "./navigation/scan.js";
export {
  estimateStuckObservation,
  isLostTargetExhausted,
  isStuckExhausted,
  LOST_TARGET_EXHAUSTED_REASON,
  LOST_TARGET_REASON,
  lostTargetScanAttempt,
  NO_PROGRESS_REASON,
  STUCK_EXHAUSTED_REASON,
} from "./navigation/estimateNavigation.js";

export type { QaActionTrace, RedactionSettings, TraceSink } from "./trace/types.js";
export { InMemoryTraceSink } from "./trace/inMemoryTraceSink.js";
export { QaTraceWriter } from "./trace/qaTraceWriter.js";
export type { QaTraceWriterOptions } from "./trace/qaTraceWriter.js";
export {
  redactIdentifiersInText,
  redactQaActionTrace,
  redactSecrets,
} from "./trace/redact.js";

export { isoTimestampFromMs, summarizeWorld } from "./loop/traceHelpers.js";
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
