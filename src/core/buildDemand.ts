/**
 * Build demand: which base + modifier COMBINATIONS current builds actually
 * buy, matched against one parsed item.
 *
 * This is the "does anyone want this" layer between the mod-family appraisal
 * (appraisal.ts: per-mod tiers, a generic score) and the decision layer
 * (itemDecision.ts: keep / list / review / discard-eligible). It answers
 * three questions with explanations the UI can show:
 *
 *   1. Which of the item's lines does the knowledge base understand at all?
 *      Every affix is classified as `demand` (a mod family with a tier),
 *      `filler` / `situational` / `local` (recognised, low or context-bound
 *      value), `implicit` (a known base implicit) or `unsupported` (nothing
 *      matched — the item cannot be judged, so it can never be discarded).
 *   2. Which curated demand patterns the item satisfies, with the build
 *      evidence behind each one (sources, dates, strength).
 *   3. For weapons, where the printed DPS sits against the curated tiers,
 *      so local modifiers already folded into the displayed damage are never
 *      counted twice.
 *
 * Demand is NOT a price. Nothing here produces an amount; the decision layer
 * keeps demand, crafting potential, listing evidence and reported sales
 * apart.
 *
 * Pure: no fs, no network, no clock (the caller passes `now`).
 */

import type { ItemAppraisal, ModAppraisal } from "./appraisal.js";
import { DEMAND_KNOWLEDGE } from "../data/demand/buildDemand.js";
import { normalizeItemClass } from "./itemClassFilter.js";
import { defenceSummary, isWeaponClass, weaponDps } from "./itemStats.js";
import { VALUABLE_BASES } from "./lookupScreen.js";
import { MOD_FAMILIES } from "./modKnowledge.js";
import { isAffixMod } from "./parseItem.js";
import type { ItemMod, ParsedItem } from "./types.js";

// ---------------------------------------------------------------------------
// Knowledge shapes (the data module in src/data/demand fills these)
// ---------------------------------------------------------------------------

export type DemandStrength = "chase" | "strong" | "useful";

export type EvidenceKind = "ladder" | "guide" | "first-party" | "community" | "user-correction";

export interface DemandSource {
  id: string;
  url: string;
  site: string;
  kind: EvidenceKind;
  /** The date shown on the page (league/patch context), ISO date. */
  date: string;
  /** When it was read, ISO date. */
  retrievedAt: string;
  strength: "strong" | "medium" | "weak";
  /** Selection bias, staleness, paywall, JS-rendered … */
  note: string;
}

export interface BuildEvidence {
  id: string;
  name: string;
  /** Coverage-matrix row: attack-bow, caster, minion, dot-ailment, … */
  archetype: string;
  ascendancy?: string;
  skill?: string;
  weapons: readonly string[];
  damage: string;
  defence: string;
  /** DemandSource ids. */
  sources: readonly string[];
  /** Ladder share or tier label as the source printed it, when available. */
  share?: string;
  note?: string;
}

export type DemandRequirement =
  | {
      kind: "family";
      /** Mod-family ids (modKnowledge.ts); any one satisfies it. */
      families: readonly string[];
      /** 1 = only top tier, 2 = tier 1-2, 3 = any judged tier. */
      minTier?: 1 | 2 | 3;
      minValue?: number;
      label?: string;
    }
  | {
      kind: "count";
      families: readonly string[];
      minCount: number;
      minTier?: 1 | 2 | 3;
      label?: string;
    }
  | {
      kind: "line";
      /** `#` stands for any number; anchored, case-insensitive. */
      pattern: string;
      minValue?: number;
      label: string;
    }
  | { kind: "dps"; metric: "total" | "physical" | "elemental"; tier: "usable" | "strong"; label?: string }
  | { kind: "defence"; name: "Armour" | "Evasion Rating" | "Energy Shield"; min: number; label?: string }
  | { kind: "itemLevel"; min: number };

export interface DemandPattern {
  id: string;
  label: string;
  strength: DemandStrength;
  /** Ctrl+C `Item Class:` values, matched after normalisation. */
  classes: readonly string[];
  /** Default: rare and magic. */
  rarities?: readonly string[];
  requires: readonly DemandRequirement[];
  /** BuildEvidence ids that want this combination. */
  builds: readonly string[];
  /** One sentence the UI shows; the met requirements are appended. */
  explain: string;
  /** False until the combination was checked against live listings. */
  verified: boolean;
}

export type LineRole = "filler" | "situational" | "local" | "implicit";

export interface KnownLine {
  id: string;
  /** `#` stands for any number; anchored, case-insensitive. */
  pattern: string;
  label: string;
  role: LineRole;
  note?: string;
}

export interface WeaponDpsTier {
  classes: readonly string[];
  /** Printed total DPS at or above which the weapon is usable / clearly good. */
  usable: number;
  strong: number;
  note: string;
  verified: boolean;
}

export interface DemandKnowledge {
  version: string;
  league: string;
  patch: string;
  retrievedAt: string;
  /** After this ISO date the knowledge is treated as stale (confidence drops, discards stop). */
  reviewBy: string;
  sources: readonly DemandSource[];
  builds: readonly BuildEvidence[];
  patterns: readonly DemandPattern[];
  lines: readonly KnownLine[];
  weaponDps: readonly WeaponDpsTier[];
  /** Item classes the patterns and line catalogue were authored for. */
  coveredClasses: readonly string[];
}

// ---------------------------------------------------------------------------
// Assessment shapes
// ---------------------------------------------------------------------------

export type ClassifiedRole = "demand" | LineRole | "unsupported";

export interface ClassifiedLine {
  text: string;
  role: ClassifiedRole;
  /** Occupies an affix slot (implicit, enchant and rune lines do not). */
  affix: boolean;
  familyId?: string;
  familyLabel?: string;
  tier?: 0 | 1 | 2 | 3;
  judgedValue?: number;
  knownId?: string;
  knownLabel?: string;
}

export interface DemandMatch {
  pattern: DemandPattern;
  /** Human-readable proof for each requirement, in requirement order. */
  met: string[];
  builds: BuildEvidence[];
  sources: DemandSource[];
}

export interface PartialMatch {
  pattern: DemandPattern;
  met: string[];
  missing: string[];
}

export interface WeaponReading {
  totalDps: number;
  physicalDps: number;
  elementalDps: number;
  aps: number;
  tier: "strong" | "usable" | "weak" | "unknown";
  usableAt?: number;
  strongAt?: number;
  verified: boolean;
}

export interface DemandAssessment {
  knowledgeVersion: string;
  league: string;
  reviewBy: string;
  expired: boolean;
  itemClass: string;
  covered: boolean;
  lines: ClassifiedLine[];
  /** Affix lines nothing recognised — the item cannot be judged. */
  unsupported: string[];
  /** Implicit lines nothing recognised — reported, never blocking. */
  unsupportedImplicits: string[];
  /**
   * Affix lines a specific kind of build wants (thorns, ailments, block …).
   * "Not in the sampled builds" is not evidence of low value, so these
   * block a discard and ask for review instead.
   */
  situational: string[];
  /** Tier-1 / tier-2 rolls on slot-occupying mods. */
  strongAffixes: number;
  topTierAffixes: number;
  weapon?: WeaponReading;
  valuableBase?: string;
  matches: DemandMatch[];
  best?: DemandMatch;
  /** The closest chase/strong pattern that did NOT match (for review priority). */
  nearest?: PartialMatch;
}

export interface AssessDemandOptions {
  knowledge?: DemandKnowledge;
  now?: Date;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STRENGTH_RANK: Record<DemandStrength, number> = { chase: 3, strong: 2, useful: 1 };

const NUMBER = String.raw`[+-]?\d+(?:\.\d+)?`;

/** `#% increased Light Radius` → anchored, case-insensitive regex. */
export function compileLinePattern(pattern: string): RegExp {
  return new RegExp(`^${pattern.replace(/#/g, NUMBER)}$`, "i");
}

function firstNumber(text: string): number | undefined {
  const match = /-?\d+(?:\.\d+)?/.exec(text);
  if (!match) return undefined;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : undefined;
}

function classKey(itemClass: string): string {
  return normalizeItemClass(itemClass).toLowerCase() || itemClass.trim().toLowerCase();
}

function classListed(itemClass: string, classes: readonly string[]): boolean {
  const wanted = classKey(itemClass);
  return classes.some((entry) => classKey(entry) === wanted);
}

function tierOk(tier: ClassifiedLine["tier"], minTier: 1 | 2 | 3 | undefined): boolean {
  if (tier === undefined || tier === 0) return false;
  return tier <= (minTier ?? 3);
}

function tierLabel(tier: ClassifiedLine["tier"]): string {
  return tier ? `T${tier}` : "low";
}

// ---------------------------------------------------------------------------
// Line classification
// ---------------------------------------------------------------------------

function classifyLine(
  mod: ItemMod,
  appraised: ModAppraisal | undefined,
  known: ReadonlyArray<{ line: KnownLine; regex: RegExp }>,
): ClassifiedLine {
  const affix = isAffixMod(mod);
  if (appraised?.familyId) {
    return {
      text: mod.text,
      role: "demand",
      affix,
      familyId: appraised.familyId,
      ...(appraised.familyLabel ? { familyLabel: appraised.familyLabel } : {}),
      ...(appraised.tier !== undefined ? { tier: appraised.tier } : {}),
      ...(appraised.judgedValue !== undefined ? { judgedValue: appraised.judgedValue } : {}),
    };
  }
  const text = mod.text.replace(/\s+/g, " ").trim();
  for (const entry of known) {
    if (!entry.regex.test(text)) continue;
    return { text: mod.text, role: entry.line.role, affix, knownId: entry.line.id, knownLabel: entry.line.label };
  }
  if (mod.kind === "implicit" || mod.implicit) return { text: mod.text, role: "unsupported", affix: false };
  return { text: mod.text, role: "unsupported", affix };
}

/** Every mod line classified; the appraisal's family matches are reused, never re-derived. */
export function classifyLines(
  parsed: ParsedItem,
  appraisal: Pick<ItemAppraisal, "mods"> | undefined,
  knowledge: DemandKnowledge = DEMAND_KNOWLEDGE,
): ClassifiedLine[] {
  const known = knowledge.lines.map((line) => ({ line, regex: compileLinePattern(line.pattern) }));
  const byText = new Map<string, ModAppraisal>();
  for (const mod of appraisal?.mods ?? []) byText.set(mod.text.replace(/\s+/g, " ").trim(), mod);
  return parsed.mods.map((mod) => classifyLine(mod, byText.get(mod.text.replace(/\s+/g, " ").trim()), known));
}

// ---------------------------------------------------------------------------
// Weapons
// ---------------------------------------------------------------------------

export function readWeapon(parsed: ParsedItem, knowledge: DemandKnowledge = DEMAND_KNOWLEDGE): WeaponReading | undefined {
  if (!isWeaponClass(parsed.itemClass)) return undefined;
  const dps = weaponDps(parsed);
  const tierRow = knowledge.weaponDps.find((row) => classListed(parsed.itemClass, row.classes));
  if (!dps) {
    return { totalDps: 0, physicalDps: 0, elementalDps: 0, aps: 0, tier: "unknown", verified: tierRow?.verified ?? false,
      ...(tierRow ? { usableAt: tierRow.usable, strongAt: tierRow.strong } : {}) };
  }
  const base = { totalDps: dps.totalDps, physicalDps: dps.physicalDps, elementalDps: dps.elementalDps, aps: dps.aps };
  if (!tierRow) return { ...base, tier: "unknown", verified: false };
  const tier: WeaponReading["tier"] =
    dps.totalDps >= tierRow.strong ? "strong" : dps.totalDps >= tierRow.usable ? "usable" : "weak";
  return { ...base, tier, usableAt: tierRow.usable, strongAt: tierRow.strong, verified: tierRow.verified };
}

// ---------------------------------------------------------------------------
// Requirements
// ---------------------------------------------------------------------------

interface RequirementContext {
  parsed: ParsedItem;
  lines: ClassifiedLine[];
  weapon?: WeaponReading;
}

function describeFamilies(families: readonly string[]): string {
  return families.join(" / ");
}

/** The proof string when the requirement holds, else undefined. */
function checkRequirement(requirement: DemandRequirement, context: RequirementContext): string | undefined {
  switch (requirement.kind) {
    case "family": {
      const hits = context.lines.filter(
        (line) =>
          line.role === "demand" &&
          line.familyId !== undefined &&
          requirement.families.includes(line.familyId) &&
          tierOk(line.tier, requirement.minTier) &&
          (requirement.minValue === undefined || (line.judgedValue ?? -Infinity) >= requirement.minValue),
      );
      const best = hits.sort((a, b) => (a.tier ?? 9) - (b.tier ?? 9))[0];
      return best ? `${best.text} (${tierLabel(best.tier)})` : undefined;
    }
    case "count": {
      const seen = new Map<string, ClassifiedLine>();
      for (const line of context.lines) {
        if (!line.affix || line.role !== "demand" || !line.familyId) continue;
        if (!requirement.families.includes(line.familyId) || !tierOk(line.tier, requirement.minTier)) continue;
        if (!seen.has(line.familyId)) seen.set(line.familyId, line);
      }
      if (seen.size < requirement.minCount) return undefined;
      return [...seen.values()].map((line) => `${line.text} (${tierLabel(line.tier)})`).join(", ");
    }
    case "line": {
      const regex = compileLinePattern(requirement.pattern);
      const hit = context.parsed.mods.find((mod) => {
        const text = mod.text.replace(/\s+/g, " ").trim();
        if (!regex.test(text)) return false;
        if (requirement.minValue === undefined) return true;
        const value = firstNumber(text);
        return value !== undefined && value >= requirement.minValue;
      });
      return hit ? `${hit.text} (${requirement.label})` : undefined;
    }
    case "dps": {
      const weapon = context.weapon;
      if (!weapon || weapon.tier === "unknown") return undefined;
      const value =
        requirement.metric === "physical" ? weapon.physicalDps : requirement.metric === "elemental" ? weapon.elementalDps : weapon.totalDps;
      const bar = requirement.tier === "strong" ? weapon.strongAt : weapon.usableAt;
      if (bar === undefined || value < bar) return undefined;
      return `${requirement.metric} DPS ${value} ≥ ${bar} (${requirement.tier}${weapon.verified ? "" : ", unverified threshold"})`;
    }
    case "defence": {
      const summary = defenceSummary(context.parsed);
      const entry = summary?.entries.find((candidate) => candidate.name === requirement.name);
      if (!entry || entry.value < requirement.min) return undefined;
      return `${requirement.name} ${entry.value} ≥ ${requirement.min}`;
    }
    case "itemLevel": {
      const level = context.parsed.itemLevel ?? 0;
      return level >= requirement.min ? `item level ${level} ≥ ${requirement.min}` : undefined;
    }
    default:
      return undefined;
  }
}

function requirementLabel(requirement: DemandRequirement): string {
  switch (requirement.kind) {
    case "family":
      return requirement.label ?? `${describeFamilies(requirement.families)}${requirement.minTier ? ` at T${requirement.minTier}+` : ""}`;
    case "count":
      return requirement.label ?? `${requirement.minCount}+ of ${describeFamilies(requirement.families)}`;
    case "line":
      return requirement.label;
    case "dps":
      return requirement.label ?? `${requirement.tier} ${requirement.metric} DPS`;
    case "defence":
      return requirement.label ?? `${requirement.name} ≥ ${requirement.min}`;
    case "itemLevel":
      return `item level ≥ ${requirement.min}`;
    default:
      return "requirement";
  }
}

// ---------------------------------------------------------------------------
// Assessment
// ---------------------------------------------------------------------------

function patternApplies(pattern: DemandPattern, parsed: ParsedItem): boolean {
  if (!classListed(parsed.itemClass, pattern.classes)) return false;
  const rarity = parsed.rarity.trim().toLowerCase();
  const allowed = (pattern.rarities ?? ["rare", "magic"]).map((entry) => entry.toLowerCase());
  return allowed.includes(rarity);
}

/**
 * Assess one parsed, identified item. `appraisal` is the mod-family scoring
 * already computed for the item (its family ids and tiers are reused so the
 * learned-tier context stays in force).
 */
export function assessDemand(
  parsed: ParsedItem,
  appraisal: Pick<ItemAppraisal, "mods"> | undefined,
  options: AssessDemandOptions = {},
): DemandAssessment {
  const knowledge = options.knowledge ?? DEMAND_KNOWLEDGE;
  const now = options.now ?? new Date();
  const reviewBy = Date.parse(knowledge.reviewBy);
  const expired = Number.isFinite(reviewBy) ? now.getTime() > reviewBy : true;
  const lines = classifyLines(parsed, appraisal, knowledge);
  const weapon = readWeapon(parsed, knowledge);
  const context: RequirementContext = { parsed, lines, ...(weapon ? { weapon } : {}) };

  const matches: DemandMatch[] = [];
  let nearest: PartialMatch | undefined;
  for (const pattern of knowledge.patterns) {
    if (!patternApplies(pattern, parsed)) continue;
    const met: string[] = [];
    const missing: string[] = [];
    for (const requirement of pattern.requires) {
      const proof = checkRequirement(requirement, context);
      if (proof) met.push(proof);
      else missing.push(requirementLabel(requirement));
    }
    if (missing.length === 0) {
      matches.push({
        pattern,
        met,
        builds: pattern.builds
          .map((id) => knowledge.builds.find((build) => build.id === id))
          .filter((build): build is BuildEvidence => build !== undefined),
        sources: sourcesFor(pattern, knowledge),
      });
      continue;
    }
    if (pattern.strength === "useful" || met.length === 0) continue;
    const ratio = met.length / pattern.requires.length;
    const nearestRatio = nearest ? nearest.met.length / nearest.pattern.requires.length : -1;
    if (ratio >= 0.5 && ratio > nearestRatio) nearest = { pattern, met, missing };
  }
  matches.sort(
    (a, b) =>
      STRENGTH_RANK[b.pattern.strength] - STRENGTH_RANK[a.pattern.strength] ||
      b.pattern.requires.length - a.pattern.requires.length ||
      a.pattern.id.localeCompare(b.pattern.id),
  );

  const affixLines = lines.filter((line) => line.affix);
  const haystack = `${parsed.baseType} ${parsed.name}`;
  const valuable = VALUABLE_BASES.map((pattern) => pattern.exec(haystack)?.[0]).find((hit) => hit !== undefined);
  return {
    knowledgeVersion: knowledge.version,
    league: knowledge.league,
    reviewBy: knowledge.reviewBy,
    expired,
    itemClass: parsed.itemClass,
    covered: classListed(parsed.itemClass, knowledge.coveredClasses),
    lines,
    unsupported: affixLines.filter((line) => line.role === "unsupported").map((line) => line.text),
    unsupportedImplicits: lines.filter((line) => !line.affix && line.role === "unsupported").map((line) => line.text),
    situational: affixLines.filter((line) => line.role === "situational").map((line) => line.text),
    strongAffixes: affixLines.filter((line) => line.role === "demand" && (line.tier === 1 || line.tier === 2)).length,
    topTierAffixes: affixLines.filter((line) => line.role === "demand" && line.tier === 1).length,
    ...(weapon ? { weapon } : {}),
    ...(valuable ? { valuableBase: valuable } : {}),
    matches,
    ...(matches[0] ? { best: matches[0] } : {}),
    ...(nearest ? { nearest } : {}),
  };
}

function sourcesFor(pattern: DemandPattern, knowledge: DemandKnowledge): DemandSource[] {
  const ids = new Set<string>();
  for (const buildId of pattern.builds) {
    const build = knowledge.builds.find((entry) => entry.id === buildId);
    for (const source of build?.sources ?? []) ids.add(source);
  }
  return knowledge.sources.filter((source) => ids.has(source.id));
}

/** "chase — Lightning Arrow Deadeye (ladder 2026-09-14, guide 2026-09-10)". */
export function describeMatch(match: DemandMatch): string {
  const builds = match.builds.map((build) => build.name).join(", ") || "curated demand";
  const dates = match.sources
    .map((source) => `${source.kind} ${source.date}`)
    .filter((entry, index, all) => all.indexOf(entry) === index)
    .slice(0, 3)
    .join(", ");
  return `${match.pattern.strength} — ${builds}${dates ? ` (${dates})` : ""}`;
}

/**
 * How much to trust a demand match as a routing signal (0-100). Pattern
 * strength sets the base; weak-only sources and stale knowledge take it
 * down. Never a sale probability.
 */
export function demandConfidence(match: DemandMatch, assessment: Pick<DemandAssessment, "expired">): number {
  let confidence = match.pattern.strength === "chase" ? 72 : match.pattern.strength === "strong" ? 64 : 56;
  const strengths = match.sources.map((source) => source.strength);
  if (strengths.length === 0) confidence -= 12;
  else if (!strengths.includes("strong")) confidence -= strengths.includes("medium") ? 4 : 10;
  if (!match.pattern.verified) confidence -= 3;
  if (assessment.expired) confidence -= 8;
  return Math.max(0, Math.min(90, confidence));
}

/** Knowledge sanity: ids unique, references resolve, patterns compile, dates parse. */
export function validateDemandKnowledge(knowledge: DemandKnowledge = DEMAND_KNOWLEDGE): string[] {
  const issues: string[] = [];
  const unique = (label: string, ids: readonly string[]): void => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) issues.push(`${label}: duplicate id "${id}"`);
      seen.add(id);
    }
  };
  unique("sources", knowledge.sources.map((entry) => entry.id));
  unique("builds", knowledge.builds.map((entry) => entry.id));
  unique("patterns", knowledge.patterns.map((entry) => entry.id));
  unique("lines", knowledge.lines.map((entry) => entry.id));
  const sourceIds = new Set(knowledge.sources.map((entry) => entry.id));
  const buildIds = new Set(knowledge.builds.map((entry) => entry.id));
  for (const build of knowledge.builds) {
    for (const source of build.sources) if (!sourceIds.has(source)) issues.push(`build ${build.id}: unknown source "${source}"`);
  }
  const familyIds = new Set(MOD_FAMILIES.map((family) => family.id));
  for (const pattern of knowledge.patterns) {
    for (const build of pattern.builds) if (!buildIds.has(build)) issues.push(`pattern ${pattern.id}: unknown build "${build}"`);
    if (pattern.requires.length === 0) issues.push(`pattern ${pattern.id}: no requirements`);
    for (const requirement of pattern.requires) {
      if (requirement.kind === "family" || requirement.kind === "count") {
        for (const family of requirement.families) {
          if (!familyIds.has(family)) issues.push(`pattern ${pattern.id}: unknown mod family "${family}"`);
        }
      }
      if (requirement.kind === "line") {
        try {
          compileLinePattern(requirement.pattern);
        } catch (error) {
          issues.push(`pattern ${pattern.id}: bad line pattern (${String(error)})`);
        }
      }
    }
  }
  for (const line of knowledge.lines) {
    try {
      compileLinePattern(line.pattern);
    } catch (error) {
      issues.push(`line ${line.id}: bad pattern (${String(error)})`);
    }
  }
  for (const [label, value] of [["retrievedAt", knowledge.retrievedAt], ["reviewBy", knowledge.reviewBy]] as const) {
    if (!Number.isFinite(Date.parse(value))) issues.push(`${label} is not a date: "${value}"`);
  }
  for (const source of knowledge.sources) {
    if (!/^https:\/\//.test(source.url)) issues.push(`source ${source.id}: url must be https`);
    if (!Number.isFinite(Date.parse(source.date))) issues.push(`source ${source.id}: date "${source.date}"`);
  }
  return issues;
}
