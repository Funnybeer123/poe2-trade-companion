import type { BotDecision } from "../input/types.js";
import type { WorldState } from "../world-state/types.js";
import { DefaultScenarioOrchestrator } from "./scenarioOrchestrator.js";
import { applyOrchestratorDecisionEffects } from "./sessionFlags.js";
import type { AutomationLoopOptions, AutomationTickResult } from "./types.js";

export type { AutomationLoopOptions, AutomationTickResult } from "./types.js";

export function applyPostDecisionEffects(
  world: WorldState,
  decision: BotDecision,
  nowMs: number,
): WorldState {
  return applyOrchestratorDecisionEffects(world, decision, nowMs);
}

export class AutomationLoop {
  readonly #orchestrator: DefaultScenarioOrchestrator;

  constructor(options: AutomationLoopOptions) {
    this.#orchestrator = new DefaultScenarioOrchestrator(options);
  }

  get world(): WorldState {
    return this.#orchestrator.world;
  }

  get orchestrator(): DefaultScenarioOrchestrator {
    return this.#orchestrator;
  }

  async tick(): Promise<AutomationTickResult> {
    return this.#orchestrator.runTick();
  }
}

export function createAutomationLoop(options: AutomationLoopOptions): AutomationLoop {
  return new AutomationLoop(options);
}
