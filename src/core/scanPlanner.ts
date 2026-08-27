import {
  SCAN_CONTRACT_VERSION,
  assertClientPoint,
  assertScanGridCell,
  assertSupportedScanGrid,
  isUtcTimestamp,
  toUtcTimestamp,
  type ScanClientPoint,
  type ScanFootprint,
  type ScanFootprintSource,
  type ScanGridCell,
  type ScanGridSpec,
  type ScanSlotDraft,
  type ScanSlotStatus,
} from "./scanContracts.js";

export type ScanPlannerPhase = "active" | "cancelled" | "finished";
export type ScanUnknownSizePolicy = "scan-each-cell" | "block";
export type ScanFootprintEdgePolicy = "clip" | "reject";

export interface ScanPlannerOptions {
  grid: ScanGridSpec;
  unknownSizePolicy?: ScanUnknownSizePolicy;
  edgePolicy?: ScanFootprintEdgePolicy;
}

export interface ScanClaim {
  cell: ScanGridCell;
  origin: ScanGridCell;
}

export interface ScanCancellation {
  at: string;
  reason: string;
  cell: ScanGridCell;
}

export interface ScanPlannerSnapshot {
  schemaVersion: typeof SCAN_CONTRACT_VERSION;
  snapshotType: "scan-planner";
  grid: ScanGridSpec;
  unknownSizePolicy: ScanUnknownSizePolicy;
  edgePolicy: ScanFootprintEdgePolicy;
  phase: ScanPlannerPhase;
  /** Row-major linear index of the next cell needing a real observation. */
  cursor: number;
  revision: number;
  nextSequence: number;
  records: ScanSlotDraft[];
  claims: ScanClaim[];
  lastCancellation?: ScanCancellation;
}

export interface ScanTarget {
  cell: ScanGridCell;
  ordinal: number;
  attempt: number;
}

export interface KnownFootprintInput {
  width: number;
  height: number;
  source: ScanFootprintSource;
}

export interface RecordScanObservationInput {
  at: string | number | Date;
  status: Exclude<ScanSlotStatus, "skipped-footprint" | "cancelled">;
  clientPoint?: ScanClientPoint;
  rawText?: string;
  itemFingerprint?: string;
  footprint?: KnownFootprintInput;
  ruleMatched?: boolean;
  reason?: string;
}

export interface FootprintGeometry {
  valid: boolean;
  reason?: string;
  clipped: boolean;
  requestedWidth: number;
  requestedHeight: number;
  claimedCells: ScanGridCell[];
}

function cellKey(cell: ScanGridCell): string {
  return `${cell.row},${cell.col}`;
}

function indexToCell(index: number, grid: ScanGridSpec): ScanGridCell {
  return {
    row: Math.floor(index / grid.cols),
    col: index % grid.cols,
  };
}

function cellToIndex(cell: ScanGridCell, grid: ScanGridSpec): number {
  return cell.row * grid.cols + cell.col;
}

function cloneCell(cell: ScanGridCell): ScanGridCell {
  return { row: cell.row, col: cell.col };
}

function clonePoint(point: ScanClientPoint | undefined): ScanClientPoint | undefined {
  return point ? { x: point.x, y: point.y } : undefined;
}

function cloneFootprint(footprint: ScanFootprint | undefined): ScanFootprint | undefined {
  if (!footprint) return undefined;
  return {
    ...footprint,
    claimedCells: footprint.claimedCells.map(cloneCell),
  } as ScanFootprint;
}

function cloneRecord(record: ScanSlotDraft): ScanSlotDraft {
  return {
    ...record,
    cell: cloneCell(record.cell),
    ...(record.clientPoint ? { clientPoint: clonePoint(record.clientPoint) } : {}),
    ...(record.footprint ? { footprint: cloneFootprint(record.footprint) } : {}),
    ...(record.claimedBy ? { claimedBy: cloneCell(record.claimedBy) } : {}),
  };
}

function cloneSnapshot(snapshot: ScanPlannerSnapshot): ScanPlannerSnapshot {
  return {
    ...snapshot,
    grid: { ...snapshot.grid },
    records: snapshot.records.map(cloneRecord),
    claims: snapshot.claims.map((claim) => ({
      cell: cloneCell(claim.cell),
      origin: cloneCell(claim.origin),
    })),
    ...(snapshot.lastCancellation
      ? {
          lastCancellation: {
            ...snapshot.lastCancellation,
            cell: cloneCell(snapshot.lastCancellation.cell),
          },
        }
      : {}),
  };
}

function attemptForCell(snapshot: ScanPlannerSnapshot, cell: ScanGridCell): number {
  let attempt = 0;
  for (const record of snapshot.records) {
    if (record.cell.row === cell.row && record.cell.col === cell.col) {
      attempt = Math.max(attempt, record.attempt);
    }
  }
  return attempt + 1;
}

function appendRecord(
  snapshot: ScanPlannerSnapshot,
  record: Omit<ScanSlotDraft, "sequence">,
): void {
  snapshot.records.push({
    ...record,
    sequence: snapshot.nextSequence,
    cell: cloneCell(record.cell),
    ...(record.clientPoint ? { clientPoint: clonePoint(record.clientPoint) } : {}),
    ...(record.footprint ? { footprint: cloneFootprint(record.footprint) } : {}),
    ...(record.claimedBy ? { claimedBy: cloneCell(record.claimedBy) } : {}),
  });
  snapshot.nextSequence += 1;
}

function claimsByCell(snapshot: ScanPlannerSnapshot): Map<string, ScanClaim> {
  return new Map(snapshot.claims.map((claim) => [cellKey(claim.cell), claim]));
}

function advancePastClaims(snapshot: ScanPlannerSnapshot, at: string): void {
  const claimMap = claimsByCell(snapshot);
  const total = snapshot.grid.cols * snapshot.grid.rows;
  while (snapshot.cursor < total) {
    const cell = indexToCell(snapshot.cursor, snapshot.grid);
    const claim = claimMap.get(cellKey(cell));
    if (!claim) break;
    appendRecord(snapshot, {
      observedAt: at,
      cell,
      status: "skipped-footprint",
      attempt: attemptForCell(snapshot, cell),
      claimedBy: claim.origin,
      reason: `claimed by known footprint at ${claim.origin.row},${claim.origin.col}`,
    });
    snapshot.cursor += 1;
  }
  if (snapshot.cursor >= total) snapshot.phase = "finished";
}

export function createScanPlanner(
  options: ScanPlannerOptions,
): ScanPlannerSnapshot {
  assertSupportedScanGrid(options.grid);
  const unknownSizePolicy = options.unknownSizePolicy ?? "scan-each-cell";
  const edgePolicy = options.edgePolicy ?? "clip";
  if (!["scan-each-cell", "block"].includes(unknownSizePolicy)) {
    throw new Error("invalid-unknown-size-policy");
  }
  if (!["clip", "reject"].includes(edgePolicy)) {
    throw new Error("invalid-footprint-edge-policy");
  }
  return {
    schemaVersion: SCAN_CONTRACT_VERSION,
    snapshotType: "scan-planner",
    grid: { ...options.grid },
    unknownSizePolicy,
    edgePolicy,
    phase: "active",
    cursor: 0,
    revision: 0,
    nextSequence: 0,
    records: [],
    claims: [],
  };
}

export function nextScanTarget(
  snapshot: ScanPlannerSnapshot,
): ScanTarget | null {
  assertScanPlannerSnapshot(snapshot);
  if (snapshot.phase !== "active") return null;
  const total = snapshot.grid.cols * snapshot.grid.rows;
  if (snapshot.cursor >= total) return null;
  const cell = indexToCell(snapshot.cursor, snapshot.grid);
  return {
    cell,
    ordinal: snapshot.cursor,
    attempt: attemptForCell(snapshot, cell),
  };
}

export function footprintGeometry(
  origin: ScanGridCell,
  width: number,
  height: number,
  grid: ScanGridSpec,
): FootprintGeometry {
  assertSupportedScanGrid(grid);
  assertScanGridCell(origin, grid);
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > grid.cols ||
    height > grid.rows
  ) {
    return {
      valid: false,
      reason: "invalid-footprint-size",
      clipped: false,
      requestedWidth: width,
      requestedHeight: height,
      claimedCells: [],
    };
  }
  const claimedCells: ScanGridCell[] = [];
  let clipped = false;
  for (let row = origin.row; row < origin.row + height; row += 1) {
    for (let col = origin.col; col < origin.col + width; col += 1) {
      if (row >= grid.rows || col >= grid.cols) {
        clipped = true;
        continue;
      }
      claimedCells.push({ row, col });
    }
  }
  return {
    valid: true,
    clipped,
    requestedWidth: width,
    requestedHeight: height,
    claimedCells,
  };
}

function knownFootprint(
  input: KnownFootprintInput,
  geometry: FootprintGeometry,
): ScanFootprint {
  return {
    known: true,
    width: input.width,
    height: input.height,
    source: input.source,
    clipped: geometry.clipped,
    claimedCells: geometry.claimedCells.map(cloneCell),
  };
}

function unknownFootprint(cell: ScanGridCell): ScanFootprint {
  return {
    known: false,
    width: null,
    height: null,
    source: "unknown",
    clipped: false,
    claimedCells: [cloneCell(cell)],
  };
}

function blockedObservation(
  snapshot: ScanPlannerSnapshot,
  input: RecordScanObservationInput,
  cell: ScanGridCell,
  at: string,
  reason: string,
  footprint?: ScanFootprint,
): ScanPlannerSnapshot {
  appendRecord(snapshot, {
    observedAt: at,
    cell,
    ...(input.clientPoint ? { clientPoint: input.clientPoint } : {}),
    status: "blocked",
    attempt: attemptForCell(snapshot, cell),
    ...(input.rawText == null ? {} : { rawText: input.rawText }),
    ...(input.itemFingerprint == null
      ? {}
      : { itemFingerprint: input.itemFingerprint }),
    ...(footprint ? { footprint } : {}),
    ...(input.ruleMatched == null ? {} : { ruleMatched: input.ruleMatched }),
    reason,
  });
  snapshot.cursor += 1;
  advancePastClaims(snapshot, at);
  snapshot.revision += 1;
  return snapshot;
}

/**
 * Records the current row-major observation and advances over any cells claimed
 * by previously recorded known footprints. Rule results are metadata only:
 * known geometry is always claimed even when `ruleMatched` is false.
 */
export function recordScanObservation(
  source: ScanPlannerSnapshot,
  input: RecordScanObservationInput,
): ScanPlannerSnapshot {
  assertScanPlannerSnapshot(source);
  if (source.phase !== "active") {
    throw new Error(`scan-planner-not-active:${source.phase}`);
  }
  const snapshot = cloneSnapshot(source);
  const target = nextScanTarget(snapshot);
  if (!target) throw new Error("scan-planner-has-no-target");
  const at = toUtcTimestamp(input.at);
  if (input.clientPoint) assertClientPoint(input.clientPoint);
  const cell = target.cell;

  if (input.status !== "copied" && input.footprint) {
    throw new Error("footprint-requires-copied-status");
  }

  let footprint: ScanFootprint | undefined;
  if (input.status === "copied") {
    if (!input.footprint) {
      footprint = unknownFootprint(cell);
      if (snapshot.unknownSizePolicy === "block") {
        return blockedObservation(
          snapshot,
          input,
          cell,
          at,
          input.reason ?? "copied item has no trusted footprint",
          footprint,
        );
      }
    } else {
      const geometry = footprintGeometry(
        cell,
        input.footprint.width,
        input.footprint.height,
        snapshot.grid,
      );
      footprint = knownFootprint(input.footprint, geometry);
      if (!geometry.valid) {
        return blockedObservation(
          snapshot,
          input,
          cell,
          at,
          geometry.reason ?? "invalid-footprint",
          footprint,
        );
      }
      if (geometry.clipped && snapshot.edgePolicy === "reject") {
        return blockedObservation(
          snapshot,
          input,
          cell,
          at,
          "known footprint crosses grid edge",
          footprint,
        );
      }

      const existingClaims = claimsByCell(snapshot);
      const recordCells = new Set(snapshot.records.map((record) => cellKey(record.cell)));
      const conflict = geometry.claimedCells.find((claimed) => {
        const key = cellKey(claimed);
        return (
          (recordCells.has(key) && key !== cellKey(cell)) ||
          existingClaims.has(key)
        );
      });
      if (conflict) {
        return blockedObservation(
          snapshot,
          input,
          cell,
          at,
          `footprint-conflict:${cellKey(conflict)}`,
          footprint,
        );
      }
      for (const claimed of geometry.claimedCells) {
        snapshot.claims.push({
          cell: cloneCell(claimed),
          origin: cloneCell(cell),
        });
      }
    }
  }

  appendRecord(snapshot, {
    observedAt: at,
    cell,
    ...(input.clientPoint ? { clientPoint: input.clientPoint } : {}),
    status: input.status,
    attempt: target.attempt,
    ...(input.rawText == null ? {} : { rawText: input.rawText }),
    ...(input.itemFingerprint == null
      ? {}
      : { itemFingerprint: input.itemFingerprint }),
    ...(footprint ? { footprint } : {}),
    ...(input.ruleMatched == null ? {} : { ruleMatched: input.ruleMatched }),
    ...(input.reason == null ? {} : { reason: input.reason }),
  });
  snapshot.cursor += 1;
  advancePastClaims(snapshot, at);
  snapshot.revision += 1;
  return snapshot;
}

export function cancelScan(
  source: ScanPlannerSnapshot,
  at: string | number | Date,
  reason = "operator-cancelled",
  clientPoint?: ScanClientPoint,
): ScanPlannerSnapshot {
  assertScanPlannerSnapshot(source);
  if (source.phase === "finished") return cloneSnapshot(source);
  if (source.phase === "cancelled") return cloneSnapshot(source);
  const snapshot = cloneSnapshot(source);
  const cell = indexToCell(snapshot.cursor, snapshot.grid);
  if (clientPoint) assertClientPoint(clientPoint);
  const observedAt = toUtcTimestamp(at);
  appendRecord(snapshot, {
    observedAt,
    cell,
    ...(clientPoint ? { clientPoint } : {}),
    status: "cancelled",
    attempt: attemptForCell(snapshot, cell),
    reason,
  });
  snapshot.phase = "cancelled";
  snapshot.lastCancellation = {
    at: observedAt,
    reason,
    cell: cloneCell(cell),
  };
  snapshot.revision += 1;
  return snapshot;
}

export function resumeScan(
  source: ScanPlannerSnapshot,
): ScanPlannerSnapshot {
  assertScanPlannerSnapshot(source);
  if (source.phase !== "cancelled") {
    throw new Error(`scan-planner-not-cancelled:${source.phase}`);
  }
  const snapshot = cloneSnapshot(source);
  snapshot.phase = "active";
  snapshot.revision += 1;
  return snapshot;
}

export function serializeScanPlannerSnapshot(
  snapshot: ScanPlannerSnapshot,
): string {
  assertScanPlannerSnapshot(snapshot);
  return JSON.stringify(snapshot);
}

function unknownObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid-scan-planner-snapshot");
  }
  return value as Record<string, unknown>;
}

/**
 * Validates persisted planner state before it is allowed to drive a resumed
 * scan. This prevents a corrupt cursor or claim from silently skipping cells.
 */
export function restoreScanPlannerSnapshot(
  value: string | unknown,
): ScanPlannerSnapshot {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  const object = unknownObject(parsed);
  const snapshot = object as unknown as ScanPlannerSnapshot;
  assertScanPlannerSnapshot(snapshot);
  return cloneSnapshot(snapshot);
}

export function assertScanPlannerSnapshot(
  snapshot: ScanPlannerSnapshot,
): void {
  if (
    snapshot.schemaVersion !== SCAN_CONTRACT_VERSION ||
    snapshot.snapshotType !== "scan-planner"
  ) {
    throw new Error("unsupported-scan-planner-snapshot");
  }
  assertSupportedScanGrid(snapshot.grid);
  if (!["scan-each-cell", "block"].includes(snapshot.unknownSizePolicy)) {
    throw new Error("invalid-unknown-size-policy");
  }
  if (!["clip", "reject"].includes(snapshot.edgePolicy)) {
    throw new Error("invalid-footprint-edge-policy");
  }
  if (!["active", "cancelled", "finished"].includes(snapshot.phase)) {
    throw new Error("invalid-scan-planner-phase");
  }
  const total = snapshot.grid.cols * snapshot.grid.rows;
  if (
    !Number.isInteger(snapshot.cursor) ||
    snapshot.cursor < 0 ||
    snapshot.cursor > total ||
    !Number.isInteger(snapshot.revision) ||
    snapshot.revision < 0 ||
    !Number.isInteger(snapshot.nextSequence) ||
    snapshot.nextSequence < 0
  ) {
    throw new Error("invalid-scan-planner-counters");
  }
  if (!Array.isArray(snapshot.records) || !Array.isArray(snapshot.claims)) {
    throw new Error("invalid-scan-planner-collections");
  }
  if (snapshot.nextSequence !== snapshot.records.length) {
    throw new Error("scan-planner-sequence-gap");
  }
  const seenClaims = new Map<string, string>();
  for (const claim of snapshot.claims) {
    assertScanGridCell(claim.cell, snapshot.grid);
    assertScanGridCell(claim.origin, snapshot.grid);
    const key = cellKey(claim.cell);
    const origin = cellKey(claim.origin);
    const prior = seenClaims.get(key);
    if (prior && prior !== origin) throw new Error(`conflicting-scan-claim:${key}`);
    if (prior) throw new Error(`duplicate-scan-claim:${key}`);
    seenClaims.set(key, origin);
  }
  for (let index = 0; index < snapshot.records.length; index += 1) {
    const record = snapshot.records[index]!;
    if (record.sequence !== index) throw new Error("scan-planner-sequence-gap");
    if (!isUtcTimestamp(record.observedAt)) {
      throw new Error("scan-planner-timestamp-not-utc");
    }
    assertScanGridCell(record.cell, snapshot.grid);
    if (!Number.isInteger(record.attempt) || record.attempt < 1) {
      throw new Error("invalid-scan-record-attempt");
    }
    if (record.clientPoint) assertClientPoint(record.clientPoint);
  }
  if (snapshot.phase === "finished" && snapshot.cursor !== total) {
    throw new Error("finished-scan-has-pending-cells");
  }
  if (snapshot.phase !== "finished" && snapshot.cursor >= total) {
    throw new Error("pending-scan-has-no-cells");
  }
  if (
    snapshot.phase === "active" &&
    snapshot.cursor < total &&
    seenClaims.has(cellKey(indexToCell(snapshot.cursor, snapshot.grid)))
  ) {
    throw new Error("scan-cursor-points-at-claimed-cell");
  }
  if (snapshot.lastCancellation) {
    if (!isUtcTimestamp(snapshot.lastCancellation.at)) {
      throw new Error("scan-cancellation-timestamp-not-utc");
    }
    assertScanGridCell(snapshot.lastCancellation.cell, snapshot.grid);
  }

  const resolved = new Map<string, ScanSlotDraft>();
  for (const record of snapshot.records) {
    const key = cellKey(record.cell);
    const prior = resolved.get(key);
    if (
      prior &&
      !["copy-timeout", "blocked", "cancelled"].includes(prior.status)
    ) {
      throw new Error(`duplicate-final-scan-cell:${key}`);
    }
    if (prior && record.attempt <= prior.attempt) {
      throw new Error(`non-increasing-scan-attempt:${key}`);
    }
    resolved.set(key, record);
  }

  for (let index = 0; index < snapshot.cursor; index += 1) {
    const cell = indexToCell(index, snapshot.grid);
    const record = resolved.get(cellKey(cell));
    if (!record || record.status === "cancelled") {
      throw new Error(`scan-cursor-skipped-unresolved-cell:${cellKey(cell)}`);
    }
  }
}

export function plannerVisitedCells(
  snapshot: ScanPlannerSnapshot,
): ScanGridCell[] {
  assertScanPlannerSnapshot(snapshot);
  return snapshot.records
    .filter((record) => record.status !== "skipped-footprint")
    .map((record) => cloneCell(record.cell));
}

export function plannerClaimedCells(
  snapshot: ScanPlannerSnapshot,
): ScanGridCell[] {
  assertScanPlannerSnapshot(snapshot);
  return [...snapshot.claims]
    .sort(
      (left, right) =>
        cellToIndex(left.cell, snapshot.grid) -
        cellToIndex(right.cell, snapshot.grid),
    )
    .map((claim) => cloneCell(claim.cell));
}
