export const MAX_LEGACY_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_LEGACY_IMPORT_RECORDS = 10_000;
export const MAX_LEGACY_JSONL_LINE_BYTES = 262_144;

export interface LegacyImportWarning {
  code: string;
  message: string;
  recordIndex?: number;
  line?: number;
  path?: string;
}

export interface LegacyParseResult<T> {
  records: T[];
  warnings: LegacyImportWarning[];
}

export interface LegacyScanHistoryEntry {
  id: string;
  name: string;
  regex: string;
  createdAt?: string;
  raw: unknown;
}

export interface LegacyRegexHistoryEntry {
  id: string;
  name: string;
  regex: string;
  createdAt?: string;
  raw: unknown;
}

export interface LegacyTradePreset {
  id: string;
  name: string;
  league?: string;
  sourceUrl?: string;
  query?: unknown;
  tags: string[];
  createdAt?: string;
  raw: unknown;
}

export interface LegacyScanRecord {
  id: string;
  sessionId: string;
  slotKey: string;
  scannedAt?: string;
  itemFingerprint?: string;
  item?: unknown;
  status?: string;
  raw: Record<string, unknown>;
}

function byteLength(value: string): number {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(value).length;
  return value.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedAlias(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function property(record: Record<string, unknown>, ...aliases: string[]): unknown {
  const wanted = new Set(aliases.map(normalizedAlias));
  for (const [key, value] of Object.entries(record)) {
    if (wanted.has(normalizedAlias(key))) return value;
  }
  return undefined;
}

function textProperty(
  record: Record<string, unknown>,
  ...aliases: string[]
): string | undefined {
  const value = property(record, ...aliases);
  if (typeof value === "string") {
    const text = value.trim();
    return text || undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
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

function stableLegacyId(kind: string, value: string): string {
  return `${kind}_${hashStableKey(`${kind}\0${value}`)}`;
}

function normalizedTimestamp(
  value: unknown,
  warnings: LegacyImportWarning[],
  context: Pick<LegacyImportWarning, "recordIndex" | "line">,
): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    warnings.push({
      code: "invalid-timestamp",
      message: `Invalid legacy timestamp '${String(value)}' was omitted`,
      ...context,
    });
    return undefined;
  }
  return date.toISOString();
}

function parseLegacyJson(
  input: string,
  warnings: LegacyImportWarning[],
): unknown | undefined {
  if (byteLength(input) > MAX_LEGACY_IMPORT_BYTES) {
    warnings.push({
      code: "input-too-large",
      message: `Legacy import exceeds ${MAX_LEGACY_IMPORT_BYTES} bytes`,
    });
    return undefined;
  }
  try {
    return JSON.parse(input) as unknown;
  } catch (error) {
    warnings.push({
      code: "malformed-json",
      message: error instanceof Error ? error.message : "Malformed legacy JSON",
    });
    return undefined;
  }
}

function arrayPayload(
  value: unknown,
  warnings: LegacyImportWarning[],
  aliases: string[],
): unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value)) {
    const nested = property(value, ...aliases);
    if (Array.isArray(nested)) return nested;
    if (nested !== undefined) {
      warnings.push({
        code: "invalid-record-container",
        message: `Legacy '${aliases[0]}' container is not an array`,
      });
      return [];
    }
    // Some older exports used an object keyed by record ID.
    const values = Object.values(value);
    if (values.every((entry) => typeof entry === "string" || isRecord(entry))) {
      warnings.push({
        code: "object-record-container",
        message: "Legacy object map was imported as a record list",
      });
      return values;
    }
  }
  warnings.push({
    code: "missing-record-container",
    message: "Legacy JSON does not contain a supported record array",
  });
  return [];
}

function capRecords(
  values: unknown[],
  warnings: LegacyImportWarning[],
): unknown[] {
  if (values.length <= MAX_LEGACY_IMPORT_RECORDS) return values;
  warnings.push({
    code: "record-cap",
    message: `Only the first ${MAX_LEGACY_IMPORT_RECORDS} legacy records were imported`,
  });
  return values.slice(0, MAX_LEGACY_IMPORT_RECORDS);
}

function parseRegexEntry(
  value: unknown,
  index: number,
  kind: "scan-history" | "regex-history",
  warnings: LegacyImportWarning[],
): LegacyScanHistoryEntry | LegacyRegexHistoryEntry | undefined {
  const record = typeof value === "string" ? { regex: value } : value;
  if (!isRecord(record)) {
    warnings.push({
      code: "invalid-record",
      message: "Legacy regex record is not an object or string",
      recordIndex: index,
    });
    return undefined;
  }
  const regex = textProperty(record, "regex", "pattern", "search", "query");
  if (!regex) {
    warnings.push({
      code: "missing-regex",
      message: "Legacy regex record was skipped because it has no regex value",
      recordIndex: index,
    });
    return undefined;
  }
  if (byteLength(regex) > 32_768) {
    warnings.push({
      code: "regex-too-large",
      message: "Legacy regex record exceeds the 32768 byte cap",
      recordIndex: index,
    });
    return undefined;
  }
  const suppliedId = textProperty(record, "id", "key", "presetId", "historyId");
  const name =
    textProperty(record, "name", "title", "label", "presetName") ??
    `Imported ${kind === "scan-history" ? "scan" : "regex"} ${index + 1}`;
  const createdAt = normalizedTimestamp(
    property(record, "createdAt", "timestamp", "savedAt", "date"),
    warnings,
    { recordIndex: index },
  );
  return {
    id: suppliedId ?? stableLegacyId(kind, `${name}\0${regex}`),
    name,
    regex,
    ...(createdAt ? { createdAt } : {}),
    raw: value,
  };
}

export function parseLegacyScanHistory(
  input: string,
): LegacyParseResult<LegacyScanHistoryEntry> {
  const warnings: LegacyImportWarning[] = [];
  const parsed = parseLegacyJson(input, warnings);
  if (parsed === undefined) return { records: [], warnings };
  const values = capRecords(
    arrayPayload(parsed, warnings, ["scanHistory", "history", "items", "records"]),
    warnings,
  );
  const records = values
    .map((value, index) => parseRegexEntry(value, index, "scan-history", warnings))
    .filter((value): value is LegacyScanHistoryEntry => value !== undefined);
  return { records, warnings };
}

export function parseLegacyRegexHistory(
  input: string,
): LegacyParseResult<LegacyRegexHistoryEntry> {
  const warnings: LegacyImportWarning[] = [];
  const parsed = parseLegacyJson(input, warnings);
  if (parsed === undefined) return { records: [], warnings };
  const values = capRecords(
    arrayPayload(parsed, warnings, [
      "regexHistory",
      "savedRegexes",
      "history",
      "items",
      "records",
    ]),
    warnings,
  );
  const records = values
    .map((value, index) => parseRegexEntry(value, index, "regex-history", warnings))
    .filter((value): value is LegacyRegexHistoryEntry => value !== undefined);
  return { records, warnings };
}

export function parseLegacyTradePresets(
  input: string,
): LegacyParseResult<LegacyTradePreset> {
  const warnings: LegacyImportWarning[] = [];
  const parsed = parseLegacyJson(input, warnings);
  if (parsed === undefined) return { records: [], warnings };
  const values = capRecords(
    arrayPayload(parsed, warnings, [
      "tradePresets",
      "presets",
      "savedSearches",
      "items",
      "records",
    ]),
    warnings,
  );
  const records: LegacyTradePreset[] = [];
  values.forEach((value, index) => {
    if (!isRecord(value)) {
      warnings.push({
        code: "invalid-record",
        message: "Legacy trade preset is not an object",
        recordIndex: index,
      });
      return;
    }
    const name =
      textProperty(value, "name", "title", "label", "presetName") ??
      `Imported trade preset ${index + 1}`;
    const sourceUrl = textProperty(
      value,
      "sourceUrl",
      "url",
      "tradeUrl",
      "searchUrl",
      "tradeSearchUrl",
    );
    let query = property(value, "query", "tradeQuery", "searchQuery", "payload");
    if (typeof query === "string" && /^[\[{]/.test(query.trim())) {
      try {
        query = JSON.parse(query) as unknown;
      } catch {
        warnings.push({
          code: "malformed-embedded-query",
          message: "Embedded trade-query JSON was retained as text",
          recordIndex: index,
        });
      }
    }
    if (!sourceUrl && query === undefined) {
      warnings.push({
        code: "missing-trade-query",
        message: "Legacy trade preset was skipped because it has no URL or query",
        recordIndex: index,
      });
      return;
    }
    const rawTags = property(value, "tags", "labels");
    const tags = Array.isArray(rawTags)
      ? [...new Set(rawTags.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean))].sort()
      : typeof rawTags === "string"
        ? [...new Set(rawTags.split(",").map((entry) => entry.trim()).filter(Boolean))].sort()
        : [];
    const createdAt = normalizedTimestamp(
      property(value, "createdAt", "timestamp", "savedAt", "date"),
      warnings,
      { recordIndex: index },
    );
    const league = textProperty(value, "league", "leagueName");
    const suppliedId = textProperty(value, "id", "key", "presetId");
    records.push({
      id:
        suppliedId ??
        stableLegacyId(
          "trade-preset",
          `${name}\0${league ?? ""}\0${sourceUrl ?? ""}\0${JSON.stringify(query ?? null)}`,
        ),
      name,
      ...(league ? { league } : {}),
      ...(sourceUrl ? { sourceUrl } : {}),
      ...(query !== undefined ? { query } : {}),
      tags,
      ...(createdAt ? { createdAt } : {}),
      raw: value,
    });
  });
  return { records, warnings };
}

export function parseLegacyScanJsonl(
  input: string,
  options: { defaultSessionId?: string } = {},
): LegacyParseResult<LegacyScanRecord> {
  const warnings: LegacyImportWarning[] = [];
  if (byteLength(input) > MAX_LEGACY_IMPORT_BYTES) {
    return {
      records: [],
      warnings: [
        {
          code: "input-too-large",
          message: `Legacy JSONL import exceeds ${MAX_LEGACY_IMPORT_BYTES} bytes`,
        },
      ],
    };
  }
  const hasFinalNewline = /(?:\r\n|\r|\n)$/.test(input);
  const lines = input.split(/\r\n|\n|\r/);
  if (hasFinalNewline && lines.at(-1) === "") lines.pop();
  const records: LegacyScanRecord[] = [];
  const defaultSessionId =
    options.defaultSessionId?.trim() ||
    stableLegacyId("scan-session", hashStableKey(input.slice(0, 1024)));

  for (let index = 0; index < lines.length; index += 1) {
    if (records.length >= MAX_LEGACY_IMPORT_RECORDS) {
      warnings.push({
        code: "record-cap",
        message: `Only the first ${MAX_LEGACY_IMPORT_RECORDS} valid JSONL records were imported`,
        line: index + 1,
      });
      break;
    }
    const line = lines[index]!;
    if (!line.trim()) continue;
    if (byteLength(line) > MAX_LEGACY_JSONL_LINE_BYTES) {
      warnings.push({
        code: "line-too-large",
        message: `JSONL line exceeds ${MAX_LEGACY_JSONL_LINE_BYTES} bytes`,
        line: index + 1,
      });
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch (error) {
      const partialFinalLine = index === lines.length - 1 && !hasFinalNewline;
      warnings.push({
        code: partialFinalLine ? "partial-final-line" : "malformed-jsonl-line",
        message: partialFinalLine
          ? "Incomplete final JSONL line was ignored"
          : error instanceof Error
            ? error.message
            : "Malformed JSONL line",
        line: index + 1,
      });
      continue;
    }
    if (!isRecord(value)) {
      warnings.push({
        code: "invalid-jsonl-record",
        message: "JSONL record is not an object",
        line: index + 1,
      });
      continue;
    }
    const sessionId =
      textProperty(value, "sessionId", "scanSessionId", "runId", "session") ??
      defaultSessionId;
    const explicitSlot = textProperty(
      value,
      "slotKey",
      "slot",
      "cell",
      "position",
      "index",
    );
    const slotKey = explicitSlot ?? `slot-${index + 1}`;
    if (!explicitSlot) {
      warnings.push({
        code: "generated-slot-key",
        message: `Missing slot key was replaced with '${slotKey}'`,
        line: index + 1,
      });
    }
    const scannedAt = normalizedTimestamp(
      property(value, "scannedAt", "capturedAt", "timestamp", "createdAt", "time"),
      warnings,
      { line: index + 1 },
    );
    const item = property(value, "item", "itemSnapshot", "normalizedItem", "result");
    const itemFingerprint =
      textProperty(value, "itemFingerprint", "fingerprint") ??
      (isRecord(item) ? textProperty(item, "fingerprint", "itemFingerprint") : undefined);
    const status = textProperty(value, "status", "state", "resultStatus");
    const suppliedId = textProperty(value, "id", "scanId", "observationId");
    records.push({
      id:
        suppliedId ??
        stableLegacyId(
          "scan-record",
          `${sessionId}\0${slotKey}\0${scannedAt ?? ""}\0${itemFingerprint ?? ""}\0${line}`,
        ),
      sessionId,
      slotKey,
      ...(scannedAt ? { scannedAt } : {}),
      ...(itemFingerprint ? { itemFingerprint } : {}),
      ...(item !== undefined ? { item } : {}),
      ...(status ? { status } : {}),
      raw: value,
    });
  }
  return { records, warnings };
}
