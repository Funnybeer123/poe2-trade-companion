import { createHash } from "node:crypto";
import {
  parseLegacyRegexHistory,
  parseLegacyScanHistory,
  parseLegacyScanJsonl,
  parseLegacyTradePresets,
  type LegacyImportWarning,
  type LegacyScanRecord,
} from "../../core/legacyImports.js";
import { boundedText, stableId, utcTimestamp } from "./json.js";
import type { LocalPersistenceDatabase } from "./database.js";

export type LegacyImportKind =
  | "scan-history"
  | "regex-history"
  | "trade-presets"
  | "scan-jsonl";

export interface LegacyPersistenceImportOptions {
  sourceKey: string;
  sourceUri?: string;
  importedAt?: Date | string | number;
}

export interface LegacyPersistenceImportResult {
  kind: LegacyImportKind;
  parsedRecords: number;
  persistedEntities: number;
  entityIds: string[];
  warnings: LegacyImportWarning[];
}

function sourceDigest(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function importTimestamp(value: Date | string | number | undefined): string {
  return utcTimestamp(value ?? new Date(), "legacy import timestamp");
}

function recordSourceKey(sourceKey: string, kind: string, recordId: string): string {
  const suffix = createHash("sha256")
    .update(`${kind}\0${recordId}`, "utf8")
    .digest("hex")
    .slice(0, 24);
  return `${sourceKey}#${suffix}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function aliasProperty(record: Record<string, unknown>, ...aliases: string[]): unknown {
  const normalize = (value: string) => value.replaceAll(/[^a-zA-Z0-9]/g, "").toLowerCase();
  const wanted = new Set(aliases.map(normalize));
  for (const [key, value] of Object.entries(record)) {
    if (wanted.has(normalize(key))) return value;
  }
  return undefined;
}

function aliasText(record: Record<string, unknown>, ...aliases: string[]): string | undefined {
  const value = aliasProperty(record, ...aliases);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function warningForError(
  warnings: LegacyImportWarning[],
  code: string,
  message: string,
  error: unknown,
  context: Pick<LegacyImportWarning, "recordIndex" | "line"> = {},
): void {
  warnings.push({
    code,
    message: `${message}: ${error instanceof Error ? error.message : String(error)}`,
    ...context,
  });
}

function persistRegexPresets(
  database: LocalPersistenceDatabase,
  input: string,
  kind: "scan-history" | "regex-history",
  options: LegacyPersistenceImportOptions,
): LegacyPersistenceImportResult {
  const parsed =
    kind === "scan-history"
      ? parseLegacyScanHistory(input)
      : parseLegacyRegexHistory(input);
  const warnings = [...parsed.warnings];
  const entityIds: string[] = [];
  const digest = sourceDigest(input);
  const importedAt = importTimestamp(options.importedAt);
  const seenNaturalKeys = new Set<string>();

  database.transaction((repositories) => {
    parsed.records.forEach((record, recordIndex) => {
      const naturalKey = record.name.trim().toLowerCase();
      if (seenNaturalKeys.has(naturalKey)) {
        warnings.push({
          code: "duplicate-preset-name",
          message: `Duplicate '${record.name}' record updated the same local preset`,
          recordIndex,
        });
      }
      seenNaturalKeys.add(naturalKey);
      try {
        const preset = repositories.presets.upsert({
          kind,
          name: record.name,
          schemaVersion: 1,
          payload: {
            regex: record.regex,
            ...(record.createdAt ? { legacyCreatedAt: record.createdAt } : {}),
            legacyId: record.id,
            raw: record.raw,
          },
        });
        repositories.provenance.upsert({
          entityType: "preset",
          entityId: preset.id,
          sourceType: kind,
          sourceKey: recordSourceKey(options.sourceKey, kind, record.id),
          ...(options.sourceUri ? { sourceUri: options.sourceUri } : {}),
          sourceDigest: digest,
          importedAt,
          payload: { legacyId: record.id, recordIndex },
        });
        entityIds.push(preset.id);
      } catch (error) {
        warningForError(
          warnings,
          "persistence-rejected-record",
          `Legacy record '${record.name}' was not persisted`,
          error,
          { recordIndex },
        );
      }
    });
  });

  return {
    kind,
    parsedRecords: parsed.records.length,
    persistedEntities: new Set(entityIds).size,
    entityIds: [...new Set(entityIds)],
    warnings,
  };
}

function persistTradePresets(
  database: LocalPersistenceDatabase,
  input: string,
  options: LegacyPersistenceImportOptions,
): LegacyPersistenceImportResult {
  const parsed = parseLegacyTradePresets(input);
  const warnings = [...parsed.warnings];
  const entityIds: string[] = [];
  const digest = sourceDigest(input);
  const importedAt = importTimestamp(options.importedAt);

  database.transaction((repositories) => {
    parsed.records.forEach((record, recordIndex) => {
      try {
        const preset = repositories.presets.upsert({
          kind: "trade-query",
          name: record.name,
          schemaVersion: 1,
          payload: {
            ...(record.league ? { league: record.league } : {}),
            ...(record.sourceUrl ? { sourceUrl: record.sourceUrl } : {}),
            ...(record.query !== undefined ? { query: record.query } : {}),
            tags: record.tags,
            ...(record.createdAt ? { legacyCreatedAt: record.createdAt } : {}),
            legacyId: record.id,
            raw: record.raw,
          },
        });
        repositories.provenance.upsert({
          entityType: "preset",
          entityId: preset.id,
          sourceType: "trade-presets",
          sourceKey: recordSourceKey(options.sourceKey, "trade-presets", record.id),
          ...(options.sourceUri ? { sourceUri: options.sourceUri } : {}),
          sourceDigest: digest,
          importedAt,
          payload: { legacyId: record.id, recordIndex },
        });
        entityIds.push(preset.id);
      } catch (error) {
        warningForError(
          warnings,
          "persistence-rejected-record",
          `Trade preset '${record.name}' was not persisted`,
          error,
          { recordIndex },
        );
      }
    });
  });

  return {
    kind: "trade-presets",
    parsedRecords: parsed.records.length,
    persistedEntities: new Set(entityIds).size,
    entityIds: [...new Set(entityIds)],
    warnings,
  };
}

function catalogInputFromScan(record: LegacyScanRecord): {
  fingerprint: string;
  name: string;
  baseType: string;
  itemClass: string;
  currentLocation: string;
  payload: unknown;
} | undefined {
  if (!record.itemFingerprint || !isRecord(record.item)) return undefined;
  return {
    fingerprint: record.itemFingerprint,
    name: aliasText(record.item, "name", "itemName") ?? "Unknown legacy item",
    baseType: aliasText(record.item, "baseType", "typeLine", "base") ?? "Unknown",
    itemClass: aliasText(record.item, "itemClass", "class") ?? "Unknown",
    currentLocation:
      aliasText(record.item, "location", "stashLocation", "tab") ?? record.slotKey,
    payload: record.item,
  };
}

function persistScanJsonl(
  database: LocalPersistenceDatabase,
  input: string,
  options: LegacyPersistenceImportOptions,
): LegacyPersistenceImportResult {
  const parsed = parseLegacyScanJsonl(input, {
    defaultSessionId: stableId("legacy-session", options.sourceKey),
  });
  const warnings = [...parsed.warnings];
  const digest = sourceDigest(input);
  const importedAt = importTimestamp(options.importedAt);
  const entityIds: string[] = [];
  const groups = new Map<string, Array<{ record: LegacyScanRecord; recordIndex: number }>>();
  parsed.records.forEach((record, recordIndex) => {
    const group = groups.get(record.sessionId) ?? [];
    group.push({ record, recordIndex });
    groups.set(record.sessionId, group);
  });

  database.transaction((repositories) => {
    for (const [legacySessionId, records] of groups) {
      const orderedTimes = records
        .flatMap(({ record }) => (record.scannedAt ? [record.scannedAt] : []))
        .sort();
      const startedAt = orderedTimes[0] ?? importedAt;
      const sessionId = stableId("scan", options.sourceKey, legacySessionId);
      try {
        const session = repositories.scanSessions.upsert({
          id: sessionId,
          source: "legacy-jsonl",
          status: "imported",
          startedAt,
          endedAt: orderedTimes.at(-1) ?? startedAt,
          summary: {
            legacySessionId,
            recordCount: records.length,
            sourceKey: options.sourceKey,
          },
        });
        repositories.provenance.upsert({
          entityType: "scan-session",
          entityId: session.id,
          sourceType: "scan-jsonl",
          sourceKey: recordSourceKey(options.sourceKey, "scan-session", legacySessionId),
          ...(options.sourceUri ? { sourceUri: options.sourceUri } : {}),
          sourceDigest: digest,
          importedAt,
          payload: { legacySessionId },
        });
        entityIds.push(session.id);
      } catch (error) {
        warningForError(
          warnings,
          "persistence-rejected-session",
          `Legacy scan session '${legacySessionId}' was not persisted`,
          error,
        );
        continue;
      }

      records.forEach(({ record, recordIndex }, ordinal) => {
        try {
          const slot = repositories.scanSlots.upsert({
            sessionId,
            slotKey: record.slotKey,
            ordinal,
            status: record.status ?? "imported",
            ...(record.itemFingerprint
              ? { itemFingerprint: record.itemFingerprint }
              : {}),
            ...(record.scannedAt ? { scannedAt: record.scannedAt } : {}),
            payload: record.raw,
          });
          repositories.provenance.upsert({
            entityType: "scan-slot",
            entityId: slot.id,
            sourceType: "scan-jsonl",
            sourceKey: recordSourceKey(options.sourceKey, "scan-record", record.id),
            ...(options.sourceUri ? { sourceUri: options.sourceUri } : {}),
            sourceDigest: digest,
            importedAt,
            payload: { legacyId: record.id, recordIndex },
          });
          entityIds.push(slot.id);

          const catalogInput = catalogInputFromScan(record);
          if (catalogInput) {
            const catalogItem = repositories.catalogItems.upsert(catalogInput);
            repositories.itemObservations.upsert({
              catalogItemId: catalogItem.id,
              observedAt: record.scannedAt ?? importedAt,
              source: "legacy-jsonl",
              location: catalogInput.currentLocation,
              payload: record.raw,
            });
            entityIds.push(catalogItem.id);
          }
        } catch (error) {
          warningForError(
            warnings,
            "persistence-rejected-record",
            `Legacy JSONL record '${record.id}' was not fully persisted`,
            error,
            { recordIndex },
          );
        }
      });
    }
  });

  return {
    kind: "scan-jsonl",
    parsedRecords: parsed.records.length,
    persistedEntities: new Set(entityIds).size,
    entityIds: [...new Set(entityIds)],
    warnings,
  };
}

export function importLegacyData(
  database: LocalPersistenceDatabase,
  kind: LegacyImportKind,
  input: string,
  options: LegacyPersistenceImportOptions,
): LegacyPersistenceImportResult {
  const sourceKey = boundedText(options.sourceKey, "legacy source key", 512);
  const normalizedOptions = { ...options, sourceKey };
  switch (kind) {
    case "scan-history":
    case "regex-history":
      return persistRegexPresets(database, input, kind, normalizedOptions);
    case "trade-presets":
      return persistTradePresets(database, input, normalizedOptions);
    case "scan-jsonl":
      return persistScanJsonl(database, input, normalizedOptions);
  }
}
