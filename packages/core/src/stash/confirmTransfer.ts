import { locationKey, type ReconcileResult, type ShadowItem } from "../inventory/types.js";
import type { GridCell, PendingStashTransfer } from "../world-state/types.js";

function sameLocation(
  left: ShadowItem["location"],
  right: ShadowItem["location"],
): boolean {
  return locationKey(left) === locationKey(right);
}

function cellLocation(
  kind: ShadowItem["location"]["kind"],
  cell: GridCell,
): ShadowItem["location"] {
  return { kind, tabId: cell.tabId, x: cell.x, y: cell.y };
}

export function fingerprintAt(
  cells: GridCell[],
  kind: ShadowItem["location"]["kind"],
  location: ShadowItem["location"],
): string | undefined {
  return cells.find(
    (cell) =>
      cell.occupied === true &&
      cell.itemFingerprint !== undefined &&
      cell.itemFingerprint.length > 0 &&
      sameLocation(cellLocation(kind, cell), location),
  )?.itemFingerprint;
}

export function transferObservedInCells(
  pending: PendingStashTransfer,
  inventoryCells: GridCell[],
  stashCells: GridCell[],
): boolean {
  const destKind = pending.to.kind;
  const destCells = destKind === "stash" ? stashCells : inventoryCells;
  const srcCells = pending.from.kind === "stash" ? stashCells : inventoryCells;
  const atDest = fingerprintAt(destCells, destKind, pending.to) === pending.fingerprint;
  const stillAtFrom = fingerprintAt(srcCells, pending.from.kind, pending.from) === pending.fingerprint;
  return atDest && !stillAtFrom;
}

export function transferObserved(result: ReconcileResult, pending: PendingStashTransfer): boolean {
  const atDest = [...result.confirmed, ...result.unexpected].some(
    (item) => item.fingerprint === pending.fingerprint && sameLocation(item.location, pending.to),
  );
  const stillAtFrom = [...result.confirmed, ...result.stale].some(
    (item) => item.fingerprint === pending.fingerprint && sameLocation(item.location, pending.from),
  );
  return atDest && !stillAtFrom;
}

/** Reclassify an expected move as confirmed so shadow success is observed, not assumed. */
export function applyExpectedTransfer(
  result: ReconcileResult,
  pending: PendingStashTransfer | null | undefined,
): ReconcileResult {
  if (pending === undefined || pending === null || pending.kind !== "move") {
    return result;
  }
  if (!transferObserved(result, pending)) {
    return result;
  }
  const destKey = locationKey(pending.to);
  const fromKey = locationKey(pending.from);
  const moved = [...result.unexpected, ...result.confirmed].find(
    (item) => item.fingerprint === pending.fingerprint && locationKey(item.location) === destKey,
  );
  const confirmed = result.confirmed
    .filter((item) => locationKey(item.location) !== destKey || item.fingerprint !== pending.fingerprint)
    .concat(moved === undefined ? [] : [{ ...moved, mismatch: false, stale: false }]);
  return {
    confirmed,
    unexpected: result.unexpected.filter(
      (item) => !(item.fingerprint === pending.fingerprint && locationKey(item.location) === destKey),
    ),
    missing: result.missing.filter(
      (item) => !(item.fingerprint === pending.fingerprint && locationKey(item.location) === fromKey),
    ),
    stale: result.stale,
  };
}
