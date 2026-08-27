export const BUILD_PROFILE_SCHEMA_VERSION = 1;
export const MAX_BUILD_PROFILE_TARGETS = 128;
export const MAX_BUILD_PROFILE_TAGS = 64;
export const MAX_GEAR_TARGET_STAT_RULES = 128;

export type GearTargetStatOperator =
  | "exists"
  | "eq"
  | "gte"
  | "lte"
  | "between"
  | "contains";

export interface GearTargetStatRule {
  id: string;
  stat: string;
  operator: GearTargetStatOperator;
  value?: string | number | boolean;
  min?: number;
  max?: number;
  required: boolean;
  weight: number;
  group?: string;
}

export interface GearTargetProvenance {
  kind: "trade-query" | "legacy-preset" | "manual" | "opaque-id";
  sourceKey: string;
  raw?: unknown;
  unsupported?: boolean;
  warnings?: string[];
}

export interface GearTarget {
  id: string;
  searchKey: string;
  name: string;
  slot: string;
  itemClass?: string;
  statRules: GearTargetStatRule[];
  sourceUrl?: string;
  league?: string;
  tags: string[];
  importedQuery?: unknown;
  provenance?: GearTargetProvenance;
  createdAt: string;
  updatedAt: string;
}

export interface BuildProfileDesirabilityPreferences {
  exactMatchBoost: number;
  nearMatchBoost: number;
  preferredSlots: string[];
  preferredItemClasses: string[];
  preferredTags: string[];
}

export interface BuildProfile {
  schemaVersion: number;
  id: string;
  name: string;
  league?: string;
  sourceUrl?: string;
  tags: string[];
  active: boolean;
  preferences: BuildProfileDesirabilityPreferences;
  gearTargets: GearTarget[];
  createdAt: string;
  updatedAt: string;
}

export interface BuildProfileValidationIssue {
  path: string;
  code: string;
  message: string;
}

export interface BuildProfileValidation {
  valid: boolean;
  issues: BuildProfileValidationIssue[];
}

export interface CreateGearTargetInput {
  id?: string;
  searchKey?: string;
  name?: string;
  slot: string;
  itemClass?: string;
  statRules?: Array<Partial<GearTargetStatRule> & Pick<GearTargetStatRule, "stat">>;
  sourceUrl?: string;
  league?: string;
  tags?: string[];
  importedQuery?: unknown;
  provenance?: GearTargetProvenance;
}

export interface CreateBuildProfileInput {
  id?: string;
  name: string;
  league?: string;
  sourceUrl?: string;
  tags?: string[];
  active?: boolean;
  preferences?: Partial<BuildProfileDesirabilityPreferences>;
  gearTargets?: CreateGearTargetInput[];
}

export interface BuildProfileMutationOptions {
  now?: Date | string;
  idFactory?: (kind: "profile" | "target" | "stat-rule", stableKey: string) => string;
}

export interface ImportedGearSearch extends Omit<CreateGearTargetInput, "slot"> {
  slot?: string;
}

export interface ImportGearTargetsResult {
  profile: BuildProfile;
  addedTargetIds: string[];
  updatedTargetIds: string[];
  warnings: string[];
}

export interface GearCandidate<T> {
  id: string;
  value: T;
}

export interface GearTargetMatcherResult {
  matched: boolean;
  score: number;
  reasons?: string[];
  nearMatchReasons?: string[];
}

export type GearTargetMatcher<T> = (
  target: GearTarget,
  candidate: GearCandidate<T>,
) => boolean | GearTargetMatcherResult;

export interface GearCoverageAlternative {
  candidateId: string;
  matched: boolean;
  score: number;
  reasons: string[];
}

export interface GearTargetCoverage {
  targetId: string;
  targetName: string;
  status: "covered" | "near-match" | "missing";
  candidateId?: string;
  score: number;
  reasons: string[];
  alternatives: GearCoverageAlternative[];
}

export interface BuildCoverage {
  profileId: string;
  covered: number;
  nearMatches: number;
  missing: number;
  total: number;
  ratio: number;
  targets: GearTargetCoverage[];
}

export interface ActiveProfileDesirabilityPreferences {
  profileIds: string[];
  targetIds: string[];
  preferredSlots: string[];
  preferredItemClasses: string[];
  preferredTags: string[];
  statRules: GearTargetStatRule[];
  exactMatchBoost: number;
  nearMatchBoost: number;
}

export interface ActiveProfileCandidatePreference {
  bonus: number;
  exactTargetIds: string[];
  nearTargetIds: string[];
  reasons: string[];
}

const DEFAULT_PREFERENCES: BuildProfileDesirabilityPreferences = {
  exactMatchBoost: 20,
  nearMatchBoost: 8,
  preferredSlots: [],
  preferredItemClasses: [],
  preferredTags: [],
};

const AUTOMATION_CONTROL_KEYS = new Set([
  "armautomation",
  "automationarmed",
  "automationenabled",
  "executeautomation",
  "runautomation",
]);

export class BuildProfileValidationError extends Error {
  readonly issues: BuildProfileValidationIssue[];

  constructor(issues: BuildProfileValidationIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
    this.name = "BuildProfileValidationError";
    this.issues = issues;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function utcTimestamp(value: Date | string | undefined): string {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (!Number.isFinite(date.getTime())) throw new Error("A valid timestamp is required");
  return date.toISOString();
}

function normalizedText(value: string | undefined, fallback = ""): string {
  return (value ?? fallback).trim();
}

function uniqueStrings(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].sort(
    (left, right) => left.localeCompare(right),
  );
}

function stableSerialize(value: unknown): string {
  const visit = (current: unknown, seen: Set<object>): unknown => {
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    ) {
      return current;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new Error("Imported queries require finite numbers");
      return current;
    }
    if (Array.isArray(current)) return current.map((entry) => visit(entry, seen));
    if (isRecord(current)) {
      if (seen.has(current)) throw new Error("Imported queries cannot be cyclic");
      seen.add(current);
      const output: Record<string, unknown> = {};
      for (const key of Object.keys(current).sort()) {
        const entry = current[key];
        if (entry === undefined) continue;
        output[key] = visit(entry, seen);
      }
      seen.delete(current);
      return output;
    }
    throw new Error(`Unsupported imported-query value: ${typeof current}`);
  };
  return JSON.stringify(visit(value, new Set()));
}

function hashStableKey(value: string): string {
  let high = 0x811c9dc5;
  let low = 0x01000193;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    high ^= code;
    high = Math.imul(high, 0x01000193);
    low ^= code + index;
    low = Math.imul(low, 0x811c9dc5);
  }
  return `${(high >>> 0).toString(16).padStart(8, "0")}${(low >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}

function defaultIdFactory(kind: "profile" | "target" | "stat-rule", stableKey: string): string {
  return `${kind}_${hashStableKey(`${kind}\0${stableKey}`)}`;
}

function safeUrl(value: string | undefined): string | undefined {
  const text = normalizedText(value);
  if (!text) return undefined;
  const url = new URL(text);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Source URLs must use http or https");
  }
  return url.toString();
}

function normalizePreferences(
  input: Partial<BuildProfileDesirabilityPreferences> | undefined,
): BuildProfileDesirabilityPreferences {
  const exactMatchBoost = input?.exactMatchBoost ?? DEFAULT_PREFERENCES.exactMatchBoost;
  const nearMatchBoost = input?.nearMatchBoost ?? DEFAULT_PREFERENCES.nearMatchBoost;
  if (!Number.isFinite(exactMatchBoost) || exactMatchBoost < 0 || exactMatchBoost > 100) {
    throw new Error("exactMatchBoost must be between 0 and 100");
  }
  if (!Number.isFinite(nearMatchBoost) || nearMatchBoost < 0 || nearMatchBoost > 100) {
    throw new Error("nearMatchBoost must be between 0 and 100");
  }
  return {
    exactMatchBoost,
    nearMatchBoost,
    preferredSlots: uniqueStrings(input?.preferredSlots),
    preferredItemClasses: uniqueStrings(input?.preferredItemClasses),
    preferredTags: uniqueStrings(input?.preferredTags),
  };
}

function normalizeStatRule(
  input: Partial<GearTargetStatRule> & Pick<GearTargetStatRule, "stat">,
  targetKey: string,
  index: number,
  idFactory: NonNullable<BuildProfileMutationOptions["idFactory"]>,
): GearTargetStatRule {
  const stat = normalizedText(input.stat);
  if (!stat) throw new Error("Stat rules require a stat identifier");
  const operator = input.operator ?? "exists";
  if (!["exists", "eq", "gte", "lte", "between", "contains"].includes(operator)) {
    throw new Error(`Unsupported stat operator: ${String(operator)}`);
  }
  const weight = input.weight ?? 1;
  if (!Number.isFinite(weight) || weight < 0 || weight > 100) {
    throw new Error("Stat rule weight must be between 0 and 100");
  }
  if (operator === "between") {
    if (!Number.isFinite(input.min) || !Number.isFinite(input.max) || input.min! > input.max!) {
      throw new Error("Between stat rules require an ordered finite min and max");
    }
  }
  return {
    id:
      normalizedText(input.id) ||
      idFactory("stat-rule", `${targetKey}\0${index}\0${stat}\0${operator}`),
    stat,
    operator,
    ...(input.value !== undefined ? { value: input.value } : {}),
    ...(input.min !== undefined ? { min: input.min } : {}),
    ...(input.max !== undefined ? { max: input.max } : {}),
    required: input.required ?? false,
    weight,
    ...(normalizedText(input.group) ? { group: normalizedText(input.group) } : {}),
  };
}

function deriveSearchKey(input: ImportedGearSearch | CreateGearTargetInput): string {
  const explicit = normalizedText(input.searchKey);
  if (explicit) return explicit;
  if (input.importedQuery !== undefined) return `query:${hashStableKey(stableSerialize(input.importedQuery))}`;
  const sourceUrl = normalizedText(input.sourceUrl);
  if (sourceUrl) return `url:${hashStableKey(sourceUrl)}`;
  const provenanceKey = normalizedText(input.provenance?.sourceKey);
  if (provenanceKey) return `source:${hashStableKey(provenanceKey)}`;
  return `manual:${hashStableKey(
    `${normalizedText(input.slot)}\0${normalizedText(input.itemClass)}\0${normalizedText(input.name)}`,
  )}`;
}

function normalizeTarget(
  input: CreateGearTargetInput,
  profileId: string,
  now: string,
  idFactory: NonNullable<BuildProfileMutationOptions["idFactory"]>,
  existing?: GearTarget,
): GearTarget {
  const searchKey = deriveSearchKey(input);
  const slot = normalizedText(input.slot, existing?.slot ?? "unspecified");
  if (!slot) throw new Error("Gear targets require a slot");
  const statRules = (input.statRules ?? existing?.statRules ?? []).map((rule, index) =>
    normalizeStatRule(rule, `${profileId}\0${searchKey}`, index, idFactory),
  );
  if (statRules.length > MAX_GEAR_TARGET_STAT_RULES) {
    throw new Error(`Gear targets support at most ${MAX_GEAR_TARGET_STAT_RULES} stat rules`);
  }
  const createdAt = existing?.createdAt ?? now;
  const importedQuery =
    input.importedQuery !== undefined ? input.importedQuery : existing?.importedQuery;
  if (importedQuery !== undefined && stableSerialize(importedQuery).length > 262_144) {
    throw new Error("Imported query exceeds the 262144 character cap");
  }
  return {
    id:
      normalizedText(input.id) ||
      existing?.id ||
      idFactory("target", `${profileId}\0${searchKey}`),
    searchKey,
    name: normalizedText(input.name, existing?.name ?? `${slot} target`),
    slot,
    ...(normalizedText(input.itemClass, existing?.itemClass)
      ? { itemClass: normalizedText(input.itemClass, existing?.itemClass) }
      : {}),
    statRules,
    ...(safeUrl(input.sourceUrl ?? existing?.sourceUrl)
      ? { sourceUrl: safeUrl(input.sourceUrl ?? existing?.sourceUrl) }
      : {}),
    ...(normalizedText(input.league, existing?.league)
      ? { league: normalizedText(input.league, existing?.league) }
      : {}),
    tags: uniqueStrings(input.tags ?? existing?.tags),
    ...(importedQuery !== undefined ? { importedQuery } : {}),
    ...(input.provenance ?? existing?.provenance
      ? { provenance: input.provenance ?? existing?.provenance }
      : {}),
    createdAt,
    updatedAt: now,
  };
}

function throwIfAutomationControls(value: object): void {
  const issues = Object.keys(value)
    .filter((key) => AUTOMATION_CONTROL_KEYS.has(key.toLowerCase().replaceAll(/[^a-z]/g, "")))
    .map<BuildProfileValidationIssue>((key) => ({
      path: key,
      code: "automation-control-forbidden",
      message: "Build profiles can express desirability only and cannot arm automation",
    }));
  if (issues.length > 0) throw new BuildProfileValidationError(issues);
}

export function createBuildProfile(
  input: CreateBuildProfileInput,
  options: BuildProfileMutationOptions = {},
): BuildProfile {
  throwIfAutomationControls(input);
  const now = utcTimestamp(options.now);
  const idFactory = options.idFactory ?? defaultIdFactory;
  const name = normalizedText(input.name);
  if (!name) throw new Error("Build profiles require a name");
  const id =
    normalizedText(input.id) ||
    idFactory(
      "profile",
      `${name}\0${normalizedText(input.league)}\0${normalizedText(input.sourceUrl)}`,
    );
  const gearTargets = (input.gearTargets ?? []).map((target) =>
    normalizeTarget(target, id, now, idFactory),
  );
  const profile: BuildProfile = {
    schemaVersion: BUILD_PROFILE_SCHEMA_VERSION,
    id,
    name,
    ...(normalizedText(input.league) ? { league: normalizedText(input.league) } : {}),
    ...(safeUrl(input.sourceUrl) ? { sourceUrl: safeUrl(input.sourceUrl) } : {}),
    tags: uniqueStrings(input.tags),
    active: input.active ?? false,
    preferences: normalizePreferences(input.preferences),
    gearTargets,
    createdAt: now,
    updatedAt: now,
  };
  const validation = validateBuildProfile(profile);
  if (!validation.valid) throw new BuildProfileValidationError(validation.issues);
  return profile;
}

export function updateBuildProfile(
  profile: BuildProfile,
  patch: Partial<Omit<CreateBuildProfileInput, "id">>,
  options: BuildProfileMutationOptions = {},
): BuildProfile {
  throwIfAutomationControls(patch);
  const now = utcTimestamp(options.now);
  const idFactory = options.idFactory ?? defaultIdFactory;
  const gearTargets =
    patch.gearTargets === undefined
      ? profile.gearTargets
      : patch.gearTargets.map((target) => {
          const searchKey = deriveSearchKey(target);
          return normalizeTarget(
            target,
            profile.id,
            now,
            idFactory,
            profile.gearTargets.find((entry) => entry.searchKey === searchKey),
          );
        });
  const next: BuildProfile = {
    ...profile,
    name: normalizedText(patch.name, profile.name),
    ...(patch.league !== undefined
      ? normalizedText(patch.league)
        ? { league: normalizedText(patch.league) }
        : { league: undefined }
      : {}),
    ...(patch.sourceUrl !== undefined
      ? normalizedText(patch.sourceUrl)
        ? { sourceUrl: safeUrl(patch.sourceUrl) }
        : { sourceUrl: undefined }
      : {}),
    tags: patch.tags === undefined ? profile.tags : uniqueStrings(patch.tags),
    active: patch.active ?? profile.active,
    preferences:
      patch.preferences === undefined
        ? profile.preferences
        : normalizePreferences({ ...profile.preferences, ...patch.preferences }),
    gearTargets,
    updatedAt: now,
  };
  const validation = validateBuildProfile(next);
  if (!validation.valid) throw new BuildProfileValidationError(validation.issues);
  return next;
}

export function importGearTargets(
  profile: BuildProfile,
  searches: readonly ImportedGearSearch[],
  options: BuildProfileMutationOptions = {},
): ImportGearTargetsResult {
  const now = utcTimestamp(options.now);
  const idFactory = options.idFactory ?? defaultIdFactory;
  const bySearchKey = new Map(profile.gearTargets.map((target) => [target.searchKey, target]));
  const seenInput = new Set<string>();
  const addedTargetIds: string[] = [];
  const updatedTargetIds: string[] = [];
  const warnings: string[] = [];

  for (const search of searches) {
    const searchKey = deriveSearchKey(search);
    if (seenInput.has(searchKey)) {
      warnings.push(`Duplicate imported search '${searchKey}' was ignored.`);
      continue;
    }
    seenInput.add(searchKey);
    const existing = bySearchKey.get(searchKey);
    const target = normalizeTarget(
      {
        ...search,
        searchKey,
        slot: normalizedText(search.slot, existing?.slot ?? "unspecified"),
      },
      profile.id,
      now,
      idFactory,
      existing,
    );
    bySearchKey.set(searchKey, target);
    (existing ? updatedTargetIds : addedTargetIds).push(target.id);
  }

  const next: BuildProfile = {
    ...profile,
    gearTargets: [...bySearchKey.values()],
    updatedAt: now,
  };
  const validation = validateBuildProfile(next);
  if (!validation.valid) throw new BuildProfileValidationError(validation.issues);
  return { profile: next, addedTargetIds, updatedTargetIds, warnings };
}

export function associateGearTarget(
  profile: BuildProfile,
  targetId: string,
  association: Partial<
    Pick<
      CreateGearTargetInput,
      "name" | "slot" | "itemClass" | "statRules" | "sourceUrl" | "league" | "tags"
    >
  >,
  options: BuildProfileMutationOptions = {},
): BuildProfile {
  const current = profile.gearTargets.find((target) => target.id === targetId);
  if (!current) throw new Error(`Unknown gear target: ${targetId}`);
  const now = utcTimestamp(options.now);
  const idFactory = options.idFactory ?? defaultIdFactory;
  const replacement = normalizeTarget(
    {
      ...current,
      ...association,
      id: current.id,
      searchKey: current.searchKey,
      importedQuery: current.importedQuery,
      provenance: current.provenance,
    },
    profile.id,
    now,
    idFactory,
    current,
  );
  return {
    ...profile,
    gearTargets: profile.gearTargets.map((target) =>
      target.id === targetId ? replacement : target,
    ),
    updatedAt: now,
  };
}

export function activateBuildProfile(
  profiles: readonly BuildProfile[],
  activeProfileId: string | undefined,
  options: BuildProfileMutationOptions = {},
): BuildProfile[] {
  const now = utcTimestamp(options.now);
  if (
    activeProfileId !== undefined &&
    !profiles.some((profile) => profile.id === activeProfileId)
  ) {
    throw new Error(`Unknown build profile: ${activeProfileId}`);
  }
  return profiles.map((profile) => ({
    ...profile,
    active: profile.id === activeProfileId,
    updatedAt:
      profile.active === (profile.id === activeProfileId) ? profile.updatedAt : now,
  }));
}

export function validateBuildProfile(value: unknown): BuildProfileValidation {
  const issues: BuildProfileValidationIssue[] = [];
  const issue = (path: string, code: string, message: string): void => {
    issues.push({ path, code, message });
  };
  if (!isRecord(value)) {
    return {
      valid: false,
      issues: [{ path: "$", code: "type", message: "Build profile must be an object" }],
    };
  }
  for (const key of Object.keys(value)) {
    if (AUTOMATION_CONTROL_KEYS.has(key.toLowerCase().replaceAll(/[^a-z]/g, ""))) {
      issue(
        `$.${key}`,
        "automation-control-forbidden",
        "Build profiles cannot arm automation",
      );
    }
  }
  if (value.schemaVersion !== BUILD_PROFILE_SCHEMA_VERSION) {
    issue("$.schemaVersion", "schema-version", "Unsupported build-profile schema version");
  }
  for (const key of ["id", "name", "createdAt", "updatedAt"] as const) {
    if (typeof value[key] !== "string" || value[key].trim().length === 0) {
      issue(`$.${key}`, "required", `${key} is required`);
    }
  }
  if (!Array.isArray(value.tags)) issue("$.tags", "type", "tags must be an array");
  if (Array.isArray(value.tags) && value.tags.length > MAX_BUILD_PROFILE_TAGS) {
    issue("$.tags", "cap", `At most ${MAX_BUILD_PROFILE_TAGS} tags are allowed`);
  }
  if (typeof value.active !== "boolean") issue("$.active", "type", "active must be boolean");
  if (!isRecord(value.preferences)) {
    issue("$.preferences", "type", "preferences must be an object");
  }
  if (!Array.isArray(value.gearTargets)) {
    issue("$.gearTargets", "type", "gearTargets must be an array");
  } else {
    if (value.gearTargets.length > MAX_BUILD_PROFILE_TARGETS) {
      issue(
        "$.gearTargets",
        "cap",
        `At most ${MAX_BUILD_PROFILE_TARGETS} targets are allowed`,
      );
    }
    const searchKeys = new Set<string>();
    const ids = new Set<string>();
    value.gearTargets.forEach((entry, index) => {
      const path = `$.gearTargets[${index}]`;
      if (!isRecord(entry)) {
        issue(path, "type", "Gear target must be an object");
        return;
      }
      for (const key of ["id", "searchKey", "name", "slot"] as const) {
        if (typeof entry[key] !== "string" || entry[key].trim().length === 0) {
          issue(`${path}.${key}`, "required", `${key} is required`);
        }
      }
      if (typeof entry.id === "string") {
        if (ids.has(entry.id)) issue(`${path}.id`, "duplicate", "Target IDs must be unique");
        ids.add(entry.id);
      }
      if (typeof entry.searchKey === "string") {
        if (searchKeys.has(entry.searchKey)) {
          issue(
            `${path}.searchKey`,
            "duplicate-search",
            "Each imported search may create only one gear target",
          );
        }
        searchKeys.add(entry.searchKey);
      }
      if (!Array.isArray(entry.statRules)) {
        issue(`${path}.statRules`, "type", "statRules must be an array");
      } else if (entry.statRules.length > MAX_GEAR_TARGET_STAT_RULES) {
        issue(
          `${path}.statRules`,
          "cap",
          `At most ${MAX_GEAR_TARGET_STAT_RULES} stat rules are allowed`,
        );
      }
    });
  }
  try {
    if (stableSerialize(value).length > 1_048_576) {
      issue("$", "cap", "Build profile exceeds the 1048576 character cap");
    }
  } catch (error) {
    issue("$", "json", error instanceof Error ? error.message : "Profile is not JSON-safe");
  }
  return { valid: issues.length === 0, issues };
}

function normalizeMatcherResult(
  result: boolean | GearTargetMatcherResult,
): Required<GearTargetMatcherResult> {
  if (typeof result === "boolean") {
    return {
      matched: result,
      score: result ? 1 : 0,
      reasons: [],
      nearMatchReasons: [],
    };
  }
  return {
    matched: result.matched,
    score: clampScore(result.score),
    reasons: result.reasons ?? [],
    nearMatchReasons: result.nearMatchReasons ?? [],
  };
}

export function computeBuildCoverage<T>(
  profile: BuildProfile,
  candidates: readonly GearCandidate<T>[],
  matcher: GearTargetMatcher<T>,
  options: { nearMatchThreshold?: number; maxAlternatives?: number } = {},
): BuildCoverage {
  const nearMatchThreshold = clampScore(options.nearMatchThreshold ?? 0.5);
  const maxAlternatives = Math.max(0, Math.min(20, options.maxAlternatives ?? 3));
  const targets = profile.gearTargets.map<GearTargetCoverage>((target) => {
    const ranked = candidates
      .map((candidate) => ({
        candidate,
        result: normalizeMatcherResult(matcher(target, candidate)),
      }))
      .sort(
        (left, right) =>
          Number(right.result.matched) - Number(left.result.matched) ||
          right.result.score - left.result.score ||
          left.candidate.id.localeCompare(right.candidate.id),
      );
    const best = ranked[0];
    if (!best) {
      return {
        targetId: target.id,
        targetName: target.name,
        status: "missing",
        score: 0,
        reasons: [`No item candidates were available for ${target.name}.`],
        alternatives: [],
      };
    }
    const status = best.result.matched
      ? "covered"
      : best.result.score >= nearMatchThreshold
        ? "near-match"
        : "missing";
    const reasons =
      status === "near-match"
        ? best.result.nearMatchReasons.length > 0
          ? best.result.nearMatchReasons
          : best.result.reasons
        : best.result.reasons;
    return {
      targetId: target.id,
      targetName: target.name,
      status,
      ...(status !== "missing" || best.result.score > 0
        ? { candidateId: best.candidate.id }
        : {}),
      score: best.result.score,
      reasons:
        reasons.length > 0
          ? reasons
          : status === "missing"
            ? [`No candidate met ${target.name}.`]
            : [`${best.candidate.id} ${status === "covered" ? "covers" : "nearly covers"} ${target.name}.`],
      alternatives: ranked.slice(1, maxAlternatives + 1).map((entry) => ({
        candidateId: entry.candidate.id,
        matched: entry.result.matched,
        score: entry.result.score,
        reasons:
          entry.result.nearMatchReasons.length > 0
            ? entry.result.nearMatchReasons
            : entry.result.reasons,
      })),
    };
  });
  const covered = targets.filter((target) => target.status === "covered").length;
  const nearMatches = targets.filter((target) => target.status === "near-match").length;
  const missing = targets.length - covered - nearMatches;
  return {
    profileId: profile.id,
    covered,
    nearMatches,
    missing,
    total: targets.length,
    ratio: targets.length === 0 ? 1 : covered / targets.length,
    targets,
  };
}

export function getActiveProfileDesirabilityPreferences(
  profiles: readonly BuildProfile[],
): ActiveProfileDesirabilityPreferences {
  const active = profiles.filter((profile) => profile.active);
  const targets = active.flatMap((profile) => profile.gearTargets);
  return {
    profileIds: active.map((profile) => profile.id),
    targetIds: targets.map((target) => target.id),
    preferredSlots: uniqueStrings([
      ...active.flatMap((profile) => profile.preferences.preferredSlots),
      ...targets.map((target) => target.slot),
    ]),
    preferredItemClasses: uniqueStrings([
      ...active.flatMap((profile) => profile.preferences.preferredItemClasses),
      ...targets.flatMap((target) => (target.itemClass ? [target.itemClass] : [])),
    ]),
    preferredTags: uniqueStrings([
      ...active.flatMap((profile) => profile.preferences.preferredTags),
      ...active.flatMap((profile) => profile.tags),
      ...targets.flatMap((target) => target.tags),
    ]),
    statRules: targets.flatMap((target) => target.statRules),
    exactMatchBoost: Math.max(0, ...active.map((profile) => profile.preferences.exactMatchBoost)),
    nearMatchBoost: Math.max(0, ...active.map((profile) => profile.preferences.nearMatchBoost)),
  };
}

export function scoreCandidateForActiveProfiles<T>(
  profiles: readonly BuildProfile[],
  candidate: GearCandidate<T>,
  matcher: GearTargetMatcher<T>,
  nearMatchThreshold = 0.5,
): ActiveProfileCandidatePreference {
  const active = profiles.filter((profile) => profile.active);
  const exactTargetIds: string[] = [];
  const nearTargetIds: string[] = [];
  const reasons: string[] = [];
  let bonus = 0;
  for (const profile of active) {
    let profileBonus = 0;
    for (const target of profile.gearTargets) {
      const result = normalizeMatcherResult(matcher(target, candidate));
      if (result.matched) {
        exactTargetIds.push(target.id);
        profileBonus = Math.max(profileBonus, profile.preferences.exactMatchBoost);
        reasons.push(...result.reasons.map((reason) => `${target.name}: ${reason}`));
      } else if (result.score >= clampScore(nearMatchThreshold)) {
        nearTargetIds.push(target.id);
        profileBonus = Math.max(profileBonus, profile.preferences.nearMatchBoost);
        const nearReasons =
          result.nearMatchReasons.length > 0 ? result.nearMatchReasons : result.reasons;
        reasons.push(...nearReasons.map((reason) => `${target.name}: ${reason}`));
      }
    }
    bonus += profileBonus;
  }
  return {
    bonus: Math.min(100, bonus),
    exactTargetIds,
    nearTargetIds,
    reasons: uniqueStrings(reasons),
  };
}
