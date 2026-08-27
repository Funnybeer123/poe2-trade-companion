import {
  scoreCandidateForActiveProfiles,
  type ActiveProfileCandidatePreference,
  type BuildProfile,
  type GearTarget,
  type GearTargetMatcherResult,
  type GearTargetStatRule,
} from "./buildProfiles.js";
import { scoreDesirability } from "./desirability.js";
import { normalizeItemClass } from "./itemClassFilter.js";
import { extractNumericRolls } from "./parseItem.js";
import type {
  DesirabilityResult,
  NormalizedItem,
  ValuationResult,
} from "./types.js";

interface CandidateLine {
  text: string;
  values: number[];
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function importedQueryBody(target: GearTarget): Record<string, unknown> | undefined {
  const document = recordValue(target.importedQuery);
  return recordValue(document?.query) ?? document;
}

function textOption(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  const option = recordValue(value)?.option;
  return typeof option === "string" && option.trim() ? option.trim() : undefined;
}

function identityConstraints(target: GearTarget): {
  name?: string;
  type?: string;
} {
  const body = importedQueryBody(target);
  const name = textOption(body?.name);
  const type = textOption(body?.type);
  return {
    ...(name ? { name } : {}),
    ...(type ? { type } : {}),
  };
}

function itemLines(item: NormalizedItem): CandidateLine[] {
  const lines: CandidateLine[] = item.mods.map((mod) => ({
    text: mod.text,
    values:
      mod.values ??
      mod.rolls?.map((roll) => roll.value) ??
      [mod.value, mod.value2].filter(
        (value): value is number => typeof value === "number",
      ),
  }));
  for (const property of item.properties ?? []) {
    lines.push({
      text: property.text || `${property.name}: ${property.value}`,
      values: property.values,
    });
  }
  return lines;
}

function statTokens(stat: string): string[] {
  return normalized(stat)
    .replace(/^(?:explicit|implicit|pseudo|crafted|fractured|enchant)\./, "")
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && token !== "stat");
}

function lineForRule(
  rule: GearTargetStatRule,
  lines: readonly CandidateLine[],
): CandidateLine | undefined {
  const tokens = statTokens(rule.stat);
  if (tokens.length === 0) return undefined;
  return lines.find((line) => {
    const value = normalized(line.text);
    return tokens.every((token) => value.includes(token));
  });
}

function compareValue(rule: GearTargetStatRule, line: CandidateLine): boolean {
  if (rule.operator === "exists") return true;
  if (rule.operator === "contains") {
    return normalized(line.text).includes(normalized(String(rule.value ?? "")));
  }
  const actual = line.values[0] ?? extractNumericRolls(line.text)[0]?.value;
  if (actual === undefined) return false;
  if (rule.operator === "eq") return actual === Number(rule.value);
  if (rule.operator === "gte") return actual >= Number(rule.value);
  if (rule.operator === "lte") return actual <= Number(rule.value);
  if (rule.operator === "between") {
    return (
      typeof rule.min === "number" &&
      typeof rule.max === "number" &&
      actual >= rule.min &&
      actual <= rule.max
    );
  }
  return false;
}

function typeMatches(item: NormalizedItem, wanted: string): boolean {
  const target = normalized(wanted);
  const base = normalized(item.baseType);
  return base === target || base.includes(target) || target.includes(base);
}

export function matchItemToGearTarget(
  target: GearTarget,
  item: NormalizedItem,
): GearTargetMatcherResult {
  const reasons: string[] = [];
  const nearMatchReasons: string[] = [];
  if (
    target.itemClass &&
    normalizeItemClass(target.itemClass) !== normalizeItemClass(item.itemClass)
  ) {
    return {
      matched: false,
      score: 0,
      reasons: [],
      nearMatchReasons: [
        `Needs ${target.itemClass}; item class is ${item.itemClass || "unknown"}.`,
      ],
    };
  }
  if (target.itemClass) reasons.push(`Item class matches ${target.itemClass}.`);

  const identity = identityConstraints(target);
  if (identity.name && normalized(identity.name) !== normalized(item.name)) {
    return {
      matched: false,
      score: 0.1,
      reasons,
      nearMatchReasons: [
        `Needs ${identity.name}; item name is ${item.name || "unknown"}.`,
      ],
    };
  }
  if (identity.name) reasons.push(`Item name matches ${identity.name}.`);
  if (identity.type && !typeMatches(item, identity.type)) {
    return {
      matched: false,
      score: 0.2,
      reasons,
      nearMatchReasons: [
        `Needs ${identity.type}; base type is ${item.baseType || "unknown"}.`,
      ],
    };
  }
  if (identity.type) reasons.push(`Base type matches ${identity.type}.`);

  const lines = itemLines(item);
  let passedWeight = 0;
  let totalWeight = 0;
  let requiredFailed = false;
  let optionalFailed = false;
  for (const rule of target.statRules) {
    const weight = Math.max(0, rule.weight || 1);
    totalWeight += weight;
    const line = lineForRule(rule, lines);
    const passed = line !== undefined && compareValue(rule, line);
    if (passed) {
      passedWeight += weight;
      reasons.push(`${rule.stat} target met.`);
      continue;
    }
    requiredFailed ||= rule.required;
    optionalFailed ||= !rule.required;
    nearMatchReasons.push(
      `${rule.required ? "Required" : "Preferred"} stat not met: ${rule.stat}.`,
    );
  }

  const identityWeight = 1;
  const score =
    totalWeight === 0
      ? identityWeight
      : Math.max(0, Math.min(1, (identityWeight + passedWeight) / (identityWeight + totalWeight)));
  return {
    matched: !requiredFailed && !optionalFailed,
    score,
    reasons,
    nearMatchReasons,
  };
}

export interface BuildAwareDesirability {
  desirability: DesirabilityResult;
  buildPreference: ActiveProfileCandidatePreference;
}

export function scoreBuildAwareDesirability(
  item: NormalizedItem,
  valuation: ValuationResult,
  profiles: readonly BuildProfile[],
): BuildAwareDesirability {
  const base = scoreDesirability(item, valuation);
  const buildPreference = scoreCandidateForActiveProfiles(
    profiles,
    { id: item.fingerprint, value: item },
    (target, candidate) => matchItemToGearTarget(target, candidate.value),
  );
  const score = Math.min(100, base.score + buildPreference.bonus);
  const category =
    buildPreference.exactTargetIds.length > 0
      ? "keep"
      : buildPreference.nearTargetIds.length > 0 &&
          (base.category === "dump" || base.category === "vendor")
        ? "sell"
        : base.category;
  return {
    buildPreference,
    desirability: {
      ...base,
      score,
      category,
      reasons: [
        ...base.reasons,
        ...(buildPreference.exactTargetIds.length > 0
          ? [
              `matches ${buildPreference.exactTargetIds.length} active build target${
                buildPreference.exactTargetIds.length === 1 ? "" : "s"
              }`,
            ]
          : []),
        ...(buildPreference.nearTargetIds.length > 0
          ? [
              `near ${buildPreference.nearTargetIds.length} active build target${
                buildPreference.nearTargetIds.length === 1 ? "" : "s"
              }`,
            ]
          : []),
        ...buildPreference.reasons,
      ],
    },
  };
}
