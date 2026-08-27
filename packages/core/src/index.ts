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
  PendingLootPickup,
  PendingStashTransfer,
  StashItemMeta,
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
export {
  createLootLabelDetector,
  DEFAULT_LOOT_COLOR_DISTANCE,
  DEFAULT_LOOT_MIN_BLOB_PIXELS,
  detectLootLabels,
  lootFromDerived,
  LOOT_RARITY_COLORS,
  LootLabelDetector,
} from "./perception/lootLabelDetector.js";
export type {
  DetectedLootLabels,
  LootLabelDetectorOptions,
  RarityColor,
} from "./perception/lootLabelDetector.js";
export {
  DEFAULT_EMPTY_CELL_COLOR,
  DEFAULT_OCCUPIED_DISTANCE,
  DEFAULT_OCCUPIED_VOTE_RATIO,
  GridDetector,
  createGridDetector,
  detectGrids,
  gridHintsFromDerived,
} from "./perception/gridDetector.js";
export type { DetectedGrids, GridDetectorOptions } from "./perception/gridDetector.js";
export { FixtureOcrPort, NoopOcrPort } from "./perception/ocrPort.js";
export type { OcrInput, OcrPort, OcrResult } from "./perception/ocrPort.js";
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
export { LootController } from "./controllers/lootController.js";
export { InventoryController } from "./controllers/inventoryController.js";
export { StashController } from "./controllers/stashController.js";
export type { StashControllerOptions } from "./controllers/stashController.js";
export { createControllerMap } from "./controllers/controllerMap.js";

export type { ReconcileResult, ShadowItem } from "./inventory/types.js";
export { hasShadowMismatch, locationKey } from "./inventory/types.js";
export {
  INVENTORY_NOT_FULL_REASON,
  INVENTORY_OBSERVED_REASON,
  SHADOW_MISMATCH_REASON,
  withShadowMismatchReason,
} from "./inventory/reasons.js";
export type { GridDetectionHints, GridGeometry, GridHover } from "./inventory/gridGeometry.js";
export {
  makeGridCells,
  occupancyFromCells,
  stashTabFull,
} from "./inventory/occupancy.js";
export type { OccupancyCounts, OccupancyFallback } from "./inventory/occupancy.js";
export { DEFAULT_SHADOW_STALE_AFTER_MS, reconcile } from "./inventory/reconcile.js";
export type { ReconcileInput } from "./inventory/reconcile.js";
export { ShadowState, createShadowState, shadowItemsFromCells } from "./inventory/shadowState.js";
export { estimateInventory } from "./inventory/estimateInventory.js";
export type { EstimateInventoryInput, EstimateInventoryResult } from "./inventory/estimateInventory.js";
export {
  MemoryInventorySnapshotStore,
  applyStaleSnapshots,
  createMemoryInventorySnapshotStore,
  inventorySnapshotFromWorld,
  shouldPersistInventory,
  shouldPersistStash,
  stashSnapshotFromWorld,
} from "./inventory/snapshots.js";
export type {
  InventoryGridSnapshot,
  InventorySnapshotStore,
  StashGridSnapshot,
  StoredInventorySnapshot,
  StoredStashSnapshot,
} from "./inventory/snapshots.js";

export type {
  DesirabilityCategory,
  DesirabilityFactor,
  DesirabilityResult,
  ItemSnapshot,
  MarketComparable,
  MarketProvider,
  MarketQuote,
  NormalizedItem,
  OutlierMethod,
  QuoteContext,
  ValuationResult,
} from "./items/types.js";
export { OUTLIER_METHOD } from "./items/types.js";
export type { DesirabilityContext, DesirabilityPort } from "./items/desirabilityPort.js";
export { clampDesirabilityScore, isLootTarget } from "./items/desirabilityPort.js";
export {
  FixtureDesirabilityScorer,
  createFixtureDesirabilityScorer,
} from "./items/fixtureDesirabilityScorer.js";
export { canonicalizeItem, fingerprintItem, withFingerprint } from "./items/fingerprint.js";
export {
  itemTextToSections,
  parseItem,
  parseItemOrUndefined,
} from "./items/parseItem.js";
export type { ParseItemFailure, ParseItemResult, ParseItemSuccess } from "./items/parseItem.js";
export { DesirabilityEngine, createDesirabilityEngine } from "./items/desirabilityEngine.js";
export {
  CompositeDesirabilityPort,
  createCompositeDesirability,
} from "./items/compositeDesirability.js";
export type { CompositeDesirabilityOptions, QuoteLookup } from "./items/compositeDesirability.js";

export {
  DEFAULT_OFFICIAL_USER_AGENT,
  isThrottleStatus,
  isTransientStatus,
  parseRetryAfterMs,
  rateLimitFetch,
} from "./market/rateLimitFetch.js";
export type { RateLimitFetchOptions, RateLimitFetchResult } from "./market/rateLimitFetch.js";
export {
  MemoryMarketCache,
  createMemoryMarketCache,
  marketCacheKey,
} from "./market/marketCache.js";
export type { MarketCacheEntry, MarketCachePort } from "./market/marketCache.js";
export {
  LOCKED_OUTLIER_METHOD,
  confidenceFromCounts,
  failedQuote,
  failedValuation,
  lowConfidenceReasonFor,
  median,
  quantile,
  summarizeInliers,
  tukeyInliers,
  valueFromPrices,
} from "./market/valuation.js";
export type { PricePoint } from "./market/valuation.js";
export {
  FixtureMarketProvider,
  createFixtureMarketProvider,
  loadFixtureMarketRecords,
  parseFixtureMarketFile,
} from "./market/fixtureMarketProvider.js";
export type { FixtureMarketProviderOptions, FixtureMarketRecord } from "./market/fixtureMarketProvider.js";
export {
  CURRENCY_EXCHANGE_BASE_URL,
  CURRENCY_METADATA_IDS,
  OFFICIAL_CURRENCY_EXCHANGE_ID,
  QUOTE_CURRENCY_ID,
  QUOTE_CURRENCY_NAME,
  OfficialCurrencyExchangeProvider,
  createOfficialCurrencyExchangeProvider,
  currencyMetadataId,
  isCurrencyItem,
  parseCurrencyExchangeDigest,
  quoteFromDigest,
} from "./market/officialCurrencyExchangeProvider.js";
export type {
  CurrencyExchangeDigest,
  CurrencyExchangeMarket,
  OfficialCurrencyExchangeProviderOptions,
} from "./market/officialCurrencyExchangeProvider.js";

export {
  DEFAULT_LOOT_MIN_SCORE,
  LOOT_BACKOFF_REASON,
  LOOT_NONE_ELIGIBLE_REASON,
  LOOT_PICK_PREFIX,
  LOOT_RECOVERY_KEY,
  LOOT_SKIP_PREFIX,
  LOOT_UNREACHABLE_REASON,
  SKIP_BELOW_MIN_SCORE,
  SKIP_INVENTORY_FULL,
  SKIP_UNREACHABLE,
} from "./loot/skipReasons.js";
export { eligibleLoot, lootDistanceToCenter, rankLoot } from "./loot/rankLoot.js";
export {
  annotateLoot,
  annotateLootTargets,
  isAdversarialScenario,
  resolveLootMinScore,
} from "./loot/annotateLoot.js";
export { estimateLootPickup } from "./loot/estimateLootPickup.js";
export type { EstimateLootPickupInput, EstimateLootPickupResult } from "./loot/estimateLootPickup.js";

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

export type {
  PlanStashTab,
  SortBucket,
  SortRule,
  TransferPlan,
  TransferPlanStep,
} from "./stash/types.js";
export { itemScore } from "./stash/types.js";
export {
  DEFAULT_SORT_RULES,
  categoryForBucket,
  matchSortRule,
  ruleMatches,
} from "./stash/sortRules.js";
export { planTransfers } from "./stash/transferPlanner.js";
export type { TransferPlannerInput } from "./stash/transferPlanner.js";
export {
  applyExpectedTransfer,
  fingerprintAt,
  transferObserved,
  transferObservedInCells,
} from "./stash/confirmTransfer.js";
export {
  DEFAULT_INVENTORY_GRID,
  DEFAULT_STASH_GRID,
  DEFAULT_TAB_CLICKS,
  cellCenter,
  tabClickPoint,
} from "./stash/geometry.js";
export {
  STASH_BACKOFF_REASON,
  STASH_FAILED_MOVE_KEY,
  STASH_FAILED_MOVE_REASON,
  STASH_FAILED_OR_TIMED_OUT_REASON,
  STASH_FALLBACK_TAB_FULL_REASON,
  STASH_MOVE_PREFIX,
  STASH_PLAN_EMPTY_REASON,
  STASH_TAB_PREFIX,
  STASH_WRONG_TAB_KEY,
  STASH_WRONG_TAB_REASON,
  stashMoveEvidence,
  stashMoveReason,
  stashTabEvidence,
  stashTabReason,
} from "./stash/reasons.js";
export {
  isStashRecovery,
  locationEvidenceKey,
  pendingMoveFromStep,
  pendingTabClick,
  stashEffectsFromDecision,
} from "./stash/session.js";

export { isoTimestampFromMs, summarizeInventory, summarizeLoot, summarizeStash, summarizeWorld } from "./loop/traceHelpers.js";
export { applyPostDecisionEffects, AutomationLoop, createAutomationLoop } from "./loop/automationLoop.js";
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
