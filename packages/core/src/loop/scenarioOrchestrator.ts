import type { Clock } from "../clock.js";
import { FrozenClock } from "../clock.js";
import type { RuntimeCapabilities, QaArmingState } from "../capabilities/createCapabilities.js";
import { createControllerMap } from "../controllers/controllerMap.js";
import type { Controller } from "../controllers/types.js";
import type { DefaultGameInputController } from "../input/gameInputController.js";
import type { BotDecision } from "../input/types.js";
import type { InterlockContext, InterlockVerdict } from "../interlock/types.js";
import { withShadowMismatchReason } from "../inventory/reasons.js";
import {
  applyStaleSnapshots,
  inventorySnapshotFromWorld,
  shouldPersistInventory,
  shouldPersistStash,
  stashSnapshotFromWorld,
  type InventorySnapshotStore,
} from "../inventory/snapshots.js";
import { ShadowState } from "../inventory/shadowState.js";
import type { DesirabilityPort } from "../items/desirabilityPort.js";
import { createCompositeDesirability } from "../items/compositeDesirability.js";
import { annotateLoot } from "../loot/annotateLoot.js";
import { createFixturePerceptionAdapter } from "../perception/fixturePerceptionAdapter.js";
import { createStateEstimator } from "../perception/stateEstimator.js";
import type { FrameSource, PerceptionAdapter, PerceptionFrame, StateEstimator } from "../perception/types.js";
import { analyzeFailureFrame } from "../perception/uiMode.js";
import { STATE_MODULE } from "../scheduler/predicates.js";
import type { ListingHistoryStore } from "../listing/types.js";
import type { TradeSessionStore } from "../trade/types.js";
import type { AutomationScenario, ScenarioScheduler } from "../scheduler/types.js";
import type { QaActionTrace } from "../trace/types.js";
import type { QaTraceWriter } from "../trace/qaTraceWriter.js";
import { createEmptyWorldState } from "../world-state/createEmptyWorldState.js";
import type { AutomationStateId, ModuleId, WorldState } from "../world-state/types.js";
import { ACTION_BUDGET_HOLD_REASON, ActionBudget, countableActions } from "./actionBudget.js";
import {
  applyOrchestratorDecisionEffects,
  beginListingSession,
  beginStashSession,
  beginTradeSession,
  clearInFlightStep,
  moduleForState,
} from "./sessionFlags.js";
import type { AutomationLoopOptions, AutomationTickResult } from "./types.js";
import { isoTimestampFromMs, summarizeLoot, summarizeWorld } from "./traceHelpers.js";

export interface ScenarioOrchestrator {
  tick(): Promise<QaActionTrace>;
}

function placeholderDecision(state: AutomationStateId): BotDecision {
  const module = STATE_MODULE[state] ?? "orchestrator";
  return {
    module,
    state,
    reason: `placeholder-${state}`,
    confidence: 1,
    intendedActions: [{ type: "noop", reason: `no-controller:${state}` }],
    evidenceIds: [],
  };
}

function budgetHoldDecision(): BotDecision {
  return {
    module: "orchestrator",
    state: "SafetyHold",
    reason: ACTION_BUDGET_HOLD_REASON,
    confidence: 1,
    intendedActions: [{ type: "noop", reason: ACTION_BUDGET_HOLD_REASON }],
    evidenceIds: [],
  };
}

function syncFrozenClock(clock: Clock, targetMs: number): void {
  if (clock instanceof FrozenClock) {
    clock.advance(targetMs - clock.nowMs());
  }
}

function applyOwnedSessionFlags(world: WorldState): WorldState {
  let flags = { ...world.flags };
  if (world.inventory.value.full) {
    flags = beginStashSession(flags);
  }
  if (flags.tradeEvent !== undefined && flags.tradeEvent !== null && flags.tradeRequested !== true) {
    flags = beginTradeSession(flags, flags.tradeEvent);
  }
  return { ...world, flags };
}

export class DefaultScenarioOrchestrator implements ScenarioOrchestrator {
  readonly #frameSource: FrameSource;
  readonly #scheduler: ScenarioScheduler;
  readonly #input: DefaultGameInputController;
  readonly #clock: Clock;
  readonly #capabilities: RuntimeCapabilities;
  readonly #arming: QaArmingState;
  readonly #scenario: AutomationScenario;
  readonly #traceWriter: QaTraceWriter;
  readonly #controllers: Map<AutomationStateId, Controller>;
  readonly #perception: PerceptionAdapter;
  readonly #estimator: StateEstimator;
  readonly #desirability: DesirabilityPort;
  readonly #snapshotStore?: InventorySnapshotStore;
  readonly #listingHistory?: ListingHistoryStore;
  readonly #tradeSessions?: TradeSessionStore;
  readonly #shadow: ShadowState;
  readonly #budget: ActionBudget;
  #world: WorldState;
  #lastTick?: AutomationTickResult;

  constructor(options: AutomationLoopOptions) {
    this.#frameSource = options.frameSource;
    this.#scheduler = options.scheduler;
    this.#input = options.input;
    this.#clock = options.clock;
    this.#capabilities = options.capabilities;
    this.#arming = options.arming;
    this.#scenario = options.scenario;
    this.#traceWriter = options.traceWriter;
    this.#desirability = options.desirability ?? createCompositeDesirability();
    this.#controllers = options.controllers ?? createControllerMap({ desirability: this.#desirability });
    this.#perception = options.perception ?? createFixturePerceptionAdapter();
    this.#snapshotStore = options.snapshotStore;
    this.#listingHistory = options.listingHistory;
    this.#tradeSessions = options.tradeSessions;
    this.#shadow = options.shadowState ?? new ShadowState();
    this.#budget = options.actionBudget ?? new ActionBudget(options.clock, options.scenario.actionsPerMinute);
    this.#estimator =
      options.estimator ??
      createStateEstimator({
        clock: options.clock,
        arming: options.arming,
        shadowState: this.#shadow,
      });
    this.#world = createEmptyWorldState({
      clock: options.clock,
      runtimeMode: options.capabilities.mode,
      activeScenarioId: options.scenario.id,
    });
    if (this.#snapshotStore !== undefined) {
      const latest = {
        inventory: this.#snapshotStore.loadLatestInventory(),
        stash: this.#snapshotStore.loadLatestStash(),
      };
      this.#world = applyStaleSnapshots(this.#world, latest);
      this.#shadow.seedFromSnapshots(latest);
    }
  }

  get world(): WorldState {
    return this.#world;
  }

  get lastTick(): AutomationTickResult | undefined {
    return this.#lastTick;
  }

  get budget(): ActionBudget {
    return this.#budget;
  }

  async tick(): Promise<QaActionTrace> {
    const outcome = await this.runTick();
    if (outcome.result === "end-of-stream") {
      throw new Error("end-of-stream");
    }
    return outcome.trace;
  }

  async runTick(): Promise<AutomationTickResult> {
    const frame = await this.#frameSource.nextFrame();
    if (frame === null) {
      const ended = { result: "end-of-stream" as const };
      this.#lastTick = ended;
      return ended;
    }

    syncFrozenClock(this.#clock, frame.capturedAtMs);

    let perceptionFrame: PerceptionFrame;
    try {
      perceptionFrame = await this.#perception.analyze(frame);
    } catch (error) {
      perceptionFrame = analyzeFailureFrame(frame, error);
    }

    let estimated: WorldState;
    try {
      estimated = this.#estimator.estimate(this.#world, perceptionFrame);
    } catch (error) {
      estimated = this.#estimator.estimate(this.#world, analyzeFailureFrame(frame, error));
    }
    const scored = annotateLoot(estimated, this.#scenario, this.#desirability);
    this.#persistSnapshots(scored, frame.tickId);
    const owned = applyOwnedSessionFlags({
      ...scored,
      flags: {
        ...scored.flags,
        emergencyStopLatched:
          scored.flags.emergencyStopLatched || this.#arming.emergencyStopLatched,
      },
    });

    const budgetExhausted = !this.#budget.hasCapacity(this.#scenario.actionsPerMinute);
    const scheduledWorld: WorldState = {
      ...owned,
      flags: {
        ...owned.flags,
        actionBudgetHold: budgetExhausted && owned.flags.emergencyStopLatched !== true,
      },
    };

    const previousState = scheduledWorld.selectedState;
    const previousModule: ModuleId | undefined = moduleForState(previousState);
    const selection = this.#scheduler.select(scheduledWorld, this.#scenario);
    let world: WorldState = {
      ...scheduledWorld,
      previousState,
      selectedState: selection.state,
      clockMs: this.#clock.nowMs(),
    };

    if (selection.interrupt) {
      world = {
        ...world,
        flags: clearInFlightStep(world.flags, previousModule),
      };
    }

    this.#world = world;

    const budgetHold = world.flags.actionBudgetHold === true && selection.state !== "EmergencyStop";
    const controller = this.#controllers.get(budgetHold ? "SafetyHold" : selection.state);
    const decided =
      budgetHold
        ? budgetHoldDecision()
        : (controller?.decide(world, this.#scenario) ?? placeholderDecision(selection.state));
    const decision = withShadowMismatchReason(decided, world.flags.shadowMismatch === true);
    this.#world = applyOrchestratorDecisionEffects(world, decision, this.#clock.nowMs());
    this.#world = this.#beginListingAfterStash(world, this.#world);
    this.#persistListingHistory(this.#world);
    this.#persistTradeSession(this.#world);

    const consumed = countableActions(decision.intendedActions);
    if (consumed > 0 && !budgetHold && selection.state !== "EmergencyStop") {
      this.#budget.tryConsume(this.#scenario.actionsPerMinute, consumed);
    }

    const ctx: InterlockContext = {
      capabilities: this.#capabilities,
      arming: this.#arming,
      scenario: this.#scenario,
      world,
      decision,
      retryIndex: decision.retryIndex,
    };
    const results = await this.#input.enqueue(decision, ctx);
    const record = this.#input.records.at(-1);
    const verdict: InterlockVerdict = record?.verdict ?? {
      code: "ok",
      allowExecute: false,
      allowRecord: true,
      message: "missing-interlock-record",
    };

    const executed = results.some((result) => result.executed);
    const dryRun = verdict.code === "dry-run" || results.some((result) => result.dryRun);
    const processValue = world.process.value;
    const selectedState = budgetHold ? "SafetyHold" : selection.state;
    if (budgetHold && this.#world.selectedState !== "SafetyHold") {
      this.#world = { ...this.#world, selectedState: "SafetyHold" };
    }

    const trace = this.#traceWriter.write({
      id: `${this.#scenario.id}:${String(frame.tickId)}`,
      timestamp: isoTimestampFromMs(this.#clock.nowMs()),
      clockMs: this.#clock.nowMs(),
      tickId: frame.tickId,
      scenarioId: this.#scenario.id,
      runtimeMode: world.runtimeMode,
      module: decision.module,
      selectedState,
      previousState,
      process:
        processValue.name !== undefined || processValue.title !== undefined
          ? { name: processValue.name, title: processValue.title }
          : undefined,
      evidenceId: world.target.evidenceId ?? perceptionFrame.evidenceId,
      observedSummary: summarizeWorld(this.#world),
      confidence: decision.confidence,
      decisionReason: decision.reason,
      intendedActions: decision.intendedActions,
      interlockCode: verdict.code,
      executed,
      dryRun,
      result: executed ? "executed" : (results[0]?.blockedReason ?? verdict.code),
      followUpSummary: summarizeLoot(this.#world),
      recoveryOf: decision.recoveryOf,
      retryIndex: decision.retryIndex,
      interrupted: selection.interrupt,
    });

    const outcome: AutomationTickResult = {
      result: "ticked",
      trace,
      world: this.#world,
      decision,
      verdict,
    };
    this.#lastTick = outcome;
    return outcome;
  }

  #beginListingAfterStash(before: WorldState, after: WorldState): WorldState {
    const stashEnded = before.flags.stashSessionActive === true && after.flags.stashSessionActive !== true;
    const catalog = after.flags.listingCatalog;
    if (!stashEnded || catalog === undefined || catalog.length === 0) {
      return after;
    }
    return { ...after, flags: beginListingSession(after.flags, catalog) };
  }

  #persistSnapshots(world: WorldState, tickId: number): void {
    if (this.#snapshotStore === undefined) {
      return;
    }
    if (shouldPersistInventory(world)) {
      this.#snapshotStore.writeInventory(
        inventorySnapshotFromWorld(world, `inv:${String(tickId)}:${String(world.inventory.observedAtMs)}`),
      );
    }
    if (shouldPersistStash(world)) {
      this.#snapshotStore.writeStash(
        stashSnapshotFromWorld(world, `stash:${String(tickId)}:${String(world.stash.observedAtMs)}`),
      );
    }
  }

  #persistListingHistory(world: WorldState): void {
    const record = world.flags.pendingListingHistory;
    if (record !== undefined && record !== null && this.#listingHistory !== undefined) {
      this.#listingHistory.append(record);
    }
    if (record !== undefined && record !== null) {
      this.#world = {
        ...world,
        flags: { ...world.flags, pendingListingHistory: null },
      };
    }
  }

  #persistTradeSession(world: WorldState): void {
    const record = world.flags.pendingTradeSessionWrite;
    if (record !== undefined && record !== null && this.#tradeSessions !== undefined) {
      this.#tradeSessions.upsert(record);
    }
    if (record !== undefined && record !== null) {
      this.#world = {
        ...this.#world,
        flags: { ...this.#world.flags, pendingTradeSessionWrite: null },
      };
    }
  }
}

export function createScenarioOrchestrator(options: AutomationLoopOptions): DefaultScenarioOrchestrator {
  return new DefaultScenarioOrchestrator(options);
}
