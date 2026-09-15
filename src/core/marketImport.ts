/**
 * "Import from the trade site": a paste box that accepts trade2 URLs (both
 * forms, search and exchange) and raw query JSON, and turns them into
 * Market drafts.
 *
 * Nothing here touches the network. A URL that carries its `?q=` document
 * becomes an editable draft; an id-form URL (the form the site's share
 * button emits) becomes an "id only" entry — usable for live search and, if
 * `tradeSearchById` proves out live, for a one-request open.
 *
 * Pure: no Electron, no DOM. Pasted text is untrusted input.
 */
import {
  exchangeQueryFromBody,
  parseTradeUrl,
  tradeQueryFromBody,
} from "./tradeQuery.js";
import { importTradeQueries } from "./tradeQueryImport.js";
import { defaultTabLabel, sanitizeDraft, type MarketDraft } from "./marketQuery.js";

export interface MarketImportDraft {
  draft: MarketDraft;
  label: string;
  league?: string;
  searchId?: string;
  /** The line it came from, so the dialog can show what produced what. */
  source: string;
  /** Filter paths the builder cannot edit; they were dropped. */
  unsupported: string[];
}

export interface MarketImportIdOnly {
  kind: "search" | "exchange";
  league: string;
  searchId: string;
  source: string;
}

export interface MarketImportResult {
  drafts: MarketImportDraft[];
  idOnly: MarketImportIdOnly[];
  warnings: string[];
  errors: string[];
}

const MAX_IMPORT_BYTES = 262_144;
const MAX_LINES = 50;

function emptyResult(): MarketImportResult {
  return { drafts: [], idOnly: [], warnings: [], errors: [] };
}

/**
 * One paste, one link per line. A line is only split on whitespace when it
 * holds more than one link: the site's own `?q=` links are URL-encoded, but
 * a hand-edited one can carry a literal space inside the JSON and must not
 * be torn in half.
 */
function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const links = trimmed.match(/https?:\/\//g)?.length ?? 0;
    if (links > 1) out.push(...trimmed.split(/\s+/).filter(Boolean));
    else out.push(trimmed);
  }
  return out;
}

function shorten(source: string): string {
  return source.length > 120 ? `${source.slice(0, 117)}…` : source;
}

function draftFromUrlQuery(
  parsed: { kind: "search" | "exchange"; league: string; searchId?: string; query?: unknown },
  source: string,
): MarketImportDraft | undefined {
  const body = parsed.query;
  if (body === undefined) return undefined;
  const converted =
    parsed.kind === "exchange"
      ? { kind: "exchange" as const, ...exchangeQueryFromBody(body) }
      : { kind: "search" as const, ...tradeQueryFromBody(body) };
  const draft = sanitizeDraft({ kind: converted.kind, query: converted.query });
  if (!draft) return undefined;
  return {
    draft,
    label: defaultTabLabel(draft),
    league: parsed.league,
    ...(parsed.searchId ? { searchId: parsed.searchId } : {}),
    source: shorten(source),
    unsupported: converted.unsupported,
  };
}

/**
 * Parse whatever was pasted. Every line that looks like a URL is checked
 * against the trade2 host allow-list first (a pasted link is untrusted);
 * a blob starting with `{` or `[` goes through the existing JSON importer.
 */
export function importMarketText(text: string): MarketImportResult {
  const result = emptyResult();
  const input = typeof text === "string" ? text : "";
  if (!input.trim()) {
    result.errors.push("Paste a trade2 URL or a search document first.");
    return result;
  }
  if (input.length > MAX_IMPORT_BYTES) {
    result.errors.push("That paste is too large to import.");
    return result;
  }

  const trimmed = input.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return fromJson(trimmed, result);
  }

  const all = tokenize(trimmed);
  const lines = all.slice(0, MAX_LINES);
  if (all.length > MAX_LINES) {
    result.warnings.push(`Only the first ${MAX_LINES} links were read.`);
  }
  for (const line of lines) {
    const parsed = parseTradeUrl(line);
    if (!parsed) {
      result.errors.push(`${shorten(line)} is not a pathofexile.com trade2 URL.`);
      continue;
    }
    const draft = draftFromUrlQuery(parsed, line);
    if (draft) {
      if (draft.unsupported.length > 0) {
        result.warnings.push(
          `${draft.label}: ${draft.unsupported.length} filter(s) from the URL are not supported and were dropped.`,
        );
      }
      result.drafts.push(draft);
      continue;
    }
    if (parsed.searchId) {
      result.idOnly.push({
        kind: parsed.kind,
        league: parsed.league,
        searchId: parsed.searchId,
        source: shorten(line),
      });
      continue;
    }
    result.errors.push(`${shorten(line)} carried neither a query nor a search id.`);
  }
  if (result.drafts.length === 0 && result.idOnly.length === 0 && result.errors.length === 0) {
    result.errors.push("Nothing importable was found in that paste.");
  }
  return result;
}

function fromJson(text: string, result: MarketImportResult): MarketImportResult {
  const imported = importTradeQueries(text);
  for (const issue of imported.errors) result.errors.push(issue.message);
  for (const issue of imported.warnings) result.warnings.push(issue.message);
  for (const query of imported.queries) {
    if (query.sourceKind === "opaque-id") {
      const searchId = query.provenance.opaqueId;
      if (searchId) {
        result.idOnly.push({
          kind: "search",
          league: query.league ?? "",
          searchId,
          source: shorten(query.provenance.sourceText),
        });
      }
      continue;
    }
    if (!query.query) continue;
    const converted = tradeQueryFromBody(query.query);
    const draft = sanitizeDraft({ kind: "search", query: converted.query });
    if (!draft) continue;
    const unsupported = [...converted.unsupported, ...query.unsupportedFilters.map((filter) => filter.path)];
    if (unsupported.length > 0) {
      result.warnings.push(`${query.searchKey}: ${unsupported.length} filter(s) were dropped.`);
    }
    result.drafts.push({
      draft,
      label: defaultTabLabel(draft),
      ...(query.league ? { league: query.league } : {}),
      source: shorten(query.provenance.sourceText),
      unsupported,
    });
  }
  if (result.drafts.length === 0 && result.idOnly.length === 0 && result.errors.length === 0) {
    result.errors.push("That document held no trade2 query this builder can edit.");
  }
  return result;
}
