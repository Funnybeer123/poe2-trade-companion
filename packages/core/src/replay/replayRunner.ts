import { FrozenClock } from "../clock.js";
import { createCapabilities } from "../capabilities/createCapabilities.js";
import type { QaArmingState, RuntimeCapabilities } from "../capabilities/createCapabilities.js";
import { EmergencyStop } from "../input/emergencyStop.js";
import {
  createGameInputController,
  DefaultGameInputController,
} from "../input/gameInputController.js";
import { NoopInputSink } from "../input/sinks/noopInputSink.js";
import { createAutomationLoop, type AutomationLoop } from "../loop/automationLoop.js";
import { createScenarioScheduler } from "../scheduler/scenarioScheduler.js";
import type { AutomationScenario, ScenarioScheduler } from "../scheduler/types.js";
import { InMemoryTraceSink } from "../trace/inMemoryTraceSink.js";
import { QaTraceWriter } from "../trace/qaTraceWriter.js";
import type { QaActionTrace } from "../trace/types.js";
import { FixtureFrameSource } from "./fixtureFrameSource.js";
import { createReplayArming } from "./replayArming.js";
import type { ReplayManifest } from "./types.js";

export interface ReplayRunResult {
  result: "end-of-stream";
  traces: QaActionTrace[];
  sinkKind: "noop";
  scheduler: ScenarioScheduler;
  inputController: DefaultGameInputController;
  seed: number;
}

export interface ReplayRunnerOptions {
  manifest: ReplayManifest;
  scenario: AutomationScenario;
  capabilities?: RuntimeCapabilities;
  arming?: QaArmingState;
  clock?: FrozenClock;
  redactIdentifiers?: boolean;
}

export class ReplayRunner {
  readonly manifest: ReplayManifest;
  readonly scheduler: ScenarioScheduler;
  readonly inputController: DefaultGameInputController;
  readonly sink: NoopInputSink;
  readonly clock: FrozenClock;
  readonly loop: AutomationLoop;
  readonly traces: InMemoryTraceSink;

  constructor(options: ReplayRunnerOptions) {
    if (options.manifest.scenarioId !== options.scenario.id) {
      throw new Error(
        `corrupt-manifest: scenarioId ${options.manifest.scenarioId} does not match scenario ${options.scenario.id}`,
      );
    }

    this.manifest = options.manifest;
    this.clock = options.clock ?? new FrozenClock(0);
    this.sink = new NoopInputSink();
    this.scheduler = createScenarioScheduler();
    const capabilities = options.capabilities ?? createCapabilities("authorized-qa");
    const arming = options.arming ?? createReplayArming();
    this.inputController = createGameInputController({
      capabilities,
      clock: this.clock,
      sink: this.sink,
      emergencyStop: new EmergencyStop(),
    });
    if (this.inputController.sink.kind !== "noop") {
      throw new Error("replay-refuses-non-noop-sink");
    }
    this.traces = new InMemoryTraceSink();
    this.loop = createAutomationLoop({
      frameSource: FixtureFrameSource.fromManifest(options.manifest),
      scheduler: this.scheduler,
      input: this.inputController,
      clock: this.clock,
      capabilities,
      arming,
      scenario: options.scenario,
      traceWriter: new QaTraceWriter(this.traces, {
        redactIdentifiers: options.redactIdentifiers ?? false,
      }),
    });
  }

  async run(): Promise<ReplayRunResult> {
    const maxTicks = this.manifest.frames.length + 2;
    for (let i = 0; i < maxTicks; i += 1) {
      const outcome = await this.loop.tick();
      if (outcome.result === "end-of-stream") {
        if (this.traces.traces.some((trace) => trace.executed)) {
          throw new Error("replay-emitted-executed-input");
        }
        return {
          result: "end-of-stream",
          traces: this.traces.traces,
          sinkKind: "noop",
          scheduler: this.scheduler,
          inputController: this.inputController,
          seed: this.manifest.seed,
        };
      }
    }
    throw new Error("corrupt-manifest: replay exceeded max ticks");
  }
}

export function createReplayRunner(options: ReplayRunnerOptions): ReplayRunner {
  return new ReplayRunner(options);
}

export async function runReplay(options: ReplayRunnerOptions): Promise<ReplayRunResult> {
  return createReplayRunner(options).run();
}
