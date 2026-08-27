import type { AutomationStateId, ScenarioId, WorldState } from "../world-state/types.js";

export interface ReplayManifestFrame {
  tickId: number;
  atMs: number;
  pngPath?: string;
  derived: Partial<WorldState>;
}

export interface ReplayManifestExpect {
  tickId: number;
  selectedState: AutomationStateId;
  decisionReasonIncludes?: string;
  executed: false;
  sinkKind: "noop" | "forbidden";
}

export interface ReplayManifest {
  id: string;
  scenarioId: ScenarioId;
  seed: number;
  frames: ReplayManifestFrame[];
  expect: ReplayManifestExpect[];
}
