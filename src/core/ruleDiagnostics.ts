import {
  compileRules,
  evaluateRuleTerm,
  parseScanRule,
  type CompiledScanRule,
  type RuleTermEvaluation,
  type RuleValidationIssue,
  type ScanHistoryItem,
} from "./scanRules.js";

export interface RuleSegmentExplanation {
  index: number;
  matched: boolean;
  matchedTerms: number;
  totalTerms: number;
  terms: RuleTermEvaluation[];
  missingTerms: string[];
}

export interface RuleMatchExplanation {
  rule: CompiledScanRule;
  matched: boolean;
  matchedSegment: number | null;
  segments: RuleSegmentExplanation[];
  nearestSegment: number | null;
  missingTerms: string[];
  nearMiss: boolean;
  score: number;
  summary: string;
  validationIssues: RuleValidationIssue[];
}

export interface NearMissOptions {
  caseInsensitive?: boolean;
  minimumMatchedTerms?: number;
  limit?: number;
}

function isCompiled(rule: ScanHistoryItem | CompiledScanRule): rule is CompiledScanRule {
  return Array.isArray((rule as CompiledScanRule).segments);
}

function prepareRule(rule: ScanHistoryItem | CompiledScanRule): {
  compiled: CompiledScanRule;
  validationIssues: RuleValidationIssue[];
} {
  if (isCompiled(rule)) return { compiled: rule, validationIssues: [] };
  const parsed = parseScanRule(rule.regex);
  const compiled = compileRules([rule])[0] ?? {
    id: rule.id,
    name: rule.name || "(unnamed)",
    regex: rule.regex,
    segments: parsed.segments,
    ast: parsed.ast,
    tags: rule.tags ? [...rule.tags] : undefined,
    sourceUrl: rule.sourceUrl,
    createdAt: rule.createdAt,
    schemaVersion: rule.schemaVersion,
  };
  return { compiled, validationIssues: parsed.issues };
}

function chooseNearest(segments: RuleSegmentExplanation[]): RuleSegmentExplanation | undefined {
  return [...segments].sort((left, right) => {
    const leftRatio = left.totalTerms === 0 ? 0 : left.matchedTerms / left.totalTerms;
    const rightRatio = right.totalTerms === 0 ? 0 : right.matchedTerms / right.totalTerms;
    return rightRatio - leftRatio || right.matchedTerms - left.matchedTerms || left.index - right.index;
  })[0];
}

export function explainRuleMatch(
  rule: ScanHistoryItem | CompiledScanRule,
  itemText: string,
  caseInsensitive = true,
): RuleMatchExplanation {
  const { compiled, validationIssues } = prepareRule(rule);
  const segments = compiled.segments.map<RuleSegmentExplanation>((terms, index) => {
    const evaluations = terms.map((term) => evaluateRuleTerm(term, itemText, caseInsensitive));
    const matchedTerms = evaluations.filter((result) => result.matched).length;
    return {
      index,
      matched: evaluations.length > 0 && matchedTerms === evaluations.length,
      matchedTerms,
      totalTerms: evaluations.length,
      terms: evaluations,
      missingTerms: evaluations.filter((result) => !result.matched).map((result) => result.term),
    };
  });
  const matchedSegment = segments.find((segment) => segment.matched);
  const nearest = chooseNearest(segments);
  const matched = validationIssues.length === 0 && matchedSegment !== undefined;
  const score = matched
    ? 1
    : nearest && nearest.totalTerms > 0
      ? nearest.matchedTerms / nearest.totalTerms
      : 0;
  const nearMiss = !matched && validationIssues.length === 0 && (nearest?.matchedTerms ?? 0) > 0;
  const missingTerms = matched ? [] : (nearest?.missingTerms ?? []);

  let summary: string;
  if (validationIssues.length > 0) {
    summary = `Rule is invalid: ${validationIssues[0]!.message}`;
  } else if (matchedSegment) {
    summary = `Matched OR group ${matchedSegment.index + 1} (${matchedSegment.totalTerms}/${matchedSegment.totalTerms} terms).`;
  } else if (nearest) {
    summary = `Nearest OR group ${nearest.index + 1} matched ${nearest.matchedTerms}/${nearest.totalTerms} terms.`;
  } else {
    summary = "Rule has no evaluable terms.";
  }

  return {
    rule: compiled,
    matched,
    matchedSegment: matchedSegment?.index ?? null,
    segments,
    nearestSegment: nearest?.index ?? null,
    missingTerms,
    nearMiss,
    score,
    summary,
    validationIssues,
  };
}

export function findNearMisses(
  rules: readonly (ScanHistoryItem | CompiledScanRule)[],
  itemText: string,
  options: NearMissOptions = {},
): RuleMatchExplanation[] {
  const minimumMatchedTerms = Math.max(1, options.minimumMatchedTerms ?? 1);
  const limit = Math.max(0, options.limit ?? Number.POSITIVE_INFINITY);
  return rules
    .map((rule) => explainRuleMatch(rule, itemText, options.caseInsensitive ?? true))
    .filter(
      (result) =>
        result.nearMiss &&
        (result.segments[result.nearestSegment ?? -1]?.matchedTerms ?? 0) >= minimumMatchedTerms,
    )
    .sort((left, right) => right.score - left.score || left.rule.name.localeCompare(right.rule.name))
    .slice(0, limit);
}

export const explainNearMisses = findNearMisses;
export const nearMissDiagnostics = findNearMisses;
