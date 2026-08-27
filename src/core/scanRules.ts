/**
 * Canonical scan-rule DSL. The legacy syntax remains accepted, while parsing,
 * validation and evaluation all use the same AST and term evaluator.
 */
export const SCAN_RULE_SCHEMA_VERSION = 1 as const;

export interface ScanHistoryItem {
  id?: string;
  name?: string;
  regex: string;
  tags?: string[];
  sourceUrl?: string;
  createdAt?: string;
  schemaVersion?: number;
}

export type RangeSemantics = "legacy" | "independent" | "average";

export interface NumericRange {
  min: number;
  max: number;
}

export interface RangeSuffix {
  base: string;
  min: number;
  max: number;
  min2: number | null;
  max2: number | null;
  ranges: NumericRange[];
  semantics: RangeSemantics;
  /** Alias retained for consumers that call the distinction a mode. */
  mode: RangeSemantics;
  explicitSemantics: boolean;
}

export interface ScanRuleTermNode {
  type: "term";
  value: string;
}

export interface ScanRuleAndNode {
  type: "and";
  terms: ScanRuleTermNode[];
}

export interface ScanRuleAst {
  type: "or";
  segments: ScanRuleAndNode[];
}

export type RuleValidationCode =
  | "empty-rule"
  | "invalid-regex"
  | "unsafe-regex"
  | "oversized-regex";

export interface RuleValidationIssue {
  code: RuleValidationCode;
  message: string;
  term?: string;
}

export interface ParsedScanRule {
  normalized: string;
  ast: ScanRuleAst;
  segments: string[][];
  issues: RuleValidationIssue[];
}

export interface RuleValidationResult extends ParsedScanRule {
  valid: boolean;
  safe: boolean;
}

export interface CompiledScanRule {
  id?: string;
  name: string;
  regex: string;
  segments: string[][];
  ast?: ScanRuleAst;
  tags?: string[];
  sourceUrl?: string;
  createdAt?: string;
  schemaVersion?: number;
}

export type RuleTermKind = "literal" | "regex" | "range" | "any-resist" | "total-ele-res";

export interface RuleTermEvaluation {
  term: string;
  matched: boolean;
  kind: RuleTermKind;
  reason: string;
  matchedLine?: string;
  actualValues?: number[];
  expectedRanges?: NumericRange[];
  rangeSemantics?: Exclude<RangeSemantics, "legacy">;
  validationIssues?: RuleValidationIssue[];
}

const NUMBER_TEXT = "[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)";
const RANGE_PART = new RegExp(`^\\s*(${NUMBER_TEXT})\\s*(?:\\.\\.|-)\\s*(${NUMBER_TEXT})\\s*$`);

export function splitOrSegments(input: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quoted = false;
  let escaped = false;
  let parenDepth = 0;
  let classDepth = 0;

  for (const ch of input) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      current += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      quoted = !quoted;
      current += ch;
      continue;
    }
    if (!quoted) {
      if (ch === "[" && classDepth === 0) classDepth = 1;
      else if (ch === "]" && classDepth > 0) classDepth = 0;
      else if (classDepth === 0 && ch === "(") parenDepth += 1;
      else if (classDepth === 0 && ch === ")" && parenDepth > 0) parenDepth -= 1;
      else if (ch === "|" && classDepth === 0 && parenDepth === 0) {
        if (current.trim()) segments.push(current.trim());
        current = "";
        continue;
      }
    }
    current += ch;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

function hasOuterGroup(value: string): boolean {
  if (!value.startsWith("(") || !value.endsWith(")")) return false;
  let depth = 0;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const ch = value[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (depth === 0 && index < value.length - 1) return false;
  }
  return depth === 0;
}

export function extractTermsFromSegment(segment: string): string[] {
  const terms: string[] = [];
  let remainder = "";
  let current = "";
  let quoted = false;
  let escaped = false;

  for (const ch of segment) {
    if (escaped) {
      if (quoted) current += ch;
      else remainder += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      if (quoted) current += ch;
      else remainder += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      if (quoted) {
        const term = current.trim();
        if (term) terms.push(term);
        current = "";
      } else {
        remainder += " ";
      }
      quoted = !quoted;
      continue;
    }
    if (quoted) current += ch;
    else remainder += ch;
  }
  if (quoted && current.trim()) terms.push(current.trim());

  for (const token of remainder.split(/\s+/).map((part) => part.trim()).filter(Boolean)) {
    if (token === "|" || token === "&" || /^AND$/i.test(token)) continue;
    const term = hasOuterGroup(token) ? token.slice(1, -1).trim() : token;
    if (term) terms.push(term);
  }
  return [...new Set(terms)];
}

function quoteTerm(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed;
  return `"${trimmed.replaceAll('"', '\\"')}"`;
}

export function normalizeRegexForMatching(regex: string): string {
  const rawLines = regex
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim());
  const segments: string[][] = [];
  let current: string[] = [];
  for (const line of rawLines) {
    if (!line || /^-{3,}$/.test(line) || /^AND$/i.test(line)) continue;
    if (/^OR$/i.test(line)) {
      if (current.length > 0) segments.push(current);
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) segments.push(current);
  if (segments.length === 0) return "";
  if (segments.length === 1 && segments[0]!.length === 1) {
    const one = segments[0]![0]!;
    return parseRangeSuffix(one) ? quoteTerm(one) : one;
  }
  return segments.map((segment) => segment.map(quoteTerm).join(" ")).join("|");
}

export function canonicalizeForRange(value: string, ci: boolean): string {
  let next = value;
  while (true) {
    const before = next;
    next = next.replace(/\s*\((?![^)]*\d)[^)]*\)\s*$/i, "").trim();
    if (next === before) break;
  }
  next = next.replace(
    /\(\s*[+-]?(?:\d+(?:\.\d+)?|\.\d+)\s*-\s*[+-]?(?:\d+(?:\.\d+)?|\.\d+)\s*\)\s*%?/g,
    "#",
  );
  next = next.replace(/[+-]?(?:\d+(?:\.\d+)?|\.\d+)/g, "#");
  next = next.replace(/#+/g, "#").replace(/\s+/g, " ").trim();
  return ci ? next.toLowerCase() : next;
}

function normalizeSemantics(value: string): Exclude<RangeSemantics, "legacy"> | undefined {
  const normalized = value.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (normalized === "independent" || normalized === "each") return "independent";
  if (normalized === "average" || normalized === "avg" || normalized === "adds-average") return "average";
  return undefined;
}

export function parseRangeSuffix(term: string): RangeSuffix | null {
  const match = term.match(/\s+\[([^\[\]]+)\]\s*$/);
  if (!match?.[1]) return null;
  let body = match[1].trim();
  let semantics: RangeSemantics = "legacy";
  let explicitSemantics = false;

  const prefixed = body.match(/^([a-z][a-z _-]*)\s*:\s*(.+)$/i);
  const prefixedSemantics = prefixed?.[1] ? normalizeSemantics(prefixed[1]) : undefined;
  if (prefixedSemantics && prefixed?.[2]) {
    semantics = prefixedSemantics;
    explicitSemantics = true;
    body = prefixed[2].trim();
  }

  const parts = body.split(";").map((part) => part.trim()).filter(Boolean);
  const trailingSemantics = parts.length > 1 ? normalizeSemantics(parts.at(-1)!) : undefined;
  if (trailingSemantics) {
    semantics = trailingSemantics;
    explicitSemantics = true;
    parts.pop();
  }

  const ranges: NumericRange[] = [];
  for (const part of parts) {
    const parsed = part.match(RANGE_PART);
    if (!parsed?.[1] || !parsed[2]) return null;
    const first = Number(parsed[1]);
    const second = Number(parsed[2]);
    if (!Number.isFinite(first) || !Number.isFinite(second)) return null;
    ranges.push({ min: Math.min(first, second), max: Math.max(first, second) });
  }
  if (ranges.length === 0) return null;
  return {
    base: term.slice(0, match.index).trim(),
    min: ranges[0]!.min,
    max: ranges[0]!.max,
    min2: ranges[1]?.min ?? null,
    max2: ranges[1]?.max ?? null,
    ranges,
    semantics,
    mode: semantics,
    explicitSemantics,
  };
}

function regexSource(term: string): string {
  const explicit = term.match(/^regex\s*:\s*(.*)$/is);
  let source = explicit?.[1] ?? term;
  if (source.startsWith("(?i)")) source = source.slice(4);
  return source;
}

function isRegexTerm(term: string): boolean {
  if (/^regex\s*:/i.test(term)) return true;
  if (/^[*?]/.test(term)) return true;
  if (/^\+(?!\d)/.test(term) || term.includes("\\")) return true;
  if (/\\[dDsSwWbB+|()[\]{}.^$*?]/.test(term)) return true;
  if (/[\[\]()^$|]/.test(term)) return true;
  if (/\.\*|\.\+/.test(term)) return true;
  return /[A-Za-z0-9.)\]](?:[*+?]|\{\d+(?:,\d*)?\})/.test(term);
}

export function validateRegexPattern(pattern: string, term = pattern): RuleValidationIssue[] {
  const issues: RuleValidationIssue[] = [];
  const source = regexSource(pattern);
  if (!source) {
    return [{ code: "invalid-regex", term, message: "A regular expression cannot be empty." }];
  }
  if (source.length > 512) {
    issues.push({
      code: "oversized-regex",
      term,
      message: "Regex terms are limited to 512 characters.",
    });
    return issues;
  }
  if (/\\(?:[1-9]\d*|k<[^>]+>)/.test(source)) {
    issues.push({
      code: "unsafe-regex",
      term,
      message: "Backreferences are not allowed in scan rules.",
    });
  }
  if (
    /\((?:\?(?:[:=!]|<[=!]))?[^()]*(?:[*+]|\{\d+(?:,\d*)?\})[^()]*\)\s*(?:[*+]|\{\d+(?:,\d*)?\})/.test(
      source,
    )
  ) {
    issues.push({
      code: "unsafe-regex",
      term,
      message: "Nested quantified groups are not allowed in scan rules.",
    });
  }
  if (/\([^()]*(?:\|[^()]*)+\)\s*(?:[*+]|\{\d+(?:,\d*)?\})/.test(source)) {
    issues.push({
      code: "unsafe-regex",
      term,
      message: "Quantified alternation groups are not allowed in scan rules.",
    });
  }
  if (/(?:\.\*|\.\+)[^|)]*(?:\.\*|\.\+)/.test(source)) {
    issues.push({
      code: "unsafe-regex",
      term,
      message: "Multiple unbounded wildcards in one branch are not allowed.",
    });
  }
  for (const quantifier of source.matchAll(/\{\s*(\d+)(?:\s*,\s*(\d*)\s*)?\}/g)) {
    const lower = Number(quantifier[1]);
    const upper = quantifier[2] ? Number(quantifier[2]) : lower;
    if (lower > 1_000 || upper > 1_000) {
      issues.push({
        code: "unsafe-regex",
        term,
        message: "Bounded repetitions above 1000 are not allowed.",
      });
      break;
    }
  }
  try {
    new RegExp(source);
  } catch (error) {
    issues.push({
      code: "invalid-regex",
      term,
      message: `Invalid regular expression: ${error instanceof Error ? error.message : "unknown error"}`,
    });
  }
  return issues;
}

function validateTerm(term: string): RuleValidationIssue[] {
  if (parseRangeSuffix(term)) return [];
  if (!isRegexTerm(term)) return [];
  return validateRegexPattern(term, term);
}

export function parseScanRule(regex: string): ParsedScanRule {
  const normalized = normalizeRegexForMatching(regex);
  const segments = splitOrSegments(normalized)
    .map(extractTermsFromSegment)
    .filter((terms) => terms.length > 0);
  const issues =
    segments.length === 0
      ? [{ code: "empty-rule" as const, message: "A scan rule must contain at least one term." }]
      : segments.flatMap((terms) => terms.flatMap(validateTerm));
  const ast: ScanRuleAst = {
    type: "or",
    segments: segments.map((terms) => ({
      type: "and",
      terms: terms.map((value) => ({ type: "term", value })),
    })),
  };
  return { normalized, ast, segments, issues };
}

export function validateRuleRegex(regex: string): RuleValidationResult {
  const parsed = parseScanRule(regex);
  return {
    ...parsed,
    valid: parsed.issues.length === 0,
    safe: parsed.issues.length === 0,
  };
}

export function compileRules(items: ScanHistoryItem[]): CompiledScanRule[] {
  const compiled: CompiledScanRule[] = [];
  for (const item of items) {
    const parsed = parseScanRule(item.regex);
    if (parsed.segments.length === 0 || parsed.issues.length > 0) continue;
    compiled.push({
      id: item.id,
      name: item.name || "(unnamed)",
      regex: item.regex,
      segments: parsed.segments,
      ast: parsed.ast,
      tags: item.tags ? [...item.tags] : undefined,
      sourceUrl: item.sourceUrl,
      createdAt: item.createdAt,
      schemaVersion: item.schemaVersion ?? SCAN_RULE_SCHEMA_VERSION,
    });
  }
  return compiled;
}

function extractNumericValues(text: string): number[] {
  const values: number[] = [];
  const rx = /[+-]?(?:\d+(?:\.\d+)?|\.\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = rx.exec(text)) !== null) {
    let raw = match[0]!;
    if (raw.startsWith("-")) {
      const previous = text.slice(0, match.index).trimEnd().at(-1);
      if (previous && /[\d.)%]/.test(previous)) raw = raw.slice(1);
    }
    const value = Number(raw);
    if (Number.isFinite(value)) values.push(value);
  }
  return values;
}

function within(value: number, range: NumericRange): boolean {
  return value >= range.min && value <= range.max;
}

function average(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function effectiveSemantics(
  range: RangeSuffix,
  isAdds: boolean,
): Exclude<RangeSemantics, "legacy"> {
  if (range.semantics !== "legacy") return range.semantics;
  if (isAdds && range.ranges.length <= 2) return "average";
  return "independent";
}

function evaluateRangeValues(
  range: RangeSuffix,
  values: number[],
  isAdds: boolean,
): { matched: boolean; semantics: Exclude<RangeSemantics, "legacy">; reason: string } {
  const semantics = effectiveSemantics(range, isAdds);
  if (semantics === "independent") {
    if (values.length < range.ranges.length) {
      return {
        matched: false,
        semantics,
        reason: `Expected ${range.ranges.length} numeric values but found ${values.length}.`,
      };
    }
    const failed = range.ranges.findIndex((expected, index) => !within(values[index]!, expected));
    return failed < 0
      ? { matched: true, semantics, reason: "Every numeric value is within its independent range." }
      : {
          matched: false,
          semantics,
          reason: `Value ${failed + 1} (${values[failed]}) is outside ${range.ranges[failed]!.min}-${range.ranges[failed]!.max}.`,
        };
  }

  const count =
    range.ranges.length === 1 && isAdds
      ? 2
      : Math.min(values.length, Math.max(1, range.ranges.length));
  if (values.length < count || count === 0) {
    return { matched: false, semantics, reason: "Not enough numeric values to calculate an average." };
  }
  const actual = average(values.slice(0, count));
  const expected =
    range.ranges.length === 1
      ? range.ranges[0]!
      : {
          min: average(range.ranges.map((entry) => entry.min)),
          max: average(range.ranges.map((entry) => entry.max)),
        };
  return within(actual, expected)
    ? {
        matched: true,
        semantics,
        reason: `Average ${actual} is within ${expected.min}-${expected.max}.`,
      }
    : {
        matched: false,
        semantics,
        reason: `Average ${actual} is outside ${expected.min}-${expected.max}.`,
      };
}

export function evaluateRuleTerm(term: string, itemText: string, ci = true): RuleTermEvaluation {
  const rawTerm = term.trim();
  const lines = itemText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const hay = ci ? itemText.toLowerCase() : itemText;

  const anyRes = rawTerm.match(/^ANY_RESIST\s*>=\s*(\d+)\s*$/i);
  if (anyRes) {
    const required = Math.max(0, Number.parseInt(anyRes[1] ?? "0", 10) || 0);
    const count = lines.filter(
      (line) =>
        /to all Elemental Resistances/i.test(line) ||
        /to (Fire|Cold|Lightning|Chaos) Resistance/i.test(line),
    ).length;
    return {
      term: rawTerm,
      matched: count >= required,
      kind: "any-resist",
      reason: `Found ${count} resistance lines; ${required} required.`,
      actualValues: [count],
    };
  }

  const totalResistance = rawTerm.match(/^TOTAL_ELE_RES\s*>=\s*([+-]?\d+(?:\.\d+)?)\s*$/i);
  if (totalResistance) {
    const required = Number(totalResistance[1]);
    let total = 0;
    for (const line of lines) {
      const all = line.match(/([+-]?\d+(?:\.\d+)?)%\s+to\s+all\s+Elemental\s+Resistances/i);
      if (all?.[1]) {
        total += Number(all[1]) * 3;
        continue;
      }
      const one = line.match(/([+-]?\d+(?:\.\d+)?)%\s+to\s+(Fire|Cold|Lightning)\s+Resistance/i);
      if (one?.[1]) total += Number(one[1]);
    }
    return {
      term: rawTerm,
      matched: total >= required,
      kind: "total-ele-res",
      reason: `Elemental resistance total is ${total}; ${required} required.`,
      actualValues: [total],
    };
  }

  const range = parseRangeSuffix(rawTerm);
  if (range) {
    const wanted = canonicalizeForRange(range.base, ci);
    for (const line of lines) {
      if (!wanted || canonicalizeForRange(line, ci) !== wanted) continue;
      const actualValues = extractNumericValues(line);
      const isAdds = /(?:^|\s)adds # to #(?:\s|$)/i.test(wanted);
      const result = evaluateRangeValues(range, actualValues, isAdds);
      return {
        term: rawTerm,
        matched: result.matched,
        kind: "range",
        reason: result.reason,
        matchedLine: line,
        actualValues,
        expectedRanges: range.ranges,
        rangeSemantics: result.semantics,
      };
    }
    return {
      term: rawTerm,
      matched: false,
      kind: "range",
      reason: "No item line has the requested normalized modifier text.",
      expectedRanges: range.ranges,
      rangeSemantics: effectiveSemantics(range, /adds # to #/i.test(wanted)),
    };
  }

  if (isRegexTerm(rawTerm)) {
    const validationIssues = validateRegexPattern(rawTerm, rawTerm);
    if (validationIssues.length > 0) {
      return {
        term: rawTerm,
        matched: false,
        kind: "regex",
        reason: validationIssues[0]!.message,
        validationIssues,
      };
    }
    const literalNeedle = ci ? rawTerm.toLowerCase() : rawTerm;
    if (literalNeedle && hay.includes(literalNeedle)) {
      const matchedLine = lines.find((line) =>
        (ci ? line.toLowerCase() : line).includes(literalNeedle),
      );
      return {
        term: rawTerm,
        matched: true,
        kind: "literal",
        reason: "The validated term occurs literally in the item text.",
        matchedLine,
      };
    }
    const source = regexSource(rawTerm);
    const forceInsensitive = rawTerm.startsWith("(?i)");
    const regex = new RegExp(source, ci || forceInsensitive ? "i" : "");
    const matchedLine = lines.find((line) => regex.test(line));
    const matched = matchedLine !== undefined || regex.test(itemText);
    return {
      term: rawTerm,
      matched,
      kind: "regex",
      reason: matched ? "The safe regular expression matched." : "The safe regular expression did not match.",
      matchedLine,
    };
  }

  const needle = ci ? rawTerm.toLowerCase() : rawTerm;
  if (needle && hay.includes(needle)) {
    const matchedLine = lines.find((line) => (ci ? line.toLowerCase() : line).includes(needle));
    return {
      term: rawTerm,
      matched: true,
      kind: "literal",
      reason: "The item text contains this literal term.",
      matchedLine,
    };
  }
  if (rawTerm.includes("#")) {
    const wanted = canonicalizeForRange(rawTerm, ci);
    const matchedLine = lines.find((line) => canonicalizeForRange(line, ci) === wanted);
    if (matchedLine) {
      return {
        term: rawTerm,
        matched: true,
        kind: "literal",
        reason: "A modifier line matches after numeric values are normalized.",
        matchedLine,
      };
    }
  }

  return {
    term: rawTerm,
    matched: false,
    kind: "literal",
    reason: "The item text does not contain this literal term.",
  };
}

export function matchCompiledRules(
  compiled: CompiledScanRule[],
  itemText: string,
  ci = true,
): CompiledScanRule[] {
  return compiled.filter((rule) =>
    rule.segments.some((terms) =>
      terms.every((term) => !term || evaluateRuleTerm(term, itemText, ci).matched),
    ),
  );
}

export function matchItemsAgainstText(
  itemText: string,
  items: ScanHistoryItem[],
  ci = true,
): CompiledScanRule[] {
  return matchCompiledRules(compileRules(items), itemText, ci);
}

export function isScrollOfWisdom(itemText: string): boolean {
  return /scroll of wisdom/i.test(itemText) && /Item Class:\s*(Stackable )?Currency/i.test(itemText);
}
