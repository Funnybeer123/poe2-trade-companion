/**
 * The game's ADVANCED item description (Ctrl+Alt+C) — the copy that carries
 * per-modifier annotation lines and per-number roll ranges:
 *
 *   { Prefix Modifier "Glaciated" (Tier: 3) — Cold }
 *   Adds 10(8-12) to 20(18-24) Cold Damage to Attacks
 *
 * `parseAdvancedItemText` splits that into (a) `plainText` — the ranges
 * stripped back in place so `parseItemText` sees the ordinary copy, with
 * every line kept so line numbers still line up — (b) the annotations and
 * (c) the ranges. `attachAnnotations` then binds each parsed mod to the
 * annotation printed above it.
 *
 * UNVERIFIED for PoE2: the `value(min-max)` range form is how PoE1 printed
 * advanced descriptions; the annotation lines themselves are observed in
 * `fixtures/items/rich-affixes.txt`. Nothing here fails when a copy carries
 * neither (`hasAnnotations` / `hasRanges` are both false and the text is
 * returned unchanged).
 *
 * Pure: no HTTP, no fs.
 */

import type { ItemMod, ItemModKind, ParsedItem } from "./types.js";

export interface ModAnnotation {
  /** Separator-delimited block index, counted the way the parser counts. */
  block: number;
  /** Zero-based raw line index of the `{ … }` line. */
  line: number;
  kind: ItemModKind | "unique";
  side?: "prefix" | "suffix";
  /** The affix name the game prints in quotes ("Robust"). */
  name?: string;
  /** The game's own `(Tier: N)` number, as printed — see the direction caveat. */
  tier?: number;
  tags: string[];
}

export interface AdvancedRange {
  line: number;
  /** Zero-based position of this number within its line. */
  index: number;
  value: number;
  min: number;
  max: number;
  /**
   * `unique-text` marks a bare `(150-250)` range with no rolled value in
   * front of it (unique and unidentified descriptions). Those are left in
   * the text untouched and `value` mirrors `min`, which is not a roll.
   */
  kind?: "value" | "unique-text";
}

export interface AdvancedItemText {
  /** Ranges stripped in place; annotation lines KEPT; line numbers unchanged. */
  plainText: string;
  annotations: ModAnnotation[];
  ranges: AdvancedRange[];
  hasAnnotations: boolean;
  hasRanges: boolean;
  statusFlags: { corrupted: boolean; mirrored: boolean; sanctified: boolean; unidentified: boolean };
}

/**
 * One annotation line. PoE2 prints an em dash before the tag list; the en
 * dash and the plain hyphen are accepted too, and the whole line is
 * case-insensitive.
 */
export const ANNOTATION_LINE =
  /^\{\s*(?<flags>(?:(?:Crafted|Fractured|Desecrated|Unique|Rune|Enchant(?:ed)?|Implicit|Master Crafted)\s+)*)(?<side>Prefix|Suffix)?\s*Modifier(?:\s+"(?<name>[^"]+)")?(?:\s+\(Tier:\s*(?<tier>\d+)\))?(?:\s+[—–-]\s+(?<tags>.+?))?\s*\}$/i;

/** Flag → kind, in the order a line carrying several of them is resolved. */
const FLAG_KINDS: ReadonlyArray<[RegExp, ModAnnotation["kind"]]> = [
  [/\brune\b/i, "rune"],
  [/\bdesecrated\b/i, "desecrated"],
  [/\bfractured\b/i, "fractured"],
  [/\b(?:master\s+)?crafted\b/i, "crafted"],
  [/\benchant(?:ed)?\b/i, "enchant"],
  [/\bimplicit\b/i, "implicit"],
  [/\bunique\b/i, "unique"],
];

/** `{ Prefix Modifier "Glaciated" (Tier: 3) — Cold }` → its parts. */
export function parseAnnotationLine(line: string): Omit<ModAnnotation, "block" | "line"> | undefined {
  const match = ANNOTATION_LINE.exec(line.trim());
  if (!match?.groups) return undefined;
  const groups = match.groups;
  const flags = groups.flags ?? "";
  const side = groups.side?.toLowerCase();
  let kind: ModAnnotation["kind"] | undefined;
  for (const [pattern, candidate] of FLAG_KINDS) {
    if (pattern.test(flags)) {
      kind = candidate;
      break;
    }
  }
  kind ??= side ? "explicit" : "unknown";
  const tier = groups.tier !== undefined ? Number(groups.tier) : undefined;
  const tags = (groups.tags ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
  return {
    kind,
    ...(side === "prefix" || side === "suffix" ? { side } : {}),
    ...(groups.name ? { name: groups.name.trim() } : {}),
    ...(tier !== undefined && Number.isFinite(tier) ? { tier } : {}),
    tags,
  };
}

/** `value(min-max)` — mixed signs allowed inside the brackets. */
const VALUE_RANGE = /(-?\d+(?:\.\d+)?)\(([-+]?\d+(?:\.\d+)?)\s*[-–]\s*([-+]?\d+(?:\.\d+)?)\)/g;
/** A bare `(150-250)` with no rolled value in front of it. */
const BARE_RANGE = /(^|[^\d)])\(([-+]?\d+(?:\.\d+)?)\s*[-–]\s*([-+]?\d+(?:\.\d+)?)\)/g;

/**
 * Strips every `value(min-max)` back to `value` and records what it found.
 * A bare `(150-250)` is left in place (the parser reads both numbers as the
 * line's values) and recorded with `kind: "unique-text"`.
 */
export function stripAdvancedRanges(line: string): {
  text: string;
  ranges: Array<Omit<AdvancedRange, "line">>;
} {
  const ranges: Array<Omit<AdvancedRange, "line">> = [];
  let index = 0;
  const text = line.replace(VALUE_RANGE, (_all, value: string, min: string, max: string) => {
    ranges.push({
      index,
      value: Number(value),
      min: Number(min),
      max: Number(max),
      kind: "value",
    });
    index += 1;
    return value;
  });
  BARE_RANGE.lastIndex = 0;
  let bare: RegExpExecArray | null;
  while ((bare = BARE_RANGE.exec(text)) !== null) {
    const min = Number(bare[2]);
    const max = Number(bare[3]);
    if (!Number.isFinite(min) || !Number.isFinite(max)) continue;
    ranges.push({ index, value: min, min, max, kind: "unique-text" });
    index += 1;
  }
  return { text, ranges };
}

const BLOCK_SEPARATOR = "--------";

/** Advanced copy → the plain copy plus everything the extra markup carried. */
export function parseAdvancedItemText(rawText: string): AdvancedItemText {
  const lines = rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const plainLines: string[] = [];
  const annotations: ModAnnotation[] = [];
  const ranges: AdvancedRange[] = [];
  const flags = { corrupted: false, mirrored: false, sanctified: false, unidentified: false };
  let block = 0;

  lines.forEach((raw, line) => {
    const trimmed = raw.trim();
    if (trimmed === BLOCK_SEPARATOR) {
      plainLines.push(raw);
      block += 1;
      return;
    }
    if (/^Corrupted$/i.test(trimmed)) flags.corrupted = true;
    if (/^Mirrored$/i.test(trimmed)) flags.mirrored = true;
    if (/^Sanctified$/i.test(trimmed)) flags.sanctified = true;
    if (/^Unidentified\b/i.test(trimmed)) flags.unidentified = true;

    const annotation = parseAnnotationLine(trimmed);
    if (annotation) {
      annotations.push({ block, line, ...annotation });
      plainLines.push(raw);
      return;
    }
    const stripped = stripAdvancedRanges(raw);
    for (const range of stripped.ranges) ranges.push({ line, ...range });
    plainLines.push(stripped.text);
  });

  return {
    plainText: plainLines.join("\n"),
    annotations,
    ranges,
    hasAnnotations: annotations.length > 0,
    hasRanges: ranges.some((range) => range.kind !== "unique-text"),
    statusFlags: flags,
  };
}

export interface AnnotatedMod {
  mod: ItemMod;
  annotation?: ModAnnotation;
  /** Shared by every mod bound to the same annotation (hybrid two-line mods). */
  groupIndex?: number;
  ranges: Array<Omit<AdvancedRange, "line">>;
}

/** Trailing `(crafted)` / `(fractured)` … tags → the kind they assert. */
const TAG_KINDS: Readonly<Record<string, ItemModKind>> = {
  implicit: "implicit",
  crafted: "crafted",
  fractured: "fractured",
  enchant: "enchant",
  rune: "rune",
  desecrated: "desecrated",
};

function taggedKindOf(mod: ItemMod): ItemModKind | undefined {
  for (const tag of mod.tags ?? []) {
    const kind = TAG_KINDS[tag.trim().toLowerCase()];
    if (kind) return kind;
  }
  return undefined;
}

/**
 * Binds each parsed mod to the annotation printed above it.
 *
 * `parsed` must come from `advanced.plainText`, so `mod.line` indexes the
 * same lines the annotations were found on. Walking in order, `current` is
 * the latest annotation in the same block above the mod; a mod whose own
 * trailing tag asserts a different kind than `current` is left unbound, and
 * so is every mod after it until the next annotation — the game only prints
 * one annotation per group, so a disagreement means the group ended.
 */
export function attachAnnotations(parsed: ParsedItem, advanced: AdvancedItemText): AnnotatedMod[] {
  const annotations = [...advanced.annotations].sort((a, b) => a.line - b.line);
  const rangesByLine = new Map<number, Array<Omit<AdvancedRange, "line">>>();
  for (const range of advanced.ranges) {
    const { line, ...rest } = range;
    const bucket = rangesByLine.get(line);
    if (bucket) bucket.push(rest);
    else rangesByLine.set(line, [rest]);
  }

  const out: AnnotatedMod[] = [];
  let cursor = 0;
  let current: ModAnnotation | undefined;
  let currentIndex: number | undefined;
  let blocked = false;

  for (const mod of parsed.mods) {
    const line = mod.line ?? -1;
    while (cursor < annotations.length && annotations[cursor]!.line < line) {
      current = annotations[cursor]!;
      currentIndex = cursor;
      blocked = false;
      cursor += 1;
    }
    const ranges = rangesByLine.get(line) ?? [];
    const candidate = current && current.block === mod.block ? current : undefined;
    if (!candidate || blocked) {
      out.push({ mod, ranges });
      continue;
    }
    const tagged = taggedKindOf(mod);
    if (tagged && tagged !== candidate.kind) {
      blocked = true;
      out.push({ mod, ranges });
      continue;
    }
    out.push({
      mod,
      annotation: candidate,
      ...(currentIndex !== undefined ? { groupIndex: currentIndex } : {}),
      ranges,
    });
  }
  return out;
}
