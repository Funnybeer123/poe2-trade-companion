/**
 * Lookup screen: which bag items deserve a trade2 comps lookup at all.
 *
 * trade2 allows roughly a dozen lookups a minute, and a full bag is mostly
 * rares whose comps come back at the base floor anyway (2026-09-03: 8 of 11
 * items priced "≈1 ex" from ten comps each). So the API is spent only on
 * items with notable mods — matched against the mod knowledge base — or on
 * uniques the price table lacks, best candidates first. Plain rares list at
 * the cheapest bucket without a lookup; Normal items vendor unless they are
 * craft-grade bases. Nothing here can mark an item dump: that verdict still
 * belongs to the value-tier rules.
 */
import type { ItemAppraisal } from "./appraisal.js";
import type { TriageTier } from "./valueTiers.js";

export type ScreenRoute = "keep" | "vendor" | "local-price" | "floor" | "lookup";

export interface ScreenInput {
  /** Caller's handle for the item (bag index, fingerprint …). */
  key: string;
  name: string;
  tier: TriageTier;
  rarity?: string;
  /** The base type (for a magic item the whole name line, which contains it). */
  baseType?: string;
  itemLevel?: number;
  appraisal?: ItemAppraisal;
}

/**
 * Bases worth a lookup whatever their mods say — the base IS the value, and
 * the mod knowledge base (gear-oriented) would floor them. Live 2026-09-03: a
 * magic Time-Lost Sapphire screened as "no notable mods → 1 ex".
 */
export const VALUABLE_BASES: readonly RegExp[] = [/time-?lost/i, /timeless/i, /\bdiamond\b/i];

function valuableBase(item: ScreenInput): string | undefined {
  const haystack = `${item.baseType ?? ""} ${item.name}`;
  const hit = VALUABLE_BASES.find((pattern) => pattern.test(haystack));
  if (!hit) return undefined;
  const match = hit.exec(haystack);
  return match ? match[0] : undefined;
}

export interface ScreenDecision {
  key: string;
  name: string;
  route: ScreenRoute;
  /** Lookup priority (higher first); 0 for every other route. */
  score: number;
  reason: string;
  notableMods: number;
}

/** A white base at or above this item level is craft stock, not vendor trash. */
export const CRAFT_BASE_ILVL = 81;

function decide(item: ScreenInput): ScreenDecision {
  const appraisal = item.appraisal;
  const notable = appraisal
    ? appraisal.mods.filter((mod) => mod.tier !== undefined && mod.tier >= 1)
    : [];
  const base = { key: item.key, name: item.name, notableMods: notable.length };
  const route = (
    routeName: ScreenRoute,
    reason: string,
    score = 0,
  ): ScreenDecision => ({ ...base, route: routeName, score, reason });

  if (item.tier === "keep") return route("keep", "keep-tier — never listed");
  if (item.tier === "dump") return route("vendor", "dump-tier rule");
  if (appraisal?.estimatedValue && /^exalted$/i.test(appraisal.estimatedValue.currency)) {
    return route("local-price", `price table (${appraisal.estimatedValue.basis})`, appraisal.valueScore);
  }
  const valuable = valuableBase(item);
  if (valuable) {
    return route("lookup", `valuable base (${valuable}) — worth a lookup`, (appraisal?.valueScore ?? 0) + 200);
  }
  const rarity = (item.rarity ?? "").toLowerCase();
  if (rarity === "normal") {
    return (item.itemLevel ?? 0) >= CRAFT_BASE_ILVL
      ? route("floor", `Normal base at ilvl ${item.itemLevel} — floor listing as craft stock`)
      : route("vendor", "Normal item — no market");
  }
  if (rarity === "unique") {
    // Unique searches are by name: cheap, precise, and the table has no row.
    return route("lookup", "unique missing from the price table", (appraisal?.valueScore ?? 0) + 100);
  }
  if (!appraisal) return route("lookup", "no appraisal — priced last", 0);
  if (notable.length === 0) return route("floor", "no notable mods — floor listing, no lookup");
  const score = appraisal.valueScore * (0.5 + appraisal.confidence / 200);
  const families = notable
    .map((mod) => mod.familyLabel ?? mod.familyId ?? "?")
    .slice(0, 3)
    .join(", ");
  return route(
    "lookup",
    `${notable.length} notable mod(s): ${families} — worth a lookup`,
    Math.round(score * 10) / 10,
  );
}

/**
 * Route every item. Lookup candidates come first, best first, so a run that
 * exhausts its budget spends it on the items most likely to be worth more
 * than the floor; every other route keeps the caller's order.
 */
export function screenForLookup(items: readonly ScreenInput[]): ScreenDecision[] {
  const decisions = items.map(decide);
  const lookups = decisions
    .filter((decision) => decision.route === "lookup")
    .sort((a, b) => b.score - a.score);
  const rest = decisions.filter((decision) => decision.route !== "lookup");
  return [...lookups, ...rest];
}

/** "screen: 3 lookup · 8 floor · 1 vendor · 0 local · 0 keep" */
export function summarizeScreen(decisions: readonly ScreenDecision[]): string {
  const count = (routeName: ScreenRoute): number =>
    decisions.filter((decision) => decision.route === routeName).length;
  return `screen: ${count("lookup")} lookup · ${count("floor")} floor · ${count("vendor")} vendor · ${count("local-price")} local · ${count("keep")} keep`;
}
