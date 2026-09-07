/**
 * trade2 stat ids for our mod families.
 *
 * The official stats catalogue (GET /api/trade2/data/stats) lists every
 * searchable modifier as `{ id: "explicit.stat_…", text: "#% increased Spell
 * Damage" }`. PoE2's ids differ from PoE1's, so nothing here is hardcoded:
 * ids are derived at runtime from the fetched payload by matching each mod
 * family's regex — rewritten into the catalogue's `#` form — against the
 * catalogue text. A family whose regex is too loose (or too tight) for that
 * rewrite can pin explicit `statText` candidates instead.
 *
 * Two lookups come out of it:
 *   - by family: which stat ids a family covers (for learned-tier keys);
 *   - by text: the exact id for one Ctrl+C mod line ("Adds 12 to 24 Fire
 *     Damage" → "adds # to # fire damage" → its id) for stat-filtered
 *     searches, where the family's OTHER ids would match the wrong mod.
 *
 * Pure: no HTTP, no fs.
 */

import type { ModFamily } from "./modKnowledge.js";

export interface StatEntry {
  id: string;
  text: string;
  type: string;
}

export interface StatCatalogue {
  /** family id → stat ids whose catalogue text the family covers. */
  byFamily: Map<string, string[]>;
  /** normalized `#`-form text → stat ids sharing that text (local variants included). */
  byText: Map<string, string[]>;
  /** How many entries the catalogue held (for status lines). */
  entryCount: number;
}

/** Stat types worth resolving: explicit mods carry the tiers we price by. */
const DEFAULT_TYPES = ["explicit"];

/**
 * Flatten the catalogue payload. Unknown shapes yield nothing rather than
 * throwing — the service treats an empty catalogue as "stat stage off".
 */
export function statEntries(payload: unknown, types: readonly string[] = DEFAULT_TYPES): StatEntry[] {
  if (typeof payload !== "object" || payload === null) return [];
  const groups = (payload as { result?: unknown }).result;
  if (!Array.isArray(groups)) return [];
  const wanted = new Set(types.map((type) => type.toLowerCase()));
  const entries: StatEntry[] = [];
  for (const group of groups) {
    if (typeof group !== "object" || group === null) continue;
    const groupId = (group as { id?: unknown }).id;
    const list = (group as { entries?: unknown }).entries;
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      if (typeof raw !== "object" || raw === null) continue;
      const entry = raw as { id?: unknown; text?: unknown; type?: unknown };
      if (typeof entry.id !== "string" || typeof entry.text !== "string") continue;
      const type =
        typeof entry.type === "string"
          ? entry.type
          : typeof groupId === "string"
            ? groupId
            : "";
      if (wanted.size > 0 && !wanted.has(type.toLowerCase())) continue;
      entries.push({ id: entry.id, text: entry.text, type });
    }
  }
  return entries;
}

/**
 * Fold a catalogue text or a `#`-form mod line for comparison: case,
 * whitespace and `+` signs are noise ("+# to maximum Mana" ≡ "# to maximum
 * Mana"; a Ctrl+C line prints the sign, the catalogue may not).
 */
export function normalizeStatText(text: string): string {
  return text.replace(/\+/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** A Ctrl+C mod line in the catalogue's `#` form: every number becomes `#`. */
export function modTextToStatText(modText: string): string {
  return normalizeStatText(modText.replace(/-?\d+(?:\.\d+)?/g, "#"));
}

/** "(local)" suffixed variants share the words of the global stat. */
const LOCAL_SUFFIX = /\s*\(local\)$/;

/**
 * Rewrite a family regex into one that matches catalogue text: the number
 * classes become a literal `#`, `+` signs drop (normalization strips them
 * on the other side), and the whole thing anchors so "#% increased Attack
 * Speed" cannot also claim "#% increased Attack Speed per 10 Dexterity".
 */
export function patternToStatRegex(pattern: string): RegExp {
  const source = pattern
    .replace(/\[\\d\.\]\+/g, "#")
    .replace(/\\d\+/g, "#")
    .replace(/\\\+\?/g, "")
    .replace(/\\\+/g, "");
  return new RegExp(`^(?:${source})$`, "i");
}

function statTexts(family: ModFamily): string[] | undefined {
  if (family.statText === undefined) return undefined;
  return Array.isArray(family.statText) ? family.statText : [family.statText];
}

/**
 * family id → stat ids. Families with explicit `statText` resolve by exact
 * normalized text; the rest by their rewritten regex. A family that matches
 * nothing is absent from the map — `unresolvedFamilies` lists those.
 */
export function resolveStatIds(
  payload: unknown,
  families: readonly ModFamily[],
  types: readonly string[] = DEFAULT_TYPES,
): Map<string, string[]> {
  const entries = statEntries(payload, types).map((entry) => ({
    id: entry.id,
    normalized: normalizeStatText(entry.text),
    bare: normalizeStatText(entry.text).replace(LOCAL_SUFFIX, ""),
  }));
  const resolved = new Map<string, string[]>();
  for (const family of families) {
    const explicit = statTexts(family)?.map(normalizeStatText);
    const regex = explicit ? undefined : patternToStatRegex(family.pattern);
    const ids: string[] = [];
    for (const entry of entries) {
      const hit = explicit
        ? explicit.includes(entry.bare)
        : regex!.test(entry.bare);
      if (hit && !ids.includes(entry.id)) ids.push(entry.id);
    }
    if (ids.length > 0) resolved.set(family.id, ids);
  }
  return resolved;
}

/** The families `resolveStatIds` found no catalogue entry for. */
export function unresolvedFamilies(
  resolved: ReadonlyMap<string, readonly string[]>,
  families: readonly ModFamily[],
): string[] {
  return families.filter((family) => !resolved.has(family.id)).map((family) => family.id);
}

/** Index every catalogue text (and its local variant) to its ids. */
export function indexStatTexts(
  payload: unknown,
  types: readonly string[] = DEFAULT_TYPES,
): Map<string, string[]> {
  const byText = new Map<string, string[]>();
  for (const entry of statEntries(payload, types)) {
    const normalized = normalizeStatText(entry.text);
    const bare = normalized.replace(LOCAL_SUFFIX, "");
    // The global text keys both variants; a "(local)" suffix on our side
    // never happens (Ctrl+C prints no such thing), so the bare form is key.
    const list = byText.get(bare) ?? [];
    if (!list.includes(entry.id)) list.push(entry.id);
    byText.set(bare, list);
  }
  return byText;
}

export function buildStatCatalogue(
  payload: unknown,
  families: readonly ModFamily[],
  types: readonly string[] = DEFAULT_TYPES,
): StatCatalogue {
  return {
    byFamily: resolveStatIds(payload, families, types),
    byText: indexStatTexts(payload, types),
    entryCount: statEntries(payload, types).length,
  };
}

/** The ids whose catalogue text equals this mod line (numbers folded to `#`). */
export function statIdsForModText(catalogue: StatCatalogue, modText: string): string[] {
  return catalogue.byText.get(modTextToStatText(modText)) ?? [];
}

/**
 * A family wider than this is not a set of siblings but a theme
 * ("increased … Damage" spans twenty stats): its other ids say nothing
 * about this line's roll, so only the exact text counts.
 */
const MAX_SIBLING_IDS = 6;

/**
 * The stat ids to key one matched mod by: the line's exact ids first (the
 * precise mod), then — for small families — its sibling ids (a learned
 * range for "+# to Dexterity" is a usable signal for "+# to Strength").
 */
export function statIdsForMatch(
  catalogue: StatCatalogue,
  familyId: string,
  modText: string,
): string[] {
  const exact = statIdsForModText(catalogue, modText);
  const family = catalogue.byFamily.get(familyId) ?? [];
  const ids = [...exact];
  if (family.length <= MAX_SIBLING_IDS) {
    for (const id of family) if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}
