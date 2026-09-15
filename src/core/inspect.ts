/**
 * Inspect: one copied item text in, one report out.
 *
 * The report is everything the overlay panel and the Item log card show —
 * identity, per-modifier tier/roll/max-tier, the affix budget, weapon DPS,
 * defences, map warnings, wiki links, the local appraisal score and the
 * area context — assembled from modules that each do one thing
 * (`itemAnnotations`, `itemStats`, `inspectTiers`, `inspectMapMods`,
 * `inspectLinks`, `modKnowledge`, `appraisal`).
 *
 * Ctrl+C is truth: nothing here asks the game for anything. The text comes
 * from the clipboard, and every number is an estimate derived from it plus
 * ranges learned from past trade2 listings — never a guaranteed value.
 *
 * Pure: no HTTP, no fs; the only clock is the injectable `now`.
 */

import { appraiseItem } from "./appraisal.js";
import type { AreaCategory } from "./clientLog.js";
import {
  attachAnnotations,
  parseAdvancedItemText,
  type AdvancedItemText,
  type AnnotatedMod,
  type AdvancedRange,
} from "./itemAnnotations.js";
import {
  affixLimitsFor,
  defenceSummary,
  isLowerIsBetter,
  isWeaponClass,
  statusFlags,
  weaponDps,
  type DefenceSummary,
  type WeaponDps,
} from "./itemStats.js";
import { linkTargets, type InspectLink } from "./inspectLinks.js";
import {
  isMapBonusLine,
  mapWarnings,
  type DangerousMapMod,
  type MapModSeverity,
  type MapWarningReport,
} from "./inspectMapMods.js";
import {
  entryForTierNumber,
  maxTierAtLevel,
  nextTierAboveLevel,
  rankForValue,
  rollPercent,
  statIdsForInspect,
  tierLadderFor,
  type TierLadder,
  type TierLadderEntry,
} from "./inspectTiers.js";
import { matchModFamily, modPoints } from "./modKnowledge.js";
import { isAffixMod, looksLikePoeItemText, parseItemText } from "./parseItem.js";
import type { PriceTable } from "./priceTable.js";
import type { StatCatalogue } from "./statIds.js";
import { learnedObservationCount, tierDirection, type LearnedTiers } from "./tierLearning.js";
import type { ItemMod, ItemModKind, ParsedItem } from "./types.js";

export const INSPECT_REPORT_VERSION = 1 as const;

/**
 * The longest text this module will parse. `looksLikePoeItemText` only
 * looks for one `Rarity:` / `Item Class:` line, so any large paste that
 * happens to contain one would otherwise be fully re-parsed — on the main
 * thread, once a second, while the panel follows the clipboard. A copied
 * item is a few hundred bytes; 64 KB is three orders of magnitude of slack.
 */
export const MAX_INSPECT_TEXT_LENGTH = 64_000;

/**
 * The most modifier lines one report will carry. The panel ships over IPC
 * and renders a row each, so a pathological paste must not turn into a
 * multi-megabyte payload. A real item has well under 20.
 */
export const MAX_INSPECT_MODS = 200;

export type AffixSide = "prefix" | "suffix";

export interface InspectTierInfo {
  /** 1 = best. Only set when the ladder direction is known. */
  rank?: number;
  /** As displayed: "T3". */
  label: string;
  /** Ladder length, when known ("T3 of 8"). */
  of?: number;
  source: "annotation" | "learned" | "family";
  /** The mod's required item level, from the learned range. */
  requiredLevel?: number;
  /** Listings behind the learned range. */
  observations?: number;
  /** One short sentence about how much to trust this badge. */
  note?: string;
}

export interface InspectRange {
  min: number;
  max: number;
  source: "advanced-text" | "learned" | "unique-text";
}

export interface InspectMaxTier {
  label: string;
  rank: number;
  requiredLevel?: number;
  /** The current tier already is the best this item level allows. */
  reached: boolean;
  /**
   * The cheapest step up this item level cannot hold yet ("T2 from item
   * level 76"), when the learned ladder knows one.
   */
  next?: { label: string; rank: number; requiredLevel: number };
}

export interface InspectMod {
  /** Position in `report.mods` — status and map-reward lines are filtered out first. */
  index: number;
  /** The copied text's block this line came from (0 = header). */
  block: number;
  text: string;
  kind: ItemModKind | "unique";
  /** Occupies an affix slot (implicit / enchant / rune do not). */
  affix: boolean;
  side?: AffixSide;
  name?: string;
  tags: string[];
  values: number[];
  /** Shared by the lines of one hybrid modifier. */
  groupIndex?: number;
  tier?: InspectTierInfo;
  range?: InspectRange;
  rollPct?: number;
  lowerIsBetter?: boolean;
  maxTier?: InspectMaxTier;
  family?: { id: string; label: string; tier: 0 | 1 | 2 | 3; points: number; source: "learned" | "threshold" };
  statIds: string[];
}

export interface InspectAffixSummary {
  prefixes: number;
  suffixes: number;
  unknownSide: number;
  maxPrefixes: number;
  maxSuffixes: number;
  /** -1 = unknown (an unidentified item). */
  open: number;
  sealedReason?: "corrupted" | "mirrored" | "sanctified";
  countedFrom: "annotations" | "estimate";
}

export interface InspectReport {
  schemaVersion: typeof INSPECT_REPORT_VERSION;
  generatedAt: string;
  fingerprint: string;
  textKind: "plain" | "advanced";
  item: {
    itemClass: string;
    rarity: string;
    name: string;
    baseType: string;
    itemLevel?: number;
    quality?: number;
    identified: boolean;
    corrupted: boolean;
    mirrored: boolean;
    sanctified: boolean;
    sockets?: string;
    requirements: Record<string, number>;
  };
  mods: InspectMod[];
  affixes: InspectAffixSummary;
  weapon?: WeaponDps;
  defences?: DefenceSummary;
  mapWarnings?: MapWarningReport;
  links: InspectLink[];
  appraisal?: { valueScore: number; confidence: number; band: string; evidence: string; craftHint?: string };
  knowledge: {
    learnedTiers: boolean;
    observations: number;
    statCatalogue: boolean;
    catalogueEntries: number;
    tierDirection?: "asc" | "desc";
  };
  context?: {
    areaId: string;
    areaName: string;
    areaCategory: AreaCategory;
    areaLevel: number;
    atlasHint?: string;
  };
  /** Parser caveats, shown behind a disclosure. */
  notes: string[];
}

export interface InspectOptions {
  learnedTiers?: LearnedTiers;
  statIds?: StatCatalogue;
  priceTable?: PriceTable;
  area?: { id: string; name: string; category: AreaCategory; level: number };
  mapModOverrides?: Record<string, MapModSeverity | "ignore">;
  mapModTable?: readonly DangerousMapMod[];
  now?: () => Date;
}

const STATUS_LINE = /^(?:Corrupted|Mirrored|Sanctified)$/i;

function firstNumber(mod: ItemMod): number | undefined {
  const value = mod.values?.find((entry) => Number.isFinite(entry));
  return value ?? (Number.isFinite(mod.value) ? mod.value : undefined);
}

/**
 * How many prefixes and suffixes this base can hold — the shared table,
 * kept behind a named export here because the panel shows the numbers.
 * Tablet and waystone limits are UNVERIFIED (noted in the report).
 */
export { affixLimitsFor };

/**
 * Implicit lines a plain copy does not mark.
 *
 * The game only prints `(implicit)` / `{ … Implicit Modifier … }` in an
 * advanced copy, so a plain one hands the parser an implicit that looks
 * exactly like an explicit — and counting it as an affix makes the SAME
 * item report one open affix fewer depending on how it was copied. What a
 * plain copy does keep is the blank-line block structure: implicits sit in
 * their own block ABOVE the explicit block. So when the affix-bearing lines
 * span more than one block, only the last block is explicit; everything
 * above it is dropped from the estimate.
 */
function explicitBlockOnly(mods: readonly InspectMod[]): readonly InspectMod[] {
  const blocks = [...new Set(mods.map((mod) => mod.block))];
  if (blocks.length < 2) return mods;
  const explicitBlock = Math.max(...blocks);
  return mods.filter((mod) => mod.block === explicitBlock);
}

/**
 * The affix budget. An annotation-bearing copy gives real prefix/suffix
 * counts; a plain copy can only count lines, so the summary says
 * "estimate" and every side badge shows "?". A hybrid two-line modifier is
 * one affix (its lines share `groupIndex`).
 */
export function affixSummary(
  mods: readonly InspectMod[],
  parsed: ParsedItem,
  flags: AdvancedItemText["statusFlags"],
): InspectAffixSummary {
  const limits = affixLimitsFor(parsed.itemClass, parsed.rarity);
  const sealedReason = flags.corrupted
    ? ("corrupted" as const)
    : flags.mirrored
      ? ("mirrored" as const)
      : flags.sanctified
        ? ("sanctified" as const)
        : undefined;

  const affixMods = mods.filter((mod) => mod.affix);
  const annotated = affixMods.some((mod) => mod.side === "prefix" || mod.side === "suffix");
  const counting = annotated ? affixMods : explicitBlockOnly(affixMods);

  const seen = new Set<string>();
  let prefixes = 0;
  let suffixes = 0;
  let unknownSide = 0;
  for (const mod of counting) {
    const key = mod.groupIndex !== undefined ? `g${mod.groupIndex}` : `i${mod.index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (mod.side === "prefix") prefixes += 1;
    else if (mod.side === "suffix") suffixes += 1;
    else unknownSide += 1;
  }

  const countedFrom = annotated ? "annotations" : "estimate";
  const counted = prefixes + suffixes + unknownSide;
  let open: number;
  if (!parsed.identified) open = -1;
  else if (sealedReason) open = 0;
  else if (countedFrom === "annotations") {
    open = Math.max(0, limits.prefixes - prefixes + (limits.suffixes - suffixes) - unknownSide);
  } else {
    open = Math.max(0, limits.prefixes + limits.suffixes - counted);
  }

  return {
    prefixes,
    suffixes,
    unknownSide,
    maxPrefixes: limits.prefixes,
    maxSuffixes: limits.suffixes,
    open,
    ...(sealedReason ? { sealedReason } : {}),
    countedFrom,
  };
}

/**
 * Best effort while the Atlas is open: the client log says which area the
 * character is in, never what UI is on screen, so the hint is phrased as
 * context ("you are in X") and never claims to see the Atlas.
 */
export function atlasHint(
  report: Pick<InspectReport, "mapWarnings">,
  area: InspectOptions["area"],
): string | undefined {
  if (!area) return undefined;
  const category = area.category;
  if (report.mapWarnings?.itemKind === "waystone") {
    // `endgame-town` is The Ziggurat Refuge — the one area where the Atlas
    // is actually opened, so leaving it out made the hint useless.
    if (category === "hideout" || category === "town" || category === "endgame-town") {
      const overall = report.mapWarnings.overall;
      const danger = overall === "none" ? "no rated dangers" : `${overall} modifiers`;
      return `You are in ${area.name} — open the Atlas to place this waystone; ${danger} apply to that map.`;
    }
  }
  if (category === "map") return `Inside ${area.name} (area level ${area.level}).`;
  return undefined;
}

interface TierResolution {
  tier?: InspectTierInfo;
  range?: InspectRange;
  maxTier?: InspectMaxTier;
}

function rangeFromEntry(entry: TierLadderEntry): InspectRange {
  return { min: entry.min, max: entry.max, source: "learned" };
}

function tierFromEntry(
  entry: TierLadderEntry,
  ladder: TierLadder,
  source: InspectTierInfo["source"],
  label: string,
  note?: string,
): InspectTierInfo {
  return {
    rank: entry.rank,
    label,
    of: ladder.entries.length,
    source,
    ...(entry.level !== undefined ? { requiredLevel: entry.level } : {}),
    observations: entry.count,
    ...(note ? { note } : {}),
  };
}

function resolveTier(
  annotationTier: number | undefined,
  ladder: TierLadder | undefined,
  judgedValue: number | undefined,
  familyTier: 0 | 1 | 2 | 3 | undefined,
  itemLevel: number | undefined,
): TierResolution {
  let tier: InspectTierInfo | undefined;
  let range: InspectRange | undefined;

  if (annotationTier !== undefined) {
    const label = `T${annotationTier}`;
    const entry = ladder ? entryForTierNumber(ladder, annotationTier) : undefined;
    if (entry && ladder) {
      tier = tierFromEntry(entry, ladder, "annotation", label);
      range = rangeFromEntry(entry);
    } else {
      tier = {
        label,
        source: "annotation",
        note: "game tier — the learned ladder does not cover this modifier yet",
      };
    }
  } else if (ladder && judgedValue !== undefined) {
    const entry = rankForValue(ladder, judgedValue);
    if (entry) {
      const aboveEveryRange = judgedValue > Math.max(...ladder.entries.map((row) => row.max));
      tier = tierFromEntry(
        entry,
        ladder,
        "learned",
        `T${entry.rank}`,
        aboveEveryRange ? "above every observed range" : undefined,
      );
      range = rangeFromEntry(entry);
    }
  }

  if (!tier && familyTier !== undefined) {
    tier = {
      label: familyTier === 0 ? "low" : `T${familyTier}`,
      source: "family",
      note: "hand thresholds — no learned range for this modifier yet",
    };
  }

  let maxTier: InspectMaxTier | undefined;
  if (ladder && itemLevel !== undefined) {
    const best = maxTierAtLevel(ladder, itemLevel);
    if (best) {
      const next = nextTierAboveLevel(ladder, itemLevel);
      maxTier = {
        label: `T${best.rank}`,
        rank: best.rank,
        ...(best.level !== undefined ? { requiredLevel: best.level } : {}),
        reached: tier?.rank !== undefined && tier.rank <= best.rank,
        ...(next?.level !== undefined
          ? { next: { label: `T${next.rank}`, rank: next.rank, requiredLevel: next.level } }
          : {}),
      };
    }
  }

  return {
    ...(tier ? { tier } : {}),
    ...(range ? { range } : {}),
    ...(maxTier ? { maxTier } : {}),
  };
}

function rangeFromAdvanced(ranges: ReadonlyArray<Omit<AdvancedRange, "line">>): InspectRange | undefined {
  const value = ranges.find((range) => range.kind !== "unique-text");
  if (value) return { min: value.min, max: value.max, source: "advanced-text" };
  const unique = ranges[0];
  if (unique) return { min: unique.min, max: unique.max, source: "unique-text" };
  return undefined;
}

function rollFromRanges(
  ranges: ReadonlyArray<Omit<AdvancedRange, "line">>,
  lowerIsBetter: boolean,
): number | undefined {
  const values = ranges.filter((range) => range.kind !== "unique-text");
  if (values.length === 0) return undefined;
  const percentages = values
    .map((range) => rollPercent(range.value, range.min, range.max, lowerIsBetter))
    .filter((value): value is number => value !== undefined);
  if (percentages.length === 0) return undefined;
  return Math.round(percentages.reduce((sum, value) => sum + value, 0) / percentages.length);
}

function buildMod(
  annotated: AnnotatedMod,
  index: number,
  parsed: ParsedItem,
  options: InspectOptions,
): InspectMod {
  const mod = annotated.mod;
  const annotation = annotated.annotation;
  const text = mod.text;
  const isUnique = /^unique$/i.test(parsed.rarity);
  const parsedKind = mod.kind ?? "explicit";
  const kind: ItemModKind | "unique" =
    annotation?.kind === "unique" || (isUnique && parsedKind === "explicit")
      ? "unique"
      : (annotation?.kind ?? parsedKind);

  const match = matchModFamily(text, {
    itemClass: parsed.itemClass,
    ...(options.learnedTiers ? { learnedTiers: options.learnedTiers } : {}),
    ...(options.statIds ? { statIds: options.statIds } : {}),
  });
  const statIds = statIdsForInspect(options.statIds, text, match?.family.id);
  const ladder = tierLadderFor(options.learnedTiers, statIds, parsed.itemClass);
  const judgedValue = match?.judgedValue ?? firstNumber(mod);
  const lowerIsBetter = isLowerIsBetter(text);

  const resolved = resolveTier(
    annotation?.tier,
    ladder,
    judgedValue,
    match?.tier,
    parsed.itemLevel,
  );
  const advancedRange = rangeFromAdvanced(annotated.ranges);
  const range = advancedRange ?? resolved.range;

  let rollPct = rollFromRanges(annotated.ranges, lowerIsBetter);
  if (rollPct === undefined && range && range.source !== "unique-text" && judgedValue !== undefined) {
    rollPct = rollPercent(judgedValue, range.min, range.max, lowerIsBetter);
  }

  return {
    index,
    // `ItemMod.block` is optional in the shared model; 0 (the header block,
    // which never holds a modifier) stands in for "the parser did not say",
    // and a report where every line says 0 simply discounts nothing.
    block: mod.block ?? 0,
    text,
    kind,
    affix: kind === "unique" ? false : isAffixMod(mod),
    ...(annotation?.side ? { side: annotation.side } : {}),
    ...(annotation?.name ? { name: annotation.name } : {}),
    tags: annotation?.tags ? [...annotation.tags] : [],
    values: [...(mod.values ?? [])],
    ...(annotated.groupIndex !== undefined ? { groupIndex: annotated.groupIndex } : {}),
    ...(resolved.tier ? { tier: resolved.tier } : {}),
    ...(range ? { range } : {}),
    ...(rollPct !== undefined ? { rollPct } : {}),
    ...(lowerIsBetter ? { lowerIsBetter } : {}),
    ...(resolved.maxTier ? { maxTier: resolved.maxTier } : {}),
    ...(match
      ? {
          family: {
            id: match.family.id,
            label: match.family.label,
            tier: match.tier,
            points: Math.round(modPoints(match) * 10) / 10,
            source: match.source,
          },
        }
      : {}),
    statIds,
  };
}

/**
 * The whole report. Undefined when the text is not a copied item (or is far
 * too long to be one — see `MAX_INSPECT_TEXT_LENGTH`), so the hotkey can say
 * "hover an item and press Ctrl+C first" instead of showing an empty panel.
 */
export function inspectItemText(rawText: string, options: InspectOptions = {}): InspectReport | undefined {
  if (!looksLikePoeItemText(rawText)) return undefined;
  if (rawText.length > MAX_INSPECT_TEXT_LENGTH) return undefined;
  const advanced = parseAdvancedItemText(rawText);
  const parsed = parseItemText(advanced.plainText);
  const textKind: InspectReport["textKind"] =
    advanced.hasAnnotations || advanced.hasRanges ? "advanced" : "plain";

  const parsedFlags = statusFlags(parsed);
  const flags = {
    corrupted: parsedFlags.corrupted || advanced.statusFlags.corrupted,
    mirrored: parsedFlags.mirrored || advanced.statusFlags.mirrored,
    sanctified: parsedFlags.sanctified || advanced.statusFlags.sanctified,
    unidentified: parsedFlags.unidentified || advanced.statusFlags.unidentified,
  };

  const warnings = mapWarnings(parsed, {
    ...(options.mapModTable ? { table: options.mapModTable } : {}),
    ...(options.mapModOverrides ? { overrides: options.mapModOverrides } : {}),
  });

  const notes: string[] = [];
  const annotated = attachAnnotations(parsed, advanced).filter((entry) => {
    const text = entry.mod.text.trim();
    if (STATUS_LINE.test(text)) return false;
    if (warnings && isMapBonusLine(text)) return false;
    return true;
  });

  const identified = !flags.unidentified;
  const shown = annotated.slice(0, MAX_INSPECT_MODS);
  if (identified && annotated.length > shown.length) {
    notes.push(
      `Only the first ${MAX_INSPECT_MODS} modifier lines are analysed (${annotated.length} were found).`,
    );
  }
  const mods = identified ? shown.map((entry, index) => buildMod(entry, index, parsed, options)) : [];

  const affixes = affixSummary(mods, parsed, flags);
  // `weaponDps` answers undefined unless the item printed a damage
  // property, so the class check is only a readability aid for the note.
  const weapon = weaponDps(parsed);
  if (weapon && !isWeaponClass(parsed.itemClass)) {
    notes.push("This item is not a weapon class but prints damage — DPS is derived from the properties block.");
  }
  const defences = defenceSummary(parsed);

  if (textKind === "plain") {
    notes.push(
      "Plain copy: hold Alt in game before Ctrl+C to get prefix/suffix, affix names, tiers and roll ranges.",
    );
  }
  if (!identified) notes.push("Unidentified — identify the item to see its modifiers and tiers.");
  if (affixes.countedFrom === "estimate" && identified) {
    notes.push("Affix sides are unknown in a plain copy; the open-affix count is an estimate.");
  }
  if (/tablet|waystone/i.test(parsed.itemClass)) {
    notes.push("Affix limits for tablets and waystones are unverified.");
  }
  if (warnings) {
    notes.push("Map ratings come from a community-maintained table — verify the wording in game.");
  }
  if (flags.mirrored) notes.push("Mirrored — the item can never be modified again.");
  if (flags.sanctified) notes.push("Sanctified — no further modifiers can be added.");

  let appraisal: InspectReport["appraisal"];
  try {
    const scored = appraiseItem(advanced.plainText, {
      parsed,
      ...(options.learnedTiers ? { learnedTiers: options.learnedTiers } : {}),
      ...(options.statIds ? { statIds: options.statIds } : {}),
      ...(options.priceTable ? { priceTable: options.priceTable } : {}),
    });
    appraisal = {
      valueScore: scored.valueScore,
      confidence: scored.confidence,
      band: scored.band,
      evidence: scored.evidence,
      ...(scored.craftHint ? { craftHint: scored.craftHint } : {}),
    };
  } catch {
    notes.push("The local appraisal could not be computed for this item.");
  }

  const direction = options.learnedTiers ? tierDirection(options.learnedTiers) : undefined;
  const report: InspectReport = {
    schemaVersion: INSPECT_REPORT_VERSION,
    generatedAt: (options.now?.() ?? new Date()).toISOString(),
    fingerprint: parsed.fingerprint,
    textKind,
    item: {
      itemClass: parsed.itemClass,
      rarity: parsed.rarity,
      name: parsed.name,
      baseType: parsed.baseType,
      ...(parsed.itemLevel !== undefined ? { itemLevel: parsed.itemLevel } : {}),
      ...(parsed.quality !== undefined ? { quality: parsed.quality } : {}),
      identified,
      corrupted: flags.corrupted,
      mirrored: flags.mirrored,
      sanctified: flags.sanctified,
      ...(parsed.sockets ? { sockets: parsed.sockets } : {}),
      requirements: { ...parsed.requirements },
    },
    mods,
    affixes,
    ...(weapon ? { weapon } : {}),
    ...(defences ? { defences } : {}),
    ...(warnings ? { mapWarnings: warnings } : {}),
    links: linkTargets(parsed),
    ...(appraisal ? { appraisal } : {}),
    knowledge: {
      learnedTiers: Boolean(options.learnedTiers),
      observations: options.learnedTiers ? learnedObservationCount(options.learnedTiers) : 0,
      statCatalogue: Boolean(options.statIds),
      catalogueEntries: options.statIds?.entryCount ?? 0,
      ...(direction ? { tierDirection: direction } : {}),
    },
    notes,
  };

  if (options.area) {
    const hint = atlasHint(report, options.area);
    report.context = {
      areaId: options.area.id,
      areaName: options.area.name,
      areaCategory: options.area.category,
      areaLevel: options.area.level,
      ...(hint ? { atlasHint: hint } : {}),
    };
  }

  return report;
}
