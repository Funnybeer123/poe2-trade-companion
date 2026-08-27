import type {
  ListingUiView,
  LootTarget,
  Observation,
  TargetCue,
  TradeWindowView,
  UiModeState,
  WorldState,
} from "../world-state/types.js";

export interface PerceptionFrameInput {
  tickId: number;
  capturedAtMs: number;
  width: number;
  height: number;
  pixels?: Uint8Array;
  pngPath?: string;
  derived?: Partial<WorldState>;
}

export interface FrameSource {
  nextFrame(): Promise<PerceptionFrameInput | null>;
}

export interface PerceptionFrame {
  tickId: number;
  capturedAtMs: number;
  evidenceId: string;
  target?: Observation<TargetCue | null>;
  loot?: Observation<LootTarget[]>;
  inventory?: Observation<WorldState["inventory"]["value"]>;
  stash?: Observation<WorldState["stash"]["value"]>;
  trade?: Observation<TradeWindowView | null>;
  listing?: Observation<ListingUiView | null>;
  ui?: Observation<UiModeState>;
  process?: WorldState["process"];
}

export interface PerceptionAdapter {
  analyze(frame: PerceptionFrameInput): Promise<PerceptionFrame>;
}

export interface StateEstimator {
  estimate(prev: WorldState, frame: PerceptionFrame): WorldState;
}
