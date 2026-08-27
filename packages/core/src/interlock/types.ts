import type { RuntimeCapabilities, QaArmingState } from "../capabilities/createCapabilities.js";
import type { BotDecision } from "../input/types.js";
import type { AutomationScenario } from "../scheduler/types.js";
import type { WorldState } from "../world-state/types.js";

export interface InterlockIdentity {
  realm?: string;
  accountAlias?: string;
  characterAlias?: string;
}

export interface InterlockContext {
  capabilities: RuntimeCapabilities;
  arming: QaArmingState;
  scenario: AutomationScenario;
  world: WorldState;
  decision: BotDecision;
  retryIndex?: number;
  identity?: InterlockIdentity;
}

export type InterlockCode =
  | "ok"
  | "public-mode"
  | "qa-not-acknowledged"
  | "qa-not-armed"
  | "emergency-stop"
  | "window-not-allowlisted"
  | "scenario-disabled"
  | "module-disabled"
  | "dry-run"
  | "low-confidence"
  | "rate-limited"
  | "retry-exhausted"
  | "allowlist-denied";

export interface InterlockVerdict {
  code: InterlockCode;
  allowExecute: boolean;
  allowRecord: boolean;
  message: string;
}

export interface InterlockGate {
  evaluate(ctx: InterlockContext): InterlockVerdict;
}
