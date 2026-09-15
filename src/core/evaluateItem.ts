/**
 * Evaluate — the item facts the builder and the header need, on top of the
 * generic parser and `itemStats.ts`.
 *
 * This module owns only what is specific to pricing an item: which KIND of
 * query the item wants, the native trade2 "pseudo" totals (total elemental
 * resistance, total life, …), the currency id for a bulk exchange, and the
 * unique names a base type could turn out to be. DPS, defences, flags,
 * required level, sockets, gem level and the affix budget come from
 * `src/core/itemStats.ts` (F4) — never re-implemented here.
 *
 * Pure: no fs, no network, no clock.
 */
import {
  defenceSummary,
  gemLevelOf,
  openAffixCount,
  requiredLevel,
  runeSocketCount,
  statusFlags,
  weaponDps,
} from "./itemStats.js";
import type { PriceTable } from "./priceTable.js";
import { TRADE_CURRENCY_NAMES } from "./tradeListings.js";
import { waystoneTierOf } from "./tradeQuery.js";
import type { ItemMod, ParsedItem } from "./types.js";
import type { EvaluateItemKind, EvaluateItemSummary } from "../shared/evaluate.js";

// ---------------------------------------------------------------------------
// Kind
// ---------------------------------------------------------------------------

/** Item classes that trade as stackable currency (exchange, not search). */
const CURRENCY_CLASS = /currency|omen|essence|catalyst|splinter|fragment|rune|soul core|key|tablet/i;

/**
 * Which default query the item wants. `Item Class:` is the authority (the
 * PoE2 clipboard always prints it); rarity only decides between rare/magic/
 * normal/unique when the class says nothing special.
 *
 * Keys (Vault Keys, Pinnacle Keys) trade as stackables like currency —
 * coverage rows 1.2 "Vault Keys as currency" / "Omen, Pinnacle Keys".
 */
export function itemKindOf(parsed: ParsedItem): EvaluateItemKind {
  const itemClass = (parsed.itemClass ?? "").trim().toLowerCase();
  const rarity = (parsed.rarity ?? "").trim().toLowerCase();
  if (/waystone/.test(itemClass)) return "waystone";
  if (/tablet/.test(itemClass)) return "tablet";
  if (/relic/.test(itemClass)) return "relic";
  if (rarity === "currency" || CURRENCY_CLASS.test(itemClass)) return "currency";
  if (rarity === "gem" || /gem/.test(itemClass)) return "gem";
  if (/flask/.test(itemClass)) return "flask";
  if (/charm/.test(itemClass)) return "charm";
  if (/jewel/.test(itemClass)) return "jewel";
  if (rarity === "unique") return parsed.identified ? "unique" : "unidentified-unique";
  if (rarity === "rare" || rarity === "magic" || rarity === "normal") return rarity;
  return "other";
}

// ---------------------------------------------------------------------------
// Pseudo totals
// ---------------------------------------------------------------------------

export type PseudoStatId =
  | "total_elemental_resistance"
  | "total_resistance"
  | "total_fire_resistance"
  | "total_cold_resistance"
  | "total_lightning_resistance"
  | "total_chaos_resistance"
  | "count_resistances"
  | "total_strength"
  | "total_dexterity"
  | "total_intelligence"
  | "total_all_attributes"
  | "total_life"
  | "total_mana"
  | "total_energy_shield";

export interface PseudoStatDefinition {
  id: PseudoStatId;
  /** Label for the builder row. */
  label: string;
  /** The catalogue text we resolve the trade2 id by (never a guessed id). */
  statText: string;
}

/**
 * The pseudo texts we try to resolve against the fetched `/data/stats`
 * catalogue. A text the catalogue does not carry simply yields no row — the
 * app never invents a `pseudo.*` id. (Kept in code rather than a JSON data
 * file so nothing has to be added to electron-builder's `files:`.)
 */
export const PSEUDO_STATS: readonly PseudoStatDefinition[] = [
  {
    id: "total_elemental_resistance",
    label: "total Elemental Resistance",
    statText: "+#% total Elemental Resistance",
  },
  { id: "total_resistance", label: "total Resistance", statText: "+#% total Resistance" },
  { id: "total_fire_resistance", label: "total Fire Resistance", statText: "+#% total to Fire Resistance" },
  { id: "total_cold_resistance", label: "total Cold Resistance", statText: "+#% total to Cold Resistance" },
  {
    id: "total_lightning_resistance",
    label: "total Lightning Resistance",
    statText: "+#% total to Lightning Resistance",
  },
  {
    id: "total_chaos_resistance",
    label: "total Chaos Resistance",
    statText: "+#% total to Chaos Resistance",
  },
  { id: "count_resistances", label: "resistances", statText: "# total Resistances" },
  { id: "total_strength", label: "total Strength", statText: "+# total to Strength" },
  { id: "total_dexterity", label: "total Dexterity", statText: "+# total to Dexterity" },
  { id: "total_intelligence", label: "total Intelligence", statText: "+# total to Intelligence" },
  { id: "total_all_attributes", label: "total to all Attributes", statText: "+# total to all Attributes" },
  { id: "total_life", label: "total maximum Life", statText: "+# total maximum Life" },
  { id: "total_mana", label: "total maximum Mana", statText: "+# total maximum Mana" },
  {
    id: "total_energy_shield",
    label: "total maximum Energy Shield",
    statText: "+# total maximum Energy Shield",
  },
];

export interface PseudoTotal extends PseudoStatDefinition {
  value: number;
  /** The mod texts that were summed (shown in the row's tooltip). */
  sources: string[];
}

/** Enchants are never the item's own substance; every other line counts. */
function countsForPseudo(mod: ItemMod): boolean {
  if (mod.kind === "enchant") return false;
  return true;
}

function firstNumber(mod: ItemMod): number | undefined {
  if (typeof mod.value === "number" && Number.isFinite(mod.value)) return mod.value;
  const match = /[+-]?\d+(?:\.\d+)?/.exec(mod.text);
  if (!match) return undefined;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : undefined;
}

const ATTRIBUTE_NAMES: Readonly<Record<string, PseudoStatId>> = {
  strength: "total_strength",
  dexterity: "total_dexterity",
  intelligence: "total_intelligence",
};

interface Accumulator {
  values: Map<PseudoStatId, number>;
  sources: Map<PseudoStatId, string[]>;
}

function add(acc: Accumulator, id: PseudoStatId, value: number, source: string): void {
  acc.values.set(id, (acc.values.get(id) ?? 0) + value);
  const list = acc.sources.get(id) ?? [];
  if (!list.includes(source)) list.push(source);
  acc.sources.set(id, list);
}

/**
 * The native pseudo totals for one item, as the trade site computes them:
 * every "+N% to all Elemental Resistances" line counts once per element,
 * "+N to all Attributes" counts for each attribute, and the elemental total
 * is fire + cold + lightning. Sanctum relics are excluded (their static
 * lines are not searchable stats — inventory row 1.4 "Sanctum Relic
 * exclusion").
 */
export function pseudoTotals(parsed: ParsedItem, kind: EvaluateItemKind = itemKindOf(parsed)): PseudoTotal[] {
  if (kind === "relic") return [];
  const acc: Accumulator = { values: new Map(), sources: new Map() };
  for (const mod of parsed.mods) {
    if (!countsForPseudo(mod)) continue;
    const text = mod.text;
    const value = firstNumber(mod);
    if (value === undefined || value === 0) continue;
    let matched: RegExpExecArray | null;
    if ((matched = /to (Fire|Cold|Lightning|Chaos) Resistance/i.exec(text))) {
      const element = matched[1]!.toLowerCase();
      const id =
        element === "fire"
          ? "total_fire_resistance"
          : element === "cold"
            ? "total_cold_resistance"
            : element === "lightning"
              ? "total_lightning_resistance"
              : "total_chaos_resistance";
      add(acc, id, value, text);
      continue;
    }
    if (/to all Elemental Resistances/i.test(text)) {
      add(acc, "total_fire_resistance", value, text);
      add(acc, "total_cold_resistance", value, text);
      add(acc, "total_lightning_resistance", value, text);
      continue;
    }
    if (/to all Attributes/i.test(text)) {
      add(acc, "total_strength", value, text);
      add(acc, "total_dexterity", value, text);
      add(acc, "total_intelligence", value, text);
      add(acc, "total_all_attributes", value, text);
      continue;
    }
    const attributes = /to (Strength|Dexterity|Intelligence)(?: and (Strength|Dexterity|Intelligence))?\b/i.exec(
      text,
    );
    if (attributes) {
      for (const name of [attributes[1], attributes[2]]) {
        if (!name) continue;
        const id = ATTRIBUTE_NAMES[name.toLowerCase()];
        if (id) add(acc, id, value, text);
      }
      continue;
    }
    if (/to maximum Life\b/i.test(text) && !/increased/i.test(text)) {
      add(acc, "total_life", value, text);
      continue;
    }
    if (/to maximum Mana\b/i.test(text) && !/increased/i.test(text)) {
      add(acc, "total_mana", value, text);
      continue;
    }
    if (/to maximum Energy Shield\b/i.test(text) && !/increased/i.test(text)) {
      add(acc, "total_energy_shield", value, text);
      continue;
    }
  }

  const fire = acc.values.get("total_fire_resistance") ?? 0;
  const cold = acc.values.get("total_cold_resistance") ?? 0;
  const lightning = acc.values.get("total_lightning_resistance") ?? 0;
  const chaos = acc.values.get("total_chaos_resistance") ?? 0;
  const elemental = fire + cold + lightning;
  const resistSources = [
    ...(acc.sources.get("total_fire_resistance") ?? []),
    ...(acc.sources.get("total_cold_resistance") ?? []),
    ...(acc.sources.get("total_lightning_resistance") ?? []),
  ];
  if (elemental !== 0) {
    acc.values.set("total_elemental_resistance", elemental);
    acc.sources.set("total_elemental_resistance", [...new Set(resistSources)]);
  }
  if (elemental + chaos !== 0) {
    acc.values.set("total_resistance", elemental + chaos);
    acc.sources.set("total_resistance", [
      ...new Set([...resistSources, ...(acc.sources.get("total_chaos_resistance") ?? [])]),
    ]);
  }
  const count = [fire, cold, lightning, chaos].filter((value) => value !== 0).length;
  if (count > 0) {
    acc.values.set("count_resistances", count);
    acc.sources.set("count_resistances", [
      ...new Set([...resistSources, ...(acc.sources.get("total_chaos_resistance") ?? [])]),
    ]);
  }
  // "+N to all Attributes" only reads as a real all-attribute total when
  // every attribute actually got there (a lone "+7 to Strength" does not).
  const strength = acc.values.get("total_strength") ?? 0;
  const dexterity = acc.values.get("total_dexterity") ?? 0;
  const intelligence = acc.values.get("total_intelligence") ?? 0;
  if (strength > 0 && dexterity > 0 && intelligence > 0) {
    acc.values.set("total_all_attributes", Math.min(strength, dexterity, intelligence));
  } else {
    acc.values.delete("total_all_attributes");
  }

  const out: PseudoTotal[] = [];
  for (const definition of PSEUDO_STATS) {
    const value = acc.values.get(definition.id);
    if (value === undefined || value === 0) continue;
    out.push({ ...definition, value: round2(value), sources: acc.sources.get(definition.id) ?? [] });
  }
  return out;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// ---------------------------------------------------------------------------
// Currency ids and unique variants
// ---------------------------------------------------------------------------

const CURRENCY_IDS_BY_NAME: ReadonlyMap<string, string> = new Map(
  Object.entries(TRADE_CURRENCY_NAMES).map(([id, name]) => [name.toLowerCase(), id]),
);

/**
 * The trade2 exchange id for an in-game currency name ("Exalted Orb" →
 * "exalted"). Stackables outside the known list get no exchange query — the
 * ids live in `/api/trade2/data/static`, and nothing here invents one.
 */
export function tradeCurrencyIdFor(name: string): string | undefined {
  return CURRENCY_IDS_BY_NAME.get(name.trim().toLowerCase());
}

/**
 * The exchange ids `/api/trade2/data/static` carries, keyed by the in-game
 * name it prints ("Vault Key" → "vault-key"). The payload shape is a list of
 * groups of `{ id, text }` entries; anything that does not look like that is
 * skipped rather than guessed at, so a changed payload yields an empty map
 * (and the caller falls back to TRADE_CURRENCY_NAMES) instead of a wrong id.
 */
export function staticCurrencyIds(payload: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const groups = (payload as { result?: unknown } | null)?.result;
  if (!Array.isArray(groups)) return out;
  for (const group of groups) {
    const entries = (group as { entries?: unknown }).entries;
    if (!Array.isArray(entries)) continue;
    for (const raw of entries) {
      if (typeof raw !== "object" || raw === null) continue;
      const entry = raw as { id?: unknown; text?: unknown };
      if (typeof entry.id !== "string" || typeof entry.text !== "string") continue;
      const name = entry.text.trim().toLowerCase();
      if (!name || out.has(name)) continue;
      out.set(name, entry.id);
    }
  }
  return out;
}

/** Unique names the price table knows for this base, most valuable first. */
export function uniqueVariantsFor(baseType: string, table: PriceTable | undefined): string[] {
  const base = baseType.trim().toLowerCase();
  if (!base || !table) return [];
  return table.entries
    .filter(
      (entry) =>
        entry.match.baseType?.trim().toLowerCase() === base &&
        typeof entry.match.name === "string" &&
        entry.match.name.trim().length > 0 &&
        (entry.match.rarity === undefined || entry.match.rarity.toLowerCase() === "unique"),
    )
    .sort((a, b) => b.value - a.value)
    .map((entry) => entry.match.name!.trim())
    .filter((name, index, all) => all.indexOf(name) === index);
}

// ---------------------------------------------------------------------------
// The renderer-safe summary
// ---------------------------------------------------------------------------

function stackCount(parsed: ParsedItem): number | undefined {
  const property = parsed.properties.find((entry) => /^stack size$/i.test(entry.name));
  const count = property?.rolls?.[0]?.value;
  return typeof count === "number" && Number.isFinite(count) && count > 0 ? Math.floor(count) : undefined;
}

/**
 * Everything the panel header, the builder seeds and the estimate need,
 * flattened into one serialisable object. Quality-normalised numbers are
 * estimates (the parser cannot tell a local % modifier from a global one) —
 * the UI labels them "(Q20 est.)".
 */
export function itemSummary(
  parsed: ParsedItem,
  options: { priceTable?: PriceTable } = {},
): EvaluateItemSummary {
  const kind = itemKindOf(parsed);
  const flags = statusFlags(parsed);
  const affixes = openAffixCount(parsed);
  const dps = weaponDps(parsed);
  const defences = defenceSummary(parsed);
  const defenceOf = (name: string): number | undefined =>
    defences?.entries.find((entry) => entry.name === name)?.value;
  // Only below 20 % quality is there a Q20 estimate; a Q20+ item keeps its
  // printed number (never scaled down).
  const defenceQ20 = (name: string): number | undefined =>
    defences?.entries.find((entry) => entry.name === name)?.atQuality20;
  const uniqueVariants =
    kind === "unidentified-unique" ? uniqueVariantsFor(parsed.baseType, options.priceTable) : [];
  const currencyId = kind === "currency" ? tradeCurrencyIdFor(parsed.name) : undefined;
  const level = requiredLevel(parsed);
  const runeSockets = runeSocketCount(parsed);
  const gemLevel = kind === "gem" ? gemLevelOf(parsed) : undefined;
  const stack = stackCount(parsed);
  const waystoneTier = kind === "waystone" ? waystoneTierOf(parsed) : undefined;

  return {
    fingerprint: parsed.fingerprint,
    itemClass: parsed.itemClass,
    rarity: parsed.rarity,
    name: parsed.name,
    baseType: parsed.baseType,
    kind,
    ...(parsed.itemLevel !== undefined ? { itemLevel: parsed.itemLevel } : {}),
    ...(parsed.quality !== undefined ? { quality: parsed.quality } : {}),
    identified: parsed.identified,
    corrupted: flags.corrupted,
    mirrored: flags.mirrored,
    sanctified: flags.sanctified,
    ...(level !== undefined ? { requiredLevel: level } : {}),
    ...(runeSockets !== undefined ? { runeSockets } : {}),
    ...(gemLevel !== undefined ? { gemLevel } : {}),
    ...(stack !== undefined ? { stackCount: stack } : {}),
    ...(waystoneTier !== undefined ? { waystoneTier } : {}),
    ...(dps
      ? {
          dps: {
            pdps: round2(dps.physicalDps),
            edps: round2(dps.elementalDps),
            chaos: round2(dps.chaosDps),
            total: round2(dps.totalDps),
            aps: dps.aps,
            ...(dps.critChance !== undefined ? { crit: dps.critChance } : {}),
            ...(dps.atQuality20
              ? {
                  pdpsQ20: round2(dps.atQuality20.physicalDps),
                  totalQ20: round2(dps.atQuality20.totalDps),
                }
              : {}),
          },
        }
      : {}),
    ...(defences
      ? {
          defences: {
            ...(defenceOf("Armour") !== undefined ? { ar: defenceOf("Armour") } : {}),
            ...(defenceOf("Evasion Rating") !== undefined ? { ev: defenceOf("Evasion Rating") } : {}),
            ...(defenceOf("Energy Shield") !== undefined ? { es: defenceOf("Energy Shield") } : {}),
            ...(defenceOf("Ward") !== undefined ? { ward: defenceOf("Ward") } : {}),
            ...(defences.blockChance !== undefined ? { block: defences.blockChance } : {}),
            ...(defenceQ20("Armour") !== undefined ? { arQ20: defenceQ20("Armour") } : {}),
            ...(defenceQ20("Evasion Rating") !== undefined ? { evQ20: defenceQ20("Evasion Rating") } : {}),
            ...(defenceQ20("Energy Shield") !== undefined ? { esQ20: defenceQ20("Energy Shield") } : {}),
          },
        }
      : {}),
    affixCount: affixes.affixCount,
    maxAffixes: affixes.maxAffixes,
    openAffixes: affixes.open,
    uniqueVariants,
    ...(currencyId ? { currencyId } : {}),
  };
}
