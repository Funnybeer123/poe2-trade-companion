import { readFileSync } from "node:fs";
import { DEFAULT_INTERRUPT_RULES, type AutomationScenario } from "../scheduler/types.js";
import type { LowConfidencePolicy, ModuleId } from "../world-state/types.js";

const MODULE_IDS = new Set<ModuleId>([
  "follow",
  "loot",
  "inventory",
  "stash",
  "listing",
  "trade",
  "recovery",
  "orchestrator",
  "perception",
  "input",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`corrupt-scenario: missing ${field}`);
  }
  return value;
}

function requireFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`corrupt-scenario: missing ${field}`);
  }
  return value;
}

export function parseAutomationScenario(raw: unknown): AutomationScenario {
  if (!isRecord(raw)) {
    throw new Error("corrupt-scenario: not an object");
  }
  if (!Array.isArray(raw.enabledModules)) {
    throw new Error("corrupt-scenario: enabledModules is not an array");
  }
  const enabledModules = raw.enabledModules.map((moduleId, index) => {
    if (typeof moduleId !== "string" || !MODULE_IDS.has(moduleId as ModuleId)) {
      throw new Error(`corrupt-scenario: enabledModules[${String(index)}] is invalid`);
    }
    return moduleId as ModuleId;
  });
  const executionMode = raw.executionMode;
  if (executionMode !== "dry-run" && executionMode !== "live") {
    throw new Error("corrupt-scenario: executionMode is invalid");
  }
  const lowConfidencePolicy = raw.lowConfidencePolicy;
  if (
    lowConfidencePolicy !== "skip" &&
    lowConfidencePolicy !== "confirm" &&
    lowConfidencePolicy !== "adversarial-execute"
  ) {
    throw new Error("corrupt-scenario: lowConfidencePolicy is invalid");
  }
  return {
    id: requireString(raw.id, "id"),
    title: requireString(raw.title, "title"),
    enabled: raw.enabled !== false,
    executionMode,
    enabledModules,
    actionsPerMinute: requireFiniteNumber(raw.actionsPerMinute, "actionsPerMinute"),
    confidenceThreshold: requireFiniteNumber(raw.confidenceThreshold, "confidenceThreshold"),
    lowConfidencePolicy: lowConfidencePolicy as LowConfidencePolicy,
    timingProfileId: requireString(raw.timingProfileId, "timingProfileId"),
    retryLimits: isRecord(raw.retryLimits)
      ? (raw.retryLimits as AutomationScenario["retryLimits"])
      : {},
    interruptRules: Array.isArray(raw.interruptRules)
      ? (raw.interruptRules as AutomationScenario["interruptRules"])
      : DEFAULT_INTERRUPT_RULES,
    marketProviderId: requireString(raw.marketProviderId, "marketProviderId"),
    lootMinScore:
      typeof raw.lootMinScore === "number" && Number.isFinite(raw.lootMinScore)
        ? raw.lootMinScore
        : undefined,
    failureInjection: isRecord(raw.failureInjection)
      ? {
          id: requireString(raw.failureInjection.id, "failureInjection.id"),
          detail:
            typeof raw.failureInjection.detail === "string"
              ? raw.failureInjection.detail
              : undefined,
        }
      : undefined,
  };
}

export function loadAutomationScenarioFile(filePath: string): AutomationScenario {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`corrupt-scenario: cannot parse ${filePath}`, { cause: error });
  }
  return parseAutomationScenario(raw);
}
