/**
 * Loot filter generator: turns the price table (poe2scout feed + the user's
 * own rows) into a Path of Exile 2 item filter.
 *
 * What a filter can and cannot see decides the shape of the output:
 *   - filters match the BASE TYPE, never a unique's name, so unique prices
 *     are grouped by base and each base is rated at the MOST valuable unique
 *     that drops on it (a "Silk Robe" glows because Temporalis might);
 *   - currency and other stackables ARE their base type, so feed rows match
 *     by exact name;
 *   - a few jewel bases are valuable whatever their mods (lookupScreen's
 *     VALUABLE_BASES) and are always shown at the valuable tier.
 *
 * Safety: the only Hide rules target Normal (and optionally Magic) rarity
 * gear below an item level; currency, waystones, gems and everything the
 * table does not mention fall through to a final default Show. Output is
 * deterministic for a given table + options (sorted names, fixed styles),
 * so it can be golden-tested and diffed.
 */

import { orbCosts } from "./crafting.js";
import { VALUABLE_BASES } from "./lookupScreen.js";
import { isFeedEntry } from "./priceFeed.js";
import type { PriceEntry, PriceTable } from "./priceTable.js";

export type LootFilterTier = "chase" | "valuable" | "pickup";

export interface LootFilterTiers {
  /** Exalted value at or above which a base gets the loudest treatment. */
  chaseAtOrAbove: number;
  valuableAtOrAbove: number;
  /** Below this the table row is not highlighted at all (still shown). */
  pickupAtOrAbove: number;
}

export const DEFAULT_LOOT_FILTER_TIERS: LootFilterTiers = {
  chaseAtOrAbove: 50,
  valuableAtOrAbove: 5,
  pickupAtOrAbove: 1,
};

export const DEFAULT_HIDE_NORMAL_BELOW_ITEM_LEVEL = 65;

/** What the renderer chooses; the main process adds the table and league. */
export interface LootFilterRequest {
  name: string;
  tiers?: Partial<LootFilterTiers>;
  /** Hide Normal-rarity gear below this item level (default 65; 0 = never). */
  hideNormalBelowItemLevel?: number;
  /** Also hide Magic-rarity gear below this item level (off when omitted/0). */
  hideMagicBelowItemLevel?: number;
  /** Catch-all Show for every unique the table does not rate (default true). */
  alwaysShowUniques?: boolean;
}

export interface LootFilterOptions extends LootFilterRequest {
  priceTable: PriceTable;
  /** Exalted per divine, for the header; defaults to the table's rate. */
  divineRate?: number;
  league?: string;
  /** Test seam: fixed generation time for deterministic output. */
  generatedAt?: Date;
}

export interface LootFilterTierSummary {
  uniqueBases: number;
  currency: number;
  bases: number;
}

export interface LootFilterSummary {
  tiers: Record<LootFilterTier, LootFilterTierSummary>;
  /** Distinct base types / names that received an explicit Show block. */
  highlightedBases: number;
  /** Distinct unique base types rated in any tier. */
  uniqueBases: number;
  /** Currency / stackable rows rated in any tier. */
  currencyRows: number;
  /** Table entries a filter cannot express (rarity-only floors, named rares…). */
  skippedEntries: number;
  priceRows: number;
  feedRows: number;
  divineRate: number;
  league?: string;
  generatedAt: string;
  tierThresholds: LootFilterTiers;
}

export interface LootFilterOutput {
  text: string;
  summary: LootFilterSummary;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const TIER_LABEL: Record<LootFilterTier, string> = {
  chase: "Chase",
  valuable: "Valuable",
  pickup: "Pickup",
};

const TIER_STYLE: Record<LootFilterTier, readonly string[]> = {
  chase: [
    "SetFontSize 45",
    "SetTextColor 255 255 255 255",
    "SetBorderColor 255 0 0 255",
    "SetBackgroundColor 120 0 0 255",
    "PlayAlertSound 6 300",
    "PlayEffect Red",
    "MinimapIcon 0 Red Star",
  ],
  valuable: [
    "SetFontSize 40",
    "SetTextColor 255 255 255 255",
    "SetBorderColor 255 200 0 255",
    "SetBackgroundColor 70 50 0 255",
    "PlayAlertSound 1 300",
    "PlayEffect Yellow",
    "MinimapIcon 1 Yellow Diamond",
  ],
  pickup: [
    "SetFontSize 35",
    "SetTextColor 255 255 255 255",
    "SetBorderColor 0 200 255 255",
    "SetBackgroundColor 0 0 0 220",
    "PlayAlertSound 2 200",
    "PlayEffect Cyan Temp",
    "MinimapIcon 2 Cyan Circle",
  ],
};

const UNIQUE_CATCH_ALL_STYLE: readonly string[] = [
  "SetFontSize 36",
  "SetTextColor 175 96 37 255",
  "SetBorderColor 175 96 37 255",
  "SetBackgroundColor 0 0 0 200",
  "PlayAlertSound 3 200",
  "MinimapIcon 2 Brown Circle",
];

/**
 * Item classes the Hide rules must never catch, whatever their rarity or
 * item level (substring Class match, so "Waystone" covers "Waystones").
 */
export const NEVER_HIDE_CLASSES: readonly string[] = [
  "Currency",
  "Waystone",
  "Gem",
  "Jewel",
  "Tablet",
  "Relic",
  "Pinnacle Key",
  "Logbook",
  "Trial",
  "Omen",
  "Soul Core",
  "Rune",
  "Essence",
  "Splinter",
  "Fragment",
];

/**
 * Substring BaseType labels for lookupScreen's VALUABLE_BASES patterns. Kept
 * as plain strings because a filter needs literal text; each label is checked
 * against the patterns at generation time so a removed pattern drops its label.
 */
const VALUABLE_BASE_LABELS: readonly string[] = ["Time-Lost", "Timeless", "Diamond"];

export function valuableBaseLabels(): string[] {
  return VALUABLE_BASE_LABELS.filter((label) =>
    VALUABLE_BASES.some((pattern) => pattern.test(label)),
  );
}

// ---------------------------------------------------------------------------
// Table classification
// ---------------------------------------------------------------------------

type RowKind = "unique-base" | "currency" | "base";

interface RatedRow {
  kind: RowKind;
  /** The BaseType text the filter matches on. */
  base: string;
  value: number;
  /** Extra conditions for plain base rows (rarity / item-level floor). */
  rarity?: string;
  minItemLevel?: number;
}

function ci(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function classify(entry: PriceEntry): RatedRow | undefined {
  const { match } = entry;
  const rarity = ci(match.rarity);
  if (rarity === "unique") {
    if (!match.baseType) return undefined; // name-only unique or the rarity floor
    return { kind: "unique-base", base: match.baseType.trim(), value: entry.value };
  }
  if (match.baseType) {
    return {
      kind: "base",
      base: match.baseType.trim(),
      value: entry.value,
      ...(match.rarity ? { rarity: match.rarity.trim() } : {}),
      ...(match.minItemLevel !== undefined ? { minItemLevel: match.minItemLevel } : {}),
    };
  }
  if (match.name && (rarity === "" || rarity === "currency")) {
    if (match.itemClass && !/currency/i.test(match.itemClass)) return undefined;
    return { kind: "currency", base: match.name.trim(), value: entry.value };
  }
  return undefined;
}

function normalizeTiers(partial: Partial<LootFilterTiers> | undefined): LootFilterTiers {
  const num = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
  const pickup = num(partial?.pickupAtOrAbove, DEFAULT_LOOT_FILTER_TIERS.pickupAtOrAbove);
  const valuable = Math.max(
    pickup,
    num(partial?.valuableAtOrAbove, DEFAULT_LOOT_FILTER_TIERS.valuableAtOrAbove),
  );
  const chase = Math.max(
    valuable,
    num(partial?.chaseAtOrAbove, DEFAULT_LOOT_FILTER_TIERS.chaseAtOrAbove),
  );
  return { chaseAtOrAbove: chase, valuableAtOrAbove: valuable, pickupAtOrAbove: pickup };
}

function tierFor(value: number, tiers: LootFilterTiers): LootFilterTier | undefined {
  if (value >= tiers.chaseAtOrAbove) return "chase";
  if (value >= tiers.valuableAtOrAbove) return "valuable";
  if (value >= tiers.pickupAtOrAbove) return "pickup";
  return undefined;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const TIER_ORDER: readonly LootFilterTier[] = ["chase", "valuable", "pickup"];

function quote(text: string): string {
  return `"${text.replace(/"/g, "").trim()}"`;
}

function byName(left: { base: string }, right: { base: string }): number {
  return left.base.localeCompare(right.base, "en", { sensitivity: "base" }) ||
    left.base.localeCompare(right.base, "en");
}

function formatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, "");
}

function describeRows(rows: readonly RatedRow[]): string {
  const top = [...rows]
    .sort((left, right) => right.value - left.value || byName(left, right))
    .slice(0, 5)
    .map((row) => `${row.base} (${formatValue(row.value)} ex)`);
  const more = rows.length - top.length;
  return `${top.join(", ")}${more > 0 ? `, +${more} more` : ""}`;
}

function block(
  action: "Show" | "Hide",
  conditions: readonly string[],
  styles: readonly string[] = [],
  comment?: string,
): string {
  const lines = comment ? [`# ${comment}`] : [];
  lines.push(action, ...conditions.map((line) => `    ${line}`), ...styles.map((line) => `    ${line}`));
  return lines.join("\n");
}

function thresholdLabel(tier: LootFilterTier, tiers: LootFilterTiers): string {
  const at =
    tier === "chase"
      ? tiers.chaseAtOrAbove
      : tier === "valuable"
        ? tiers.valuableAtOrAbove
        : tiers.pickupAtOrAbove;
  return `≥ ${formatValue(at)} ex`;
}

/**
 * Dedupe rows of one kind to the best value per base. Plain base rows also
 * key on their extra conditions so an "ilvl 82+" row stays separate from a
 * bare one.
 */
function bestPerBase(rows: readonly RatedRow[]): RatedRow[] {
  const best = new Map<string, RatedRow>();
  for (const row of rows) {
    const key = `${row.kind}|${ci(row.base)}|${ci(row.rarity)}|${row.minItemLevel ?? ""}`;
    const existing = best.get(key);
    if (!existing || row.value > existing.value) best.set(key, row);
  }
  return [...best.values()];
}

export function generateLootFilter(options: LootFilterOptions): LootFilterOutput {
  const tiers = normalizeTiers(options.tiers);
  const table = options.priceTable;
  const generatedAt = (options.generatedAt ?? new Date()).toISOString();
  const divineRate = options.divineRate ?? orbCosts(table).divine;
  const hideNormalBelow =
    options.hideNormalBelowItemLevel === undefined
      ? DEFAULT_HIDE_NORMAL_BELOW_ITEM_LEVEL
      : Math.max(0, Math.floor(options.hideNormalBelowItemLevel));
  const hideMagicBelow = Math.max(0, Math.floor(options.hideMagicBelowItemLevel ?? 0));
  const alwaysShowUniques = options.alwaysShowUniques ?? true;
  const name = options.name.trim() || "poe2-companion";

  let skippedEntries = 0;
  const rated: RatedRow[] = [];
  for (const entry of table.entries) {
    const row = classify(entry);
    if (!row) {
      skippedEntries += 1;
      continue;
    }
    rated.push(row);
  }
  const rows = bestPerBase(rated);
  const feedRows = table.entries.filter((entry) => isFeedEntry(entry)).length;

  const summary: LootFilterSummary = {
    tiers: {
      chase: { uniqueBases: 0, currency: 0, bases: 0 },
      valuable: { uniqueBases: 0, currency: 0, bases: 0 },
      pickup: { uniqueBases: 0, currency: 0, bases: 0 },
    },
    highlightedBases: 0,
    uniqueBases: 0,
    currencyRows: 0,
    skippedEntries,
    priceRows: table.entries.length,
    feedRows,
    divineRate,
    ...(options.league ? { league: options.league } : {}),
    generatedAt,
    tierThresholds: tiers,
  };

  const blocks: string[] = [];
  const highlighted = new Set<string>();

  for (const tier of TIER_ORDER) {
    const inTier = rows.filter((row) => tierFor(row.value, tiers) === tier);
    const label = `${TIER_LABEL[tier]} (${thresholdLabel(tier, tiers)})`;

    const uniques = inTier.filter((row) => row.kind === "unique-base").sort(byName);
    if (uniques.length > 0) {
      summary.tiers[tier].uniqueBases = uniques.length;
      summary.uniqueBases += uniques.length;
      for (const row of uniques) highlighted.add(`u:${ci(row.base)}`);
      blocks.push(
        block(
          "Show",
          ["Rarity Unique", `BaseType == ${uniques.map((row) => quote(row.base)).join(" ")}`],
          TIER_STYLE[tier],
          `${label} unique bases, rated at the best unique on each: ${describeRows(uniques)}`,
        ),
      );
    }

    const currency = inTier.filter((row) => row.kind === "currency").sort(byName);
    if (currency.length > 0) {
      summary.tiers[tier].currency = currency.length;
      summary.currencyRows += currency.length;
      for (const row of currency) highlighted.add(`c:${ci(row.base)}`);
      blocks.push(
        block(
          "Show",
          [`BaseType == ${currency.map((row) => quote(row.base)).join(" ")}`],
          TIER_STYLE[tier],
          `${label} currency and stackables, per unit: ${describeRows(currency)}`,
        ),
      );
    }

    // Plain base rows group by their extra conditions (one BaseType line per block).
    const bases = inTier.filter((row) => row.kind === "base");
    const groups = new Map<string, RatedRow[]>();
    for (const row of bases) {
      const key = `${ci(row.rarity)}|${row.minItemLevel ?? ""}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    for (const key of [...groups.keys()].sort()) {
      const group = groups.get(key)!.sort(byName);
      summary.tiers[tier].bases += group.length;
      for (const row of group) highlighted.add(`b:${ci(row.base)}`);
      const sample = group[0]!;
      const conditions = [
        ...(sample.rarity ? [`Rarity ${sample.rarity}`] : []),
        ...(sample.minItemLevel !== undefined ? [`ItemLevel >= ${sample.minItemLevel}`] : []),
        `BaseType == ${group.map((row) => quote(row.base)).join(" ")}`,
      ];
      blocks.push(
        block("Show", conditions, TIER_STYLE[tier], `${label} bases: ${describeRows(group)}`),
      );
    }

    if (tier === "valuable") {
      const labels = valuableBaseLabels();
      if (labels.length > 0) {
        for (const label of labels) highlighted.add(`v:${ci(label)}`);
        blocks.push(
          block(
            "Show",
            [`BaseType ${labels.map(quote).join(" ")}`],
            TIER_STYLE.valuable,
            "Valuable jewel bases — the base is the value whatever the mods say",
          ),
        );
      }
    }
  }

  if (alwaysShowUniques) {
    blocks.push(
      block(
        "Show",
        ["Rarity Unique"],
        UNIQUE_CATCH_ALL_STYLE,
        "Every other unique stays visible",
      ),
    );
  }

  blocks.push(
    block(
      "Show",
      [`Class ${NEVER_HIDE_CLASSES.map(quote).join(" ")}`],
      [],
      "Never hidden, whatever the rarity or item level",
    ),
  );

  if (hideNormalBelow > 0) {
    blocks.push(
      block(
        "Hide",
        ["Rarity Normal", `ItemLevel < ${hideNormalBelow}`],
        [],
        `Normal gear below item level ${hideNormalBelow}`,
      ),
    );
  }
  if (hideMagicBelow > 0) {
    blocks.push(
      block(
        "Hide",
        ["Rarity Magic", `ItemLevel < ${hideMagicBelow}`],
        [],
        `Magic gear below item level ${hideMagicBelow}`,
      ),
    );
  }

  blocks.push(block("Show", [], [], "Everything else stays visible"));

  summary.highlightedBases = highlighted.size;

  const header = [
    `# PoE2 Trade Companion loot filter: ${name}`,
    `# Generated ${generatedAt} · league: ${options.league ?? "unknown (refresh the price feed to stamp it)"}`,
    `# Price table: ${table.entries.length} rows (${feedRows} from the poe2scout feed${table.updatedAt ? `, updated ${table.updatedAt}` : ""}) · ${skippedEntries} rows a filter cannot express`,
    `# Thresholds in exalted: chase ${thresholdLabel("chase", tiers)} · valuable ${thresholdLabel("valuable", tiers)} · pickup ${thresholdLabel("pickup", tiers)} · 1 divine ≈ ${formatValue(divineRate)} ex`,
    "# Every price is a local estimate, never a guaranteed sale. Currency, waystones, gems, jewels and anything",
    "# the table does not mention are never hidden; unique prices are rated per BASE (filters cannot see names).",
  ];

  return {
    text: `${header.join("\n")}\n\n${blocks.join("\n\n")}\n`,
    summary,
  };
}
