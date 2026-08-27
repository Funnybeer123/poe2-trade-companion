export const SCAN_CONTRACT_VERSION = 1 as const;

export type ScanContractVersion = typeof SCAN_CONTRACT_VERSION;
export type ScanGridKind = "stash-normal" | "stash-quad" | "inventory";
export type ScanSourceMode = "live" | "replay" | "fixture";
export type ScanRuntimeMode = "public-companion" | "authorized-qa" | "assistive-access";
export type ScanSlotStatus =
  | "copied"
  | "empty"
  | "skipped-footprint"
  | "copy-timeout"
  | "blocked"
  | "cancelled";

export interface ScanGridCell {
  row: number;
  col: number;
}

export interface ScanClientPoint {
  x: number;
  y: number;
}

export interface ScanGridSpec {
  kind: ScanGridKind;
  cols: number;
  rows: number;
}

export interface ScanCoordinateSpace {
  kind: "client-relative";
  origin: "client-top-left";
  pointUnit: "physical-pixel";
  gridIndexBase: 0;
}

export const CLIENT_RELATIVE_SCAN_SPACE: Readonly<ScanCoordinateSpace> = Object.freeze({
  kind: "client-relative",
  origin: "client-top-left",
  pointUnit: "physical-pixel",
  gridIndexBase: 0,
});

export interface ScanTimingMetadata {
  profile: string;
  hoverMs: number;
  copyTimeoutMs: number;
  pollIntervalMs: number;
  afterCopyMs: number;
  randomized: boolean;
  seed?: string;
}

export interface ScanSourceMetadata {
  sourceMode: ScanSourceMode;
  runtimeMode: ScanRuntimeMode;
  profileId: string;
  profileVersion?: number;
  calibrationId?: string;
  calibrationHash: string;
  ruleHash: string;
  timing: ScanTimingMetadata;
}

export interface ScanSessionContext {
  coordinateSpace: ScanCoordinateSpace;
  grid: ScanGridSpec;
  source: ScanSourceMetadata;
}

export type ScanFootprintSource =
  | "measured"
  | "fixed-class"
  | "parsed"
  | "legacy";

export type ScanFootprint =
  | {
      known: true;
      width: number;
      height: number;
      source: ScanFootprintSource;
      clipped: boolean;
      claimedCells: ScanGridCell[];
    }
  | {
      known: false;
      width: null;
      height: null;
      source: "unknown";
      clipped: false;
      claimedCells: ScanGridCell[];
    };

/**
 * A planner-produced slot record before a persistence layer assigns session
 * identity. Sequences are zero-based and cells are always client-grid-relative.
 */
export interface ScanSlotDraft {
  sequence: number;
  observedAt: string;
  cell: ScanGridCell;
  clientPoint?: ScanClientPoint;
  status: ScanSlotStatus;
  attempt: number;
  rawText?: string;
  textTruncated?: boolean;
  itemFingerprint?: string;
  footprint?: ScanFootprint;
  claimedBy?: ScanGridCell;
  ruleMatched?: boolean;
  reason?: string;
}

/** Portable, self-describing slot record used by JSONL persistence/export. */
export interface ScanSlotRecord extends ScanSlotDraft {
  schemaVersion: ScanContractVersion;
  recordType: "scan-slot";
  id: string;
  sessionId: string;
  context: ScanSessionContext;
}

export const SUPPORTED_SCAN_GRIDS: Readonly<Record<ScanGridKind, ScanGridSpec>> =
  Object.freeze({
    "stash-normal": Object.freeze({
      kind: "stash-normal",
      cols: 12,
      rows: 12,
    }),
    "stash-quad": Object.freeze({
      kind: "stash-quad",
      cols: 24,
      rows: 24,
    }),
    inventory: Object.freeze({
      kind: "inventory",
      cols: 12,
      rows: 5,
    }),
  });

export function createScanGrid(kind: ScanGridKind): ScanGridSpec {
  return { ...SUPPORTED_SCAN_GRIDS[kind] };
}

export function assertSupportedScanGrid(grid: ScanGridSpec): void {
  const expected = SUPPORTED_SCAN_GRIDS[grid.kind];
  if (
    !Number.isInteger(grid.cols) ||
    !Number.isInteger(grid.rows) ||
    grid.cols !== expected.cols ||
    grid.rows !== expected.rows
  ) {
    throw new Error(
      `unsupported-scan-grid:${grid.kind}:${String(grid.cols)}x${String(grid.rows)}`,
    );
  }
}

export function assertScanGridCell(cell: ScanGridCell, grid: ScanGridSpec): void {
  if (
    !Number.isInteger(cell.row) ||
    !Number.isInteger(cell.col) ||
    cell.row < 0 ||
    cell.col < 0 ||
    cell.row >= grid.rows ||
    cell.col >= grid.cols
  ) {
    throw new Error(`scan-cell-out-of-bounds:${String(cell.row)},${String(cell.col)}`);
  }
}

export function assertClientPoint(point: ScanClientPoint): void {
  if (
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    point.x < 0 ||
    point.y < 0
  ) {
    throw new Error(`invalid-client-relative-point:${String(point.x)},${String(point.y)}`);
  }
}

export function toUtcTimestamp(value: string | number | Date): string {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("invalid-scan-timestamp");
  return date.toISOString();
}

export function isUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !value.endsWith("Z")) return false;
  try {
    return toUtcTimestamp(value) === value;
  } catch {
    return false;
  }
}

function assertNonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label}-required`);
}

function assertBoundedMilliseconds(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 300_000) {
    throw new Error(`invalid-${label}`);
  }
}

export function assertScanSourceMetadata(metadata: ScanSourceMetadata): void {
  if (!["live", "replay", "fixture"].includes(metadata.sourceMode)) {
    throw new Error("invalid-scan-source-mode");
  }
  if (
    !["public-companion", "authorized-qa", "assistive-access"].includes(
      metadata.runtimeMode,
    )
  ) {
    throw new Error("invalid-scan-runtime-mode");
  }
  assertNonEmpty(metadata.profileId, "scan-profile-id");
  assertNonEmpty(metadata.calibrationHash, "scan-calibration-hash");
  assertNonEmpty(metadata.ruleHash, "scan-rule-hash");
  assertNonEmpty(metadata.timing.profile, "scan-timing-profile");
  if (
    metadata.profileVersion != null &&
    (!Number.isInteger(metadata.profileVersion) || metadata.profileVersion < 0)
  ) {
    throw new Error("invalid-scan-profile-version");
  }
  assertBoundedMilliseconds(metadata.timing.hoverMs, "scan-hover-ms");
  assertBoundedMilliseconds(metadata.timing.copyTimeoutMs, "scan-copy-timeout-ms");
  assertBoundedMilliseconds(metadata.timing.pollIntervalMs, "scan-poll-interval-ms");
  assertBoundedMilliseconds(metadata.timing.afterCopyMs, "scan-after-copy-ms");
  if (metadata.timing.pollIntervalMs > metadata.timing.copyTimeoutMs) {
    throw new Error("scan-poll-interval-exceeds-timeout");
  }
}

export function assertScanSessionContext(context: ScanSessionContext): void {
  if (
    context.coordinateSpace.kind !== "client-relative" ||
    context.coordinateSpace.origin !== "client-top-left" ||
    context.coordinateSpace.pointUnit !== "physical-pixel" ||
    context.coordinateSpace.gridIndexBase !== 0
  ) {
    throw new Error("unsupported-scan-coordinate-space");
  }
  assertSupportedScanGrid(context.grid);
  assertScanSourceMetadata(context.source);
}

export interface JsonlParseIssue {
  lineNumber: number;
  message: string;
  line: string;
}

export interface JsonlParseResult<T> {
  records: T[];
  issues: JsonlParseIssue[];
  recoveredPartialLine: boolean;
  partialLine?: string;
}

/**
 * Parses complete JSONL records and safely ignores an unterminated malformed
 * final line. Malformed complete lines are reported while later valid records
 * remain recoverable.
 */
export function parseJsonlWithPartialRecovery<T>(
  text: string,
  decode: (value: unknown, lineNumber: number) => T,
): JsonlParseResult<T> {
  const lines = text.split(/\r?\n/);
  const terminated = /(?:\r\n|\n)$/.test(text);
  const lastContentIndex = (() => {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (lines[index]!.trim()) return index;
    }
    return -1;
  })();
  const records: T[] = [];
  const issues: JsonlParseIssue[] = [];
  let recoveredPartialLine = false;
  let partialLine: string | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    try {
      records.push(decode(JSON.parse(line) as unknown, index + 1));
    } catch (error) {
      const isUnterminatedTail = !terminated && index === lastContentIndex;
      if (isUnterminatedTail) {
        recoveredPartialLine = true;
        partialLine = line;
        continue;
      }
      issues.push({
        lineNumber: index + 1,
        message: error instanceof Error ? error.message : "invalid-jsonl-record",
        line,
      });
    }
  }

  return {
    records,
    issues,
    recoveredPartialLine,
    ...(partialLine == null ? {} : { partialLine }),
  };
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("legacy-scan-record-must-be-object");
  }
  return value as UnknownRecord;
}

function caseInsensitiveRecord(value: unknown): Map<string, unknown> {
  return new Map(
    Object.entries(asRecord(value)).map(([key, entry]) => [
      key.replace(/[^a-z0-9]/gi, "").toLowerCase(),
      entry,
    ]),
  );
}

function legacyValue(
  record: Map<string, unknown>,
  ...names: string[]
): unknown {
  for (const name of names) {
    const value = record.get(name.replace(/[^a-z0-9]/gi, "").toLowerCase());
    if (value != null) return value;
  }
  return undefined;
}

function optionalInteger(value: unknown, label: string): number | undefined {
  if (value == null || value === "") return undefined;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(number)) throw new Error(`invalid-legacy-${label}`);
  return number;
}

function requiredInteger(value: unknown, label: string): number {
  const number = optionalInteger(value, label);
  if (number == null) throw new Error(`legacy-${label}-required`);
  return number;
}

function optionalNumber(value: unknown, label: string): number | undefined {
  if (value == null || value === "") return undefined;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) throw new Error(`invalid-legacy-${label}`);
  return number;
}

function optionalString(value: unknown): string | undefined {
  if (value == null) return undefined;
  return String(value);
}

function normalizeLegacyStatus(value: unknown): ScanSlotStatus {
  const status = String(value ?? "")
    .trim()
    .replace(/[_\s]+/g, "-")
    .toLowerCase();
  if (["copied", "copy", "success", "item", "occupied"].includes(status)) return "copied";
  if (["empty", "no-item", "none"].includes(status)) return "empty";
  if (
    [
      "skipped",
      "skip",
      "skipped-footprint",
      "skippedfootprint",
      "footprint",
    ].includes(status)
  ) {
    return "skipped-footprint";
  }
  if (["copy-timeout", "copytimeout", "timeout", "timed-out"].includes(status)) {
    return "copy-timeout";
  }
  if (["blocked", "denied"].includes(status)) return "blocked";
  if (["cancelled", "canceled", "aborted"].includes(status)) return "cancelled";
  throw new Error(`unsupported-legacy-slot-status:${status || "(empty)"}`);
}

export interface LegacyScanImportOptions {
  sessionId: string;
  context: ScanSessionContext;
  /** Absolute screen coordinate of the client area's top-left corner. */
  clientOrigin?: ScanClientPoint;
  defaultObservedAt?: string | number | Date;
}

export interface LegacyScanImportResult extends JsonlParseResult<ScanSlotRecord> {
  format: "legacy-jsonl";
}

function decodeLegacyScanRecord(
  value: unknown,
  lineNumber: number,
  options: LegacyScanImportOptions,
): ScanSlotRecord {
  const legacy = caseInsensitiveRecord(value);
  const legacyRows = optionalInteger(
    legacyValue(legacy, "rows", "gridRows"),
    "grid-rows",
  );
  const legacyCols = optionalInteger(
    legacyValue(legacy, "cols", "columns", "gridCols", "gridColumns"),
    "grid-columns",
  );
  if (
    (legacyRows != null && legacyRows !== options.context.grid.rows) ||
    (legacyCols != null && legacyCols !== options.context.grid.cols)
  ) {
    throw new Error("legacy-grid-shape-mismatch");
  }
  const scanType = optionalString(legacyValue(legacy, "scanType", "gridType"))
    ?.replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
  const expectedScanTypes: Record<ScanGridKind, string[]> = {
    "stash-normal": ["normal", "normalstash", "stash", "stashnormal"],
    "stash-quad": ["quad", "quadstash", "stashquad"],
    inventory: ["inventory", "bag"],
  };
  if (
    scanType &&
    !expectedScanTypes[options.context.grid.kind].includes(scanType)
  ) {
    throw new Error("legacy-scan-type-mismatch");
  }
  const oneBasedRow = requiredInteger(
    legacyValue(legacy, "row", "gridRow", "slotRow"),
    "row",
  );
  const oneBasedCol = requiredInteger(
    legacyValue(legacy, "col", "column", "gridCol", "gridColumn", "slotCol", "slotColumn"),
    "column",
  );
  const cell = { row: oneBasedRow - 1, col: oneBasedCol - 1 };
  assertScanGridCell(cell, options.context.grid);

  const absoluteX = optionalNumber(
    legacyValue(legacy, "x", "absoluteX", "screenX", "mouseX", "pixelX"),
    "x",
  );
  const absoluteY = optionalNumber(
    legacyValue(legacy, "y", "absoluteY", "screenY", "mouseY", "pixelY"),
    "y",
  );
  if ((absoluteX == null) !== (absoluteY == null)) {
    throw new Error("legacy-absolute-point-incomplete");
  }

  let clientPoint: ScanClientPoint | undefined;
  if (absoluteX != null && absoluteY != null) {
    const left =
      options.clientOrigin?.x ??
      optionalNumber(
        legacyValue(legacy, "clientLeft", "windowLeft", "clientOriginX"),
        "client-left",
      );
    const top =
      options.clientOrigin?.y ??
      optionalNumber(
        legacyValue(legacy, "clientTop", "windowTop", "clientOriginY"),
        "client-top",
      );
    if (left == null || top == null) {
      throw new Error("client-origin-required-for-legacy-absolute-point");
    }
    clientPoint = { x: absoluteX - left, y: absoluteY - top };
    assertClientPoint(clientPoint);
  }

  const width = optionalInteger(
    legacyValue(legacy, "w", "width", "gridWidth", "footprintWidth"),
    "footprint-width",
  );
  const height = optionalInteger(
    legacyValue(legacy, "h", "height", "gridHeight", "footprintHeight"),
    "footprint-height",
  );
  if ((width == null) !== (height == null)) {
    throw new Error("legacy-footprint-incomplete");
  }
  if (
    (width != null &&
      (width < 1 || width > options.context.grid.cols)) ||
    (height != null &&
      (height < 1 || height > options.context.grid.rows))
  ) {
    throw new Error("invalid-legacy-footprint");
  }

  const rawText = optionalString(
    legacyValue(legacy, "rawText", "itemText", "clipboardText", "text"),
  );
  const legacyStatus = legacyValue(legacy, "status", "slotStatus", "result");
  const status =
    legacyStatus == null
      ? rawText?.trim()
        ? "copied"
        : "empty"
      : normalizeLegacyStatus(legacyStatus);
  const observedAt = toUtcTimestamp(
    legacyValue(
      legacy,
      "observedAt",
      "timestamp",
      "capturedAt",
      "createdAt",
      "time",
    ) as string | number | Date ??
      options.defaultObservedAt ??
      0,
  );
  const attempt =
    optionalInteger(legacyValue(legacy, "attempt", "copyAttempt"), "attempt") ?? 1;
  if (attempt < 1) throw new Error("invalid-legacy-attempt");

  const claimedRow = optionalInteger(
    legacyValue(legacy, "claimedByRow", "originRow"),
    "claimed-by-row",
  );
  const claimedCol = optionalInteger(
    legacyValue(legacy, "claimedByCol", "claimedByColumn", "originCol", "originColumn"),
    "claimed-by-column",
  );
  if ((claimedRow == null) !== (claimedCol == null)) {
    throw new Error("legacy-claimed-by-incomplete");
  }
  const claimedBy =
    claimedRow == null || claimedCol == null
      ? undefined
      : { row: claimedRow - 1, col: claimedCol - 1 };
  if (claimedBy) assertScanGridCell(claimedBy, options.context.grid);

  const footprint: ScanFootprint | undefined =
    width == null || height == null
      ? status === "copied"
        ? {
            known: false,
            width: null,
            height: null,
            source: "unknown",
            clipped: false,
            claimedCells: [{ ...cell }],
          }
        : undefined
      : {
          known: true,
          width,
          height,
          source: "legacy",
          clipped:
            cell.row + height > options.context.grid.rows ||
            cell.col + width > options.context.grid.cols,
          claimedCells: Array.from({ length: height }, (_, rowOffset) =>
            Array.from({ length: width }, (_, colOffset) => ({
              row: cell.row + rowOffset,
              col: cell.col + colOffset,
            })),
          )
            .flat()
            .filter(
              (claimed) =>
                claimed.row < options.context.grid.rows &&
                claimed.col < options.context.grid.cols,
            ),
        };
  const sequence =
    optionalInteger(legacyValue(legacy, "sequence", "index"), "sequence") ??
    lineNumber - 1;

  return {
    schemaVersion: SCAN_CONTRACT_VERSION,
    recordType: "scan-slot",
    id:
      optionalString(legacyValue(legacy, "id", "recordId")) ??
      `${options.sessionId}:legacy:${String(lineNumber)}`,
    sessionId: options.sessionId,
    context: options.context,
    sequence: Math.max(0, sequence),
    observedAt,
    cell,
    ...(clientPoint ? { clientPoint } : {}),
    status,
    attempt,
    ...(rawText == null ? {} : { rawText }),
    ...(optionalString(legacyValue(legacy, "fingerprint", "itemFingerprint")) == null
      ? {}
      : {
          itemFingerprint: optionalString(
            legacyValue(legacy, "fingerprint", "itemFingerprint"),
          ),
        }),
    ...(footprint ? { footprint } : {}),
    ...(claimedBy ? { claimedBy } : {}),
    ...(optionalString(legacyValue(legacy, "reason", "message")) == null
      ? {}
      : { reason: optionalString(legacyValue(legacy, "reason", "message")) }),
  };
}

export function importLegacyScanJsonl(
  text: string,
  options: LegacyScanImportOptions,
): LegacyScanImportResult {
  assertNonEmpty(options.sessionId, "scan-session-id");
  assertScanSessionContext(options.context);
  if (options.clientOrigin) assertClientPoint(options.clientOrigin);
  const parsed = parseJsonlWithPartialRecovery(text, (value, lineNumber) =>
    decodeLegacyScanRecord(value, lineNumber, options),
  );
  return { ...parsed, format: "legacy-jsonl" };
}

export interface LegacyScanExportOptions {
  style: "camelCase" | "PascalCase";
  /** Absolute screen coordinate of the client area's top-left corner. */
  clientOrigin: ScanClientPoint;
  profileIndex?: number;
}

function pascalCaseKeys(record: UnknownRecord): UnknownRecord {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      `${key.charAt(0).toUpperCase()}${key.slice(1)}`,
      value,
    ]),
  );
}

export function exportLegacyScanJsonl(
  records: readonly ScanSlotRecord[],
  options: LegacyScanExportOptions,
): string {
  assertClientPoint(options.clientOrigin);
  if (
    options.profileIndex != null &&
    (!Number.isInteger(options.profileIndex) || options.profileIndex < 0)
  ) {
    throw new Error("invalid-legacy-profile-index");
  }
  if (records.length === 0) return "";
  return (
    records
      .map((record) => {
        assertScanSessionContext(record.context);
        assertScanGridCell(record.cell, record.context.grid);
        const legacy: UnknownRecord = {
          version: record.schemaVersion,
          recordId: record.id,
          sessionId: record.sessionId,
          scanType:
            record.context.grid.kind === "stash-normal"
              ? "normal"
              : record.context.grid.kind === "stash-quad"
                ? "quad"
                : "inventory",
          profileIndex: options.profileIndex ?? 0,
          rows: record.context.grid.rows,
          cols: record.context.grid.cols,
          sequence: record.sequence,
          row: record.cell.row + 1,
          column: record.cell.col + 1,
          coordinateSpace: "absolute-screen",
          indexBase: 1,
          status: record.status,
          capturedAt: toUtcTimestamp(record.observedAt),
          observedAt: toUtcTimestamp(record.observedAt),
          attempt: record.attempt,
          sourceMode: record.context.source.sourceMode,
          runtimeMode: record.context.source.runtimeMode,
          profileId: record.context.source.profileId,
          calibrationHash: record.context.source.calibrationHash,
          ruleHash: record.context.source.ruleHash,
          timingProfile: record.context.source.timing.profile,
        };
        if (record.clientPoint) {
          legacy.x = record.clientPoint.x + options.clientOrigin.x;
          legacy.y = record.clientPoint.y + options.clientOrigin.y;
          legacy.clientLeft = options.clientOrigin.x;
          legacy.clientTop = options.clientOrigin.y;
        }
        legacy.itemText = record.rawText ?? "";
        if (record.rawText != null) legacy.rawText = record.rawText;
        if (record.itemFingerprint != null) {
          legacy.itemFingerprint = record.itemFingerprint;
        }
        if (record.reason != null) legacy.reason = record.reason;
        if (record.ruleMatched != null) legacy.ruleMatched = record.ruleMatched;
        if (record.footprint?.known) {
          legacy.gridWidth = record.footprint.width;
          legacy.gridHeight = record.footprint.height;
          legacy.footprintClipped = record.footprint.clipped;
        }
        if (record.claimedBy) {
          legacy.claimedByRow = record.claimedBy.row + 1;
          legacy.claimedByColumn = record.claimedBy.col + 1;
        }
        return JSON.stringify(
          options.style === "PascalCase" ? pascalCaseKeys(legacy) : legacy,
        );
      })
      .join("\n") + "\n"
  );
}
