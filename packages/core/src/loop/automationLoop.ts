import type { Clock } from "../clock.js";
import { FrozenClock } from "../clock.js";
import type { RuntimeCapabilities, QaArmingState } from "../capabilities/createCapabilities.js";
import { createControllerMap } from "../controllers/controllerMap.js";
import type { Controller } from "../controllers/types.js";
import type { DefaultGameInputController } from "../input/gameInputController.js";
import type { BotDecision } from "../input/types.js";
import type { InterlockContext, InterlockVerdict } from "../interlock/types.js";
import { createFixturePerceptionAdapter } from "../perception/fixturePerceptionAdapter.js";
import { createStateEstimator } from "../perception/stateEstimator.js";
import type { FrameSource, PerceptionAdapter, PerceptionFrame, StateEstimator } from "../perception/types.js";
import { analyzeFailureFrame } from "../perception/uiMode.js";
import { STATE_MODULE } from "../scheduler/predicates.js";
import type { AutomationScenario, ScenarioScheduler } from "../scheduler/types.js";
import type { QaActionTrace } from "../trace/types.js";
import type { QaTraceWriter } from "../trace/qaTraceWriter.js";
import { createEmptyWorldState } from "../world-state/createEmptyWorldState.js";
import type { AutomationStateId, WorldState } from "../world-state/types.js";
import { isoTimestampFromMs, summarizeWorld } from "./traceHelpers.js";

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
    const previousState = estimated.selectedState;
    const selection = this.#scheduler.select(estimated, this.#scenario);
    const world: WorldState = {
      ...estimated,
      previousState,
      selectedState: selection.state,
      flags: {
        ...estimated.flags,
        emergencyStopLatched:
          estimated.flags.emergencyStopLatched || this.#arming.emergencyStopLatched,
      },
      clockMs: this.#clock.nowMs(),
    };
    this.#world = world;

    const controller = this.#controllers.get(selection.state);
    const decision = controller?.decide(world, this.#scenario) ?? placeholderDecision(selection.state);

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
      observedSummary: summarizeWorld(world),
      confidence: decision.confidence,
      decisionReason: decision.reason,
      intendedActions: decision.intendedActions,
      interlockCode: verdict.code,
      executed,
      dryRun,
      result: executed ? "executed" : (results[0]?.blockedReason ?? verdict.code),
      recoveryOf: decision.recoveryOf,
      retryIndex: decision.retryIndex,
    });

    return { result: "ticked", trace, world, decision, verdict };
  }
}

export function createAutomationLoop(options: AutomationLoopOptions): AutomationLoop {
  return new AutomationLoop(options);
}
