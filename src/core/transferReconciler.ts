import { stashItems, type StashItem } from "./bagPack.js";
import type { OccupiedCell, UiFacts } from "./uiPerception.js";

export type TransferDirection = "stash-to-bag" | "bag-to-stash";
export type TransferItemStatus = "moved" | "rejected" | "ambiguous";
export type TransferOutcome =
  | "bag-full"
  | "bag-empty"
  | "no-more-auto-fit"
  | "source-empty"
  | "filter-exhausted"
  | "partial"
  | "failed";

export interface ReconciledItem {
  item: StashItem;
  status: TransferItemStatus;
  sourceCellsBefore: number;
  sourceCellsAfter: number;
  expectedDestinationCells: number;
}

export interface TransferReconciliation {
  direction: TransferDirection;
  moved: ReconciledItem[];
  rejected: ReconciledItem[];
  ambiguous: ReconciledItem[];
  remaining: StashItem[];
  sourceCellsBefore: number;
  sourceCellsAfter: number;
  destinationCellsBefore: number;
  destinationCellsAfter: number;
  destinationGain: number;
  panelsStable: boolean;
}

export interface FillOutcomeOptions {
  eligibleRemaining: number;
  noMoreAutoFit?: boolean;
  filtered?: boolean;
  bagCapacity?: number;
}

function cellKey(cell: Pick<OccupiedCell, "row" | "col">): string {
  return `${cell.row},${cell.col}`;
}

function cellSet(cells: Array<Pick<OccupiedCell, "row" | "col">>): Set<string> {
  return new Set(cells.map(cellKey));
}

function sourceCells(direction: TransferDirection, facts: UiFacts): OccupiedCell[] {
  return direction === "stash-to-bag" ? facts.occupiedStash : facts.occupiedBag;
}

function destinationCells(direction: TransferDirection, facts: UiFacts): OccupiedCell[] {
  return direction === "stash-to-bag" ? facts.occupiedBag : facts.occupiedStash;
}

function remainingItems(direction: TransferDirection, facts: UiFacts): StashItem[] {
  return direction === "stash-to-bag"
    ? facts.stashItems
    : stashItems(facts.occupiedBag, 12);
}

function expectedDestinationCells(item: StashItem): number {
  return Math.max(1, item.w * item.h, item.cells.length);
}

function presence(item: StashItem, cells: Set<string>): number {
  const footprint = item.cells.length ? item.cells : [item.grab];
  return footprint.filter((cell) => cells.has(cellKey(cell))).length;
}

/**
 * Reconciles one Ctrl+click burst without trusting click intent as success.
 *
 * An item is rejected when its source footprint is still present. A source
 * disappearance is confirmed as moved only while there is enough observed
 * destination growth to account for it; otherwise it stays ambiguous.
 */
export function reconcileTransfer(
  direction: TransferDirection,
  attempted: StashItem[],
  before: UiFacts,
  after: UiFacts,
): TransferReconciliation {
  const beforeSource = sourceCells(direction, before);
  const afterSource = sourceCells(direction, after);
  const beforeDestination = destinationCells(direction, before);
  const afterDestination = destinationCells(direction, after);
  const beforeSourceSet = cellSet(beforeSource);
  const afterSourceSet = cellSet(afterSource);
  const beforeDestinationSet = cellSet(beforeDestination);
  const destinationGain = [...cellSet(afterDestination)].filter((key) => !beforeDestinationSet.has(key)).length;
  let unclaimedDestinationGain = destinationGain;
  let unclaimedSourceLoss = Math.max(0, beforeSource.length - afterSource.length);

  const moved: ReconciledItem[] = [];
  const rejected: ReconciledItem[] = [];
  const ambiguous: ReconciledItem[] = [];

  for (const item of attempted) {
    const beforePresence = presence(item, beforeSourceSet);
    const afterPresence = presence(item, afterSourceSet);
    const expected = expectedDestinationCells(item);
    const result: ReconciledItem = {
      item,
      status: "ambiguous",
      sourceCellsBefore: beforePresence,
      sourceCellsAfter: afterPresence,
      expectedDestinationCells: expected,
    };

    if (beforePresence === 0) {
      ambiguous.push(result);
      continue;
    }
    const observedSize = Math.max(1, beforePresence);
    if (
      afterPresence > 0 &&
      unclaimedDestinationGain >= observedSize &&
      unclaimedSourceLoss >= observedSize
    ) {
      // Search highlighting can leave stale/neighbor occupancy over a source
      // footprint. A matching aggregate source loss plus destination growth is
      // still item-level evidence, and prevents re-clicking an emptied anchor.
      result.status = "moved";
      moved.push(result);
      unclaimedDestinationGain -= observedSize;
      unclaimedSourceLoss -= observedSize;
      continue;
    }
    if (afterPresence > 0) {
      result.status = "rejected";
      rejected.push(result);
      continue;
    }

    if (unclaimedDestinationGain >= observedSize) {
      result.status = "moved";
      moved.push(result);
      unclaimedDestinationGain -= observedSize;
      unclaimedSourceLoss = Math.max(0, unclaimedSourceLoss - observedSize);
    } else {
      ambiguous.push(result);
    }
  }

  return {
    direction,
    moved,
    rejected,
    ambiguous,
    remaining: remainingItems(direction, after),
    sourceCellsBefore: beforeSource.length,
    sourceCellsAfter: afterSource.length,
    destinationCellsBefore: beforeDestination.length,
    destinationCellsAfter: afterDestination.length,
    destinationGain,
    panelsStable:
      before.stashPanelOpen &&
      before.inventoryPanelOpen &&
      after.stashPanelOpen &&
      after.inventoryPanelOpen,
  };
}

export function classifyFillOutcome(facts: UiFacts, options: FillOutcomeOptions): TransferOutcome {
  const capacity = options.bagCapacity ?? 60;
  if (!facts.stashPanelOpen || !facts.inventoryPanelOpen) return "failed";
  if (facts.occupiedBag.length >= capacity) return "bag-full";
  if (options.noMoreAutoFit) return "no-more-auto-fit";
  if (options.eligibleRemaining === 0) {
    return options.filtered ? "filter-exhausted" : "source-empty";
  }
  return facts.occupiedBag.length > 0 ? "partial" : "failed";
}

export function classifyDepositOutcome(facts: UiFacts, stableEmptyFrames: number): TransferOutcome {
  if (!facts.stashPanelOpen || !facts.inventoryPanelOpen) return "failed";
  if (facts.occupiedBag.length === 0 && stableEmptyFrames >= 2) return "bag-empty";
  return facts.occupiedBag.length > 0 ? "partial" : "failed";
}
