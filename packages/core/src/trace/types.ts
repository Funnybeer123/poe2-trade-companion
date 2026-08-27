import type { InterlockCode } from "../interlock/types.js";
import type { InputAction } from "../input/types.js";
import type {
  AutomationStateId,
  Confidence,
  HexSha256,
  IsoTimestamp,
  ModuleId,
  RuntimeMode,
  ScenarioId,
} from "../world-state/types.js";

export interface QaActionTrace {
  id: string;
  timestamp: IsoTimestamp;
  clockMs: number;
  tickId: number;
  scenarioId: ScenarioId;
  runtimeMode: RuntimeMode;
  module: ModuleId;
  selectedState: AutomationStateId;
  previousState: AutomationStateId;
  process?: { name?: string; title?: string };
  evidenceId?: HexSha256;
  observedSummary: string;
  confidence: Confidence;
  decisionReason: string;
  intendedActions: InputAction[];
  interlockCode: InterlockCode;
  executed: boolean;
  dryRun: boolean;
  result?: string;
  followUpSummary?: string;
  recoveryOf?: string;
  retryIndex?: number;
}

export interface TraceSink {
  append(trace: QaActionTrace): void;
}

export interface RedactionSettings {
  redactIdentifiers: boolean;
  identifiers?: string[];
}
