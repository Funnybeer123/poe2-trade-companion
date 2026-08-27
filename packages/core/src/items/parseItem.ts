import { ItemCategory } from "../vendor/exiled-exchange-2/parser/meta.js";
import { fingerprintItem } from "./fingerprint.js";
import type { ItemSnapshot, NormalizedItem } from "./types.js";

export interface ParseItemSuccess {
  ok: true;
  item: NormalizedItem;
}

export interface ParseItemFailure {
  ok: false;
  error: string;
  category: "ManualReview";
}

export type ParseItemResult = ParseItemSuccess | ParseItemFailure;

const ITEM_CLASS_PREFIX = "Item Class: ";
const RARITY_PREFIX = "Rarity: ";
const SECTION_BREAK = "--------";

const KNOWN_HEADERS = [
  /^Item Level:\s*(\d+)/i,
  /^Quality(?:\s*\([^)]+\))?:\s*\+?(\d+)/i,
  /^Sockets?:\s*(.+)$/i,
  /^Stack Size:\s*(\d+)/i,
  /^Area Level:\s*(\d+)/i,
  /^Level:\s*(\d+)/i,
  /^Requirements:$/i,
  /^Requires\b/i,
];

const CLASS_TO_CATEGORY: Record<string, ItemCategory | undefined> = {
  currency: ItemCategory.Currency,
  "stackable currency": ItemCategory.Currency,
  waystones: ItemCategory.Waystone,
  waystone: ItemCategory.Waystone,
  "skill gems": ItemCategory.SkillGem,
  "support gems": ItemCategory.SupportGem,
  gems: ItemCategory.Gem,
  rings: ItemCategory.Ring,
  amulets: ItemCategory.Amulet,
  belts: ItemCategory.Belt,
  "body armours": ItemCategory.BodyArmour,
  helmets: ItemCategory.Helmet,
  gloves: ItemCategory.Gloves,
  boots: ItemCategory.Boots,
  shields: ItemCategory.Shield,
  foci: ItemCategory.Focus,
  wands: ItemCategory.Wand,
  staves: ItemCategory.Staff,
  bows: ItemCategory.Bow,
  crossbows: ItemCategory.Crossbow,
  jewels: ItemCategory.Jewel,
  flasks: ItemCategory.Flask,
  charms: ItemCategory.Charm,
  tablets: ItemCategory.Tablet,
  relics: ItemCategory.Relic,
};

function fail(error: string): ParseItemFailure {
  return { ok: false, error, category: "ManualReview" };
}

/** EE2 `itemTextToSections` — blank `--------` separators. */
export function itemTextToSections(text: string): string[][] {
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  const sections: string[][] = [[]];
  lines.reduce((section, line) => {
    if (line !== SECTION_BREAK) {
      section.push(line);
      return section;
    }
    const next: string[] = [];
    sections.push(next);
    return next;
  }, sections[0]);
  return sections.filter((section) => section.length > 0);
}

function normalizeRarity(text: string | undefined): string | undefined {
  if (text === undefined || text.length === 0) {
    return undefined;
  }
  return text.trim().toLowerCase();
}

function categoryFromClass(itemClass: string | undefined): string | undefined {
  if (itemClass === undefined) {
    return undefined;
  }
  const mapped = CLASS_TO_CATEGORY[itemClass.toLowerCase()];
  return mapped ?? itemClass;
}

function parseNumber(line: string, pattern: RegExp): number | undefined {
  const match = pattern.exec(line);
  if (match?.[1] === undefined) {
    return undefined;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

function isKnownHeader(line: string): boolean {
  return KNOWN_HEADERS.some((pattern) => pattern.test(line));
}

function parseModifierLine(line: string): NormalizedItem["modifiers"][number] | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (
    trimmed === "Corrupted" ||
    trimmed === "Unidentified" ||
    trimmed === "Mirrored" ||
    trimmed === "Sanctified" ||
    trimmed.startsWith("Right click") ||
    trimmed.startsWith("Place into") ||
    trimmed.startsWith("Can be placed") ||
    trimmed.startsWith("Shift click")
  ) {
    return undefined;
  }
  const valueMatch = /([+-]?\d+(?:\.\d+)?)/.exec(trimmed);
  const value = valueMatch?.[1] !== undefined ? Number(valueMatch[1]) : undefined;
  return {
    text: trimmed,
    value: value !== undefined && Number.isFinite(value) ? value : undefined,
    kind: "explicit",
  };
}

export function parseItem(snapshot: ItemSnapshot): ParseItemResult {
  try {
    const raw = snapshot.rawText.trim();
    if (raw.length === 0) {
      return fail("item.empty");
    }

    const sections = itemTextToSections(raw);
    const plate = sections[0];
    if (plate === undefined || plate.length === 0) {
      return fail("item.parse_error");
    }

    let index = 0;
    let itemClass: string | undefined;
    if (plate[0]?.startsWith(ITEM_CLASS_PREFIX)) {
      itemClass = plate[0].slice(ITEM_CLASS_PREFIX.length).trim();
      index += 1;
    } else if (plate.some((line) => line.startsWith("Rarity: "))) {
      return fail("item.wrong_language_or_missing_class");
    } else {
      return fail("item.parse_error");
    }

    let rarityText: string | undefined;
    if (plate[index]?.startsWith(RARITY_PREFIX)) {
      rarityText = plate[index].slice(RARITY_PREFIX.length).trim();
      index += 1;
    }

    const name = plate[index]?.trim();
    if (name === undefined || name.length === 0) {
      return fail("item.parse_error");
    }
    index += 1;
    const base = plate[index]?.trim();

    const rarity = normalizeRarity(rarityText);
    const itemClassNormalized = itemClass.toLowerCase();
    const className = categoryFromClass(itemClass);

    let itemLevel: number | undefined;
    let quality: number | undefined;
    let sockets: string | undefined;
    let gemLevel: number | undefined;
    let areaLevel: number | undefined;
    let corrupted = false;
    let unidentified = false;
    const modifiers: NormalizedItem["modifiers"] = [];

    for (const section of sections.slice(1)) {
      for (const line of section) {
        if (line === "Corrupted") {
          corrupted = true;
          continue;
        }
        if (line === "Unidentified") {
          unidentified = true;
          continue;
        }
        const ilvl = parseNumber(line, /^Item Level:\s*(\d+)/i);
        if (ilvl !== undefined) {
          itemLevel = ilvl;
          continue;
        }
        const q = parseNumber(line, /^Quality(?:\s*\([^)]+\))?:\s*\+?(\d+)/i);
        if (q !== undefined) {
          quality = q;
          continue;
        }
        const socketMatch = /^Sockets?:\s*(.+)$/i.exec(line);
        if (socketMatch?.[1] !== undefined) {
          sockets = socketMatch[1].trim();
          continue;
        }
        const area = parseNumber(line, /^Area Level:\s*(\d+)/i);
        if (area !== undefined) {
          areaLevel = area;
          continue;
        }
        if (itemClassNormalized.includes("gem")) {
          const level = parseNumber(line, /^Level:\s*(\d+)/i);
          if (level !== undefined) {
            gemLevel = level;
            continue;
          }
        }
        if (line === "Requirements:" || /^Requires\b/i.test(line) || /^Level:\s*\d+/i.test(line)) {
          continue;
        }
        if (isKnownHeader(line)) {
          continue;
        }
        const modifier = parseModifierLine(line);
        if (modifier !== undefined) {
          modifiers.push(modifier);
        }
      }
    }

    const currencyLike =
      rarity === "currency" ||
      itemClassNormalized.includes("currency") ||
      className === ItemCategory.Currency;
    const resolvedBase = currencyLike ? name : (base ?? name);
    const resolvedName = currencyLike || rarity === "normal" || rarity === "magic" ? name : name;

    const pseudos: Record<string, number> = {};
    if (areaLevel !== undefined) {
      pseudos.areaLevel = areaLevel;
    }
    if (gemLevel !== undefined) {
      pseudos.gemLevel = gemLevel;
    }

    const draft: Omit<NormalizedItem, "fingerprint"> = {
      class: className,
      rarity,
      name: resolvedName,
      base: resolvedBase,
      itemLevel,
      quality,
      sockets,
      modifiers,
      pseudos,
      corrupted: corrupted || undefined,
      unidentified: unidentified || undefined,
    };

    return {
      ok: true,
      item: { ...draft, fingerprint: fingerprintItem(draft) },
    };
  } catch {
    return fail("item.parse_error");
  }
}

export function parseItemOrUndefined(rawText: string, capturedAtMs = 0): NormalizedItem | undefined {
  const result = parseItem({ rawText, source: "fixture", capturedAtMs });
  return result.ok ? result.item : undefined;
}
