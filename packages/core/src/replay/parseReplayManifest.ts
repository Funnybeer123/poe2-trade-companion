import { AUTOMATION_STATE_IDS } from "../scheduler/priorities.js";
import type { AutomationStateId } from "../world-state/types.js";
import type {
  ReplayManifest,
  ReplayManifestExpect,
  ReplayManifestFrame,
} from "./types.js";

const AUTOMATION_STATE_SET = new Set<string>(AUTOMATION_STATE_IDS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`corrupt-manifest: missing ${field}`);
  }
  return value;
}

function requireFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`corrupt-manifest: missing ${field}`);
  }
  return value;
}

function parseFrame(value: unknown, index: number): ReplayManifestFrame {
  if (!isRecord(value)) {
    throw new Error(`corrupt-manifest: frames[${String(index)}] is not an object`);
  }
  if (!isRecord(value.derived)) {
    throw new Error(`corrupt-manifest: frames[${String(index)}].derived is not an object`);
  }
  const pngPath = value.pngPath;
  if (pngPath !== undefined && typeof pngPath !== "string") {
    throw new Error(`corrupt-manifest: frames[${String(index)}].pngPath is not a string`);
  }
  return {
    tickId: requireFiniteNumber(value.tickId, `frames[${String(index)}].tickId`),
    atMs: requireFiniteNumber(value.atMs, `frames[${String(index)}].atMs`),
    pngPath,
    derived: value.derived,
  };
}

function parseExpect(value: unknown, index: number): ReplayManifestExpect {
  if (!isRecord(value)) {
    throw new Error(`corrupt-manifest: expect[${String(index)}] is not an object`);
  }
  const selectedState = requireString(
    value.selectedState,
    `expect[${String(index)}].selectedState`,
  );
  if (!AUTOMATION_STATE_SET.has(selectedState)) {
    throw new Error(`corrupt-manifest: expect[${String(index)}].selectedState is invalid`);
  }
  if (value.executed !== false) {
    throw new Error(`corrupt-manifest: expect[${String(index)}].executed must be false`);
  }
  if (value.sinkKind !== "noop" && value.sinkKind !== "forbidden") {
    throw new Error(`corrupt-manifest: expect[${String(index)}].sinkKind is invalid`);
  }
  const decisionReasonIncludes = value.decisionReasonIncludes;
  if (decisionReasonIncludes !== undefined && typeof decisionReasonIncludes !== "string") {
    throw new Error(
      `corrupt-manifest: expect[${String(index)}].decisionReasonIncludes is not a string`,
    );
  }
  return {
    tickId: requireFiniteNumber(value.tickId, `expect[${String(index)}].tickId`),
    selectedState: selectedState as AutomationStateId,
    decisionReasonIncludes,
    executed: false,
    sinkKind: value.sinkKind,
  };
}

export function parseReplayManifest(raw: unknown): ReplayManifest {
  if (!isRecord(raw)) {
    throw new Error("corrupt-manifest: not an object");
  }
  if (!Array.isArray(raw.frames)) {
    throw new Error("corrupt-manifest: frames is not an array");
  }
  if (!Array.isArray(raw.expect)) {
    throw new Error("corrupt-manifest: expect is not an array");
  }
  return {
    id: requireString(raw.id, "id"),
    scenarioId: requireString(raw.scenarioId, "scenarioId"),
    seed: requireFiniteNumber(raw.seed, "seed"),
    frames: raw.frames.map(parseFrame),
    expect: raw.expect.map(parseExpect),
  };
}
