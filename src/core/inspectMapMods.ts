/**
 * Map warnings: rating a waystone's (or tablet's) modifiers against the
 * curated danger table in `src/data/inspect/dangerousMapMods.ts`.
 *
 * The rating is an opinion, not a fact — the table is community-maintained,
 * every entry is `verified: false`, and the user can re-rate or ignore any
 * entry from settings. Lines the table does not know are reported as
 * `unmatched` rather than dropped, so a wording change shows up as "we do
 * not rate this line" instead of a silently safe-looking map.
 *
 * Pure: no HTTP, no fs, no clock.
 */

import { DANGEROUS_MAP_MODS } from "../data/inspect/dangerousMapMods.js";
import { mapItemKind } from "./itemStats.js";
import type { ParsedItem } from "./types.js";

export type MapModSeverity = "deadly" | "dangerous" | "caution" | "info";

/** Ascending: later entries win when several warnings are combined. */
export const SEVERITY_ORDER: readonly MapModSeverity[] = ["info", "caution", "dangerous", "deadly"];

export interface DangerousMapMod {
  /** Stable id — the key a user override is stored under. */
  id: string;
  /** Regex source where `#` stands for any number; compiled anchored + case-insensitive. */
  pattern: string;
  severity: MapModSeverity;
  label: string;
  reason: string;
  tags: string[];
  /** Always false: hand-authored wording, never captured from a live copy. */
  verified: false;
}

export interface MapWarning {
  id: string;
  label: string;
  severity: MapModSeverity;
  /** The modifier line as the game printed it. */
  text: string;
  reason: string;
  tags: string[];
  values: number[];
  /** The user re-rated this entry in settings. */
  overridden?: boolean;
}

export interface MapWarningReport {
  itemKind: "waystone" | "tablet";
  tier?: number;
  overall: MapModSeverity | "none";
  warnings: MapWarning[];
  /** Modifier lines the table does not rate. */
  unmatched: string[];
  /** Quantity / rarity / pack-size style lines: rewards, not dangers. */
  bonuses: Array<{ name: string; value: string }>;
  /** How many warnings the user's overrides silenced. */
  ignored: number;
  /** Table entries are hand-authored; the UI must say so. */
  verified: false;
}

export { mapItemKind };

/** Reward lines the game prints as `Name: value` on a waystone. */
const BONUS_NAMES: readonly string[] = [
  "Item Rarity",
  "Item Quantity",
  "Rarity of Items found",
  "Quantity of Items found",
  "Monster Pack Size",
  "Pack Size",
  "Magic Monsters",
  "Revives Available",
  "Waystone Drop Chance",
];

const BONUS_LINE = new RegExp(`^(${BONUS_NAMES.map(escapeLiteral).join("|")})\\s*:\\s*(.+)$`, "i");
const WAYSTONE_TIER_LINE = /^Waystone Tier\s*:\s*(\d+)/i;

function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True for the reward/tier lines a waystone prints as `Name: value`. They
 * are the map's payout, not a modifier, so the panel lists them separately
 * and never counts them as affixes.
 */
export function isMapBonusLine(text: string): boolean {
  const line = text.replace(/\s+/g, " ").trim();
  return BONUS_LINE.test(line) || WAYSTONE_TIER_LINE.test(line);
}

/** The tier from the base type ("Waystone (Tier 15)") or the printed property. */
export function waystoneTier(parsed: ParsedItem): number | undefined {
  const fromBase = /Waystone\s*\(Tier\s*(\d+)\)/i.exec(parsed.baseType ?? "");
  if (fromBase) return Number(fromBase[1]);
  const property = parsed.properties.find((entry) => /^waystone tier$/i.test(entry.name.trim()));
  const printed = property?.rolls[0]?.value ?? Number(property?.value.replace(/[^\d.-]/g, ""));
  if (printed !== undefined && Number.isFinite(printed)) return printed;
  for (const mod of parsed.mods) {
    const match = WAYSTONE_TIER_LINE.exec(mod.text.trim());
    if (match) return Number(match[1]);
  }
  return undefined;
}

const compiled = new Map<string, RegExp>();

/** `#` → any number, anchored to the whole line, case-insensitive. */
export function compileMapModPattern(pattern: string): RegExp {
  const cached = compiled.get(pattern);
  if (cached) return cached;
  const source = `^${pattern.replace(/#/g, "(?:-?\\d+(?:\\.\\d+)?)")}$`;
  const regex = new RegExp(source, "i");
  compiled.set(pattern, regex);
  return regex;
}

function numbersIn(text: string): number[] {
  return [...text.matchAll(/-?\d+(?:\.\d+)?/g)]
    .map((match) => Number(match[0]))
    .filter((value) => Number.isFinite(value));
}

/** The first table entry whose pattern covers the whole line. */
export function matchMapMod(
  text: string,
  table: readonly DangerousMapMod[] = DANGEROUS_MAP_MODS,
): { mod: DangerousMapMod; values: number[] } | undefined {
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return undefined;
  for (const mod of table) {
    if (compileMapModPattern(mod.pattern).test(line)) {
      return { mod, values: numbersIn(line) };
    }
  }
  return undefined;
}

/** `a` is at least as severe as `b` ("none" is below everything). */
export function severityAtLeast(a: MapModSeverity | "none", b: MapModSeverity): boolean {
  if (a === "none") return false;
  return SEVERITY_ORDER.indexOf(a) >= SEVERITY_ORDER.indexOf(b);
}

function worst(severities: readonly MapModSeverity[]): MapModSeverity | "none" {
  let current: MapModSeverity | "none" = "none";
  for (const severity of severities) {
    if (current === "none" || SEVERITY_ORDER.indexOf(severity) > SEVERITY_ORDER.indexOf(current)) {
      current = severity;
    }
  }
  return current;
}

function isSeverity(value: unknown): value is MapModSeverity {
  return typeof value === "string" && (SEVERITY_ORDER as readonly string[]).includes(value);
}

export interface MapWarningOptions {
  table?: readonly DangerousMapMod[];
  /** Entry id → the user's own rating, or "ignore" to silence it. */
  overrides?: Record<string, MapModSeverity | "ignore">;
}

/**
 * Rate one map item. Undefined for anything that is not a waystone or a
 * tablet — the panel then shows no map block at all.
 */
export function mapWarnings(
  parsed: ParsedItem,
  options: MapWarningOptions = {},
): MapWarningReport | undefined {
  const itemKind = mapItemKind(parsed);
  if (!itemKind) return undefined;
  const table = options.table ?? DANGEROUS_MAP_MODS;
  const overrides = options.overrides ?? {};

  const warnings: MapWarning[] = [];
  const unmatched: string[] = [];
  const bonuses: Array<{ name: string; value: string }> = [];
  let ignored = 0;

  for (const mod of parsed.mods) {
    const text = mod.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (WAYSTONE_TIER_LINE.test(text)) continue;
    const bonus = BONUS_LINE.exec(text);
    if (bonus) {
      bonuses.push({ name: bonus[1]!.trim(), value: bonus[2]!.trim() });
      continue;
    }
    const hit = matchMapMod(text, table);
    if (!hit) {
      unmatched.push(text);
      continue;
    }
    const override = overrides[hit.mod.id];
    if (override === "ignore") {
      ignored += 1;
      continue;
    }
    const severity = isSeverity(override) ? override : hit.mod.severity;
    warnings.push({
      id: hit.mod.id,
      label: hit.mod.label,
      severity,
      text,
      reason: hit.mod.reason,
      tags: [...hit.mod.tags],
      values: hit.values,
      ...(isSeverity(override) ? { overridden: true } : {}),
    });
  }

  const tier = itemKind === "waystone" ? waystoneTier(parsed) : undefined;
  return {
    itemKind,
    ...(tier !== undefined ? { tier } : {}),
    overall: worst(warnings.map((warning) => warning.severity)),
    warnings,
    unmatched,
    bonuses,
    ignored,
    verified: false,
  };
}
