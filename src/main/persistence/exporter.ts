import type {
  IntelligenceExportKind,
  IntelligenceExportRequest,
  IntelligenceExportResult,
} from "../../shared/ipc.js";
import type { LocalPersistenceDatabase } from "./database.js";
import { deterministicJson, utcTimestamp } from "./json.js";

export const INTELLIGENCE_EXPORT_SCHEMA_VERSION = 1 as const;
export const MAX_INTELLIGENCE_EXPORT_BYTES = 25 * 1024 * 1024;

function safeStamp(timestamp: string): string {
  return timestamp.replaceAll(/[:.]/g, "-");
}

function prettyJson(value: unknown): string {
  const canonical = deterministicJson(
    value,
    "item intelligence export",
    MAX_INTELLIGENCE_EXPORT_BYTES,
  );
  return `${JSON.stringify(JSON.parse(canonical) as unknown, null, 2)}\n`;
}

function result(
  kind: IntelligenceExportKind,
  exportedAt: string,
  content: string,
  recordCount: number,
  extension: "json" | "jsonl",
): IntelligenceExportResult {
  const bytes = new TextEncoder().encode(content).length;
  if (bytes > MAX_INTELLIGENCE_EXPORT_BYTES) {
    throw new Error(
      `item intelligence export exceeds ${MAX_INTELLIGENCE_EXPORT_BYTES} bytes`,
    );
  }
  return {
    kind,
    schemaVersion: INTELLIGENCE_EXPORT_SCHEMA_VERSION,
    fileName: `poe2-${kind}-${safeStamp(exportedAt)}.${extension}`,
    mimeType:
      extension === "jsonl"
        ? "application/x-ndjson"
        : "application/json",
    content,
    recordCount,
    exportedAt,
  };
}

function exportRules(
  persistence: LocalPersistenceDatabase,
  exportedAt: string,
): IntelligenceExportResult {
  const ruleSets = persistence.ruleSets.list("stash-scan");
  const records = ruleSets.flatMap((set) => {
    if (!Array.isArray(set.rules)) return [];
    return set.rules.flatMap((rule, index) => {
      if (
        typeof rule !== "object" ||
        rule === null ||
        Array.isArray(rule) ||
        typeof (rule as Record<string, unknown>).regex !== "string"
      ) {
        return [];
      }
      const value = rule as Record<string, unknown>;
      return [{
        ...value,
        id:
          typeof value.id === "string"
            ? value.id
            : `${set.id}:rule:${index}`,
        name:
          typeof value.name === "string" && value.name.trim()
            ? value.name
            : set.name,
        regex: value.regex,
        ruleSetId: set.id,
        ruleSetName: set.name,
        active: set.active,
      }];
    });
  });
  return result(
    "regex-history",
    exportedAt,
    prettyJson({
      schemaVersion: INTELLIGENCE_EXPORT_SCHEMA_VERSION,
      exportedAt,
      regexHistory: records,
    }),
    records.length,
    "json",
  );
}

function exportTradePresets(
  persistence: LocalPersistenceDatabase,
  exportedAt: string,
): IntelligenceExportResult {
  const records = persistence.presets.list("trade-query").map((preset) => ({
    id: preset.id,
    name: preset.name,
    schemaVersion: preset.schemaVersion,
    ...(
      typeof preset.payload === "object" &&
      preset.payload !== null &&
      !Array.isArray(preset.payload)
        ? preset.payload
        : { payload: preset.payload }
    ),
  }));
  return result(
    "trade-presets",
    exportedAt,
    prettyJson({
      schemaVersion: INTELLIGENCE_EXPORT_SCHEMA_VERSION,
      exportedAt,
      tradePresets: records,
    }),
    records.length,
    "json",
  );
}

function exportScanJsonl(
  persistence: LocalPersistenceDatabase,
  exportedAt: string,
  sessionId?: string,
): IntelligenceExportResult {
  const sessions = sessionId
    ? [persistence.scanSessions.get(sessionId)].filter(
        (entry): entry is NonNullable<typeof entry> => entry !== undefined,
      )
    : persistence.scanSessions.list(10_000);
  if (sessionId && sessions.length === 0) {
    throw new Error("scan-session-not-found");
  }
  const records = sessions.flatMap((session) =>
    persistence.scanSlots.listForSession(session.id).map((slot) => ({
      schemaVersion: INTELLIGENCE_EXPORT_SCHEMA_VERSION,
      sessionId: session.id,
      sessionSource: session.source,
      sessionStatus: session.status,
      slotKey: slot.slotKey,
      ordinal: slot.ordinal,
      status: slot.status,
      ...(slot.itemFingerprint
        ? { itemFingerprint: slot.itemFingerprint }
        : {}),
      ...(slot.scannedAt ? { scannedAt: slot.scannedAt } : {}),
      payload: slot.payload,
    })),
  );
  const content =
    records.length === 0
      ? ""
      : `${records
          .map((record) =>
            deterministicJson(
              record,
              "scan JSONL record",
              MAX_INTELLIGENCE_EXPORT_BYTES,
            ),
          )
          .join("\n")}\n`;
  return result(
    "scan-jsonl",
    exportedAt,
    content,
    records.length,
    "jsonl",
  );
}

function exportBundle(
  persistence: LocalPersistenceDatabase,
  exportedAt: string,
): IntelligenceExportResult {
  const catalog = persistence.catalogItems.list(10_000);
  const scans = persistence.scanSessions.list(10_000).map((session) => ({
    ...session,
    slots: persistence.scanSlots.listForSession(session.id),
  }));
  const bundle = {
    schemaVersion: INTELLIGENCE_EXPORT_SCHEMA_VERSION,
    exportedAt,
    catalog: catalog.map((item) => ({
      ...item,
      observations: persistence.itemObservations.listForCatalogItem(
        item.id,
        10_000,
      ),
      valuations: persistence.valuations.listForCatalogItem(item.id, 10_000),
    })),
    ruleSets: persistence.ruleSets.list(undefined, 10_000),
    presets: persistence.presets.list(undefined, 10_000),
    buildProfiles: persistence.buildProfiles.list(10_000),
    scans,
    settings: persistence.settings.list(10_000),
  };
  const recordCount =
    catalog.length +
    bundle.ruleSets.length +
    bundle.presets.length +
    bundle.buildProfiles.length +
    scans.reduce((count, scan) => count + 1 + scan.slots.length, 0) +
    bundle.settings.length;
  return result(
    "bundle",
    exportedAt,
    prettyJson(bundle),
    recordCount,
    "json",
  );
}

export function exportIntelligenceData(
  persistence: LocalPersistenceDatabase,
  request: IntelligenceExportRequest,
  now: Date | string | number = new Date(),
): IntelligenceExportResult {
  const exportedAt = utcTimestamp(now, "export timestamp");
  switch (request.kind) {
    case "regex-history":
      return exportRules(persistence, exportedAt);
    case "trade-presets":
      return exportTradePresets(persistence, exportedAt);
    case "scan-jsonl":
      return exportScanJsonl(
        persistence,
        exportedAt,
        request.scanSessionId?.trim() || undefined,
      );
    case "bundle":
      return exportBundle(persistence, exportedAt);
  }
}
