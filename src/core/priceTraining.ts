/** Local price examples: deterministic retrieval, with no filesystem or market access. */
import { parseAdvancedItemText } from "./itemAnnotations.js";
import { looksLikePoeItemText, parseItemText } from "./parseItem.js";
import { modTextToStatText } from "./statIds.js";
import type { ItemModKind, ParsedItem } from "./types.js";

export type PriceLessonEvidence = "estimate" | "listing" | "sale";
export type PriceLessonCurrency = "divine" | "exalted" | "chaos";

export interface PriceLessonInput {
  itemText: string;
  league: string;
  amount: number;
  currency: PriceLessonCurrency;
  evidence: PriceLessonEvidence;
  scope: "exact" | "similar";
  note?: string;
  sourceUrl?: string;
  observedAt?: string;
}

export interface PriceLesson extends PriceLessonInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface TrainingMod {
  kind: ItemModKind;
  pattern: string;
  values: number[];
}

export interface TrainingIdentity {
  fingerprint: string;
  groupKey: string;
  parsed: ParsedItem;
  itemClass: string;
  baseType: string;
  rarity: string;
  itemLevel?: number;
  quality: number;
  sockets: string;
  flags: { corrupted: boolean; mirrored: boolean; sanctified: boolean; split: boolean };
  mods: TrainingMod[];
}

export interface TrainingPriceEstimate {
  status: "matched" | "unknown" | "stale" | "conflict";
  matchKind?: "exact" | "similar";
  amount?: number;
  low?: number;
  high?: number;
  currency?: PriceLessonCurrency;
  confidence: number;
  exampleCount: number;
  reasons: string[];
  lessonIds: string[];
  fingerprint: string;
  groupKey: string;
}

export const PRICE_TRAINING_LIMITS = {
  itemText: 65_536,
  league: 120,
  note: 2_000,
  sourceUrl: 2_048,
  maxAmount: 1_000_000_000,
  maxAgeDays: 30,
  maxRollDifference: 0.15,
  maxItemLevelDifference: 5,
  maxPriceRatio: 3,
} as const;

const fold = (value: string): string => value.trim().replace(/\s+/g, " ").toLowerCase();
const DAY_MS = 86_400_000;
const evidenceRank: Record<PriceLessonEvidence, number> = { estimate: 1, listing: 2, sale: 3 };

/** Compact deterministic key; matching also compares the full feature group. */
function keyOf(value: unknown): string {
  const text = JSON.stringify(value);
  let first = 2166136261;
  let second = 5381;
  for (let i = 0; i < text.length; i += 1) {
    first = Math.imul(first ^ text.charCodeAt(i), 16777619);
    second = Math.imul(second, 33) ^ text.charCodeAt(i);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

function canonicalBase(parsed: ParsedItem): string {
  // Magic jewel copies have one header line: "Chilling Sapphire of Chanting".
  // Resolve only the three ordinary jewel bases; unknown bases retain their
  // complete header instead of being guessed into a broader item group.
  if (fold(parsed.itemClass) === "jewels" && fold(parsed.rarity) === "magic") {
    const beforeSuffix = parsed.name.split(/\s+of\s+/i)[0]!.trim();
    const match = /^(?:\S+\s+)?(Ruby|Emerald|Sapphire)$/i.exec(beforeSuffix);
    if (match) return match[1]![0]!.toUpperCase() + match[1]!.slice(1).toLowerCase();
  }
  return parsed.baseType.trim();
}

function modOrder(a: TrainingMod, b: TrainingMod): number {
  const left = `${a.kind}:${a.pattern}`;
  const right = `${b.kind}:${b.pattern}`;
  const byKey = left < right ? -1 : left > right ? 1 : 0;
  if (byKey) return byKey;
  for (let i = 0; i < Math.max(a.values.length, b.values.length); i += 1) {
    const difference = (a.values[i] ?? 0) - (b.values[i] ?? 0);
    if (difference) return difference;
  }
  return a.values.length - b.values.length;
}

/** Advanced ranges and printed tier labels are metadata, not additional rolls. */
export function trainingIdentity(raw: string): TrainingIdentity {
  if (typeof raw !== "string" || !raw.trim() || raw.length > PRICE_TRAINING_LIMITS.itemText ||
    !looksLikePoeItemText(raw) || !/^\s*Item Class:/im.test(raw) || !/^\s*Rarity:/im.test(raw)) {
    throw new Error("A complete copied item description is required.");
  }
  const advanced = parseAdvancedItemText(raw);
  if (advanced.ranges.some((range) => range.kind === "unique-text")) {
    throw new Error("A price example needs actual rolled values, not unrolled ranges.");
  }
  const parsed = parseItemText(advanced.plainText);
  if (!parsed.identified) throw new Error("Identify the item before recording a price example.");
  if (!parsed.name || /^unknown(?: item)?$/i.test(parsed.name) || /^unknown$/i.test(parsed.itemClass)) {
    throw new Error("The copied item has no usable identity.");
  }
  const baseType = canonicalBase(parsed);
  const mods = parsed.mods.filter((mod) => !/^(Mirrored|Sanctified|Split)$/i.test(mod.text.trim()))
    .map((mod): TrainingMod => ({
      kind: mod.kind === "unknown" ? "explicit" : mod.kind ?? "explicit",
      pattern: modTextToStatText(mod.text),
      values: [...(mod.values ?? [])],
    })).sort(modOrder);
  if (mods.some((mod) => mod.values.some((value) => !Number.isFinite(value)))) {
    throw new Error("The copied item has invalid modifier values.");
  }
  const flags = {
    corrupted: advanced.statusFlags.corrupted,
    mirrored: advanced.statusFlags.mirrored,
    sanctified: advanced.statusFlags.sanctified,
    split: /^\s*Split\s*$/im.test(raw),
  };
  const quality = parsed.quality ?? 0;
  const sockets = fold(parsed.sockets ?? "");
  const group = {
    version: 1,
    itemClass: fold(parsed.itemClass),
    baseType: fold(baseType),
    rarity: fold(parsed.rarity),
    // Unique names identify different designs; random rare names do not.
    uniqueName: fold(parsed.rarity) === "unique" ? fold(parsed.name) : undefined,
    flags, quality, sockets,
    mods: mods.map((mod) => ({ kind: mod.kind, pattern: mod.pattern, count: mod.values.length })),
  };
  const groupKey = JSON.stringify(group);
  return {
    fingerprint: keyOf({ group, level: parsed.itemLevel ?? null, values: mods.map((mod) => mod.values) }),
    groupKey, parsed, itemClass: parsed.itemClass, baseType, rarity: parsed.rarity,
    ...(parsed.itemLevel !== undefined ? { itemLevel: parsed.itemLevel } : {}),
    quality, sockets, flags, mods,
  };
}

export type PriceLessonValidation =
  | { valid: true; value: PriceLessonInput }
  | { valid: false; errors: string[] };

function timestamp(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length > 40 ||
    !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function validatePriceLessonInput(input: unknown): PriceLessonValidation {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { valid: false, errors: ["A price example must be an object."] };
  }
  const data = input as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof data.itemText !== "string") errors.push("Copied item text is required.");
  else {
    try { trainingIdentity(data.itemText); }
    catch (error) { errors.push(error instanceof Error ? error.message : "Invalid item text."); }
  }
  if (typeof data.league !== "string" || !data.league.trim() ||
    data.league.length > PRICE_TRAINING_LIMITS.league || /[\u0000-\u001f\u007f]/.test(data.league)) {
    errors.push("A league name of 1–120 characters is required.");
  } else if (["auto", "unknown", "unassigned"].includes(fold(data.league))) {
    errors.push("Choose a specific league for this price example.");
  }
  if (typeof data.amount !== "number" || !Number.isFinite(data.amount) || data.amount <= 0 ||
    data.amount > PRICE_TRAINING_LIMITS.maxAmount) errors.push("Price must be a positive finite amount at most 1,000,000,000.");
  if (typeof data.currency !== "string" || !["divine", "exalted", "chaos"].includes(data.currency)) errors.push("Choose divine, exalted, or chaos.");
  if (typeof data.evidence !== "string" || !["estimate", "listing", "sale"].includes(data.evidence)) errors.push("Choose estimate, listing, or sale evidence.");
  if (typeof data.scope !== "string" || !["exact", "similar"].includes(data.scope)) errors.push("Choose exact or similar matching.");
  if (data.note !== undefined && (typeof data.note !== "string" || data.note.length > PRICE_TRAINING_LIMITS.note)) {
    errors.push("Notes must be at most 2,000 characters.");
  }
  if (data.observedAt !== undefined && timestamp(data.observedAt) === undefined) {
    errors.push("Observation time must be a valid ISO timestamp with a timezone.");
  }
  if (data.sourceUrl !== undefined) {
    try {
      if (typeof data.sourceUrl !== "string" || data.sourceUrl.length > PRICE_TRAINING_LIMITS.sourceUrl) throw new Error();
      const url = new URL(data.sourceUrl);
      if (url.protocol !== "https:" || url.username || url.password) throw new Error();
    } catch { errors.push("Source URL must be an HTTPS URL without embedded credentials."); }
  }
  if (errors.length) return { valid: false, errors };
  return {
    valid: true,
    value: {
      itemText: data.itemText as string,
      league: (data.league as string).trim().replace(/\s+/g, " "),
      amount: data.amount as number,
      currency: data.currency as PriceLessonCurrency,
      evidence: data.evidence as PriceLessonEvidence,
      scope: data.scope as "exact" | "similar",
      ...(typeof data.note === "string" ? { note: data.note.trim() } : {}),
      ...(typeof data.sourceUrl === "string" ? { sourceUrl: data.sourceUrl } : {}),
      ...(typeof data.observedAt === "string" ? { observedAt: new Date(data.observedAt).toISOString() } : {}),
    },
  };
}

function sameIdentity(a: TrainingIdentity, b: TrainingIdentity): boolean {
  return a.groupKey === b.groupKey && a.itemLevel === b.itemLevel &&
    JSON.stringify(a.mods.map((mod) => mod.values)) === JSON.stringify(b.mods.map((mod) => mod.values));
}

function closeIdentity(a: TrainingIdentity, b: TrainingIdentity): boolean {
  if (a.groupKey !== b.groupKey || a.itemLevel === undefined || b.itemLevel === undefined ||
    Math.abs(a.itemLevel - b.itemLevel) > PRICE_TRAINING_LIMITS.maxItemLevelDifference) return false;
  return a.mods.every((mod, index) => mod.values.every((value, roll) => {
    const other = b.mods[index]!.values[roll]!;
    if (value === other) return true;
    if (Math.sign(value) !== Math.sign(other)) return false;
    return Math.abs(value - other) / Math.max(Math.abs(value), Math.abs(other)) <= PRICE_TRAINING_LIMITS.maxRollDifference;
  }));
}

interface Candidate { lesson: PriceLesson; identity: TrainingIdentity; exact: boolean; age: number }

/** Prices are retrieved from recorded examples, never inferred from tier labels alone. */
export function estimateTrainingPrice(
  raw: string,
  league: string,
  lessons: readonly PriceLesson[],
  now: Date = new Date(),
): TrainingPriceEstimate {
  let identity: TrainingIdentity;
  const empty: TrainingPriceEstimate = {
    status: "unknown", confidence: 0, exampleCount: 0, reasons: [], lessonIds: [], fingerprint: "", groupKey: "",
  };
  try { identity = trainingIdentity(raw); }
  catch (error) { return { ...empty, reasons: [error instanceof Error ? error.message : "Invalid item text."] }; }
  const base = { ...empty, fingerprint: identity.fingerprint, groupKey: identity.groupKey };
  const clock = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(clock) || typeof league !== "string" || !league.trim() || fold(league) === "auto") {
    return { ...base, reasons: ["A specific league and valid evaluation time are required."] };
  }
  const candidates: Candidate[] = [];
  for (const lesson of lessons) {
    const validation = validatePriceLessonInput(lesson);
    if (!validation.valid || typeof lesson.id !== "string" || !lesson.id.trim() || lesson.id.length > 128 ||
      timestamp(lesson.createdAt) === undefined || timestamp(lesson.updatedAt) === undefined || fold(lesson.league) !== fold(league)) continue;
    const observed = timestamp(lesson.observedAt ?? lesson.createdAt)!;
    if (observed > clock) continue;
    const learned = trainingIdentity(lesson.itemText);
    const exact = sameIdentity(identity, learned);
    if (!exact && (lesson.scope !== "similar" || !closeIdentity(identity, learned))) continue;
    candidates.push({ lesson, identity: learned, exact, age: (clock - observed) / DAY_MS });
  }
  const fresh = candidates.filter((candidate) => candidate.age <= PRICE_TRAINING_LIMITS.maxAgeDays);
  const exact = fresh.filter((candidate) => candidate.exact);
  const selected = exact.length ? exact : fresh;
  if (!selected.length) {
    if (candidates.length) return {
      ...base, status: "stale", exampleCount: new Set(candidates.map((candidate) => candidate.identity.fingerprint)).size,
      lessonIds: [...new Set(candidates.map((candidate) => candidate.lesson.id))].sort(),
      reasons: ["Matching examples are older than 30 days. Review their historical prices before using them."],
    };
    return { ...base, reasons: ["No comparable local price example matches this item's league, base, modifiers, and condition."] };
  }
  const exampleCount = new Set(selected.map((candidate) => candidate.identity.fingerprint)).size;
  const lessonIds = [...new Set(selected.map((candidate) => candidate.lesson.id))].sort();
  const matchKind = exact.length ? "exact" as const : "similar" as const;
  const currencies = new Set(selected.map((candidate) => candidate.lesson.currency));
  const values = selected.map((candidate) => candidate.lesson.amount).sort((a, b) => a - b);
  const low = values[0]!;
  const high = values[values.length - 1]!;
  if (currencies.size !== 1 || high / low > PRICE_TRAINING_LIMITS.maxPriceRatio) return {
    ...base, status: "conflict", matchKind, exampleCount, lessonIds,
    reasons: [currencies.size !== 1
      ? "Matching examples use different currencies; no exchange rate was assumed. Review them together."
      : "Matching example prices differ by more than 3×. Review the evidence before assigning a price."],
  };
  // Each item fingerprint contributes once; repeated imports cannot inflate
  // confidence or pull the median toward a repeatedly recorded observation.
  const distinct = new Map<string, Candidate>();
  for (const candidate of selected) {
    const prior = distinct.get(candidate.identity.fingerprint);
    if (!prior || evidenceRank[candidate.lesson.evidence] > evidenceRank[prior.lesson.evidence] ||
      (candidate.lesson.evidence === prior.lesson.evidence && (candidate.age < prior.age ||
        (candidate.age === prior.age && candidate.lesson.id < prior.lesson.id)))) {
      distinct.set(candidate.identity.fingerprint, candidate);
    }
  }
  const prices = [...distinct.values()].map((candidate) => candidate.lesson.amount).sort((a, b) => a - b);
  // The lower median is an actual recorded example amount, including for an
  // even sample count. Low/high likewise describe observed examples only.
  const amount = prices[Math.floor((prices.length - 1) / 2)]!;
  const evidence = [...distinct.values()].map((candidate) => candidate.lesson.evidence);
  const strongest = evidence.reduce((best, value) => evidenceRank[value] > evidenceRank[best] ? value : best, "estimate");
  const starting = { estimate: 40, listing: 55, sale: 70 }[strongest];
  const cap = { estimate: 55, listing: 70, sale: 85 }[strongest];
  const agePenalty = Math.floor(Math.max(...[...distinct.values()].map((candidate) => candidate.age)) / 10) * 3;
  const confidence = Math.max(0, Math.min(cap, starting + Math.min(15, (exampleCount - 1) * 5)) -
    (matchKind === "similar" ? 10 : 0) - agePenalty);
  const labels: Record<PriceLessonEvidence, string> = { estimate: "user estimate", listing: "asking-price listing", sale: "recorded sale" };
  const counts = (Object.keys(labels) as PriceLessonEvidence[]).flatMap((kind) => {
    const count = evidence.filter((value) => value === kind).length;
    return count ? [`${count} ${labels[kind]}${count === 1 ? "" : "s"}`] : [];
  });
  return {
    ...base, status: "matched", matchKind, amount, low, high, currency: selected[0]!.lesson.currency,
    confidence, exampleCount, lessonIds,
    reasons: [
      `${matchKind === "exact" ? "Exact item features" : "Same base, rarity, modifier patterns, and condition; rolls within 15% and item level within 5"} in ${league.trim()}.`,
      `Evidence: ${counts.join(", ")}. These are recorded examples, not a guaranteed sale price.`,
      ...(selected.length > exampleCount ? ["Repeated examples of the same item features count once toward confidence."] : []),
    ],
  };
}
