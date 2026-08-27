import { fingerprintItem } from "./itemFingerprint.js";
import type {
  ItemMod,
  ItemModKind,
  ItemNumericRoll,
  ItemProperty,
  ItemSection,
  ItemSectionKind,
  ParsedItem,
} from "./types.js";

const METADATA_PREFIXES = ["Requires Level", "Level:", "Corrupted", "Unidentified"];

const WAYSTONE_COLON_PREFIXES = [
  "Waystone Tier:",
  "Revives Available:",
  "Monster Pack Size:",
  "Magic Monsters:",
  "Item Rarity:",
  "Item Quantity:",
  "Waystone Drop Chance:",
  "Pack Size:",
  "Rarity of Items found:",
  "Quantity of Items found:",
];

const TRAILING_TAG = /\s*\((augmented|implicit|crafted|fractured|enchant(?:ed)?)\)\s*$/i;
const NUMBER = /[+-]?(?:\d[\d,]*(?:\.\d+)?|\.\d+)/g;
const DEFENSE_PROPERTIES = new Set([
  "armour",
  "evasion rating",
  "energy shield",
  "ward",
  "block",
  "block chance",
]);

interface SourceLine {
  raw: string;
  text: string;
  line: number;
}

interface SourceBlock {
  block: number;
  lines: SourceLine[];
}

function parseNumber(text: string): number | undefined {
  const match = text.replace(/,/g, "").match(/(-?\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : undefined;
}

export function looksLikePoeItemText(text: string | null | undefined): boolean {
  if (!text) return false;
  return /^\s*Item Class:/im.test(text) || /^\s*Rarity:/im.test(text);
}

export function extractNumericRolls(text: string): ItemNumericRoll[] {
  const rolls: ItemNumericRoll[] = [];
  const rx = new RegExp(NUMBER.source, "g");
  let match: RegExpExecArray | null;
  while ((match = rx.exec(text)) !== null) {
    let raw = match[0]!;
    let start = match.index;

    // A hyphen between two values is a range separator, not a negative sign.
    if (raw.startsWith("-")) {
      const previous = text.slice(0, start).trimEnd().at(-1);
      if (previous && /[\d.)%]/.test(previous)) {
        raw = raw.slice(1);
        start += 1;
      }
    }

    const value = Number(raw.replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    const end = match.index + match[0].length;
    const unit = text.slice(end).match(/^\s*(%)/)?.[1];
    rolls.push({
      index: rolls.length,
      value,
      raw,
      unit,
      start,
      end,
    });
  }
  return rolls;
}

function kindFromTag(tag: string): ItemModKind | undefined {
  switch (tag.toLowerCase()) {
    case "implicit":
      return "implicit";
    case "crafted":
      return "crafted";
    case "fractured":
      return "fractured";
    case "enchant":
    case "enchanted":
      return "enchant";
    default:
      return undefined;
  }
}

function kindFromAnnotation(line: string): ItemModKind | undefined {
  if (!/^\{.+\}$/.test(line.trim())) return undefined;
  const annotation = line.toLowerCase();
  if (annotation.includes("fractured")) return "fractured";
  if (annotation.includes("crafted")) return "crafted";
  if (annotation.includes("enchant")) return "enchant";
  if (annotation.includes("implicit")) return "implicit";
  if (/\b(?:prefix|suffix|explicit)\b/.test(annotation)) return "explicit";
  return "unknown";
}

function normalizeModLine(line: string): {
  text: string;
  tags: string[];
  taggedKind?: ItemModKind;
} {
  let next = line.trim();
  const tags: string[] = [];
  let taggedKind: ItemModKind | undefined;
  while (true) {
    const before = next;
    const tag = next.match(TRAILING_TAG);
    if (tag?.[1]) {
      const normalizedTag = tag[1].toLowerCase().replace("enchanted", "enchant");
      tags.unshift(normalizedTag);
      taggedKind ??= kindFromTag(normalizedTag);
    }
    next = next.replace(TRAILING_TAG, "").trim();
    if (next === before) break;
  }
  return { text: next.replace(/\s+/g, " ").trim(), tags, taggedKind };
}

function isMetadataLine(line: string, itemClass: string): boolean {
  if (METADATA_PREFIXES.some((prefix) => line.toLowerCase().startsWith(prefix.toLowerCase()))) return true;
  if (/^\{.+\}$/.test(line)) return true;
  if (
    line.includes(":") &&
    !WAYSTONE_COLON_PREFIXES.some((prefix) =>
      line.toLowerCase().startsWith(prefix.toLowerCase()),
    )
  ) {
    return true;
  }
  if (line.endsWith(".") && !/\d/.test(line)) return true;
  if (/currency/i.test(itemClass) && !/\d/.test(line) && line.split(/\s+/).length >= 6) return true;
  return false;
}

function isAffixLine(line: string, itemClass: string): boolean {
  if (
    WAYSTONE_COLON_PREFIXES.some((prefix) =>
      line.toLowerCase().startsWith(prefix.toLowerCase()),
    )
  ) {
    return true;
  }
  if (isMetadataLine(line, itemClass)) return false;
  return line.length > 0;
}

function parseModLine(
  source: SourceLine,
  block: number,
  order: number,
  contextualKind?: ItemModKind,
): ItemMod {
  const { text, tags, taggedKind } = normalizeModLine(source.text);
  const rolls = extractNumericRolls(text);
  const kind = taggedKind ?? contextualKind ?? "explicit";
  const values = rolls.map((roll) => roll.value);
  const allTags = [...new Set([...tags, kind])];
  return {
    text,
    implicit: kind === "implicit",
    kind,
    block,
    order,
    line: source.line,
    rawText: source.raw,
    tags: allTags,
    values,
    rolls,
    value: values[0],
    value2: values[1],
    unit: rolls[0]?.unit,
  };
}

function splitBlocks(itemText: string): { normalized: string; blocks: SourceBlock[] } {
  const normalized = itemText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const blocks: SourceBlock[] = [{ block: 0, lines: [] }];
  normalized.split("\n").forEach((raw, line) => {
    const withoutTrailingSpace = raw.trimEnd();
    const text = withoutTrailingSpace.trim();
    if (text === "--------") {
      blocks.push({ block: blocks.length, lines: [] });
    } else if (text) {
      blocks[blocks.length - 1]!.lines.push({ raw: withoutTrailingSpace, text, line });
    }
  });
  return { normalized, blocks };
}

function extractModsFromBlocks(blocks: SourceBlock[], itemClass: string): ItemMod[] {
  const mods: ItemMod[] = [];
  for (const block of blocks) {
    // Block zero contains Item Class/Rarity/name/base in both supported formats.
    if (block.block === 0) continue;
    let contextualKind: ItemModKind | undefined;
    for (const source of block.lines) {
      const annotationKind = kindFromAnnotation(source.text);
      if (annotationKind) {
        contextualKind = annotationKind;
        continue;
      }
      if (!isAffixLine(source.text, itemClass)) continue;
      mods.push(parseModLine(source, block.block, mods.length, contextualKind));
    }
  }
  return mods;
}

export function extractItemMods(itemText: string): ItemMod[] {
  const { blocks } = splitBlocks(itemText);
  const allLines = blocks.flatMap((block) => block.lines.map((line) => line.text));
  const itemClass = valueAfter(allLines, "Item Class:") ?? "Unknown";
  return extractModsFromBlocks(blocks, itemClass);
}

function parseProperty(source: SourceLine, block: number, order: number): ItemProperty | undefined {
  const colon = source.text.indexOf(":");
  if (colon <= 0 || /^\{.+\}$/.test(source.text)) return undefined;
  const name = source.text.slice(0, colon).trim();
  const value = source.text.slice(colon + 1).trim();
  if (!name || (!value && name.toLowerCase() === "requirements")) return undefined;
  const rolls = extractNumericRolls(source.text);
  return {
    name,
    value,
    text: source.text,
    rawText: source.raw,
    block,
    order,
    line: source.line,
    values: rolls.map((roll) => roll.value),
    rolls,
    augmented: /\(augmented\)\s*$/i.test(source.text) || undefined,
  };
}

function classifySection(
  block: SourceBlock,
  properties: ItemProperty[],
  blockMods: ItemMod[],
  itemClass: string,
): ItemSectionKind {
  if (block.block === 0) return "header";
  const lines = block.lines.map((line) => line.text);
  if (lines.some((line) => /^Requirements:$/i.test(line))) return "requirements";
  if (lines.length > 0 && lines.every((line) => /^(?:Corrupted|Unidentified)\b/i.test(line))) return "status";
  if (lines.some((line) => /^Sockets:/i.test(line)) && blockMods.length === 0) return "sockets";
  if (lines.some((line) => /^Item Level:/i.test(line)) && blockMods.length === 0) return "item-level";
  if (blockMods.length > 0) return "modifiers";
  if (properties.length > 0) return "properties";
  if (/currency/i.test(itemClass)) return "description";
  return lines.length > 0 ? "unknown" : "description";
}

export function parseItemText(rawText: string): ParsedItem {
  const { blocks } = splitBlocks(rawText);
  const allLines = blocks.flatMap((block) => block.lines.map((line) => line.text));
  const header = (blocks[0]?.lines ?? [])
    .map((line) => line.text)
    .filter(
      (line) =>
        !line.toLowerCase().startsWith("item class:") &&
        !line.toLowerCase().startsWith("rarity:"),
    );

  const itemClass = valueAfter(allLines, "Item Class:") ?? "Unknown";
  const rarity = valueAfter(allLines, "Rarity:") ?? "Normal";
  const identified = !allLines.some((line) => /^Unidentified\b/i.test(line));
  const corrupted = allLines.some((line) => /^Corrupted\b/i.test(line));

  let name = header[0];
  let baseType = header[1] ?? header[0];
  if (name && baseType && name.toLowerCase() === baseType.toLowerCase()) {
    name = baseType;
  }

  const requirements: Record<string, number> = {};
  const requirementBlock = blocks.find((block) =>
    block.lines.some((line) => /^Requirements:$/i.test(line.text)),
  );
  if (requirementBlock) {
    for (const source of requirementBlock.lines) {
      if (/^Requirements:$/i.test(source.text)) continue;
      const colon = source.text.indexOf(":");
      if (colon <= 0) continue;
      const key = source.text.slice(0, colon).trim();
      const numeric = parseNumber(source.text.slice(colon + 1));
      if (key && numeric !== undefined) requirements[key] = numeric;
    }
  }

  let propertyOrder = 0;
  const propertiesByBlock = new Map<number, ItemProperty[]>();
  const properties: ItemProperty[] = [];
  for (const block of blocks) {
    const parsed: ItemProperty[] = [];
    if (block.block !== 0) {
      for (const source of block.lines) {
        const property = parseProperty(source, block.block, propertyOrder);
        if (!property) continue;
        propertyOrder += 1;
        parsed.push(property);
        properties.push(property);
      }
    }
    propertiesByBlock.set(block.block, parsed);
  }

  const mods = extractModsFromBlocks(blocks, itemClass);
  const sections: ItemSection[] = blocks.map((block) => {
    const blockProperties = propertiesByBlock.get(block.block) ?? [];
    const blockMods = mods.filter((mod) => mod.block === block.block);
    const rawLines = block.lines.map((line) => line.raw);
    return {
      block: block.block,
      order: block.block,
      kind: classifySection(block, blockProperties, blockMods, itemClass),
      lines: [...rawLines],
      rawLines: [...rawLines],
      rawText: rawLines.join("\n"),
      startLine: block.lines[0]?.line ?? -1,
      endLine: block.lines.at(-1)?.line ?? -1,
      properties: blockProperties,
      mods: blockMods,
    };
  });
  const defenses = properties.filter((property) => DEFENSE_PROPERTIES.has(property.name.toLowerCase()));
  const modifierBlocks = sections
    .filter((section) => section.mods.length > 0)
    .map((section, order) => ({
      block: section.block,
      order,
      rawLines: [...section.rawLines],
      mods: section.mods,
    }));

  const draft = {
    itemClass,
    rarity,
    name: name ?? "Unknown Item",
    baseType: baseType ?? name ?? "Unknown Item",
    itemLevel: parsePrefixed(allLines, "Item Level:"),
    quality: parsePrefixed(allLines, "Quality:"),
    sockets: valueAfter(allLines, "Sockets:"),
    requirements,
    mods,
    identified,
    corrupted,
    rawText,
    rawSections: sections.map((section) => [...section.rawLines]),
    sections,
    properties,
    defenses,
    modifierBlocks,
  };

  return { ...draft, fingerprint: fingerprintItem(draft) };
}

function valueAfter(lines: string[], prefix: string): string | undefined {
  const lowerPrefix = prefix.toLowerCase();
  const line = lines.find((entry) => entry.toLowerCase().startsWith(lowerPrefix));
  return line ? line.slice(prefix.length).trim() : undefined;
}

function parsePrefixed(lines: string[], prefix: string): number | undefined {
  const value = valueAfter(lines, prefix);
  return value ? parseNumber(value) : undefined;
}
