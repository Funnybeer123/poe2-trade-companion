export const MAX_TRADE_IMPORT_BYTES = 262_144;
export const MAX_TRADE_IMPORT_URLS = 50;
export const MAX_TRADE_QUERY_DEPTH = 40;
export const MAX_TRADE_QUERY_NODES = 50_000;

export type TradeQuerySourceKind = "inline-query" | "raw-query" | "opaque-id";

export interface TradeImportIssue {
  code: string;
  message: string;
  sourceIndex?: number;
  source?: string;
  path?: string;
}

export interface ImportedTradeOrGroup {
  path: string;
  filters: unknown[];
  raw: unknown;
}

export interface UnsupportedTradeFilter {
  path: string;
  reason: string;
  raw: unknown;
}

export interface TradeQueryProvenance {
  kind: TradeQuerySourceKind;
  sourceText: string;
  sourceUrl?: string;
  opaqueId?: string;
  unsupported: boolean;
}

export interface ImportedTradeQuery {
  id: string;
  searchKey: string;
  sourceKind: TradeQuerySourceKind;
  sourceIndex: number;
  league?: string;
  sourceUrl?: string;
  query?: Record<string, unknown>;
  orGroups: ImportedTradeOrGroup[];
  unsupportedFilters: UnsupportedTradeFilter[];
  provenance: TradeQueryProvenance;
}

export interface TradeQueryImportResult {
  queries: ImportedTradeQuery[];
  warnings: TradeImportIssue[];
  errors: TradeImportIssue[];
}

const ALLOWED_HOSTS = new Set(["pathofexile.com", "www.pathofexile.com"]);
const SUPPORTED_ROOT_KEYS = new Set(["query", "sort"]);
const SUPPORTED_QUERY_KEYS = new Set([
  "status",
  "name",
  "type",
  "term",
  "stats",
  "filters",
]);
const SUPPORTED_FILTER_GROUPS = new Set([
  "type_filters",
  "misc_filters",
  "equipment_filters",
  "socket_filters",
  "req_filters",
  "map_filters",
  "trade_filters",
]);
const DANGEROUS_JSON_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function byteLength(value: string): number {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(value).length;
  return value.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hashStableKey(value: string): string {
  let high = 0x811c9dc5;
  let low = 0x01000193;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    high ^= code;
    high = Math.imul(high, 0x01000193);
    low ^= code + index;
    low = Math.imul(low, 0x811c9dc5);
  }
  return `${(high >>> 0).toString(16).padStart(8, "0")}${(low >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}

function inspectJson(value: unknown): string | undefined {
  let nodes = 0;
  const seen = new Set<object>();
  const visit = (current: unknown, depth: number, path: string): string | undefined => {
    nodes += 1;
    if (nodes > MAX_TRADE_QUERY_NODES) {
      return `JSON exceeds the ${MAX_TRADE_QUERY_NODES} node cap`;
    }
    if (depth > MAX_TRADE_QUERY_DEPTH) {
      return `JSON exceeds the ${MAX_TRADE_QUERY_DEPTH} level depth cap`;
    }
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    ) {
      return undefined;
    }
    if (typeof current === "number") {
      return Number.isFinite(current) ? undefined : `${path} contains a non-finite number`;
    }
    if (Array.isArray(current)) {
      if (seen.has(current)) return `${path} contains a cycle`;
      seen.add(current);
      for (let index = 0; index < current.length; index += 1) {
        const error = visit(current[index], depth + 1, `${path}[${index}]`);
        if (error) return error;
      }
      seen.delete(current);
      return undefined;
    }
    if (!isRecord(current)) return `${path} contains a non-JSON value`;
    if (seen.has(current)) return `${path} contains a cycle`;
    seen.add(current);
    for (const key of Object.keys(current)) {
      if (DANGEROUS_JSON_KEYS.has(key)) return `${path}.${key} uses a forbidden key`;
      const error = visit(current[key], depth + 1, `${path}.${key}`);
      if (error) return error;
    }
    seen.delete(current);
    return undefined;
  };
  return visit(value, 0, "$");
}

export function stableTradeQueryJson(value: unknown): string {
  const validationError = inspectJson(value);
  if (validationError) throw new Error(validationError);
  const visit = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(visit);
    if (isRecord(current)) {
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(current).sort()) result[key] = visit(current[key]);
      return result;
    }
    return current;
  };
  return JSON.stringify(visit(value));
}

function trimUrlPunctuation(value: string): string {
  let result = value.trim();
  while (/[),;\]}]$/.test(result)) result = result.slice(0, -1);
  return result;
}

function extractUrlCandidates(input: string): string[] {
  const matches = input.match(/[a-zA-Z][a-zA-Z\d+.-]*:\/\/[^\s<>"']+/g);
  return (matches ?? []).map(trimUrlPunctuation).filter(Boolean);
}

function parseJson(
  text: string,
  sourceIndex: number,
  source: string,
  errors: TradeImportIssue[],
): unknown | undefined {
  if (byteLength(text) > MAX_TRADE_IMPORT_BYTES) {
    errors.push({
      code: "query-too-large",
      message: `Decoded query exceeds ${MAX_TRADE_IMPORT_BYTES} bytes`,
      sourceIndex,
      source,
    });
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(text);
    const inspectionError = inspectJson(value);
    if (inspectionError) {
      errors.push({
        code: "hostile-json",
        message: inspectionError,
        sourceIndex,
        source,
      });
      return undefined;
    }
    return value;
  } catch (error) {
    errors.push({
      code: "malformed-json",
      message: error instanceof Error ? error.message : "Malformed JSON",
      sourceIndex,
      source,
    });
    return undefined;
  }
}

function normalizeTradeDocument(
  value: unknown,
  sourceIndex: number,
  source: string,
  warnings: TradeImportIssue[],
  errors: TradeImportIssue[],
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    errors.push({
      code: "query-object-required",
      message: "Trade query export must be a JSON object",
      sourceIndex,
      source,
    });
    return undefined;
  }
  if (isRecord(value.query)) return value;
  if ([...SUPPORTED_QUERY_KEYS].some((key) => Object.hasOwn(value, key))) {
    warnings.push({
      code: "query-only-export",
      message: "Imported a query-only export and wrapped it in a trade document",
      sourceIndex,
      source,
    });
    return { query: value };
  }
  errors.push({
    code: "missing-query",
    message: "Trade query export does not contain a query object",
    sourceIndex,
    source,
  });
  return undefined;
}

function inspectUnsupportedFilters(
  document: Record<string, unknown>,
  sourceIndex: number,
  source: string,
  warnings: TradeImportIssue[],
): UnsupportedTradeFilter[] {
  const unsupported: UnsupportedTradeFilter[] = [];
  const add = (path: string, reason: string, raw: unknown): void => {
    unsupported.push({ path, reason, raw });
    warnings.push({
      code: "unsupported-filter",
      message: `${path}: ${reason}; preserved verbatim`,
      sourceIndex,
      source,
      path,
    });
  };
  for (const [key, raw] of Object.entries(document)) {
    if (!SUPPORTED_ROOT_KEYS.has(key)) add(`$.${key}`, "unsupported root field", raw);
  }
  const query = document.query;
  if (!isRecord(query)) return unsupported;
  for (const [key, raw] of Object.entries(query)) {
    if (!SUPPORTED_QUERY_KEYS.has(key)) add(`$.query.${key}`, "unsupported query field", raw);
  }
  if (query.filters !== undefined) {
    if (!isRecord(query.filters)) {
      add("$.query.filters", "filters must be an object", query.filters);
    } else {
      for (const [key, raw] of Object.entries(query.filters)) {
        if (!SUPPORTED_FILTER_GROUPS.has(key)) {
          add(`$.query.filters.${key}`, "unsupported filter group", raw);
        }
      }
    }
  }
  if (query.stats !== undefined) {
    if (!Array.isArray(query.stats)) {
      add("$.query.stats", "stats must be an array", query.stats);
    } else {
      query.stats.forEach((group, index) => {
        if (!isRecord(group)) {
          add(`$.query.stats[${index}]`, "stat group must be an object", group);
          return;
        }
        const groupType = typeof group.type === "string" ? group.type.toLowerCase() : "";
        if (!["and", "or", "count", "not"].includes(groupType)) {
          add(
            `$.query.stats[${index}].type`,
            "unsupported stat-group type",
            group.type,
          );
        }
        if (!Array.isArray(group.filters)) {
          add(
            `$.query.stats[${index}].filters`,
            "stat-group filters must be an array",
            group.filters,
          );
        }
      });
    }
  }
  return unsupported;
}

function collectOrGroups(document: Record<string, unknown>): ImportedTradeOrGroup[] {
  const query = document.query;
  if (!isRecord(query) || !Array.isArray(query.stats)) return [];
  const groups: ImportedTradeOrGroup[] = [];
  query.stats.forEach((group, index) => {
    if (
      isRecord(group) &&
      typeof group.type === "string" &&
      group.type.toLowerCase() === "or" &&
      Array.isArray(group.filters)
    ) {
      groups.push({
        path: `$.query.stats[${index}]`,
        filters: group.filters,
        raw: group,
      });
    }
  });
  return groups;
}

function parseTradePath(
  url: URL,
): { league?: string; opaqueId?: string; validTradePath: boolean; pathError?: string } {
  const segments: string[] = [];
  try {
    for (const segment of url.pathname.split("/").filter(Boolean)) {
      segments.push(decodeURIComponent(segment));
    }
  } catch {
    return {
      validTradePath: false,
      pathError: "Trade URL path contains malformed percent encoding",
    };
  }
  const tradeIndex = segments.findIndex((segment) => segment === "trade" || segment === "trade2");
  const searchIndex = segments.findIndex((segment, index) => index > tradeIndex && segment === "search");
  if (tradeIndex < 0 || searchIndex < 0) return { validTradePath: false };
  let cursor = searchIndex + 1;
  if (segments[cursor]?.toLowerCase() === "poe2") cursor += 1;
  const league = segments[cursor];
  const opaqueId = segments[cursor + 1];
  return {
    validTradePath: true,
    ...(league ? { league } : {}),
    ...(opaqueId ? { opaqueId } : {}),
  };
}

function rawQueryParameters(url: URL): string[] | undefined {
  const results: string[] = [];
  const query = url.search.startsWith("?") ? url.search.slice(1) : url.search;
  if (!query) return results;
  for (const part of query.split("&")) {
    const equals = part.indexOf("=");
    const rawKey = equals >= 0 ? part.slice(0, equals) : part;
    let key: string;
    try {
      key = decodeURIComponent(rawKey.replaceAll("+", " "));
    } catch {
      return undefined;
    }
    if (key === "q") results.push(equals >= 0 ? part.slice(equals + 1) : "");
  }
  return results;
}

function importDocument(
  document: Record<string, unknown>,
  sourceKind: Exclude<TradeQuerySourceKind, "opaque-id">,
  sourceText: string,
  sourceIndex: number,
  warnings: TradeImportIssue[],
  sourceUrl?: string,
  league?: string,
): ImportedTradeQuery {
  const unsupportedFilters = inspectUnsupportedFilters(
    document,
    sourceIndex,
    sourceText,
    warnings,
  );
  const canonical = stableTradeQueryJson(document);
  const searchKey = `trade-query:${hashStableKey(canonical)}`;
  return {
    id: `trade_${hashStableKey(`${searchKey}\0${league ?? ""}`)}`,
    searchKey,
    sourceKind,
    sourceIndex,
    ...(league ? { league } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
    query: document,
    orGroups: collectOrGroups(document),
    unsupportedFilters,
    provenance: {
      kind: sourceKind,
      sourceText,
      ...(sourceUrl ? { sourceUrl } : {}),
      unsupported: unsupportedFilters.length > 0,
    },
  };
}

function importUrl(
  sourceText: string,
  sourceIndex: number,
  warnings: TradeImportIssue[],
  errors: TradeImportIssue[],
): ImportedTradeQuery | undefined {
  let url: URL;
  try {
    url = new URL(sourceText);
  } catch {
    errors.push({
      code: "malformed-url",
      message: "Trade URL is malformed",
      sourceIndex,
      source: sourceText,
    });
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    errors.push({
      code: "unsupported-protocol",
      message: "Trade URLs must use http or https",
      sourceIndex,
      source: sourceText,
    });
    return undefined;
  }
  if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) {
    errors.push({
      code: "untrusted-host",
      message: `Untrusted trade host: ${url.hostname}`,
      sourceIndex,
      source: sourceText,
    });
    return undefined;
  }
  if (url.username || url.password) {
    errors.push({
      code: "url-credentials",
      message: "Trade URLs must not contain credentials",
      sourceIndex,
      source: sourceText,
    });
    return undefined;
  }
  const defaultPort =
    !url.port ||
    (url.protocol === "https:" && url.port === "443") ||
    (url.protocol === "http:" && url.port === "80");
  if (!defaultPort) {
    errors.push({
      code: "unsupported-port",
      message: "Trade URLs must use the default HTTP(S) port",
      sourceIndex,
      source: sourceText,
    });
    return undefined;
  }
  const pathInfo = parseTradePath(url);
  if (pathInfo.pathError) {
    errors.push({
      code: "malformed-encoding",
      message: pathInfo.pathError,
      sourceIndex,
      source: sourceText,
    });
    return undefined;
  }
  if (!pathInfo.validTradePath) {
    errors.push({
      code: "not-trade-url",
      message: "Official host URL is not a trade search URL",
      sourceIndex,
      source: sourceText,
    });
    return undefined;
  }
  const rawParameters = rawQueryParameters(url);
  if (!rawParameters) {
    errors.push({
      code: "malformed-encoding",
      message: "Trade URL query parameter name contains malformed encoding",
      sourceIndex,
      source: sourceText,
    });
    return undefined;
  }
  if (rawParameters.length > 1) {
    errors.push({
      code: "duplicate-query",
      message: "Trade URL contains more than one q parameter",
      sourceIndex,
      source: sourceText,
    });
    return undefined;
  }
  if (rawParameters.length === 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawParameters[0]!.replaceAll("+", " "));
    } catch {
      errors.push({
        code: "malformed-encoding",
        message: "Trade URL q parameter contains malformed percent encoding",
        sourceIndex,
        source: sourceText,
      });
      return undefined;
    }
    const parsed = parseJson(decoded, sourceIndex, sourceText, errors);
    if (parsed === undefined) return undefined;
    const document = normalizeTradeDocument(
      parsed,
      sourceIndex,
      sourceText,
      warnings,
      errors,
    );
    if (!document) return undefined;
    return importDocument(
      document,
      "inline-query",
      sourceText,
      sourceIndex,
      warnings,
      url.toString(),
      pathInfo.league,
    );
  }
  if (!pathInfo.opaqueId) {
    errors.push({
      code: "missing-query",
      message: "Trade URL contains neither inline q JSON nor an opaque search ID",
      sourceIndex,
      source: sourceText,
    });
    return undefined;
  }
  if (pathInfo.opaqueId.length > 256) {
    errors.push({
      code: "opaque-id-too-large",
      message: "Opaque trade search ID exceeds 256 characters",
      sourceIndex,
      source: sourceText,
    });
    return undefined;
  }
  warnings.push({
    code: "opaque-query-id",
    message: "Opaque trade search ID was retained as unsupported provenance; no fetch was made",
    sourceIndex,
    source: sourceText,
  });
  const searchKey = `opaque:${pathInfo.opaqueId}`;
  return {
    id: `trade_${hashStableKey(`${searchKey}\0${pathInfo.league ?? ""}`)}`,
    searchKey,
    sourceKind: "opaque-id",
    sourceIndex,
    ...(pathInfo.league ? { league: pathInfo.league } : {}),
    sourceUrl: url.toString(),
    orGroups: [],
    unsupportedFilters: [
      {
        path: "$.opaqueId",
        reason: "Opaque search IDs require a network fetch and are not resolved during local import",
        raw: pathInfo.opaqueId,
      },
    ],
    provenance: {
      kind: "opaque-id",
      sourceText,
      sourceUrl: url.toString(),
      opaqueId: pathInfo.opaqueId,
      unsupported: true,
    },
  };
}

export function importTradeQueries(input: string): TradeQueryImportResult {
  const warnings: TradeImportIssue[] = [];
  const errors: TradeImportIssue[] = [];
  const queries: ImportedTradeQuery[] = [];
  if (byteLength(input) > MAX_TRADE_IMPORT_BYTES) {
    return {
      queries,
      warnings,
      errors: [
        {
          code: "input-too-large",
          message: `Trade import exceeds ${MAX_TRADE_IMPORT_BYTES} bytes`,
        },
      ],
    };
  }
  const trimmed = input.trim();
  if (!trimmed) {
    return {
      queries,
      warnings,
      errors: [{ code: "empty-input", message: "Trade query import is empty" }],
    };
  }

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed = parseJson(trimmed, 0, "raw-json", errors);
    if (parsed !== undefined) {
      const document = normalizeTradeDocument(parsed, 0, "raw-json", warnings, errors);
      if (document) {
        queries.push(
          importDocument(document, "raw-query", trimmed, 0, warnings),
        );
      }
    }
    return { queries, warnings, errors };
  }

  const candidates = extractUrlCandidates(trimmed);
  if (candidates.length === 0) {
    return {
      queries,
      warnings,
      errors: [
        {
          code: "unsupported-input",
          message: "Expected raw query JSON or one or more absolute trade URLs",
        },
      ],
    };
  }
  if (candidates.length > MAX_TRADE_IMPORT_URLS) {
    return {
      queries,
      warnings,
      errors: [
        {
          code: "too-many-urls",
          message: `At most ${MAX_TRADE_IMPORT_URLS} URLs may be imported at once`,
        },
      ],
    };
  }
  const seen = new Set<string>();
  candidates.forEach((candidate, sourceIndex) => {
    const imported = importUrl(candidate, sourceIndex, warnings, errors);
    if (!imported) return;
    if (seen.has(imported.searchKey)) {
      warnings.push({
        code: "duplicate-search",
        message: `Duplicate imported search '${imported.searchKey}' was ignored`,
        sourceIndex,
        source: candidate,
      });
      return;
    }
    seen.add(imported.searchKey);
    queries.push(imported);
  });
  return { queries, warnings, errors };
}
