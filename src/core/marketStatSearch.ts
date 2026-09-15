/**
 * Stat autocomplete for the Market query builder: the trade2 stats
 * catalogue (`/api/trade2/data/stats`, cached a week by PriceFeedService)
 * indexed once and searched with a token score.
 *
 * The site's own box is a fuzzy match over the printed text; ours scores
 * exact > prefix > in-order token prefixes > out-of-order > substring >
 * subsequence so "max life" finds "+# to maximum Life" without listing
 * every mod that happens to contain "life".
 *
 * Pure: no Electron, no DOM, no network.
 */
import { normalizeStatText, modTextToStatText, statEntries } from "./statIds.js";

export interface MarketStatOption {
  /** trade2 stat id, e.g. "explicit.stat_3299347043". */
  id: string;
  /** The text as trade2 prints it ("+# to maximum Life"). */
  text: string;
  /** Catalogue group: explicit, implicit, pseudo, enchant, rune, … */
  type: string;
  /** A "(Local)" defence variant — ranked below the global one. */
  local: boolean;
}

/**
 * The catalogue groups worth offering. `explicit` first because it is what
 * a search almost always means; the rest are there so an enchant or a
 * pseudo total can be picked deliberately.
 */
export const MARKET_STAT_TYPES: readonly string[] = [
  "explicit",
  "implicit",
  "pseudo",
  "enchant",
  "rune",
  "sanctified",
  "desecrated",
  "fractured",
  "crafted",
  "skill",
  "ultimatum",
];

/** Ties break by type in this order — the one a player usually wants first. */
const TYPE_ORDER: readonly string[] = [
  "explicit",
  "pseudo",
  "implicit",
  "enchant",
  "rune",
  "fractured",
  "desecrated",
  "sanctified",
  "crafted",
  "skill",
  "ultimatum",
];

const LOCAL_SUFFIX = /\(local\)\s*$/i;

/** Flatten a /data/stats payload into the options the builder offers. */
export function statOptionsFromPayload(payload: unknown): MarketStatOption[] {
  const options: MarketStatOption[] = [];
  const seen = new Set<string>();
  for (const entry of statEntries(payload, MARKET_STAT_TYPES)) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    options.push({
      id: entry.id,
      text: entry.text,
      type: entry.type,
      local: LOCAL_SUFFIX.test(entry.text),
    });
  }
  return options;
}

export interface StatIndex {
  options: MarketStatOption[];
  /** Per option: its normalized text, and that text split into tokens. */
  normalized: string[];
  tokens: string[][];
  byId: Map<string, MarketStatOption>;
}

function tokenize(normalized: string): string[] {
  return normalized
    .replace(/#/g, " ")
    .split(/[^a-z0-9]+/i)
    .filter(Boolean);
}

/** Build the search index once per catalogue payload (thousands of entries). */
export function indexStatOptions(options: readonly MarketStatOption[]): StatIndex {
  const normalized: string[] = [];
  const tokens: string[][] = [];
  const byId = new Map<string, MarketStatOption>();
  for (const option of options) {
    const norm = normalizeStatText(option.text);
    normalized.push(norm);
    tokens.push(tokenize(norm));
    byId.set(option.id, option);
  }
  return { options: [...options], normalized, tokens, byId };
}

export function statOptionById(index: StatIndex, id: string): MarketStatOption | undefined {
  return index.byId.get(id);
}

/**
 * The stat id whose catalogue text is exactly this mod line (numbers folded
 * to `#`). Used by "use this item's mods as filters" in the renderer, where
 * the full stat catalogue is not available — only the option list. Prefers
 * an explicit, non-local entry, the way the site's own copy does.
 */
export function statIdForText(index: StatIndex, text: string, types?: readonly string[]): string | undefined {
  const wanted = normalizeStatText(modTextToStatText(text));
  if (!wanted) return undefined;
  const allowed = types && types.length > 0 ? new Set(types.map((type) => type.toLowerCase())) : undefined;
  let best: { id: string; rank: number } | undefined;
  for (let position = 0; position < index.options.length; position += 1) {
    if (index.normalized[position] !== wanted) continue;
    const option = index.options[position]!;
    if (allowed && !allowed.has(option.type.toLowerCase())) continue;
    const rank = typeRank(option.type) * 2 + (option.local ? 1 : 0);
    if (!best || rank < best.rank) best = { id: option.id, rank };
  }
  return best?.id;
}

/** Longest common subsequence ratio of two token lists (0..1). */
function subsequenceRatio(query: readonly string[], candidate: readonly string[]): number {
  if (query.length === 0) return 0;
  let matched = 0;
  let cursor = 0;
  for (const token of query) {
    const hit = candidate.findIndex((entry, position) => position >= cursor && entry.startsWith(token));
    if (hit >= 0) {
      matched += 1;
      cursor = hit + 1;
    }
  }
  return matched / query.length;
}

function everyTokenIsPrefixInOrder(query: readonly string[], candidate: readonly string[]): boolean {
  let cursor = 0;
  for (const token of query) {
    const hit = candidate.findIndex((entry, position) => position >= cursor && entry.startsWith(token));
    if (hit < 0) return false;
    cursor = hit + 1;
  }
  return true;
}

function everyTokenIsPrefix(query: readonly string[], candidate: readonly string[]): boolean {
  return query.every((token) => candidate.some((entry) => entry.startsWith(token)));
}

function scoreOption(query: string, queryTokens: readonly string[], normalized: string, tokens: readonly string[]): number {
  if (!query) return 1;
  if (normalized === query) return 100;
  if (normalized.startsWith(query)) return 80;
  if (everyTokenIsPrefixInOrder(queryTokens, tokens)) return 65;
  if (everyTokenIsPrefix(queryTokens, tokens)) return 55;
  if (queryTokens.every((token) => normalized.includes(token))) return 40;
  return Math.round(subsequenceRatio(queryTokens, tokens) * 30);
}

export interface SearchStatsOptions {
  limit?: number;
  /** Restrict to these catalogue groups (the type dropdown). */
  types?: readonly string[];
}

const SCORE_FLOOR = 12;
const DEFAULT_LIMIT = 20;

/**
 * The ranked options for what the user has typed. An empty query lists the
 * first explicit entries alphabetically so the list is never blank.
 */
export function searchStats(index: StatIndex, query: string, opts: SearchStatsOptions = {}): MarketStatOption[] {
  const limit = Math.max(1, Math.min(100, opts.limit ?? DEFAULT_LIMIT));
  const types = opts.types && opts.types.length > 0 ? new Set(opts.types.map((type) => type.toLowerCase())) : undefined;
  const normalizedQuery = normalizeStatText(modTextToStatText(query ?? ""));
  const queryTokens = tokenize(normalizedQuery);

  if (!normalizedQuery.trim() || queryTokens.length === 0) {
    return index.options
      .filter((option) => (types ? types.has(option.type.toLowerCase()) : option.type === "explicit"))
      .slice()
      .sort((left, right) => left.text.localeCompare(right.text))
      .slice(0, limit);
  }

  const scored: Array<{ option: MarketStatOption; score: number; position: number }> = [];
  for (let position = 0; position < index.options.length; position += 1) {
    const option = index.options[position]!;
    if (types && !types.has(option.type.toLowerCase())) continue;
    const score = scoreOption(normalizedQuery, queryTokens, index.normalized[position]!, index.tokens[position]!);
    if (score < SCORE_FLOOR) continue;
    scored.push({ option, score, position });
  }

  scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    const typeDelta = typeRank(left.option.type) - typeRank(right.option.type);
    if (typeDelta !== 0) return typeDelta;
    if (left.option.local !== right.option.local) return left.option.local ? 1 : -1;
    if (left.option.text.length !== right.option.text.length) return left.option.text.length - right.option.text.length;
    return left.position - right.position;
  });
  return scored.slice(0, limit).map((entry) => entry.option);
}

function typeRank(type: string): number {
  const index = TYPE_ORDER.indexOf(type.toLowerCase());
  return index < 0 ? TYPE_ORDER.length : index;
}
