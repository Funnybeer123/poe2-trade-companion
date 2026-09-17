import snapshot from "./knowledge/forbidden-rites.json" with { type: "json" };
import { archetypeForClass } from "./crafting.js";
import { destForItemClass } from "./gearSort.js";
import { parseItemText, looksLikePoeItemText } from "./parseItem.js";
import { evaluateStashItem, matchStashMod, observeAdvancedAffixes, validateStashValuationSettings,
  type StashValuationRow, type StashValuationReport, type StashValuationSettings } from "./stashValuation.js";
import type { ItemMod, ParsedItem } from "./types.js";

export const BATCH_MODEL = "batch-triage-v1";
export interface LeagueKnowledge {
  schemaVersion: number; id: string; league: string; patch: string; accessedAt: string; tierOrder: string; refreshPolicy: string;
  sample: { guideCount: number; ladderCharacters: number; marketListings: number; limitations: string[] };
  sources: Array<{ id: string; url: string; publishedAt: string | null; kind: string }>;
  archetypes: Array<{ id: string; label: string; subject: string; sources: string[]; slots: Record<string, string[] | undefined>; uniqueNames: string[]; bases: string[] }>;
  baseOpportunities: Array<{ base: string; itemClass: string; minimumItemLevel: number; source: string; reason: string }>;
  lifeTiers: Array<{ classes: string[]; ranges: number[][] }>;
}
export const BUNDLED_KNOWLEDGE: LeagueKnowledge = snapshot;
export type Outcome = "keep" | "craft" | "review" | "low-priority";
type Subject = "general" | "player" | "attack" | "spell" | "minion" | "unknown";
export interface AssessedModifier {
  text: string; family?: string; group: string; kind?: "prefix" | "suffix";
  tier?: number; tierEvidence: "advanced" | "verified-range" | "unknown";
  ranges: Array<{ min: number; max: number }>; rollPosition?: number;
  useful: boolean; subject: Subject; points: number;
}
export interface ItemAssessment {
  model: string; knowledgeId: string; patch: string; outcome: Outcome;
  components: { modifierQuality: number; combination: number; generalUsefulness: number; craftingPotential: number; confidence: number };
  modifiers: AssessedModifier[];
  resistance: { fire: number; cold: number; lightning: number; chaos: number; elementalTotal: number; elementalCoverage: number; triple: boolean; affixGroups: number };
  crafting: { limits?: { prefixes: number; suffixes: number }; prefixes?: number; suffixes?: number;
    freePrefixes?: number; freeSuffixes?: number; restricted: boolean; routes: string[] };
  matches: Array<{ id: string; label: string; families: string[]; urls: string[] }>;
  uncertainty: string[]; reasons: string[]; override?: "keep" | "review";
}
const score = (value: number) => Math.max(0, Math.min(100, Math.round(value)));
const explicitMod = (mod: ItemMod) => !mod.implicit && !["implicit", "enchant"].includes(mod.kind ?? "");
const isOrdinaryJewel = (item: ParsedItem) => item.itemClass === "Jewels" && ["Ruby", "Emerald", "Sapphire"].includes(item.baseType);
const defensive = /^(life|energy-shield-flat|energy-shield-percent|armour-percent|evasion-percent|defence-flat|movement-speed|.*-res|attribute|all-attributes|jewel-es|jewel-life)$/;
function subjectOf(text: string, family: string): Subject {
  if (/\b(?:totems?|traps?|mines?|offerings?|companions?)\b/i.test(text)) return "unknown";
  if (/\bminions?\b/i.test(text)) return "minion";
  if (/spell|cast-speed|mana/.test(family) || /\b(?:Spells?|Spell Skills)\b/i.test(text)) return "spell";
  if (/attack|adds-|phys-pct|additional-projectiles/.test(family) || /\b(?:Attacks?|Melee|Bows?|Crossbows?|Spears?|Maces?|Quarterstaves)\b/i.test(text)) return "attack";
  if (/damage|crit|penetration|leech/.test(family)) return "player";
  return "general";
}
function familyOf(mod: ItemMod, itemClass: string): string | undefined {
  const text = mod.text;
  if (!explicitMod(mod) && itemClass === "Rings" && /^Grants 1 additional Skill Slots?$/.test(text)) return "skill-slots";
  if (/^Minions (?:deal|have) \d+% increased Damage$/i.test(text)) return "minion-damage";
  if (/^Minions have \d+% increased Attack and Cast Speed$/i.test(text)) return itemClass === "Jewels" ? "jewel-minion-speed" : "minion-speed";
  const known = matchStashMod(text, itemClass);
  if (known) return known.family.id;
  if (/^\d+(?:\.\d+)? Life Regeneration per second$/i.test(text)) return "life-regen";
  if (/^\d+% increased Armour$/i.test(text)) return "armour-percent";
  if (/^\d+% increased Evasion Rating$/i.test(text)) return "evasion-percent";
  if (/^\d+% increased (?:Armour and Evasion|Armour and Energy Shield|Evasion and Energy Shield|Armour, Evasion and Energy Shield)$/i.test(text)) return "armour-percent";
  if (/^\+\d+ to (?:Armour|Evasion Rating)$/i.test(text)) return "defence-flat";
  if (/^\+\d+ to Accuracy Rating$/i.test(text)) return "accuracy";
  if (/^\d+% increased Light Radius$/i.test(text)) return "light-radius";
  if (/^\+\d+% to (?:Fire|Cold|Lightning|Chaos) and (?:Fire|Cold|Lightning|Chaos) Resistances$/i.test(text)) return "mixed-res";
  return undefined;
}
function inferLife(mod: ItemMod, item: ParsedItem, knowledge: LeagueKnowledge): number | undefined {
  if (!/^\+\d+ to maximum Life$/.test(mod.text) || item.quality || mod.kind !== "explicit") return;
  const table = knowledge.lifeTiers.find(entry => entry.classes.includes(item.itemClass));
  const candidates = table?.ranges.flatMap(([min, max, level], index) =>
    mod.value! >= min! && mod.value! <= max! && item.itemLevel !== undefined && item.itemLevel >= level! ? [index + 1] : []) ?? [];
  return candidates.length === 1 ? candidates[0] : undefined;
}
/** No I/O or market provider is reachable from this model. Unknowns are carried as evidence. */
export function assessItem(rawText: string, settings: StashValuationSettings, knowledge: LeagueKnowledge = snapshot): ItemAssessment {
  const item = parseItemText(rawText);
  const explicit = item.mods.filter(explicitMod);
  const affixes = observeAdvancedAffixes(rawText, explicit);
  const ordinary = !!archetypeForClass(item.itemClass) && item.itemClass !== "Sceptres";
  const jewel = isOrdinaryJewel(item);
  // Absent Amulet changes affix capacity; its crafting mechanics are not yet
  // verified across rarities. Never apply ordinary accessory limits to it.
  const supported = (ordinary || jewel || item.itemClass === "Sceptres") && item.baseType !== "Absent Amulet";
  const normal = item.rarity === "Normal", magic = item.rarity === "Magic", rare = item.rarity === "Rare";
  const limits = supported && (normal || magic || rare)
    ? { prefixes: magic ? 1 : jewel ? 2 : 3, suffixes: magic ? 1 : jewel ? 2 : 3 } : undefined;
  const grouped = normal && explicit.length === 0 || !!affixes?.complete;
  const prefixes = grouped ? affixes?.prefixes ?? 0 : undefined;
  const suffixes = grouped ? affixes?.suffixes ?? 0 : undefined;
  const validGroups = grouped && !!limits && prefixes! <= limits.prefixes && suffixes! <= limits.suffixes;
  const restricted = rawText.split(/\r?\n/).some(line => /^(?:(?:Twice )?Corrupted|Mirrored|Split|Sanctified|Unmodifiable|Cannot be modified)$/i.test(line.trim().replace(/\s+/g, " "))) ||
    explicit.some(mod => mod.kind === "fractured" || mod.kind === "crafted");
  const uncertainty: string[] = [];
  if (!looksLikePoeItemText(rawText) || item.itemClass === "Unknown" || !/^Rarity:/im.test(rawText) || !item.identified) uncertainty.push("Incomplete or unidentified item text.");
  if (settings.league !== knowledge.league) uncertainty.push("No researched knowledge snapshot for this selected league.");
  if (settings.knowledgeId && settings.knowledgeId !== knowledge.id) throw new Error("Selected knowledge snapshot is not loaded.");
  if (!supported && item.rarity !== "Unique") uncertainty.push("Special item class or base lacks a supported assessment model.");
  if (item.itemLevel === undefined && item.rarity !== "Unique") uncertainty.push("Item level is unknown.");
  if (!validGroups && (rare || magic)) uncertainty.push("Affix grouping or class-specific capacity is incomplete.");
  const mods: AssessedModifier[] = item.mods.map((mod, index) => {
    const family = familyOf(mod, item.itemClass);
    const subject = family ? subjectOf(mod.text, family) : "unknown";
    const annotation = affixes?.complete ? affixes.byLine.get(mod.line!) : undefined;
    const tier = annotation?.tier && annotation.tier >= 1 ? annotation.tier :
      settings.league === knowledge.league && !mod.annotation ? inferLife(mod, item, knowledge) : undefined;
    // Hybrid defence/life affixes have their own tier table. A life line in
    // a multi-line group must never be compared against standalone flat life.
    const standalone = !annotation || [...affixes!.byLine.values()].filter(other => other.group === annotation.group).length === 1;
    const verifiedLife = standalone ? inferLife(mod, item, knowledge) : undefined;
    if (annotation?.tier && verifiedLife && annotation.tier !== verifiedLife) uncertainty.push("Advanced life tier conflicts with verified class range.");
    const ranges = mod.ranges ?? [];
    const range = ranges[0];
    const rollPosition = range && mod.value !== undefined && range.max >= range.min ?
      (range.max === range.min ? 1 : Math.max(0, Math.min(1, (mod.value - range.min) / (range.max - range.min)))) : undefined;
    if (ranges.some((v, i) => v.max < v.min || mod.values?.[i] === undefined || mod.values[i]! < v.min || mod.values[i]! > v.max)) uncertainty.push("Copied roll is outside its annotated range.");
    const slotFamilies = archetypeForClass(item.itemClass)?.desirableFamilies ?? [];
    const useful = !!family && subject !== "unknown" && (
      family === "skill-slots" && !explicitMod(mod) ||
      jewel && family.startsWith("jewel-") ||
      slotFamilies.includes(family) ||
      supported && defensive.test(family) && !/weapon/.test(archetypeForClass(item.itemClass)?.id ?? "") ||
      ["Amulets", "Rings", "Foci"].includes(item.itemClass) && ["cast-speed", "spell-damage", "mana"].includes(family) ||
      ["Sceptres", "Amulets", "Helmets", "Jewels"].includes(item.itemClass) && subject === "minion"
    ) && (settings.weights[family] ?? 1) > 0;
    const points = useful && tier ? (tier === 1 ? 25 : tier === 2 ? 21 : tier === 3 ? 10 : 3) *
      (jewel ? 0.4 + 0.6 * (rollPosition ?? 0.5) : 1) * (settings.weights[family!] ?? 1) : 0;
    return { text: mod.text, family, subject, group: String(annotation?.group ?? "line-" + index), kind: annotation?.kind,
      tier, tierEvidence: annotation?.tier ? "advanced" : tier ? "verified-range" : "unknown", ranges, rollPosition, useful, points };
  });
  // Incomplete implicit/enchant recognition remains visible too, but it is never an affix slot.
  const unknown = mods.filter(mod => !mod.family || mod.subject === "unknown");
  if (unknown.length) uncertainty.push(unknown.length + " unrecognized modifier line(s).");
  const explicitScores = mods.filter((_, index) => explicitMod(item.mods[index]!));
  const missingTiers = explicitScores.filter(mod => mod.tier === undefined);
  if (missingTiers.length && (rare || magic)) uncertainty.push(missingTiers.length + " explicit modifier tier(s) are unknown.");
  const resistance = { fire: 0, cold: 0, lightning: 0, chaos: 0, elementalTotal: 0, elementalCoverage: 0, triple: false, affixGroups: 0 };
  const resistanceGroups = new Set<string>();
  item.mods.forEach((mod, index) => {
    const text = mod.text;
    const all = /^\+(\d+)% to all Elemental Resistances$/i.exec(text);
    const individual = /^\+(\d+)% to (Fire|Cold|Lightning|Chaos)(?: and (Fire|Cold|Lightning|Chaos))? Resistances?$/i.exec(text);
    if (!all && !individual) return;
    for (const element of ["fire", "cold", "lightning", "chaos"] as const) {
      if (all && element !== "chaos") resistance[element] += Number(all[1]);
      if (individual && [individual[2]?.toLowerCase(), individual[3]?.toLowerCase()].includes(element)) resistance[element] += Number(individual[1]);
    }
    if (explicitMod(mod)) resistanceGroups.add(mods[index]!.group);
  });
  resistance.elementalTotal = resistance.fire + resistance.cold + resistance.lightning;
  resistance.elementalCoverage = [resistance.fire, resistance.cold, resistance.lightning].filter(n => n > 0).length;
  resistance.triple = resistance.elementalCoverage === 3;
  resistance.affixGroups = resistanceGroups.size;
  const best = (["attack", "spell", "minion"] as const).map(subject => {
    const selected = explicitScores.filter(mod => mod.useful && (mod.subject === "general" || mod.subject === subject || mod.subject === "player" && subject !== "minion"));
    const groups = new Map<string, AssessedModifier>();
    for (const mod of selected) if ((groups.get(mod.group)?.points ?? -1) < mod.points) groups.set(mod.group, mod);
    return { subject, selected: [...groups.values()], points: [...groups.values()].reduce((sum, mod) => sum + mod.points, 0) };
  }).sort((a, b) => b.points - a.points)[0]!;
  const strong = best.selected.filter(mod => mod.tier && mod.tier <= 2 && mod.points >= 14);
  const relevant = best.selected.filter(mod => mod.points >= 10);
  const families = relevant.map(mod => mod.family!);
  const defence = families.some(family => /^(life|energy-shield|jewel-es|jewel-life|armour-percent|evasion-percent)/.test(family));
  const weapon = /weapon/.test(archetypeForClass(item.itemClass)?.id ?? "") || item.itemClass === "Sceptres";
  const damage = families.some(family => /damage|adds-|phys-pct|skill-levels/.test(family));
  const speed = families.some(family => /speed/.test(family));
  // Resistances contribute coverage, while chaos remains a separate requirement.
  const resistCombo = defence && (([resistance.fire, resistance.cold, resistance.lightning].filter(n => n >= 30).length >= 2) ||
    resistance.chaos >= 20 && resistance.elementalTotal >= 35);
  const coherent = weapon ? damage && (speed || best.subject === "minion" && families.includes("spirit")) :
    jewel ? strong.length >= 2 : resistCombo || defence && strong.length >= 2 ||
      item.itemClass === "Boots" && families.includes("movement-speed") && relevant.length >= 2;
  const matches = settings.league !== knowledge.league ? [] : knowledge.archetypes.flatMap(archetype => {
    if (archetype.subject !== best.subject && families.some(f => !defensive.test(f))) return [];
    const wants = archetype.slots[item.itemClass] ?? [];
    const matched = families.filter(family => wants.includes(family));
    return matched.length >= 2 ? [{ id: archetype.id, label: archetype.label, families: matched,
      urls: knowledge.sources.filter(source => archetype.sources.includes(source.id)).map(source => source.url) }] : [];
  });
  const base = settings.league === knowledge.league ? knowledge.baseOpportunities.find(entry => entry.itemClass === item.itemClass &&
    entry.base === item.baseType && item.itemLevel !== undefined && item.itemLevel >= entry.minimumItemLevel) : undefined;
  const special = item.rarity === "Unique" && settings.league === knowledge.league ?
    knowledge.archetypes.find(archetype => archetype.uniqueNames.includes(item.name)) : undefined;
  const freePrefixes = validGroups ? limits!.prefixes - prefixes! : undefined;
  const freeSuffixes = validGroups ? limits!.suffixes - suffixes! : undefined;
  const room = validGroups && (freePrefixes! + freeSuffixes! > 0 || magic);
  const craftCandidate = supported && !restricted && item.identified && ((normal || magic) && !!base || room && strong.length >= 2 && coherent);
  const combination = coherent ? Math.min(100, 40 + strong.length * 10 + (matches.length ? 10 : 0)) : 0;
  const modifierQuality = score(best.points);
  const generalUsefulness = special ? 85 : score(best.points + (coherent ? 20 : 0));
  const craftingPotential = craftCandidate ? score(base ? 65 : 25 + best.points) : 0;
  const rules = settings.triageRules ?? { keepScore: 70, craftScore: 55, lowPriorityScore: 25 };
  const reasons = [
    "Local heuristic selection; scores are not prices or evidence of a sale above 1 chaos.",
    "Best compatible requirements: " + best.subject + "; " + strong.length + " useful T1/T2 affix groups.",
    "Resistance coverage: fire " + resistance.fire + ", cold " + resistance.cold + ", lightning " + resistance.lightning +
      "; elemental total " + resistance.elementalTotal + "; chaos " + resistance.chaos + " evaluated separately."
  ];
  if (base) reasons.push(base.reason);
  if (special) reasons.push("Build-enabling unique recognized in " + special.label + ". Its price and exact variant remain unverified.");
  if (resistance.triple && !resistCombo) reasons.push("Triple elemental coverage alone does not establish strong rolls or a useful defensive combination.");
  if (!coherent) reasons.push("The known modifiers do not establish a supported coherent combination.");
  if (restricted) reasons.push("Modification restriction blocks the modeled crafting routes; existing usefulness is assessed independently.");
  const routes: string[] = [];
  if (craftCandidate) routes.push(normal ? "Transmute this recognized base, then reassess the resulting affixes." :
    magic ? "Regal to rare, then reassess; new affix is random and may be unwanted." :
      "Consider adding an affix only in a confirmed free prefix/suffix slot; specific outcomes and costs are unknown.");
  if (room && !craftCandidate) routes.push("Space is confirmed but no supported improvement opportunity is established.");
  if (!validGroups && !normal) routes.push("Affix room unknown; obtain complete advanced annotations before planning additions.");
  if (validGroups) reasons.push(prefixes + " prefix / " + suffixes + " suffix groups; free " + freePrefixes + " / " + freeSuffixes + (magic ? " at magic rarity; rare promotion has separate capacity." : "."));
  // Uniques use their own recognition path. Unknown special effects are not scored as weak rare affixes.
  let outcome: Outcome = "review";
  if (special && item.identified) outcome = "keep";
  else if (!uncertainty.length) {
    if (coherent && generalUsefulness >= rules.keepScore) outcome = "keep";
    else if (craftCandidate && craftingPotential >= rules.craftScore) outcome = "craft";
    else if (!base && !strong.length && best.points <= rules.lowPriorityScore && explicitScores.length >= (jewel ? 3 : 4) && !coherent) {
      outcome = "low-priority";
      reasons.push("Complete known weak/irrelevant rolls, no recognized base or sampled special opportunity; retained in the ledger.");
    }
  }
  return { model: BATCH_MODEL, knowledgeId: knowledge.id, patch: settings.league === knowledge.league ? knowledge.patch : "unknown", outcome,
    components: { modifierQuality, combination, generalUsefulness, craftingPotential, confidence: score(95 - uncertainty.length * 18 - (matches.length ? 0 : 10)) },
    modifiers: mods, resistance, crafting: { limits, prefixes, suffixes, freePrefixes, freeSuffixes, restricted, routes }, matches,
    uncertainty: [...new Set(uncertainty)], reasons };
}
export function assessRow(original: StashValuationRow, settings: StashValuationSettings, at: string, knowledge: LeagueKnowledge = snapshot): StashValuationRow {
  const parsed = parseItemText(original.rawText);
  const assessment = assessItem(original.rawText, settings, knowledge);
  const override = settings.feedback?.[original.id];
  if (override) { assessment.override = override; assessment.outcome = override; assessment.reasons.push("Local user feedback override: " + override + "."); }
  // Reuse the existing strict market gate; discard its legacy crafting interpretation.
  const market = evaluateStashItem(original.rawText, original.quote, settings, { id: original.id, row: original.row, col: original.col, at });
  const priceConfirmed = market.decision === "valuable" && original.quote.low! > Math.max(1, settings.minChaos) &&
    original.quote.patch === assessment.patch;
  const eligible = override !== "review" && (priceConfirmed || ["keep", "craft"].includes(assessment.outcome));
  const destination = settings.routingMode === "class" ? settings.classTabs[destForItemClass(parsed.itemClass)] :
    assessment.outcome === "craft" ? settings.craftTab : settings.valuableTab;
  const row: StashValuationRow = { ...original, assessment, parsed, name: parsed.name, baseType: parsed.baseType,
    itemClass: parsed.itemClass, itemLevel: parsed.itemLevel, scoreVersion: BATCH_MODEL,
    gearScore: assessment.components.generalUsefulness, craftScore: assessment.components.craftingPotential,
    decision: override === "review" ? "review" : priceConfirmed ? "valuable" : assessment.outcome === "keep" ? "valuable" : assessment.outcome === "craft" ? "craft" : assessment.outcome === "low-priority" ? "leave" : "review",
    destination: eligible && destination ? destination : original.sourceTab, status: eligible && destination ? "planned" : "stay",
    reasons: [...assessment.reasons, ...assessment.uncertainty, ...assessment.crafting.routes,
      ...(priceConfirmed ? ["Fresh adequate comparable evidence exceeds the strict 1-chaos floor."] : [])] };
  if (eligible && !destination) { row.decision = "review"; row.reasons.push("No mapped destination; retain in source for review."); }
  if (original.status === "moved" || original.status === "failed") {
    row.status = original.status; row.destination = original.destination; row.actualDestination = original.actualDestination;
    row.reasons = [...new Set([...row.reasons, "Historical transfer receipt retained; capture coordinates are not a current location.", ...original.reasons])];
  }
  return row;
}
/** Caller validates the saved report before invoking this pure operation. */
export function assessBatch(saved: StashValuationReport, settings = saved.settings, at = new Date().toISOString(), knowledge: LeagueKnowledge = snapshot): StashValuationReport {
  const issues = validateStashValuationSettings(settings);
  if (issues.length) throw new Error(issues.join(" "));
  const report = structuredClone(saved);
  settings = { ...settings, sourceTab: saved.sourceTab, captureSource: saved.settings.captureSource };
  report.knowledgeSnapshots ??= {};
  report.knowledgeSnapshots[knowledge.id] = structuredClone(knowledge);
  report.capture ??= { id: saved.id, league: saved.league, patch: saved.league === knowledge.league ? knowledge.patch : "unknown",
    completedSources: saved.unreadCells.length === 0 && saved.scannedItems === saved.rows.length ? [saved.sourceTab] : [],
    complete: saved.unreadCells.length === 0 && saved.scannedItems === saved.rows.length && !["running", "stopped"].includes(saved.status) && (saved.rows.length > 0 || saved.status === "complete") };
  report.settings = structuredClone(settings); report.league = settings.league; report.scoreVersion = BATCH_MODEL;
  report.rows = saved.rows.map(row => assessRow(row, settings, at, knowledge));
  report.assessmentHistory ??= [];
  report.assessmentHistory.push({ id: at + ":" + report.assessmentHistory.length, at, model: BATCH_MODEL, knowledgeId: knowledge.id,
    patch: settings.league === knowledge.league ? knowledge.patch : "unknown", league: settings.league, settings: structuredClone(settings),
    results: report.rows.map(row => ({ id: row.id, assessment: structuredClone(row.assessment!) })) });
  report.finishedAt = at;
  report.status = report.capture.complete && !report.unreadCells.length ? "complete" : "incomplete";
  return report;
}
