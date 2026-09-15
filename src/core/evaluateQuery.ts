/**
 * Evaluate — the query builder: a parsed item becomes a list of TOGGLEABLE
 * rows (mods, pseudo totals, properties) plus the identity/misc seeds, and
 * that state becomes a typed `TradeQuery` the foundation serialises.
 *
 * Why a state in between: PoE Overlay's value is that the user can see and
 * edit exactly what is being searched. `tradeQueryFromItem` (F4) seeds the
 * identity and misc filters; every stat line is rebuilt here so each one can
 * be ticked, re-bounded, or left out.
 *
 * Pure: no fs, no network, no clock. Nothing in here invents a trade2 stat
 * id — a line the catalogue does not carry is shown DISABLED with a reason.
 */
import type { ModAppraisal } from "./appraisal.js";
import { itemKindOf, itemSummary, pseudoTotals, type PseudoTotal } from "./evaluateItem.js";
import { attachAnnotations, type AdvancedItemText, type ModAnnotation } from "./itemAnnotations.js";
import { isLowerIsBetter } from "./itemStats.js";
import type { PriceTable } from "./priceTable.js";
import { normalizeStatText, statIdsForModText, type StatCatalogue } from "./statIds.js";
import { tierForValue, type LearnedTiers } from "./tierLearning.js";
import {
  EVALUATE_PROFILES,
  tradeQueryFromItem,
  type EvaluateProfile,
  type EvaluateProfileId,
  type TradeQuery,
  type TradeStatFilter,
  type TradeStatGroup,
} from "./tradeQuery.js";
import type { ItemMod, ParsedItem } from "./types.js";
import type {
  EvaluateEquipmentKey,
  EvaluateFilterRow,
  EvaluateItemKind,
  EvaluateItemSummary,
  EvaluateQueryState,
  EvaluateRangeToggle,
  EvaluateSettings,
} from "../shared/evaluate.js";

/** Item kinds whose implicit lines ARE the item's substance. */
const IMPLICIT_ROW_KINDS: ReadonlySet<EvaluateItemKind> = new Set([
  "unique",
  "unidentified-unique",
  "jewel",
  "flask",
  "charm",
  "waystone",
  "tablet",
  "relic",
  "gem",
]);

/** Bare status lines the parser hands back as mods; never query rows. */
const STATUS_LINE = /^(?:mirrored|sanctified|corrupted|unidentified|split|synthesised)$/i;

/** A family wider than this says nothing about the line's own roll. */
const MAX_FAMILY_IDS = 4;

/** Catalogue texts that could carry "N empty affixes"; unverified, so tried in order. */
const EMPTY_AFFIX_TEXTS = ["# empty affix modifiers", "# empty modifiers", "# empty affixes"];

export interface BuildStateInput {
  parsed: ParsedItem;
  /** Precomputed summary; derived from `parsed` when absent. */
  summary?: EvaluateItemSummary;
  /** The advanced (Ctrl+Alt+C) markup, when the copy carried it. */
  advanced?: AdvancedItemText;
  appraisal?: { mods: readonly ModAppraisal[] };
  catalogue?: StatCatalogue;
  learnedTiers?: LearnedTiers;
  settings: EvaluateSettings;
  profile?: EvaluateProfileId;
  priceTable?: PriceTable;
}

/** The foundation's preset with this install's percentages applied. */
export function profileOf(id: EvaluateProfileId, settings: EvaluateSettings): EvaluateProfile {
  const base = EVALUATE_PROFILES[id];
  const override = settings.profiles[id];
  if (!override) return base;
  return {
    id,
    slack: override.slack,
    maxMods: override.maxMods >= 99 ? Number.POSITIVE_INFINITY : override.maxMods,
  };
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The search bounds one row gets under a profile.
 *
 * Higher-is-better with a positive roll asks for `slack` of it (85 % of 72
 * life → 61). A NEGATIVE roll on a higher-is-better stat is already a
 * penalty, so the bound is loosened the other way (−17 at 0.85 → −19) or the
 * search would exclude every item that rolled better than ours. A
 * lower-is-better line bounds `max` instead: a 10 % penalty accepts 12 %.
 * Exact Match (slack 1) pins both ends.
 */
export function boundsFor(
  row: Pick<EvaluateFilterRow, "value" | "lowerIsBetter">,
  slack: number,
  /**
   * "pin" is Exact Match's meaning for a MOD row: this roll, nothing else.
   * Property rows (DPS, armour, crit) are DERIVED decimals — pinning both
   * ends there asks trade2 for one exact fractional number and reliably
   * returns zero listings — so they stay open-ended even at slack 1.
   */
  exact: "pin" | "open" = "pin",
): { min?: number; max?: number } {
  const value = row.value;
  if (!finite(value) || value === 0) return {};
  // Exact Match pins both ends: "this roll, nothing else".
  if (slack >= 1 && exact === "pin") return { min: value, max: value };
  if (row.lowerIsBetter) {
    if (value < 0) return { min: round2(Math.floor(value * (2 - slack))) };
    return { max: round2(Math.ceil(value / slack)) };
  }
  if (value < 0) return { min: round2(Math.floor(value * (2 - slack))) };
  const min = value * slack;
  // trade2 takes decimals, but integers are what the site sends for integral
  // rolls; a fractional roll (APS, crit) keeps two decimals.
  return { min: Number.isInteger(value) ? Math.floor(min) : round2(Math.floor(min * 100) / 100) };
}

function affixOf(mod: ItemMod, annotation: ModAnnotation | undefined): EvaluateFilterRow["affix"] {
  if (annotation?.side) return annotation.side;
  switch (annotation?.kind ?? mod.kind) {
    case "implicit":
      return "implicit";
    case "enchant":
      return "enchant";
    case "rune":
      return "rune";
    case "desecrated":
      return "desecrated";
    case "crafted":
      return "crafted";
    default:
      return mod.implicit ? "implicit" : "unknown";
  }
}

function statIdsFor(
  mod: ItemMod,
  familyId: string | undefined,
  catalogue: StatCatalogue | undefined,
): string[] {
  if (!catalogue) return [];
  const exact = statIdsForModText(catalogue, mod.text);
  if (exact.length > 0) return exact;
  const family = familyId ? (catalogue.byFamily.get(familyId) ?? []) : [];
  return family.length > 0 && family.length <= MAX_FAMILY_IDS ? family : [];
}

function pseudoIdFor(statText: string, catalogue: StatCatalogue | undefined): string[] {
  if (!catalogue) return [];
  return catalogue.byText.get(normalizeStatText(statText)) ?? [];
}

function modRows(input: BuildStateInput, kind: EvaluateItemKind): EvaluateFilterRow[] {
  const { parsed, catalogue, learnedTiers } = input;
  const annotated = input.advanced ? attachAnnotations(parsed, input.advanced) : undefined;
  const annotationFor = (mod: ItemMod): ModAnnotation | undefined =>
    annotated?.find((entry) => entry.mod === mod)?.annotation;
  const appraisalByText = new Map<string, ModAppraisal>();
  for (const mod of input.appraisal?.mods ?? []) {
    if (!appraisalByText.has(mod.text)) appraisalByText.set(mod.text, mod);
  }

  const rows: EvaluateFilterRow[] = [];
  parsed.mods.forEach((mod, index) => {
    if (mod.kind === "rune" || mod.kind === "enchant") return;
    if (STATUS_LINE.test(mod.text.trim())) return;
    const implicit = mod.kind === "implicit" || mod.implicit === true;
    if (implicit && !IMPLICIT_ROW_KINDS.has(kind)) return;
    const annotation = annotationFor(mod);
    const scored = appraisalByText.get(mod.text);
    const familyId = scored?.familyId;
    const statIds = statIdsFor(mod, familyId, catalogue);
    const value = finite(mod.value) ? mod.value : undefined;
    const rowKind: EvaluateFilterRow["kind"] = mod.kind === "fractured" ? "fractured" : "mod";
    const learnedTier =
      annotation?.tier === undefined && learnedTiers && statIds[0] !== undefined && value !== undefined
        ? tierForValue(learnedTiers, statIds[0], value, parsed.itemClass)
        : undefined;
    rows.push({
      key: `mod:${mod.block ?? 0}:${mod.order ?? index}`,
      kind: rowKind,
      label: mod.text,
      statIds,
      ...(familyId ? { familyId } : {}),
      ...(value !== undefined ? { value } : {}),
      lowerIsBetter: isLowerIsBetter(mod.text),
      enabled: false,
      affix: affixOf(mod, annotation),
      ...(annotation?.tier !== undefined
        ? { tier: annotation.tier, tierSource: "copy" as const }
        : learnedTier
          ? { tier: learnedTier, tierSource: "learned" as const }
          : {}),
      ...(annotation?.name ? { modName: annotation.name } : {}),
      ...(scored?.points !== undefined ? { score: scored.points } : {}),
      ...(statIds.length === 0
        ? {
            unsearchableReason: catalogue
              ? "no trade2 stat matches this line"
              : "stat catalogue not loaded — base-type search only",
          }
        : {}),
    });
  });
  return rows;
}

function pseudoRows(
  totals: readonly PseudoTotal[],
  catalogue: StatCatalogue | undefined,
): EvaluateFilterRow[] {
  const rows: EvaluateFilterRow[] = [];
  for (const total of totals) {
    const statIds = pseudoIdFor(total.statText, catalogue);
    // Never a guessed id: an unresolved pseudo simply has no row.
    if (statIds.length === 0) continue;
    rows.push({
      key: `pseudo:${total.id}`,
      kind: "pseudo",
      label: `${total.statText.replace(/#/, String(total.value))} (${total.label})`,
      statIds: [statIds[0]!],
      value: total.value,
      lowerIsBetter: false,
      enabled: false,
      sources: [...total.sources],
    });
  }
  return rows;
}

interface PropertyCandidate {
  key: EvaluateEquipmentKey;
  label: string;
  value: number;
  note?: string;
}

function propertyRows(summary: EvaluateItemSummary): EvaluateFilterRow[] {
  const candidates: PropertyCandidate[] = [];
  const dps = summary.dps;
  if (dps) {
    const q20 = dps.totalQ20 !== undefined;
    if (dps.total > 0) {
      candidates.push({
        key: "dps",
        label: "DPS",
        value: dps.totalQ20 ?? dps.total,
        ...(q20 ? { note: "Q20 est." } : {}),
      });
    }
    if (dps.pdps > 0) {
      candidates.push({
        key: "pdps",
        label: "Physical DPS",
        value: dps.pdpsQ20 ?? dps.pdps,
        ...(dps.pdpsQ20 !== undefined ? { note: "Q20 est." } : {}),
      });
    }
    if (dps.edps > 0) candidates.push({ key: "edps", label: "Elemental DPS", value: dps.edps });
    if (dps.aps > 0) candidates.push({ key: "aps", label: "Attacks per Second", value: dps.aps });
    if (dps.crit !== undefined && dps.crit > 0) {
      candidates.push({ key: "crit", label: "Critical Hit Chance", value: dps.crit });
    }
  }
  const defences = summary.defences;
  if (defences) {
    const entry = (
      key: EvaluateEquipmentKey,
      label: string,
      value: number | undefined,
      q20: number | undefined,
    ): void => {
      if (value === undefined || value <= 0) return;
      candidates.push({
        key,
        label,
        value: q20 ?? value,
        ...(q20 !== undefined ? { note: "Q20 est." } : {}),
      });
    };
    entry("ar", "Armour", defences.ar, defences.arQ20);
    entry("ev", "Evasion Rating", defences.ev, defences.evQ20);
    entry("es", "Energy Shield", defences.es, defences.esQ20);
    entry("ward", "Ward", defences.ward, undefined);
    entry("block", "Block chance", defences.block, undefined);
  }
  return candidates.map((candidate) => ({
    key: `prop:${candidate.key}`,
    kind: "property" as const,
    label: candidate.label,
    statIds: [],
    equipmentKey: candidate.key,
    value: candidate.value,
    lowerIsBetter: false,
    enabled: false,
    ...(candidate.note ? { note: candidate.note } : {}),
  }));
}

function toggle(min: number | undefined, enabled: boolean, max?: number): EvaluateRangeToggle {
  return {
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    enabled,
  };
}

/**
 * The builder's opening state: identity + misc from `tradeQueryFromItem`,
 * every candidate row rebuilt so the user can tick each one, then the
 * profile's selection and bounds applied.
 */
export function initialQueryState(input: BuildStateInput): EvaluateQueryState {
  const { parsed, settings } = input;
  const kind = itemKindOf(parsed);
  const summary = input.summary ?? itemSummary(parsed, { priceTable: input.priceTable });
  const profileId = input.profile ?? settings.defaultProfile;
  const profile = profileOf(profileId, settings);
  const seed = tradeQueryFromItem(parsed, input.appraisal, input.catalogue, profile);

  const rows = [
    ...modRows(input, kind),
    ...(settings.pseudoMods ? pseudoRows(pseudoTotals(parsed, kind), input.catalogue) : []),
    ...propertyRows(summary),
  ];
  // A pseudo total that summed several lines speaks for them: its sources
  // are shown, unticked, tagged "in pseudo" until the user takes one back.
  for (const row of rows) {
    if (row.kind !== "pseudo" || (row.sources?.length ?? 0) < 2) continue;
    for (const source of row.sources ?? []) {
      for (const candidate of rows) {
        if (candidate.kind === "mod" && candidate.label === source && !candidate.consumedBy) {
          candidate.consumedBy = row.key;
        }
      }
    }
  }

  const emptyAffixIds = EMPTY_AFFIX_TEXTS.map((text) => pseudoIdFor(text, input.catalogue)).find(
    (ids) => ids.length > 0,
  );
  const rarity = ((): EvaluateQueryState["rarity"] => {
    const seeded = seed.rarity?.toLowerCase();
    if (
      seeded === "nonunique" ||
      seeded === "unique" ||
      seeded === "rare" ||
      seeded === "magic" ||
      seeded === "normal"
    ) {
      return seeded;
    }
    return "any";
  })();

  const state: EvaluateQueryState = {
    profile: profileId,
    ...(seed.name ? { name: seed.name } : {}),
    ...(seed.type ? { type: seed.type } : {}),
    ...(seed.category ? { category: seed.category } : {}),
    rarity,
    status: settings.defaultStatus,
    indexed: settings.defaultIndexed,
    priceCurrency: settings.defaultCurrency,
    rows,
    ilvl: toggle(seed.misc?.ilvl?.min, seed.misc?.ilvl?.min !== undefined),
    quality: toggle(
      summary.quality,
      (kind === "gem" || kind === "normal") && (summary.quality ?? 0) > 0,
    ),
    gemLevel: toggle(summary.gemLevel, kind === "gem" && summary.gemLevel !== undefined),
    mapTier: toggle(
      summary.waystoneTier,
      kind === "waystone" && summary.waystoneTier !== undefined,
      summary.waystoneTier,
    ),
    runeSockets: toggle(summary.runeSockets, kind === "normal" && (summary.runeSockets ?? 0) > 0),
    emptyRuneSockets: toggle(undefined, false),
    gemSockets: toggle(undefined, false),
    flags: {
      ...(seed.misc?.corrupted !== undefined ? { corrupted: seed.misc.corrupted } : {}),
      ...(kind === "unidentified-unique" ? { identified: false } : {}),
      modifiableOnly: false,
    },
    openAffixes: {
      count: summary.openAffixes,
      enabled: false,
      ...(emptyAffixIds?.[0] ? { statId: emptyAffixIds[0] } : {}),
    },
  };
  return applyProfile(state, profile, settings);
}

/** Pseudo rows that overlap: only the most useful one of each family is ticked. */
const RESISTANCE_PSEUDO_PRIORITY = ["pseudo:total_elemental_resistance", "pseudo:total_resistance"];
const RESISTANCE_PSEUDO_KEYS = [
  ...RESISTANCE_PSEUDO_PRIORITY,
  "pseudo:total_fire_resistance",
  "pseudo:total_cold_resistance",
  "pseudo:total_lightning_resistance",
  "pseudo:total_chaos_resistance",
  "pseudo:count_resistances",
];
const ATTRIBUTE_PSEUDO_PRIORITY = ["pseudo:total_all_attributes"];
const ATTRIBUTE_PSEUDO_KEYS = [
  ...ATTRIBUTE_PSEUDO_PRIORITY,
  "pseudo:total_strength",
  "pseudo:total_dexterity",
  "pseudo:total_intelligence",
];

/**
 * Which pseudo totals a profile ticks. They overlap by construction (total
 * Resistance contains total Elemental Resistance contains total Fire
 * Resistance), so ticking all of them would ask trade2 the same question
 * four times and narrow the result set for nothing: one resistance total,
 * one attribute total, plus any other pseudo that actually summed ≥ 2 lines.
 */
function selectPseudoRows(rows: readonly EvaluateFilterRow[]): EvaluateFilterRow[] {
  const byKey = new Map(rows.map((row) => [row.key, row] as const));
  const summed = (key: string): EvaluateFilterRow | undefined => {
    const row = byKey.get(key);
    return row && (row.sources?.length ?? 0) >= 2 ? row : undefined;
  };
  const picked: EvaluateFilterRow[] = [];
  const resistance = RESISTANCE_PSEUDO_PRIORITY.map(summed).find((row) => row !== undefined);
  if (resistance) picked.push(resistance);
  const attribute = ATTRIBUTE_PSEUDO_PRIORITY.map(summed).find((row) => row !== undefined);
  if (attribute) picked.push(attribute);
  for (const row of rows) {
    if (RESISTANCE_PSEUDO_KEYS.includes(row.key) || ATTRIBUTE_PSEUDO_KEYS.includes(row.key)) continue;
    if ((row.sources?.length ?? 0) >= 2) picked.push(row);
  }
  return picked;
}

function dominantDefenceKey(rows: readonly EvaluateFilterRow[]): string | undefined {
  const defences = rows.filter(
    (row) => row.kind === "property" && ["ar", "ev", "es", "ward"].includes(row.equipmentKey ?? ""),
  );
  if (defences.length === 0) return undefined;
  return [...defences].sort((a, b) => (b.value ?? 0) - (a.value ?? 0))[0]?.key;
}

/**
 * Re-applies a profile's selection and bounds. Identity, misc toggles and
 * flags are the user's; only which rows are ticked and how tightly they are
 * bounded belong to the profile.
 */
export function applyProfile(
  state: EvaluateQueryState,
  profile: EvaluateProfile,
  settings: EvaluateSettings,
): EvaluateQueryState {
  const cleared = state.rows.map((row) => {
    const { min: _min, max: _max, ...rest } = row;
    return { ...rest, enabled: false };
  });
  const searchable = (row: EvaluateFilterRow): boolean =>
    row.kind === "property" ? row.equipmentKey !== undefined : row.statIds.length > 0;
  const enable = (row: EvaluateFilterRow): void => {
    row.enabled = true;
    Object.assign(row, boundsFor(row, profile.slack, row.kind === "property" ? "open" : "pin"));
  };

  const pseudoRowsHere = cleared.filter((row) => row.kind === "pseudo" && searchable(row));
  const modRowsHere = cleared.filter(
    (row) => (row.kind === "mod" || row.kind === "fractured") && searchable(row),
  );
  const properties = cleared.filter((row) => row.kind === "property");

  if (profile.id === "crafting-base") {
    for (const row of modRowsHere) if (row.kind === "fractured") enable(row);
  } else if (profile.id === "exact-match") {
    for (const row of modRowsHere) enable(row);
    for (const row of properties) enable(row);
  } else {
    const enabledPseudoKeys = new Set<string>();
    if (settings.pseudoMods) {
      for (const row of selectPseudoRows(pseudoRowsHere)) {
        enable(row);
        enabledPseudoKeys.add(row.key);
      }
    }
    const budget = profile.maxMods;
    if (budget > 0) {
      const seenFamilies = new Set<string>();
      const ranked = [...modRowsHere]
        .filter((row) => !(row.consumedBy && enabledPseudoKeys.has(row.consumedBy)))
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (b.value ?? 0) - (a.value ?? 0));
      let picked = 0;
      for (const row of ranked) {
        if (picked >= budget) break;
        if (row.familyId && seenFamilies.has(row.familyId)) continue;
        if (row.familyId) seenFamilies.add(row.familyId);
        enable(row);
        picked += 1;
      }
    }
    if (profile.id === "quick-price") {
      const dps = properties.find((row) => row.equipmentKey === "dps");
      if (dps) enable(dps);
      else {
        const defence = dominantDefenceKey(properties);
        const row = properties.find((entry) => entry.key === defence);
        if (row) enable(row);
      }
    }
  }

  const ilvl: EvaluateRangeToggle =
    profile.id === "broad"
      ? { ...state.ilvl, enabled: false }
      : profile.id === "crafting-base"
        ? { ...state.ilvl, enabled: state.ilvl.min !== undefined }
        : state.ilvl;
  const anyFractured = cleared.some((row) => row.kind === "fractured" && row.enabled);
  return {
    ...state,
    profile: profile.id,
    rows: cleared,
    ilvl,
    flags: {
      ...state.flags,
      ...(profile.id === "crafting-base" && anyFractured ? { fractured: true } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// State → TradeQuery
// ---------------------------------------------------------------------------

function rangeOf(row: Pick<EvaluateFilterRow, "min" | "max">): { min?: number; max?: number } {
  return {
    ...(finite(row.min) ? { min: row.min } : {}),
    ...(finite(row.max) ? { max: row.max } : {}),
  };
}

/**
 * The typed query for the current state. Disabled rows are omitted; a row
 * whose line matched several catalogue ids (local vs global) becomes a
 * `count ≥ 1` group so either sibling satisfies it.
 */
export function queryStateToTradeQuery(state: EvaluateQueryState): TradeQuery {
  const andFilters: TradeStatFilter[] = [];
  const groups: TradeStatGroup[] = [];
  const equipment: Partial<Record<EvaluateEquipmentKey, { min?: number; max?: number }>> = {};

  for (const row of state.rows) {
    if (!row.enabled) continue;
    const value = rangeOf(row);
    if (row.kind === "property") {
      if (!row.equipmentKey) continue;
      if (Object.keys(value).length > 0) equipment[row.equipmentKey] = value;
      continue;
    }
    const ids = row.statIds.filter((id) => typeof id === "string" && id.trim().length > 0);
    if (ids.length === 0) continue;
    const filter = (id: string): TradeStatFilter =>
      Object.keys(value).length > 0 ? { id, value } : { id };
    if (ids.length === 1) andFilters.push(filter(ids[0]!));
    else groups.push({ type: "count", filters: ids.map(filter), value: { min: 1 } });
  }

  if (state.openAffixes.enabled && state.openAffixes.statId) {
    andFilters.push({ id: state.openAffixes.statId, value: { min: state.openAffixes.count } });
  }

  const sockets: Array<[EvaluateEquipmentKey, EvaluateRangeToggle]> = [
    ["rune_sockets", state.runeSockets],
    ["empty_rune_sockets", state.emptyRuneSockets],
    ["gem_sockets", state.gemSockets],
  ];
  for (const [key, entry] of sockets) {
    if (!entry.enabled) continue;
    const range = rangeOf(entry);
    if (Object.keys(range).length > 0) equipment[key] = range;
  }

  const misc: NonNullable<TradeQuery["misc"]> = {};
  if (state.ilvl.enabled) misc.ilvl = rangeOf(state.ilvl);
  if (state.quality.enabled) misc.quality = rangeOf(state.quality);
  if (state.gemLevel.enabled) misc.gem_level = rangeOf(state.gemLevel);
  if (state.mapTier.enabled) misc.map_tier = rangeOf(state.mapTier);
  const flags = state.flags;
  if (flags.modifiableOnly) {
    misc.corrupted = false;
    misc.mirrored = false;
    misc.sanctified = false;
  } else {
    if (typeof flags.corrupted === "boolean") misc.corrupted = flags.corrupted;
    if (typeof flags.mirrored === "boolean") misc.mirrored = flags.mirrored;
    if (typeof flags.sanctified === "boolean") misc.sanctified = flags.sanctified;
  }
  if (typeof flags.fractured === "boolean") misc.fractured_item = flags.fractured;
  if (typeof flags.desecrated === "boolean") misc.desecrated_item = flags.desecrated;
  if (typeof flags.identified === "boolean") misc.identified = flags.identified;

  const trade: NonNullable<TradeQuery["trade"]> = {};
  if (state.priceCurrency) trade.price = { option: state.priceCurrency };
  if (state.indexed) trade.indexed = state.indexed;

  const stats: TradeStatGroup[] = [
    ...(andFilters.length > 0 ? [{ type: "and" as const, filters: andFilters }] : []),
    ...groups,
  ];

  return {
    ...(state.name ? { name: state.name } : {}),
    ...(state.type ? { type: state.type } : {}),
    ...(state.category ? { category: state.category } : {}),
    ...(state.rarity !== "any" ? { rarity: state.rarity } : {}),
    status: state.status,
    stats,
    ...(Object.keys(equipment).length > 0 ? { equipment } : {}),
    ...(Object.keys(misc).length > 0 ? { misc } : {}),
    ...(Object.keys(trade).length > 0 ? { trade } : {}),
    sort: { key: "price", direction: "asc" },
  };
}

/**
 * A rough "this will need a session cookie" warning. Anonymous trade2
 * answers 400 for wide queries; the panel shows this BEFORE spending a
 * lookup so the user can untick something instead.
 */
export function complexityHint(query: TradeQuery): string | undefined {
  const filters = query.stats.reduce((sum, group) => sum + group.filters.length, 0);
  const wideGroup = query.stats.find((group) => group.type === "count" && group.filters.length > 4);
  if (filters > 12) {
    return `${filters} stat filters — anonymous trade2 searches often refuse this many. Untick a few, or add a POESESSID in Tools → Settings → Market data.`;
  }
  if (wideGroup) {
    return "One line matched many stat ids — anonymous trade2 may refuse the group. Untick it or add a POESESSID in Tools → Settings → Market data.";
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Sanitizer (main never trusts renderer state)
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * A bound the renderer sent. `undefined`, `null` and "" mean "no bound" —
 * never 0, which is what `Number()` would have made of them and which would
 * silently pin a filter to zero.
 */
function boundFrom(raw: unknown): number | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) ? round2(raw) : undefined;
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? round2(value) : undefined;
}

function toggleFrom(raw: unknown, fallback: EvaluateRangeToggle): EvaluateRangeToggle {
  const source = asRecord(raw);
  const min = boundFrom(source.min);
  const max = boundFrom(source.max);
  return {
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    enabled: typeof source.enabled === "boolean" ? source.enabled : fallback.enabled,
  };
}

function textFrom(raw: unknown, fallback: string | undefined): string | undefined {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim().slice(0, 120);
  return trimmed ? trimmed : undefined;
}

function flagFrom(raw: unknown): boolean | undefined {
  return typeof raw === "boolean" ? raw : undefined;
}

/**
 * Renderer state → trusted state. Only what the user can legitimately change
 * survives: which rows are ticked, their bounds, the identity text, the misc
 * toggles and the search filters. Row LABELS, stat ids and kinds always come
 * from the session's own state, so a compromised renderer cannot search for
 * something the item never had.
 */
export function sanitizeQueryState(raw: unknown, fallback: EvaluateQueryState): EvaluateQueryState {
  const source = asRecord(raw);
  const incomingRows = Array.isArray(source.rows) ? source.rows.map(asRecord) : [];
  const byKey = new Map<string, Record<string, unknown>>();
  for (const row of incomingRows) {
    const key = typeof row.key === "string" ? row.key : undefined;
    if (key && !byKey.has(key)) byKey.set(key, row);
  }
  const rows = fallback.rows.map((row) => {
    const incoming = byKey.get(row.key);
    if (!incoming) return { ...row };
    const searchable = row.kind === "property" ? row.equipmentKey !== undefined : row.statIds.length > 0;
    const min = boundFrom(incoming.min);
    const max = boundFrom(incoming.max);
    // The bounds come from the INCOMING row alone: a user who cleared the Min
    // box means "any roll", so the previous bound must not survive. Label,
    // stat ids and kind still come from the session's own row.
    const { min: _min, max: _max, ...rest } = row;
    return {
      ...rest,
      enabled: searchable && incoming.enabled === true,
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
    };
  });

  const profile = EVALUATE_PROFILES[source.profile as EvaluateProfileId]
    ? (source.profile as EvaluateProfileId)
    : fallback.profile;
  const rarityRaw = typeof source.rarity === "string" ? source.rarity : fallback.rarity;
  const rarity: EvaluateQueryState["rarity"] = (
    ["nonunique", "unique", "rare", "magic", "normal", "any"] as const
  ).includes(rarityRaw as EvaluateQueryState["rarity"])
    ? (rarityRaw as EvaluateQueryState["rarity"])
    : fallback.rarity;
  const status: EvaluateQueryState["status"] = (["online", "onlineleague", "any"] as const).includes(
    source.status as EvaluateQueryState["status"],
  )
    ? (source.status as EvaluateQueryState["status"])
    : fallback.status;
  const indexed: EvaluateQueryState["indexed"] = (
    ["", "1day", "3days", "1week", "2weeks", "1month", "3months"] as const
  ).includes(source.indexed as EvaluateQueryState["indexed"])
    ? (source.indexed as EvaluateQueryState["indexed"])
    : fallback.indexed;
  const priceCurrency: EvaluateQueryState["priceCurrency"] = (
    ["", "exalted", "divine", "chaos"] as const
  ).includes(source.priceCurrency as EvaluateQueryState["priceCurrency"])
    ? (source.priceCurrency as EvaluateQueryState["priceCurrency"])
    : fallback.priceCurrency;

  const flagsRaw = asRecord(source.flags);
  const openAffixesRaw = asRecord(source.openAffixes);
  const name = textFrom(source.name, fallback.name);
  const type = textFrom(source.type, fallback.type);
  const category = textFrom(source.category, fallback.category);
  const uniqueVariant = textFrom(source.uniqueVariant, fallback.uniqueVariant);

  return {
    profile,
    ...(name ? { name } : {}),
    ...(type ? { type } : {}),
    ...(category ? { category } : {}),
    rarity,
    status,
    indexed,
    priceCurrency,
    rows,
    ilvl: toggleFrom(source.ilvl, fallback.ilvl),
    quality: toggleFrom(source.quality, fallback.quality),
    gemLevel: toggleFrom(source.gemLevel, fallback.gemLevel),
    mapTier: toggleFrom(source.mapTier, fallback.mapTier),
    runeSockets: toggleFrom(source.runeSockets, fallback.runeSockets),
    emptyRuneSockets: toggleFrom(source.emptyRuneSockets, fallback.emptyRuneSockets),
    gemSockets: toggleFrom(source.gemSockets, fallback.gemSockets),
    flags: {
      ...(flagFrom(flagsRaw.corrupted) !== undefined ? { corrupted: flagFrom(flagsRaw.corrupted)! } : {}),
      ...(flagFrom(flagsRaw.mirrored) !== undefined ? { mirrored: flagFrom(flagsRaw.mirrored)! } : {}),
      ...(flagFrom(flagsRaw.sanctified) !== undefined ? { sanctified: flagFrom(flagsRaw.sanctified)! } : {}),
      ...(flagFrom(flagsRaw.fractured) !== undefined ? { fractured: flagFrom(flagsRaw.fractured)! } : {}),
      ...(flagFrom(flagsRaw.desecrated) !== undefined ? { desecrated: flagFrom(flagsRaw.desecrated)! } : {}),
      ...(flagFrom(flagsRaw.identified) !== undefined ? { identified: flagFrom(flagsRaw.identified)! } : {}),
      modifiableOnly: flagsRaw.modifiableOnly === true,
    },
    openAffixes: {
      count: boundFrom(openAffixesRaw.count) ?? fallback.openAffixes.count,
      enabled: openAffixesRaw.enabled === true && fallback.openAffixes.statId !== undefined,
      ...(fallback.openAffixes.statId ? { statId: fallback.openAffixes.statId } : {}),
    },
    ...(uniqueVariant ? { uniqueVariant } : {}),
  };
}
