import type { Clock } from "../clock.js";
import { FrozenClock } from "../clock.js";
import type { RuntimeCapabilities, QaArmingState } from "../capabilities/createCapabilities.js";
import { createControllerMap } from "../controllers/controllerMap.js";
import type { Controller } from "../controllers/types.js";
import type { DefaultGameInputController } from "../input/gameInputController.js";
import type { BotDecision, InputAction } from "../input/types.js";
import type { InterlockContext, InterlockVerdict } from "../interlock/types.js";
import type { DesirabilityPort } from "../items/desirabilityPort.js";
import { createFixtureDesirabilityScorer } from "../items/fixtureDesirabilityScorer.js";
import { annotateLoot } from "../loot/annotateLoot.js";
import { LOOT_RECOVERY_KEY } from "../loot/skipReasons.js";
import { createFixturePerceptionAdapter } from "../perception/fixturePerceptionAdapter.js";
import { createStateEstimator } from "../perception/stateEstimator.js";
import type { FrameSource, PerceptionAdapter, PerceptionFrame, StateEstimator } from "../perception/types.js";
import { analyzeFailureFrame } from "../perception/uiMode.js";
import { DEFAULT_RECOVERY } from "../recovery/defaultRecovery.js";
import { STATE_MODULE } from "../scheduler/predicates.js";
import type { AutomationScenario, ScenarioScheduler } from "../scheduler/types.js";
import type { QaActionTrace } from "../trace/types.js";
import type { QaTraceWriter } from "../trace/qaTraceWriter.js";
import { createEmptyWorldState } from "../world-state/createEmptyWorldState.js";
import type { AutomationStateId, WorldState } from "../world-state/types.js";
import { isoTimestampFromMs, summarizeLoot, summarizeWorld } from "./traceHelpers.js";

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

function syncFrozenClock(clock: Clock, targetMs: number): void {
  if (clock instanceof FrozenClock) {
    clock.advance(targetMs - clock.nowMs());
  }
}

function lootIdFromDecision(decision: BotDecision, world: WorldState, click: InputAction): string | undefined {
  const fromEvidence = decision.evidenceIds.find((id) => id.startsWith("loot:"));
  if (fromEvidence !== undefined) {
    return fromEvidence.slice("loot:".length);
  }
  const pickMatch = /pick:([^;]+)/.exec(decision.reason);
  if (pickMatch?.[1] !== undefined) {
    return pickMatch[1];
  }
  if (click.type !== "mouse-click") {
    return undefined;
  }
  return world.loot.value.find(
    (item) => item.screenPoint.x === click.x && item.screenPoint.y === click.y,
  )?.id;
}

export function applyPostDecisionEffects(
  world: WorldState,
  decision: BotDecision,
  nowMs: number,
): WorldState {
  const flags = { ...world.flags };
  if (
    world.inventory.value.full &&
    (decision.module === "inventory" ||
      decision.state === "InventoryFull" ||
      world.selectedState === "InventoryFull")
  ) {
    flags.stashSessionActive = true;
  }

  const click = decision.intendedActions.find((action) => action.type === "mouse-click");
  if (decision.module === "loot" && click !== undefined) {
    const id = lootIdFromDecision(decision, world, click);
    if (id !== undefined) {
      flags.pendingLootPickup = {
        id,
        occupancy: world.inventory.value.occupied,
        clickedAtMs: nowMs,
      };
      flags.lootLastAttemptMs = { ...(flags.lootLastAttemptMs ?? {}), [id]: nowMs };
    }
  }

  if (decision.suppressTargetIds !== undefined && decision.suppressTargetIds.length > 0) {
    const until = nowMs + (DEFAULT_RECOVERY[LOOT_RECOVERY_KEY]?.suppressMs ?? 15_000);
    flags.lootSuppressedUntilMs = { ...(flags.lootSuppressedUntilMs ?? {}) };
    for (const id of decision.suppressTargetIds) {
      flags.lootSuppressedUntilMs[id] = until;
    }
  }

  return { ...world, flags };
}

export class AutomationLoop {
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
  #world: WorldState;

  constructor(options: AutomationLoopOptions) {
    this.#frameSource = options.frameSource;
    this.#scheduler = options.scheduler;
    this.#input = options.input;
    this.#clock = options.clock;
    this.#capabilities = options.capabilities;
    this.#arming = options.arming;
    this.#scenario = options.scenario;
    this.#traceWriter = options.traceWriter;
    this.#controllers = options.controllers ?? createControllerMap();
    this.#perception = options.perception ?? createFixturePerceptionAdapter();
    this.#estimator =
      options.estimator ??
      createStateEstimator({
        clock: options.clock,
        arming: options.arming,
      });
    this.#desirability = options.desirability ?? createFixtureDesirabilityScorer();
    this.#world = createEmptyWorldState({
      clock: options.clock,
      runtimeMode: options.capabilities.mode,
      activeScenarioId: options.scenario.id,
    });
  }

  get world(): WorldState {
    return this.#world;
  }

  async tick(): Promise<AutomationTickResult> {
    const frame = await this.#frameSource.nextFrame();
    if (frame === null) {
      return { result: "end-of-stream" };
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
    const previousState = scored.selectedState;
    const selection = this.#scheduler.select(scored, this.#scenario);
    const world: WorldState = {
      ...scored,
      previousState,
      selectedState: selection.state,
      flags: {
        ...scored.flags,
        emergencyStopLatched:
          scored.flags.emergencyStopLatched || this.#arming.emergencyStopLatched,
      },
      clockMs: this.#clock.nowMs(),
    };
    this.#world = world;

    const controller = this.#controllers.get(selection.state);
    const decision = controller?.decide(world, this.#scenario) ?? placeholderDecision(selection.state);
    this.#world = applyPostDecisionEffects(world, decision, this.#clock.nowMs());

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

    const trace = this.#traceWriter.write({
      id: `${this.#scenario.id}:${String(frame.tickId)}`,
      timestamp: isoTimestampFromMs(this.#clock.nowMs()),
      clockMs: this.#clock.nowMs(),
      tickId: frame.tickId,
      scenarioId: this.#scenario.id,
      runtimeMode: world.runtimeMode,
      module: decision.module,
      selectedState: selection.state,
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
    });

    return { result: "ticked", trace, world: this.#world, decision, verdict };
  }
}

export function createAutomationLoop(options: AutomationLoopOptions): AutomationLoop {
  return new AutomationLoop(options);
}
