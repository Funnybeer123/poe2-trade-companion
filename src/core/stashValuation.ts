import { archetypeForClass } from "./crafting.js";
import { MOD_FAMILIES, matchModFamily, modPoints } from "./modKnowledge.js";
import { looksLikePoeItemText, parseItemText } from "./parseItem.js";
import { destForItemClass, GEAR_TAB_NAMES } from "./gearSort.js";
import type { ItemMod } from "./types.js";

export const STASH_SCORING_VERSION = "stash-2026-09-14.3";

export interface StashValuationSettings {
  league: string;
  sourceTab: string;
  destinationFolder: string;
  routingMode: "class" | "purpose";
  /** Canonical sorter destination -> exact user tab label. */
  classTabs: Record<string, string>;
  valuableTab: string;
  craftTab: string;
  reviewTab: string;
  minChaos: number;
  minCraftScore: number;
  minMarketConfidence: number;
  maxAgeMinutes: number;
  /** Per-family score multipliers, saved with the explicit league. */
  weights: Record<string, number>;
}

export interface StashMarketQuote {
  state: "priced" | "no-comparables" | "unavailable" | "unsupported";
  league: string;
  provider: string;
  fetchedAt: string;
  /** Earliest expiry of the comparable listings and any currency conversion evidence. */
  validUntil?: string;
  /** A provider-enforced retry deadline; callers must pause further lookups until this time. */
  retryAfter?: string;
  currency: "chaos";
  low?: number;
  fair?: number;
  high?: number;
  sampleSize: number;
  candidateCount: number;
  confidence: number;
  reasons: string[];
  tradeUrl?: string;
  cached?: boolean;
}

export interface StashModScore {
  text: string;
  familyId?: string;
  label?: string;
  tier?: number;
  points: number;
  multiplier: number;
  /** Copied game metadata, separate from the heuristic score band above. */
  observedAffix?: { kind: "prefix" | "suffix"; name?: string; tier?: number; group: number };
  /** Strength used for crafting when complete accessory annotations supply the class-specific tier. */
  craftTier?: number;
}

export interface StashValuationRow {
  id: string;
  rawText: string;
  name: string;
  baseType: string;
  itemClass: string;
  itemLevel?: number;
  sourceTab: string;
  row?: number;
  col?: number;
  fingerprint?: string;
  scoreVersion: string;
  gearScore: number;
  craftScore: number;
  mods: StashModScore[];
  quote: StashMarketQuote;
  decision: "valuable" | "craft" | "review" | "leave";
  destination: string;
  status: "stay" | "planned" | "moved" | "failed";
  actualDestination?: string;
  reasons: string[];
}

export interface StashValuationReport {
  schemaVersion: 1;
  id: string;
  startedAt: string;
  finishedAt?: string;
  league: string;
  settings: StashValuationSettings;
  scoreVersion: string;
  mode: "scan" | "move";
  status: "running" | "complete" | "incomplete" | "stopped" | "failed";
  sourceTab: string;
  scannedItems: number;
  unreadCells: Array<{ row: number; col: number; reason?: string }>;
  rows: StashValuationRow[];
  errors: string[];
}

export function defaultStashValuationSettings(): StashValuationSettings {
  return { league: "", sourceTab: "Dump", valuableTab: "Sell", craftTab: "Craft", reviewTab: "Review",
    destinationFolder: "G", routingMode: "class", classTabs: {
      "1h Mace": "1h Mace", QuarterStaff: "QuarterStaff", Spears: "Spears", Shields: "Shields", Wands: "Wands",
      Jewels: "Jewels", Amulets: "Amulets", Rings: "Rings", Helmets: "Helmets", OffHands: "OffHands",
      "Body Armor": "Body Armour", Gloves: "Gloves", "Bow/Crossbow": "Bow/Crossbow", Belts: "Belts", Boots: "Boots",
      "2h Mace": "2h Mace", Sceptres: "Sceptres", Staves: "Staves",
    },
    minChaos: 1, minCraftScore: 70, minMarketConfidence: 65, maxAgeMinutes: 60, weights: {} };
}

/** Configuration errors must surface before scanning or moving anything. */
export function validateStashValuationSettings(value: unknown, requireLeague = true): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["Invalid valuation settings."];
  const input = value as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof input.league !== "string" || input.league.length > 80 ||
      (requireLeague && (!input.league.trim() || input.league.trim().toLowerCase() === "auto")) ||
      (input.league && !/^[\p{L}\p{N}][\p{L}\p{N} '()-]*$/u.test(input.league))) {
    errors.push("Choose the exact league; automatic league selection is not used for stash valuation.");
  }
  const names: string[] = [];
  const validTab = (name: unknown): name is string => typeof name === "string" && !!name.trim() && name.length <= 50 &&
    !/[\r\n\x00-\x1f]/.test(name) && !/~(?:b\/o|price)|remove.?only/i.test(name);
  if (!validTab(input.destinationFolder)) errors.push("Invalid destination folder name.");
  if (input.routingMode !== "class" && input.routingMode !== "purpose") errors.push("Invalid routing mode.");
  for (const key of ["sourceTab", "valuableTab", "craftTab", "reviewTab"] as const) {
    const name = input[key];
    if (!validTab(name)) errors.push(`Invalid ${key} name.`);
    else names.push(name.trim().toLowerCase());
  }
  if (new Set(names).size !== names.length) errors.push("Source, sale, crafting, and review tabs must have distinct names.");
  if (!input.classTabs || typeof input.classTabs !== "object" || Array.isArray(input.classTabs)) errors.push("Invalid class tab mapping.");
  else for (const [key, label] of Object.entries(input.classTabs)) {
    if (!(GEAR_TAB_NAMES as readonly string[]).includes(key) || !validTab(label)) errors.push(`Invalid class tab mapping for ${key}.`);
  }
  for (const [key, max] of [["minChaos", 1_000_000], ["minCraftScore", 100], ["minMarketConfidence", 100], ["maxAgeMinutes", 1440]] as const) {
    const n = input[key];
    if (typeof n !== "number" || !Number.isFinite(n) || n < (key === "maxAgeMinutes" ? 1 : 0) || n > max) errors.push(`Invalid ${key}.`);
  }
  if (!input.weights || typeof input.weights !== "object" || Array.isArray(input.weights)) errors.push("Invalid scoring weights.");
  else for (const [key, weight] of Object.entries(input.weights)) {
    if (!MOD_FAMILIES.some(family => family.id === key) || typeof weight !== "number" || !Number.isFinite(weight) || weight < 0 || weight > 5) {
      errors.push(`Invalid score multiplier for ${key}; use a known family and a number from 0 to 5.`);
    }
  }
  return errors;
}

export function unavailableStashQuote(league: string, reason: string, at = new Date().toISOString()): StashMarketQuote {
  return { state: "unavailable", league, provider: "trade2", fetchedAt: at, currency: "chaos", sampleSize: 0,
    candidateCount: 0, confidence: 0, reasons: [reason] };
}

const clampScore = (score: number) => Math.max(0, Math.min(100, Math.round(score)));

type CraftModMatch = NonNullable<ReturnType<typeof matchModFamily>> & { affixGroup?: number };
type JewelArchetype = "general-defence" | "player-attack" | "player-caster" | "minion";
const JEWEL_ARCHETYPES: JewelArchetype[] = ["general-defence", "player-attack", "player-caster", "minion"];

function matchStashMod(text: string, itemClass: string): CraftModMatch | undefined {
  const match = matchModFamily(text, { itemClass });
  // Family regexes match substrings. Other entities cannot inherit player
  // stats; retain only the explicitly supported minion damage/speed cases.
  const otherSubject = /^\s*(?:(?:your|nearby|allied|summoned)\s+)*(?:minions?|offerings?|totems?|traps?|mines?|allies|enemies|enemy|companions?|spectres?|skeletons?)\b/i.test(text);
  const supportedMinion = /^\s*Minions?\b/i.test(text) && ["jewel-minion-speed", "jewel-damage"].includes(match?.family.id ?? "");
  if (otherSubject && !supportedMinion) return undefined;
  // Require the entire life/ES/mana statement, including its subject, to
  // match. This also rejects suffix forms such as "maximum Life of Totems".
  if (match && ["life", "mana", "energy-shield-flat", "jewel-life", "jewel-es"].includes(match.family.id) &&
      !new RegExp(`^(?:${match.family.pattern})$`, "i").test(text.trim())) return undefined;
  return match;
}

interface ObservedAffixes {
  prefixes: number;
  suffixes: number;
  complete: boolean;
  byLine: Map<number, NonNullable<StashModScore["observedAffix"]>>;
}

/** Only known two-line shapes establish a hybrid; a missing header must not silently merge unrelated affixes. */
function isSupportedHybrid(kind: "prefix" | "suffix", mods: readonly ItemMod[]): boolean {
  if (mods.length !== 2) return false;
  const [first, second] = mods.map(mod => mod.text);
  if (kind === "suffix") return /^(?:\+\d+ to Accuracy Rating|\d+% increased Mana Regeneration Rate)$/i.test(first!) &&
    /^\d+% increased Light Radius$/i.test(second!);
  return (/^\d+% increased Physical Damage$/i.test(first!) && /^\+\d+ to Accuracy Rating$/i.test(second!)) ||
    (/^\d+% increased Spell Damage$/i.test(first!) && /^\+\d+ to maximum Mana$/i.test(second!)) ||
    (/^\d+% increased (?:Armour|Evasion Rating|Energy Shield|Armour and Evasion|Armour and Energy Shield|Evasion and Energy Shield)$/i.test(first!) &&
      /^\+\d+ to maximum (?:Life|Mana)$/i.test(second!)) ||
    (/^\+\d+ to Armour$/i.test(first!) && /^\+\d+ to (?:Evasion Rating|maximum Energy Shield)$/i.test(second!)) ||
    (/^\+\d+ to Evasion Rating$/i.test(first!) && /^\+\d+ to maximum Energy Shield$/i.test(second!));
}

/** Source line positions preserve affix grouping even when one annotation owns several parsed modifier lines. */
function observeAdvancedAffixes(rawText: string, explicit: readonly ItemMod[]): ObservedAffixes | undefined {
  const groups: Array<NonNullable<StashModScore["observedAffix"]> & { mods: ItemMod[] }> = [];
  const byLine = new Map(explicit.map(mod => [mod.line, mod]));
  let active: typeof groups[number] | undefined;
  let seen = false;
  let accounted = 0;
  let complete = explicit.every(mod => mod.line !== undefined);
  rawText.replace(/\r\n?/g, "\n").split("\n").forEach((source, line) => {
    const text = source.trim();
    if (!text) return;
    if (text === "--------") { active = undefined; return; }
    if (text.startsWith("{")) {
      active = undefined;
      if (/\b(?:prefix|suffix)\b/i.test(text)) seen = true;
      const header = text.match(/^\{\s*(Prefix|Suffix)\s+Modifier(?:\s+"([^"]+)")?(?:\s+\(Tier:\s*(\d+)\))?(?:\s+—\s+[^{}]+)?\s*\}$/i);
      if (header) {
        active = { kind: header[1]!.toLowerCase() as "prefix" | "suffix", group: line,
          ...(header[2] ? { name: header[2] } : {}), ...(header[3] ? { tier: Number(header[3]) } : {}), mods: [] };
        groups.push(active);
      }
      return;
    }
    const mod = byLine.get(line);
    if (mod) {
      if (active) { active.mods.push(mod); accounted += 1; }
      else complete = false;
    } else active = undefined;
  });
  if (!seen) return undefined;
  return { prefixes: groups.filter(group => group.kind === "prefix").length,
    suffixes: groups.filter(group => group.kind === "suffix").length,
    byLine: new Map(groups.flatMap(({ mods, ...annotation }) => mods.map(mod => [mod.line!, annotation] as const))),
    complete: complete && accounted === explicit.length && groups.length > 0 &&
      groups.every(group => group.mods.length === 1 || isSupportedHybrid(group.kind, group.mods)) };
}

/** Generic player damage/speed does not improve minions; broad family regexes cannot establish that distinction. */
function jewelArchetypes(familyId: string, text: string): readonly JewelArchetype[] {
  if (/\bminions?\b/i.test(text)) return ["minion"];
  if (/\b(?:totems?|traps?|mines?)\b/i.test(text)) return [];
  if (["jewel-life", "jewel-es", "jewel-all-res", "jewel-chaos-res", "jewel-rarity"].includes(familyId)) return JEWEL_ARCHETYPES;
  if (familyId === "jewel-minion-speed") return ["minion"];
  if (familyId === "jewel-attack-speed") return ["player-attack"];
  if (familyId === "jewel-cast-speed") return ["player-caster"];
  if (familyId === "jewel-damage" || familyId === "jewel-leech") {
    if (/\b(?:attacks?|melee|bows?|crossbows?|spears?|maces?|swords?|axes?|claws?|quarterstaves?|quarterstaff|unarmed|weapons?)\b/i.test(text)) return ["player-attack"];
    if (/\bspells?\b/i.test(text)) return ["player-caster"];
  }
  return familyId.startsWith("jewel-") ? ["player-attack", "player-caster"] : [];
}

function strongestCraftFamilies(matches: readonly CraftModMatch[]): CraftModMatch[] {
  const familyBest = new Map<string, CraftModMatch>();
  for (const match of matches) {
    if (!familyBest.has(match.family.id) || modPoints(match) > modPoints(familyBest.get(match.family.id)!)) familyBest.set(match.family.id, match);
  }
  // A hybrid still represents one retained affix, even when both lines match desirable families.
  const affixBest = new Map<number | string, CraftModMatch>();
  for (const match of [...familyBest.values()].filter(match => match.tier > 0 && match.tier <= 2)) {
    const key = match.affixGroup ?? match.family.id;
    const old = affixBest.get(key);
    if (!old || match.tier < old.tier || (match.tier === old.tier && modPoints(match) > modPoints(old))) affixBest.set(key, match);
  }
  return [...affixBest.values()];
}

const hasStrongCraftPair = (matches: readonly CraftModMatch[]) => matches.length >= 2 && matches.some(match => match.tier === 1);
const craftModPoints = (matches: readonly CraftModMatch[], settings: StashValuationSettings) =>
  matches.reduce((sum, match) => sum + (20 + (match.tier === 1 ? 15 : 0)) * (settings.weights[match.family.id] ?? 1), 0);

/** Scores describe item properties, never an invented currency amount or crafting profit. */
export function evaluateStashItem(rawText: string, quote: StashMarketQuote, settings: StashValuationSettings,
  context: { id?: string; row?: number; col?: number; at?: string } = {}): StashValuationRow {
  const at = context.at ?? new Date().toISOString();
  const parsed = parseItemText(rawText);
  const readable = looksLikePoeItemText(rawText) && parsed.itemClass !== "Unknown";
  const explicit = parsed.mods.filter(mod => !mod.implicit && !["implicit", "enchant"].includes(mod.kind ?? ""));
  const jewel = /^Jewels$/i.test(parsed.itemClass);
  const affixes = !jewel && /^Rare$/i.test(parsed.rarity) ? observeAdvancedAffixes(rawText, explicit) : undefined;
  const useObservedTiers = !!affixes?.complete && /^(?:Amulets?|Rings?|Belts?)$/i.test(parsed.itemClass) &&
    explicit.every(mod => (affixes.byLine.get(mod.line!)?.tier ?? 0) > 0);
  const craftingMatch = (mod: ItemMod): CraftModMatch | undefined => {
    const match = matchStashMod(mod.text, parsed.itemClass);
    if (!match) return undefined;
    const annotation = affixes?.byLine.get(mod.line!);
    return { ...match, ...(affixes?.complete && annotation ? { affixGroup: annotation.group } : {}),
      ...(useObservedTiers && annotation?.tier ? { tier: annotation.tier <= 3 ? annotation.tier as 1 | 2 | 3 : 0 } : {}) };
  };
  const mods: StashModScore[] = parsed.mods.map(mod => {
    const match = matchStashMod(mod.text, parsed.itemClass);
    const multiplier = match ? settings.weights[match.family.id] ?? 1 : 1;
    return { text: mod.text, points: match ? Math.round(modPoints(match) * multiplier * 10) / 10 : 0, multiplier,
      ...(match ? { familyId: match.family.id, label: match.family.label, tier: match.tier } : {}),
      ...(affixes?.byLine.has(mod.line!) ? { observedAffix: affixes.byLine.get(mod.line!) } : {}),
      ...(useObservedTiers && match && affixes?.byLine.has(mod.line!) ? { craftTier: craftingMatch(mod)?.tier } : {}) };
  });
  const gearScore = readable && parsed.identified ? clampScore(mods.reduce((sum, mod) => sum + mod.points, 0) / 70 * 100) : 0;
  const reasons: string[] = [];
  // Without complete advanced annotations, displayed lines only suggest room.
  const archetype = archetypeForClass(parsed.itemClass);
  const explicitFacts = explicit.map(mod => ({ text: mod.text, match: craftingMatch(mod) }));
  const unknownExplicit = explicitFacts.filter(fact => !fact.match).length;
  const eligibleFacts = explicitFacts.filter((fact): fact is { text: string; match: CraftModMatch } =>
    !!fact.match && (settings.weights[fact.match.family.id] ?? 1) > 0 &&
      (jewel ? fact.match.family.id.startsWith("jewel-") : !!archetype?.desirableFamilies.includes(fact.match.family.id)));
  const candidates = (jewel ? JEWEL_ARCHETYPES : ["item-class"] as const).map(candidate => ({
    archetype: candidate,
    strong: strongestCraftFamilies(eligibleFacts.filter(fact => !jewel || jewelArchetypes(fact.match.family.id, fact.text).includes(candidate as JewelArchetype)).map(fact => fact.match)),
  })).sort((a, b) => Number(hasStrongCraftPair(b.strong)) - Number(hasStrongCraftPair(a.strong)) || craftModPoints(b.strong, settings) - craftModPoints(a.strong, settings));
  const selected = candidates[0]!;
  const strong = selected.strong;
  const craftStatus = rawText.split(/\r?\n/).map(line => line.trim().replace(/\s+/g, " ")).find(line =>
    /^(?:(?:Twice )?Corrupted|Mirrored|Split|Unmodifiable|Sanctified|Cannot be modified)$/i.test(line));
  const blockedCraft = !readable || !parsed.identified || parsed.corrupted || !!craftStatus || unknownExplicit > 0 ||
    !/^(?:Magic|Rare)$/i.test(parsed.rarity) || (!jewel && !archetype);
  const withinOrdinaryLimits = !affixes || (affixes.prefixes <= 3 && affixes.suffixes <= 3);
  const sparse = withinOrdinaryLimits && (affixes?.complete ? affixes.prefixes < 3 || affixes.suffixes < 3
    : /^Magic$/i.test(parsed.rarity) ? explicit.length <= 2 : explicit.length <= (jewel ? 3 : 4));
  if (affixes) {
    if (!withinOrdinaryLimits) reasons.push(`Observed ${affixes.prefixes} prefix and ${affixes.suffixes} suffix groups exceed ordinary rare limits; crafting room is not established.`);
    else if (affixes.complete) reasons.push(`Advanced affix annotations account for ${explicit.length} explicit lines in ${affixes.prefixes} prefix and ${affixes.suffixes} suffix groups; ${3 - affixes.prefixes} prefix and ${3 - affixes.suffixes} suffix slots remain under ordinary rare limits.`);
    else reasons.push(`Advanced affix annotations are incomplete or ambiguous (${affixes.prefixes} observed prefix and ${affixes.suffixes} observed suffix groups); using the conservative ${explicit.length}-line heuristic without asserting open affix slots.`);
  }
  if (useObservedTiers) reasons.push("Craft strength uses copied affix tiers for known accessory modifiers; heuristic gear score bands remain separate. Modifier tiers do not establish market value.");
  const strongCraft = !blockedCraft && sparse && hasStrongCraftPair(strong);
  const craftScore = !blockedCraft && sparse
    ? clampScore(craftModPoints(strong, settings) + ((parsed.itemLevel ?? 0) >= 80 ? 10 : 0)) : 0;
  if (strongCraft) reasons.push(`${strong.length} strong modifier families suit this item class; ${affixes?.complete ? "annotated affix groups establish ordinary crafting room" : `${explicit.length} explicit lines suggest crafting room`}. Verify affix restrictions and crafting costs first.`);
  if (strongCraft && jewel) reasons.push(`The strong jewel modifiers share a ${selected.archetype} scoring archetype.`);
  if (jewel && !hasStrongCraftPair(strong) && strongestCraftFamilies(eligibleFacts.map(fact => fact.match)).length >= 2) {
    reasons.push("The strong jewel modifiers do not share a supported crafting archetype; player and minion bonuses are evaluated separately.");
  }
  if (craftStatus || parsed.corrupted) reasons.push(`${craftStatus ?? "Corrupted"}: excluded from the crafting route.`);
  if (unknownExplicit) reasons.push("Unrecognized explicit modifier lines exclude automated crafting assessment; review the full item first.");
  if (!parsed.identified) reasons.push("Unidentified: identify and rescan to assess modifiers.");
  const unknownMods = mods.filter(mod => !mod.familyId).length;
  if (unknownMods) reasons.push(`${unknownMods} modifier line(s) are outside the scoring knowledge base; the score can miss value.`);
  const age = Date.parse(at) - Date.parse(quote.fetchedAt);
  const validExpiry = quote.validUntil === undefined || (typeof quote.validUntil === "string" &&
    Number.isFinite(Date.parse(quote.validUntil)) && Date.parse(quote.validUntil) > Date.parse(at));
  if (!validExpiry) reasons.push("The market evidence expiry is invalid or elapsed; the quote was rejected.");
  const finiteBand = [quote.low, quote.fair, quote.high].every(n => typeof n === "number" && Number.isFinite(n) && n > 0);
  const validMarket = quote.state === "priced" && quote.league === settings.league && quote.currency === "chaos" &&
    Number.isFinite(age) && age >= -60_000 && age <= settings.maxAgeMinutes * 60_000 && validExpiry && finiteBand &&
    quote.low! <= quote.fair! && quote.fair! <= quote.high! && quote.sampleSize >= 3 &&
    Number.isFinite(quote.confidence) && quote.confidence >= settings.minMarketConfidence;
  let decision: StashValuationRow["decision"] = "review";
  if (readable && parsed.identified && validMarket && quote.low! > settings.minChaos) {
    decision = "valuable";
    reasons.unshift(`Conservative asking-price estimate ${quote.low} chaos exceeds ${settings.minChaos} chaos (${quote.sampleSize} comparable listings).`);
  } else if (strongCraft && craftScore >= settings.minCraftScore) {
    decision = "craft";
    reasons.unshift(`Crafting candidate score ${craftScore}/100 meets ${settings.minCraftScore}; this is not a profit estimate.`);
  } else if (readable && parsed.identified && validMarket && quote.high! <= settings.minChaos && unknownMods === 0) {
    decision = "leave";
    reasons.unshift(`Comparable asking-price range does not exceed ${settings.minChaos} chaos; leave in ${settings.sourceTab}.`);
  } else {
    reasons.unshift(`Value needs review; leave in ${settings.sourceTab}.`);
    if (quote.league !== settings.league) reasons.push("The quote belongs to a different league and was rejected.");
    if (!Number.isFinite(age) || age < -60_000 || age > settings.maxAgeMinutes * 60_000) reasons.push("The market timestamp is missing, invalid, or stale.");
    if (!readable) reasons.push("Copied item text is incomplete or unrecognized.");
    if (quote.state === "priced" && !validMarket) reasons.push("The price evidence does not meet the sample, confidence, or freshness requirements.");
  }
  let destination = decision === "valuable" ? settings.valuableTab : decision === "craft" ? settings.craftTab : settings.sourceTab;
  if (settings.routingMode === "class" && (decision === "valuable" || decision === "craft")) {
    const mapped = settings.classTabs[destForItemClass(parsed.itemClass)];
    if (mapped) destination = mapped;
    else {
      decision = "review";
      destination = settings.sourceTab;
      reasons.unshift(`No destination tab is configured for ${parsed.itemClass}; retain in ${settings.sourceTab} for review.`);
    }
  }
  return { id: context.id ?? `${settings.sourceTab}:${context.row ?? "?"}:${context.col ?? "?"}:${parsed.fingerprint}`,
    rawText, name: parsed.name, baseType: parsed.baseType, itemClass: parsed.itemClass,
    ...(parsed.itemLevel !== undefined ? { itemLevel: parsed.itemLevel } : {}), sourceTab: settings.sourceTab,
    ...(context.row !== undefined ? { row: context.row } : {}), ...(context.col !== undefined ? { col: context.col } : {}),
    fingerprint: parsed.fingerprint, scoreVersion: STASH_SCORING_VERSION, gearScore, craftScore, mods, quote,
    decision, destination, status: decision === "valuable" || decision === "craft" ? "planned" : "stay",
    reasons: [...reasons, ...quote.reasons] };
}
