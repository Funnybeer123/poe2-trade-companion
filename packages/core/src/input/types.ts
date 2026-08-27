import type { InterlockContext } from "../interlock/types.js";
import type { AutomationStateId, Confidence, ModuleId, PixelPoint } from "../world-state/types.js";

export type InputAction =
  | { type: "key-down"; key: string }
  | { type: "key-up"; key: string }
  | { type: "key-tap"; key: string }
  | { type: "mouse-move"; x: number; y: number }
  | { type: "mouse-click"; x: number; y: number; button: "left" | "right"; holdMs?: number }
  | { type: "mouse-drag"; from: PixelPoint; to: PixelPoint; button: "left" }
  | { type: "wait"; durationMs: number }
  | { type: "noop"; reason: string };

export interface BotDecision {
  module: ModuleId;
  state: AutomationStateId;
  reason: string;
  confidence: Confidence;
  intendedActions: InputAction[];
  evidenceIds: string[];
  suppressTargetIds?: string[];
  recoveryOf?: string;
  retryIndex?: number;
}

export interface InputResult {
  accepted: boolean;
  executed: boolean;
  dryRun: boolean;
  blockedReason?: string;
  startedAtMs: number;
  finishedAtMs: number;
}

export interface GameInputController {
  enqueue(decision: BotDecision, ctx: InterlockContext): Promise<InputResult[]>;
  emergencyStop(): void;
  clearQueue(): void;
  isStopped(): boolean;
}

export interface InputSink {
  readonly kind: "native" | "recording" | "forbidden" | "noop";
  execute(action: InputAction): Promise<InputResult>;
  cancel(): void;
}

export interface Sleeper {
  sleep(ms: number): Promise<void>;
}
