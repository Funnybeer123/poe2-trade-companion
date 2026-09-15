/**
 * Item facts computed straight off a parsed Ctrl+C item: weapon DPS,
 * defences, quality normalisation, status flags, the affix budget, the
 * lower-is-better mod list and the map-item kind.
 *
 * Why here: Evaluate (P1), Inspect (P5) and Market (P2) all need the same
 * numbers from the same `ParsedItem`, and each of them computing its own
 * DPS produced three slightly different answers. This module is the one
 * implementation; features import it and never re-derive.
 *
 * Every number the game already prints is used as printed: the properties
 * block is post-quality and post-local-mod, so explicit lines are NEVER
 * re-applied on top of it. The only derived figures are the Q20
 * normalisations, and those are estimates (`exact: false`) because a local
 * "#% increased Physical Damage" mod changes how quality scales.
 *
 * Pure: no HTTP, no fs, no clock.
 */

import { isAffixMod } from "./parseItem.js";
import type { ItemMod, ItemProperty, ParsedItem } from "./types.js";

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** First number in a property's value text ("1,234", "+20%", "5-9" → 5). */
function firstNumber(text: string): number | undefined {
  const match = /[+-]?\d[\d,]*(?:\.\d+)?/.exec(text);
  if (!match) return undefined;
  const value = Number(match[0].replace(/,/g, ""));
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Damage ranges inside a property value: "30-50 (augmented)" → [[30, 50]],
 * "12-24 (augmented), 5-60 (augmented)" → [[12, 24], [5, 60]].
 *
 * The parser's own rolls cannot be used here: it reads "5-60" after a comma
 * as the single number −60 (its hyphen rule only looks at the character
 * before the sign), which is right for mod lines and wrong for damage pairs.
 */
function damagePairs(text: string): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  const rx = /(\d[\d,]*(?:\.\d+)?)\s*[-–]\s*(\d[\d,]*(?:\.\d+)?)/g;
  let match: RegExpExecArray | null;
  while ((match = rx.exec(text)) !== null) {
    const min = Number(match[1]!.replace(/,/g, ""));
    const max = Number(match[2]!.replace(/,/g, ""));
    if (Number.isFinite(min) && Number.isFinite(max)) pairs.push([min, max]);
  }
  return pairs;
}

function propertyNamed(parsed: ParsedItem, name: string): ItemProperty | undefined {
  const wanted = name.trim().toLowerCase();
  return parsed.properties.find((property) => property.name.trim().toLowerCase() === wanted);
}

/** A property's own first number (commas handled), from the rolls or the text. */
function propertyNumber(property: ItemProperty | undefined): number | undefined {
  if (!property) return undefined;
  const roll = property.rolls[0]?.value;
  if (roll !== undefined && Number.isFinite(roll)) return roll;
  return firstNumber(property.value);
}

// ---------------------------------------------------------------------------
// Weapon DPS
// ---------------------------------------------------------------------------

/**
 * The PoE2 weapon item classes as the game prints them. A non-weapon that
 * still carries a damage property (a unique charm, a future base) is priced
 * by `weaponDps` anyway — the class list is only the fast path.
 */
const WEAPON_CLASSES: ReadonlySet<string> = new Set(
  [
    "Bows",
    "Crossbows",
    "Wands",
    "Staves",
    "Quarterstaves",
    "Sceptres",
    "One Hand Maces",
    "Two Hand Maces",
    "Spears",
    "Daggers",
    "Claws",
    "Swords",
    "Axes",
    "Flails",
    "Talismans",
  ].map((entry) => entry.toLowerCase()),
);

const WEAPON_CLASS_WORDS =
  /\b(?:bow|bows|crossbow|crossbows|wand|wands|staff|staves|quarterstaff|quarterstaves|sceptre|sceptres|mace|maces|spear|spears|dagger|daggers|claw|claws|sword|swords|axe|axes|flail|flails)\b/i;

export function isWeaponClass(itemClass: string): boolean {
  const normalized = itemClass.trim().toLowerCase();
  if (!normalized) return false;
  return WEAPON_CLASSES.has(normalized) || WEAPON_CLASS_WORDS.test(normalized);
}

export type DamageKind = "physical" | "fire" | "cold" | "lightning" | "chaos" | "elemental-unknown";

export interface DamageComponent {
  kind: DamageKind;
  min: number;
  max: number;
  average: number;
  dps: number;
}

export interface WeaponDps {
  aps: number;
  critChance?: number;
  reloadTime?: number;
  quality: number;
  components: DamageComponent[];
  physicalDps: number;
  elementalDps: number;
  chaosDps: number;
  totalDps: number;
  /** Physical rescaled from the item's quality to 20 %; never exact. */
  atQuality20?: { physicalDps: number; totalDps: number; exact: false };
  notes: string[];
}

const ELEMENTAL_KINDS: ReadonlySet<DamageKind> = new Set([
  "fire",
  "cold",
  "lightning",
  "elemental-unknown",
]);

function componentOf(kind: DamageKind, min: number, max: number, aps: number): DamageComponent {
  const average = (min + max) / 2;
  return { kind, min, max, average: round1(average), dps: round1(average * aps) };
}

/**
 * `Adds # to # Fire|Cold|Lightning Damage` — attack lines only. The spell
 * form ("… Damage to Spells") never contributes to a weapon's printed
 * Elemental Damage property.
 */
const ADDS_ELEMENT =
  /^Adds\s+(\d[\d,]*(?:\.\d+)?)\s+to\s+(\d[\d,]*(?:\.\d+)?)\s+(Fire|Cold|Lightning)\s+Damage(?:\s+to\s+Attacks)?$/i;

/**
 * Which element each printed `Elemental Damage` pair is: the property does
 * not say, so the pairs are matched against the summed `Adds # to #
 * <Element> Damage` modifiers (any kind — implicit, explicit, rune — since
 * the property already includes all of them). Each element is consumed
 * once; a pair that matches nothing stays `elemental-unknown`.
 *
 * `dps` is per-hit here (APS 1); `weaponDps` rescales by the item's APS.
 */
export function attributeElements(
  pairs: Array<[number, number]>,
  mods: readonly ItemMod[],
): DamageComponent[] | undefined {
  if (pairs.length === 0) return undefined;
  const sums = new Map<DamageKind, { min: number; max: number }>();
  for (const mod of mods) {
    const match = ADDS_ELEMENT.exec(mod.text.trim());
    if (!match) continue;
    const kind = match[3]!.toLowerCase() as DamageKind;
    const min = Number(match[1]!.replace(/,/g, ""));
    const max = Number(match[2]!.replace(/,/g, ""));
    if (!Number.isFinite(min) || !Number.isFinite(max)) continue;
    const current = sums.get(kind) ?? { min: 0, max: 0 };
    sums.set(kind, { min: current.min + min, max: current.max + max });
  }
  const used = new Set<DamageKind>();
  const components: DamageComponent[] = [];
  for (const [min, max] of pairs) {
    let matched: DamageKind | undefined;
    for (const [kind, sum] of sums) {
      if (used.has(kind)) continue;
      if (Math.abs(sum.min - min) <= 0.5 && Math.abs(sum.max - max) <= 0.5) {
        matched = kind;
        break;
      }
    }
    if (matched) used.add(matched);
    components.push(componentOf(matched ?? "elemental-unknown", min, max, 1));
  }
  return components;
}

/**
 * PoE2 prints a weapon's elemental damage either as one combined
 * `Elemental Damage: a-b, c-d` property or — when the weapon carries a
 * single element — as its own line: `Cold Damage: 55-102 (cold)`,
 * `Fire Damage: 79-116 (fire)`, `Lightning Damage: 3-60 (lightning)`
 * (live bag copies, 2026-09-15). The per-element lines already say which
 * element they are, so no modifier matching is needed for them.
 */
const ELEMENT_PROPERTIES: ReadonlyArray<[string, DamageKind]> = [
  ["Fire Damage", "fire"],
  ["Cold Damage", "cold"],
  ["Lightning Damage", "lightning"],
];

/**
 * DPS from the properties block as printed. Undefined when the item prints
 * no damage property at all (armour, jewellery, currency, maps).
 */
export function weaponDps(parsed: ParsedItem): WeaponDps | undefined {
  const physicalPairs = damagePairs(propertyNamed(parsed, "Physical Damage")?.value ?? "");
  const elementalPairs = damagePairs(propertyNamed(parsed, "Elemental Damage")?.value ?? "");
  const chaosPairs = damagePairs(propertyNamed(parsed, "Chaos Damage")?.value ?? "");
  const perElement = ELEMENT_PROPERTIES.flatMap(([name, kind]) =>
    damagePairs(propertyNamed(parsed, name)?.value ?? "").map((pair) => ({ kind, pair })),
  );
  if (
    physicalPairs.length === 0 &&
    elementalPairs.length === 0 &&
    chaosPairs.length === 0 &&
    perElement.length === 0
  ) {
    return undefined;
  }

  const notes: string[] = [];
  const printedAps = propertyNumber(propertyNamed(parsed, "Attacks per Second"));
  const aps = printedAps !== undefined && printedAps > 0 ? printedAps : 1;
  if (printedAps === undefined || printedAps <= 0) {
    notes.push("no Attacks per Second line — per-hit only");
  }

  const components: DamageComponent[] = [];
  let physicalRaw = 0;
  let elementalRaw = 0;
  let chaosRaw = 0;

  for (const [min, max] of physicalPairs) {
    const component = componentOf("physical", min, max, aps);
    components.push(component);
    physicalRaw += ((min + max) / 2) * aps;
  }
  const elementalComponents = attributeElements(elementalPairs, parsed.mods) ?? [];
  for (const component of elementalComponents) {
    const scaled: DamageComponent = { ...component, dps: round1(component.average * aps) };
    components.push(scaled);
    elementalRaw += component.average * aps;
  }
  if (elementalComponents.some((component) => component.kind === "elemental-unknown")) {
    notes.push("an elemental damage pair matched no 'Adds # to # … Damage' modifier");
  }
  for (const { kind, pair: [min, max] } of perElement) {
    const component = componentOf(kind, min, max, aps);
    components.push(component);
    elementalRaw += ((min + max) / 2) * aps;
  }
  for (const [min, max] of chaosPairs) {
    const component = componentOf("chaos", min, max, aps);
    components.push(component);
    chaosRaw += ((min + max) / 2) * aps;
  }

  const physicalDps = round1(physicalRaw);
  const elementalDps = round1(elementalRaw);
  const chaosDps = round1(chaosRaw);
  const totalDps = round1(physicalRaw + elementalRaw + chaosRaw);
  const quality = parsed.quality ?? 0;
  const critChance = propertyNumber(propertyNamed(parsed, "Critical Hit Chance"));
  const reloadTime = propertyNumber(propertyNamed(parsed, "Reload Time"));
  if (reloadTime !== undefined) notes.push("reload time is reported, not folded into DPS");

  let atQuality20: WeaponDps["atQuality20"];
  if (quality < 20) {
    const physicalAt20 = round1((physicalRaw * (100 + 20)) / (100 + quality));
    atQuality20 = {
      physicalDps: physicalAt20,
      totalDps: round1(physicalAt20 + elementalDps + chaosDps),
      exact: false,
    };
    notes.push("Q20 assumes no local % physical modifier — an estimate");
  }

  return {
    aps,
    ...(critChance !== undefined ? { critChance } : {}),
    ...(reloadTime !== undefined ? { reloadTime } : {}),
    quality,
    components,
    physicalDps,
    elementalDps,
    chaosDps,
    totalDps,
    ...(atQuality20 ? { atQuality20 } : {}),
    notes,
  };
}

// ---------------------------------------------------------------------------
// Defences
// ---------------------------------------------------------------------------

export interface DefenceEntry {
  name: "Armour" | "Evasion Rating" | "Energy Shield" | "Ward";
  value: number;
  atQuality20?: number;
}

export interface DefenceSummary {
  quality: number;
  entries: DefenceEntry[];
  blockChance?: number;
  /** Quality normalisation ignores local defence modifiers: never exact. */
  exact: false;
}

const DEFENCE_NAMES = ["Armour", "Evasion Rating", "Energy Shield", "Ward"] as const;

/** `value × (100 + target) / (100 + quality)`, to 1 dp. */
export function normaliseToQuality(value: number, quality: number, target = 20): number {
  const divisor = 100 + quality;
  if (!Number.isFinite(value) || !Number.isFinite(quality) || divisor <= 0) return round1(value);
  return round1((value * (100 + target)) / divisor);
}

/** Undefined when the item prints no defence and no block chance. */
export function defenceSummary(parsed: ParsedItem): DefenceSummary | undefined {
  const quality = parsed.quality ?? 0;
  const entries: DefenceEntry[] = [];
  for (const name of DEFENCE_NAMES) {
    const value = propertyNumber(propertyNamed(parsed, name));
    if (value === undefined) continue;
    entries.push({
      name,
      value,
      ...(quality < 20 ? { atQuality20: normaliseToQuality(value, quality) } : {}),
    });
  }
  const blockChance =
    propertyNumber(propertyNamed(parsed, "Block chance")) ?? propertyNumber(propertyNamed(parsed, "Block"));
  if (entries.length === 0 && blockChance === undefined) return undefined;
  return {
    quality,
    entries,
    ...(blockChance !== undefined ? { blockChance } : {}),
    exact: false,
  };
}

// ---------------------------------------------------------------------------
// Status, requirements, sockets, gem level
// ---------------------------------------------------------------------------

/**
 * `Mirrored` and `Sanctified` parse as explicit mods today (they are bare
 * lines with no colon), so the raw text is the only honest source.
 */
export function statusFlags(parsed: ParsedItem): {
  corrupted: boolean;
  mirrored: boolean;
  sanctified: boolean;
  unidentified: boolean;
} {
  const lines = parsed.rawText.split(/\r?\n/).map((line) => line.trim());
  return {
    corrupted: lines.some((line) => /^Corrupted$/i.test(line)),
    mirrored: lines.some((line) => /^Mirrored$/i.test(line)),
    sanctified: lines.some((line) => /^Sanctified$/i.test(line)),
    unidentified: parsed.identified === false || lines.some((line) => /^Unidentified\b/i.test(line)),
  };
}

/** The Requirements block's `Level:` line, else a `Requires Level N` line. */
export function requiredLevel(parsed: ParsedItem): number | undefined {
  for (const [key, value] of Object.entries(parsed.requirements)) {
    if (key.trim().toLowerCase() === "level" && Number.isFinite(value)) return value;
  }
  const match = /^\s*Requires\s+Level\s+(\d+)/im.exec(parsed.rawText);
  return match ? Number(match[1]) : undefined;
}

/** `Sockets: S S` → 2. Undefined when the item prints no sockets line. */
export function runeSocketCount(parsed: ParsedItem): number | undefined {
  const sockets = parsed.sockets?.trim();
  if (!sockets) return undefined;
  return sockets.split(/\s+/).filter((token) => /^S$/i.test(token)).length;
}

/** Skill/support gems print `Level: N` (sometimes `N (Max)`) as a property. */
export function gemLevelOf(parsed: ParsedItem): number | undefined {
  if (!/gem/i.test(parsed.rarity) && !/gem/i.test(parsed.itemClass)) return undefined;
  for (const section of parsed.sections) {
    if (section.kind === "requirements") continue;
    for (const property of section.properties) {
      if (property.name.trim().toLowerCase() !== "level") continue;
      const value = propertyNumber(property);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Affix budget
// ---------------------------------------------------------------------------

/**
 * How many prefixes and suffixes the base can hold. Rarity wins over the
 * class: magic is 1/1, normal and unique have no rollable affix budget at
 * all (a unique's mods are fixed).
 */
export function affixLimitsFor(itemClass: string, rarity: string): { prefixes: number; suffixes: number } {
  const kind = rarity.trim().toLowerCase();
  if (kind === "magic") return { prefixes: 1, suffixes: 1 };
  if (kind === "normal" || kind === "unique") return { prefixes: 0, suffixes: 0 };
  const cls = itemClass.trim();
  if (/jewel/i.test(cls)) return { prefixes: 2, suffixes: 2 };
  if (/tablet/i.test(cls)) return { prefixes: 2, suffixes: 2 };
  if (/flask|charm/i.test(cls)) return { prefixes: 1, suffixes: 1 };
  return { prefixes: 3, suffixes: 3 };
}

/**
 * Affix lines versus the budget. Duplicate modifier texts each count (two
 * `+#% to Fire Resistance` lines are two suffixes); implicits, enchants and
 * socketed rune effects never do (`isAffixMod`). A corrupted, mirrored or
 * sanctified item can take no more affixes whatever the count says.
 */
export function openAffixCount(parsed: ParsedItem): {
  affixCount: number;
  maxAffixes: number;
  open: number;
  sealedReason?: "corrupted" | "mirrored" | "sanctified";
} {
  const limits = affixLimitsFor(parsed.itemClass, parsed.rarity);
  const maxAffixes = limits.prefixes + limits.suffixes;
  const affixCount = parsed.mods.filter((mod) => isAffixMod(mod)).length;
  const flags = statusFlags(parsed);
  const sealedReason = flags.corrupted
    ? ("corrupted" as const)
    : flags.mirrored
      ? ("mirrored" as const)
      : flags.sanctified
        ? ("sanctified" as const)
        : undefined;
  const open = sealedReason ? 0 : Math.max(0, maxAffixes - affixCount);
  return { affixCount, maxAffixes, open, ...(sealedReason ? { sealedReason } : {}) };
}

// ---------------------------------------------------------------------------
// Lower-is-better modifiers
// ---------------------------------------------------------------------------

/**
 * Mod texts whose number is a penalty: a SMALLER roll is the better item,
 * so a search bound derived from one belongs on `max`, not `min`. Authored
 * by reading each line as a penalty; anything not listed is treated as
 * higher-is-better (the safe default — it only ever asks for more).
 */
export const LOWER_IS_BETTER: readonly RegExp[] = [
  /Movement Speed Penalty/i,
  /\bless Movement Speed\b/i,
  /reduced Movement Speed/i,
  /increased Charges per use/i,
  /reduced Charm Effect Duration/i,
  /Physical Damage taken from Attack Hits/i,
  /Enemies\s+Gain\b.*\bExtra Chaos/i,
  /damage from Blocked Hits/i,
  /Slowing Potency of Debuffs on You/i,
  /reduced Rarity of Items found/i,
  /Traps deal\b.*\breduced Damage/i,
];

export function isLowerIsBetter(modText: string): boolean {
  return LOWER_IS_BETTER.some((pattern) => pattern.test(modText));
}

// ---------------------------------------------------------------------------
// Map items
// ---------------------------------------------------------------------------

/** Waystone or tablet; undefined for everything else (no map block). */
export function mapItemKind(
  parsed: Pick<ParsedItem, "itemClass" | "baseType">,
): "waystone" | "tablet" | undefined {
  const itemClass = parsed.itemClass ?? "";
  const baseType = parsed.baseType ?? "";
  if (/waystone/i.test(itemClass) || /^Waystone\s*\(Tier/i.test(baseType.trim())) return "waystone";
  if (/tablet/i.test(itemClass) || /tablet/i.test(baseType)) return "tablet";
  return undefined;
}
