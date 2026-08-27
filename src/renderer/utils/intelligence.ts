import {
  computeBuildCoverage,
  type BuildCoverage,
  type BuildProfile,
  type GearTarget,
  type GearTargetMatcherResult,
  type GearTargetStatRule,
} from "@core/buildProfiles";
import {
  evaluateRuleTerm,
  parseScanRule,
  type RuleTermEvaluation,
  type ScanHistoryItem,
} from "@core/scanRules";
import type { NormalizedItem } from "@core/types";
import type { CatalogItemView } from "../../shared/ipc.js";

export function formatDate(value: string | undefined): string {
  if (!value) return "Not recorded";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

export function formatAmount(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 2,
  }).format(value);
}

export function itemText(item: NormalizedItem): string {
  if (item.rawText?.trim()) return item.rawText;
  return [
    `Item Class: ${item.itemClass}`,
    `Rarity: ${item.rarity}`,
    item.name,
    item.baseType !== item.name ? item.baseType : "",
    ...Object.entries(item.requirements).map(
      ([name, value]) => `${name}: ${value}`,
    ),
    ...(item.properties ?? []).map((property) => property.text),
    ...item.mods.map((mod) => mod.text),
  ]
    .filter(Boolean)
    .join("\n");
}

export interface RuleBranchExplanation {
  index: number;
  matched: boolean;
  matchedTerms: number;
  terms: RuleTermEvaluation[];
}

export interface RuleMatchExplanation {
  status: "match" | "near-match" | "miss";
  summary: string;
  branches: RuleBranchExplanation[];
  bestBranch?: RuleBranchExplanation;
}

export function explainRuleMatch(
  rule: ScanHistoryItem,
  item: NormalizedItem,
): RuleMatchExplanation {
  const parsed = parseScanRule(rule.regex);
  if (parsed.issues.length > 0 || parsed.segments.length === 0) {
    return {
      status: "miss",
      summary:
        parsed.issues[0]?.message ?? "The selected rule has no matchable terms.",
      branches: [],
    };
  }
  const source = itemText(item);
  const branches = parsed.segments.map<RuleBranchExplanation>(
    (terms, index) => {
      const evaluations = terms.map((term) =>
        evaluateRuleTerm(term, source, true),
      );
      const matchedTerms = evaluations.filter((term) => term.matched).length;
      return {
        index,
        matched: matchedTerms === evaluations.length,
        matchedTerms,
        terms: evaluations,
      };
    },
  );
  const exact = branches.find((branch) => branch.matched);
  if (exact) {
    return {
      status: "match",
      summary: `OR branch ${exact.index + 1} matched all ${exact.terms.length} AND terms.`,
      branches,
      bestBranch: exact,
    };
  }
  const bestBranch = [...branches].sort(
    (left, right) =>
      right.matchedTerms / Math.max(1, right.terms.length) -
        left.matchedTerms / Math.max(1, left.terms.length) ||
      left.index - right.index,
  )[0];
  if (bestBranch && bestBranch.matchedTerms > 0) {
    return {
      status: "near-match",
      summary: `Closest branch matched ${bestBranch.matchedTerms} of ${bestBranch.terms.length} required terms.`,
      branches,
      bestBranch,
    };
  }
  return {
    status: "miss",
    summary: "No OR branch matched any complete set of AND terms.",
    branches,
    bestBranch,
  };
}

function normalized(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9%+.-]+/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
}

function statLines(item: NormalizedItem, stat: string): string[] {
  const needle = normalized(stat).replaceAll("-", " ");
  const tokens = needle.split(" ").filter((token) => token.length > 1);
  const lines = [
    ...(item.properties ?? []).map((property) => property.text),
    ...item.mods.map((mod) => mod.text),
  ];
  return lines.filter((line) => {
    const haystack = normalized(line).replaceAll("-", " ");
    return tokens.every((token) => haystack.includes(token));
  });
}

function numbers(value: string): number[] {
  return [...value.matchAll(/[+-]?(?:\d+(?:\.\d+)?|\.\d+)/g)]
    .map((match) => Number(match[0]))
    .filter(Number.isFinite);
}

function directStatValues(
  item: NormalizedItem,
  stat: string,
): number[] | undefined {
  const key = normalized(stat).replaceAll("-", " ");
  if (key === "quality") return item.quality === undefined ? [] : [item.quality];
  if (key === "item level" || key === "itemlevel") {
    return item.itemLevel === undefined ? [] : [item.itemLevel];
  }
  if (key === "mod count" || key === "mods") return [item.mods.length];
  return undefined;
}

interface StatRuleResult {
  matched: boolean;
  reason: string;
}

function evaluateStatRule(
  item: NormalizedItem,
  rule: GearTargetStatRule,
): StatRuleResult {
  const lines = statLines(item, rule.stat);
  const direct = directStatValues(item, rule.stat);
  const values = direct ?? lines.flatMap(numbers);
  const label = rule.stat.replaceAll("-", " ");

  if (rule.operator === "exists") {
    const matched = direct !== undefined ? direct.length > 0 : lines.length > 0;
    return {
      matched,
      reason: matched
        ? `${label} is present.`
        : `${label} was not found on the item.`,
    };
  }

  if (rule.operator === "contains") {
    const expected = String(rule.value ?? "").trim().toLowerCase();
    const matched =
      expected.length > 0 &&
      lines.some((line) => line.toLowerCase().includes(expected));
    return {
      matched,
      reason: matched
        ? `${label} contains “${expected}”.`
        : `${label} does not contain “${expected || "an expected value"}”.`,
    };
  }

  const expected = Number(rule.value);
  let matched = false;
  if (rule.operator === "eq" && Number.isFinite(expected)) {
    matched = values.some((value) => value === expected);
  } else if (rule.operator === "gte" && Number.isFinite(expected)) {
    matched = values.some((value) => value >= expected);
  } else if (rule.operator === "lte" && Number.isFinite(expected)) {
    matched = values.some((value) => value <= expected);
  } else if (
    rule.operator === "between" &&
    Number.isFinite(rule.min) &&
    Number.isFinite(rule.max)
  ) {
    matched = values.some(
      (value) => value >= rule.min! && value <= rule.max!,
    );
  }

  const wanted =
    rule.operator === "between"
      ? `${rule.min ?? "?"}–${rule.max ?? "?"}`
      : String(rule.value ?? "?");
  return {
    matched,
    reason: matched
      ? `${label} satisfies ${rule.operator} ${wanted} (observed ${values.join(", ")}).`
      : `${label} misses ${rule.operator} ${wanted}${
          values.length ? ` (observed ${values.join(", ")})` : " (no numeric value found)"
        }.`,
  };
}

export function matchGearTarget(
  target: GearTarget,
  item: NormalizedItem,
): GearTargetMatcherResult {
  const targetClass = target.itemClass?.trim().toLowerCase();
  const itemClass = item.itemClass.trim().toLowerCase();
  const classMatches =
    !targetClass ||
    targetClass === itemClass ||
    itemClass.includes(targetClass) ||
    targetClass.includes(itemClass);

  if (!classMatches) {
    return {
      matched: false,
      score: 0,
      reasons: [
        `Item class ${item.itemClass} does not match required ${target.itemClass}.`,
      ],
      nearMatchReasons: [
        `Wrong class: ${item.itemClass}; expected ${target.itemClass}.`,
      ],
    };
  }

  const results = target.statRules.map((rule) => ({
    rule,
    result: evaluateStatRule(item, rule),
  }));
  const totalWeight = results.reduce(
    (total, entry) => total + Math.max(0, entry.rule.weight),
    0,
  );
  const matchedWeight = results
    .filter((entry) => entry.result.matched)
    .reduce((total, entry) => total + Math.max(0, entry.rule.weight), 0);
  const ruleRatio =
    results.length === 0
      ? 1
      : totalWeight > 0
        ? matchedWeight / totalWeight
        : results.filter((entry) => entry.result.matched).length / results.length;
  const requiredMiss = results.some(
    (entry) => entry.rule.required && !entry.result.matched,
  );
  const allRulesMatch = results.every((entry) => entry.result.matched);
  const matched = !requiredMiss && allRulesMatch;
  const score = Math.max(0, Math.min(1, 0.35 + ruleRatio * 0.65));
  const positive = results
    .filter((entry) => entry.result.matched)
    .map((entry) => entry.result.reason);
  const negative = results
    .filter((entry) => !entry.result.matched)
    .map((entry) =>
      `${entry.rule.required ? "Required" : "Preferred"}: ${entry.result.reason}`,
    );

  return {
    matched,
    score,
    reasons: matched
      ? [
          `${item.itemClass} matches ${target.itemClass ?? "any item class"}.`,
          ...positive,
        ]
      : negative,
    nearMatchReasons: [
      `${item.itemClass} matches the target class.`,
      ...positive,
      ...negative,
    ],
  };
}

export function catalogBuildCoverage(
  profile: BuildProfile,
  catalog: readonly CatalogItemView[],
): BuildCoverage {
  return computeBuildCoverage(
    profile,
    catalog.flatMap((entry) =>
      entry.item ? [{ id: entry.id, value: entry.item }] : [],
    ),
    (target, candidate) => matchGearTarget(target, candidate.value),
    { nearMatchThreshold: 0.5, maxAlternatives: 3 },
  );
}

function isNormalizedItem(value: unknown): value is NormalizedItem {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const item = value as Partial<NormalizedItem>;
  return (
    typeof item.name === "string" &&
    typeof item.baseType === "string" &&
    typeof item.itemClass === "string" &&
    typeof item.rarity === "string" &&
    typeof item.fingerprint === "string" &&
    Array.isArray(item.mods)
  );
}

export function itemFromScanPayload(payload: unknown): NormalizedItem | null {
  if (isNormalizedItem(payload)) return payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  for (const key of ["item", "itemSnapshot", "normalizedItem", "result"]) {
    if (isNormalizedItem(record[key])) return record[key];
  }
  return null;
}
