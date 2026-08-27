import { extractNumericRolls } from "./parseItem.js";
import { validateRegexPattern } from "./scanRules.js";
import type { ItemMod, NormalizedItem } from "./types.js";

export const DEFAULT_STASH_QUERY_MAX_LENGTH = 50;

export type SearchRegexField = "name" | "base" | "class" | "mod" | "text";
export type SearchRegexMatch = "text" | "numeric";

export interface SearchNumericConstraint {
  /** Zero-based numeric value position. Defaults to zero. */
  index?: number;
  exact?: number;
  min?: number;
  max?: number;
}

export interface SearchRegexSelection {
  id?: string;
  label?: string;
  field?: SearchRegexField;
  text?: string;
  representativeLine?: string;
  mod?: ItemMod;
  match?: SearchRegexMatch;
  numeric?: boolean | SearchNumericConstraint | readonly SearchNumericConstraint[];
  /** Convenience fields for a range on numeric value zero. */
  min?: number;
  max?: number;
}

export type SearchRegexInput = string | ItemMod | SearchRegexSelection;

export interface SearchRegexOptions {
  /** Includes the surrounding stash-search quotes when quoteForStash is true. */
  maxLength?: number;
  quoteForStash?: boolean;
  caseInsensitive?: boolean;
  label?: string;
  /**
   * Allows a deliberate text fragment fallback for a single over-limit term.
   * Disabled by default because a fragment broadens matching semantics.
   */
  allowBroadMatches?: boolean;
}

export interface SearchRegexRequest {
  item?: Pick<NormalizedItem, "name" | "baseType" | "itemClass" | "mods">;
  selections?: readonly SearchRegexInput[];
  mods?: readonly (ItemMod | SearchRegexSelection | string)[];
  includeName?: boolean;
  includeBaseType?: boolean;
  includeClass?: boolean;
  includeMods?: boolean;
  options?: SearchRegexOptions;
}

export interface LabeledSearchQuery {
  label: string;
  /** Raw JavaScript-compatible regular expression (without stash quotes). */
  query: string;
  /** Alias for query. */
  regex: string;
  /** Paste-ready PoE stash query. */
  stashQuery: string;
  flags: string;
  length: number;
  selectionIds: string[];
  representativeLines: string[];
}

export interface SearchRegexResult {
  queries: LabeledSearchQuery[];
  warnings: string[];
  conflicts: string[];
  maxLength: number;
}

interface NormalizedSelection {
  id: string;
  label: string;
  field: SearchRegexField;
  line: string;
  match: SearchRegexMatch;
  numeric: SearchRegexSelection["numeric"];
  min?: number;
  max?: number;
}

interface BuiltAlternative {
  pattern: string;
  selectionIds: string[];
  labels: string[];
  representativeLines: string[];
}

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "from",
  "with",
  "have",
  "has",
  "increased",
  "reduced",
  "more",
  "less",
  "chance",
  "item",
]);

function escapeRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&").replaceAll('"', '\\"');
}

function normalizeLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isItemMod(value: SearchRegexInput): value is ItemMod {
  return (
    typeof value === "object" &&
    value !== null &&
    "text" in value &&
    !("field" in value) &&
    !("mod" in value) &&
    !("representativeLine" in value) &&
    !("id" in value) &&
    !("label" in value) &&
    !("match" in value) &&
    !("numeric" in value) &&
    !("min" in value) &&
    !("max" in value)
  );
}

function fieldLine(field: SearchRegexField, text: string): string {
  const normalized = normalizeLine(text);
  if (field === "class" && !/^Item Class:/i.test(normalized)) return `Item Class: ${normalized}`;
  return normalized;
}

function normalizeSelection(input: SearchRegexInput, index: number): NormalizedSelection | undefined {
  if (typeof input === "string") {
    const line = normalizeLine(input);
    if (!line) return undefined;
    return {
      id: `text-${index}`,
      label: line,
      field: "text",
      line,
      match: "text",
      numeric: false,
    };
  }
  if (isItemMod(input)) {
    const line = normalizeLine(input.text);
    if (!line) return undefined;
    const hasNumbers =
      (input.rolls?.length ?? 0) > 0 ||
      (input.values?.length ?? 0) > 0 ||
      input.value !== undefined;
    return {
      id: `mod-${index}`,
      label: input.text,
      field: "mod",
      line,
      match: hasNumbers ? "numeric" : "text",
      numeric: hasNumbers,
    };
  }

  const field = input.field ?? (input.mod ? "mod" : "text");
  const sourceText = input.representativeLine ?? input.text ?? input.mod?.text ?? "";
  const line = fieldLine(field, sourceText);
  if (!line) return undefined;
  const hasNumericConfig =
    input.numeric !== undefined ||
    input.min !== undefined ||
    input.max !== undefined ||
    input.mod?.value !== undefined ||
    (input.mod?.rolls?.length ?? 0) > 0;
  return {
    id: input.id ?? `${field}-${index}`,
    label: input.label ?? input.text ?? input.mod?.text ?? line,
    field,
    line,
    match: input.match ?? (hasNumericConfig ? "numeric" : "text"),
    numeric: input.numeric ?? hasNumericConfig,
    min: input.min,
    max: input.max,
  };
}

function requestSelections(request: SearchRegexRequest): SearchRegexInput[] {
  const selections = [...(request.selections ?? []), ...(request.mods ?? [])];
  const item = request.item;
  if (!item) return selections;
  if (request.includeName && item.name) {
    selections.push({ id: "item-name", label: "Item name", field: "name", text: item.name });
  }
  if (request.includeBaseType && item.baseType) {
    selections.push({ id: "item-base", label: "Base type", field: "base", text: item.baseType });
  }
  if (request.includeClass && item.itemClass) {
    selections.push({ id: "item-class", label: "Item class", field: "class", text: item.itemClass });
  }
  if (request.includeMods) selections.push(...item.mods);
  return selections;
}

function digitClass(first: number, last: number): string {
  return first === last ? String(first) : `[${first}-${last}]`;
}

function anyDigits(count: number): string {
  if (count <= 0) return "";
  if (count === 1) return "[0-9]";
  return `[0-9]{${count}}`;
}

function fixedWidthRange(lower: string, upper: string): string[] {
  if (lower === upper) return [lower];
  let common = 0;
  while (common < lower.length && lower[common] === upper[common]) common += 1;
  if (common > 0) {
    return fixedWidthRange(lower.slice(common), upper.slice(common)).map(
      (suffix) => lower.slice(0, common) + suffix,
    );
  }

  const lowDigit = Number(lower[0]);
  const highDigit = Number(upper[0]);
  const width = lower.length;
  const lowSuffix = lower.slice(1);
  const highSuffix = upper.slice(1);
  if (/^0*$/.test(lowSuffix) && /^9*$/.test(highSuffix)) {
    return [digitClass(lowDigit, highDigit) + anyDigits(width - 1)];
  }

  const output: string[] = [];
  const allZero = "0".repeat(width - 1);
  const allNine = "9".repeat(width - 1);
  output.push(
    ...fixedWidthRange(lowSuffix, allNine).map((suffix) => String(lowDigit) + suffix),
  );
  if (highDigit - lowDigit > 1) {
    output.push(digitClass(lowDigit + 1, highDigit - 1) + anyDigits(width - 1));
  }
  output.push(
    ...fixedWidthRange(allZero, highSuffix).map((suffix) => String(highDigit) + suffix),
  );
  return [...new Set(output)];
}

function nonNegativeIntegerRange(min: number, max: number): string[] {
  const output: string[] = [];
  const minWidth = String(min).length;
  const maxWidth = String(max).length;
  for (let width = minWidth; width <= maxWidth; width += 1) {
    const widthMin = width === 1 ? 0 : 10 ** (width - 1);
    const widthMax = 10 ** width - 1;
    const lower = Math.max(min, widthMin);
    const upper = Math.min(max, widthMax);
    if (lower > upper) continue;
    output.push(...fixedWidthRange(String(lower), String(upper)));
  }
  return output;
}

function integerRangePattern(minimum: number, maximum: number): string {
  const min = Math.ceil(Math.min(minimum, maximum));
  const max = Math.floor(Math.max(minimum, maximum));
  const alternatives: string[] = [];
  if (min < 0) {
    const negativeMax = Math.min(max, -1);
    const absoluteMin = Math.abs(negativeMax);
    const absoluteMax = Math.abs(min);
    alternatives.push(...nonNegativeIntegerRange(absoluteMin, absoluteMax).map((entry) => `-${entry}`));
  }
  if (max >= 0) {
    alternatives.push(...nonNegativeIntegerRange(Math.max(0, min), max));
  }
  if (alternatives.length === 1) return alternatives[0]!;
  return `(?:${alternatives.join("|")})`;
}

function constraintsFor(selection: NormalizedSelection): SearchNumericConstraint[] {
  const configured = selection.numeric;
  const constraints =
    configured && typeof configured === "object"
      ? Array.isArray(configured)
        ? [...configured]
        : [configured as SearchNumericConstraint]
      : [];
  if (selection.min !== undefined || selection.max !== undefined) {
    constraints.push({ index: 0, min: selection.min, max: selection.max });
  }
  return constraints;
}

function numericPattern(
  selection: NormalizedSelection,
  conflicts: string[],
): string | undefined {
  const line = selection.line;
  const rolls = extractNumericRolls(line);
  if (rolls.length === 0) {
    conflicts.push(`${selection.label}: numeric matching was requested, but the selected line has no number.`);
    return undefined;
  }
  const configured = constraintsFor(selection);
  const byIndex = new Map(configured.map((constraint) => [constraint.index ?? 0, constraint]));
  let cursor = 0;
  let pattern = "";

  for (const roll of rolls) {
    pattern += escapeRegex(line.slice(cursor, roll.start));
    const constraint = byIndex.get(roll.index);
    if (!constraint) {
      pattern += escapeRegex(roll.raw);
    } else {
      const exact = constraint.exact;
      const min = exact ?? constraint.min ?? constraint.max;
      const max = exact ?? constraint.max ?? constraint.min;
      if (min === undefined || max === undefined || !Number.isFinite(min) || !Number.isFinite(max)) {
        conflicts.push(`${selection.label}: numeric range ${roll.index + 1} is incomplete.`);
        return undefined;
      }
      if (roll.value < Math.min(min, max) || roll.value > Math.max(min, max)) {
        conflicts.push(
          `${selection.label}: representative value ${roll.value} is outside ${Math.min(min, max)}-${Math.max(min, max)}.`,
        );
        return undefined;
      }
      if (min === max && roll.value === min) {
        pattern += escapeRegex(roll.raw);
      } else if (Number.isInteger(min) && Number.isInteger(max)) {
        pattern += integerRangePattern(min, max);
      } else {
        conflicts.push(
          `${selection.label}: decimal ranges require equal endpoints; arbitrary decimal intervals cannot be represented safely.`,
        );
        return undefined;
      }
    }
    cursor = roll.end;
  }
  pattern += escapeRegex(line.slice(cursor));
  return pattern;
}

function significantFragment(line: string, budget: number): string | undefined {
  const words = [...line.matchAll(/[\p{L}\p{N}]+/gu)]
    .map((match) => match[0])
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word.toLowerCase()))
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
  const wholeWord = words.find((word) => escapeRegex(word).length <= budget);
  if (wholeWord) return escapeRegex(wholeWord);
  const longest = words[0];
  if (!longest || budget < 3) return undefined;
  return escapeRegex(longest.slice(0, budget));
}

function buildAlternative(
  selection: NormalizedSelection,
  budget: number,
  allowBroadMatches: boolean,
  warnings: string[],
  conflicts: string[],
): BuiltAlternative | undefined {
  let pattern =
    selection.match === "numeric"
      ? numericPattern(selection, conflicts)
      : escapeRegex(selection.line);
  if (!pattern) return undefined;

  if (pattern.length > budget) {
    if (!allowBroadMatches) {
      conflicts.push(
        `${selection.label}: its ${pattern.length}-character expression exceeds the ${budget}-character regex budget.`,
      );
      return undefined;
    }
    const fragment = significantFragment(selection.line, budget);
    if (!fragment) {
      conflicts.push(`${selection.label}: no safe expression fits the configured query length.`);
      return undefined;
    }
    pattern = fragment;
    warnings.push(`${selection.label}: used the broader fragment /${fragment}/ to fit the query limit.`);
  }

  const validationIssues = validateRegexPattern(pattern, selection.label);
  if (validationIssues.length > 0) {
    conflicts.push(`${selection.label}: ${validationIssues[0]!.message}`);
    return undefined;
  }
  const regex = new RegExp(pattern, "i");
  if (!regex.test(selection.line)) {
    conflicts.push(`${selection.label}: generated expression does not match its representative line.`);
    return undefined;
  }
  return {
    pattern,
    selectionIds: [selection.id],
    labels: [selection.label],
    representativeLines: [selection.line],
  };
}

function dedupeAlternatives(alternatives: BuiltAlternative[]): BuiltAlternative[] {
  const byPattern = new Map<string, BuiltAlternative>();
  for (const alternative of alternatives) {
    const existing = byPattern.get(alternative.pattern);
    if (!existing) {
      byPattern.set(alternative.pattern, alternative);
      continue;
    }
    existing.selectionIds.push(...alternative.selectionIds);
    existing.labels.push(...alternative.labels);
    existing.representativeLines.push(...alternative.representativeLines);
  }
  return [...byPattern.values()];
}

function packAlternatives(alternatives: BuiltAlternative[], budget: number): BuiltAlternative[][] {
  const groups: BuiltAlternative[][] = [];
  let current: BuiltAlternative[] = [];
  for (const alternative of alternatives) {
    const candidate = [...current, alternative].map((entry) => entry.pattern).join("|");
    if (candidate.length <= budget) {
      current.push(alternative);
      continue;
    }
    if (current.length > 0) groups.push(current);
    current = [alternative];
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function unique(messages: string[]): string[] {
  return [...new Set(messages)];
}

export function buildSearchRegex(
  input: readonly SearchRegexInput[] | SearchRegexRequest,
  options: SearchRegexOptions = {},
): SearchRegexResult {
  const request = Array.isArray(input) ? undefined : (input as SearchRegexRequest);
  const mergedOptions = { ...(request?.options ?? {}), ...options };
  const maxLength = Math.floor(mergedOptions.maxLength ?? DEFAULT_STASH_QUERY_MAX_LENGTH);
  const quoteForStash = mergedOptions.quoteForStash ?? true;
  const budget = maxLength - (quoteForStash ? 2 : 0);
  const warnings: string[] = [];
  const conflicts: string[] = [];

  if (!Number.isFinite(maxLength) || maxLength <= 0 || budget <= 0) {
    return {
      queries: [],
      warnings,
      conflicts: ["The configured maximum length leaves no room for a regular expression."],
      maxLength,
    };
  }

  const rawSelections = request
    ? requestSelections(request)
    : [...(input as readonly SearchRegexInput[])];
  const selections = rawSelections
    .map(normalizeSelection)
    .filter((selection): selection is NormalizedSelection => selection !== undefined);
  if (selections.length === 0) {
    return {
      queries: [],
      warnings,
      conflicts: ["Select at least one item field or modifier."],
      maxLength,
    };
  }

  const alternatives = dedupeAlternatives(
    selections
      .map((selection) =>
        buildAlternative(
          selection,
          budget,
          mergedOptions.allowBroadMatches ?? false,
          warnings,
          conflicts,
        ),
      )
      .filter((entry): entry is BuiltAlternative => entry !== undefined),
  );
  const groups = packAlternatives(alternatives, budget);
  if (groups.length > 1) {
    warnings.push(`The selections require ${groups.length} labeled queries; no expression was truncated.`);
  }

  const baseLabel = mergedOptions.label ?? "Stash search";
  const flags = mergedOptions.caseInsensitive === false ? "" : "i";
  const queries = groups.map<LabeledSearchQuery>((group, index) => {
    const query = group.map((entry) => entry.pattern).join("|");
    const stashQuery = quoteForStash ? `"${query}"` : query;
    const regex = new RegExp(query, flags);
    for (const line of group.flatMap((entry) => entry.representativeLines)) {
      if (!regex.test(line)) conflicts.push(`${baseLabel}: a packed query failed representative-line validation.`);
    }
    return {
      label:
        groups.length === 1
          ? baseLabel
          : `${baseLabel} ${index + 1}/${groups.length}`,
      query,
      regex: query,
      stashQuery,
      flags,
      length: stashQuery.length,
      selectionIds: group.flatMap((entry) => entry.selectionIds),
      representativeLines: group.flatMap((entry) => entry.representativeLines),
    };
  });

  return {
    queries,
    warnings: unique(warnings),
    conflicts: unique(conflicts),
    maxLength,
  };
}

export const buildStashSearchQueries = buildSearchRegex;
export const generateSearchRegex = buildSearchRegex;
