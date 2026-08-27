import {
  sortRectCells,
  type SortBagState,
  type SortCell,
  type SortMoveArea,
  type SortMoveSchedule,
  type SortMoveStep,
  type SortPlacement,
  type StashSortPlan,
} from "./stashSort.js";

export type HeldItemState = "none" | "known" | "unknown";

export interface SortObservedItem {
  itemId: string;
  area: SortMoveArea;
  position: SortCell;
}

export interface SortExecutionSnapshot {
  evidenceHash: string;
  tabSignature: string;
  stable: boolean;
  foreground: boolean;
  stale?: boolean;
  heldItem: HeldItemState;
  occupiedStash: SortCell[];
  occupiedBag: SortCell[];
  identifiedItems: SortObservedItem[];
  /** Required on preflight and compared with the immutable preview scan. */
  planSnapshotHash?: string;
}

export interface SortExecutionAdapter {
  capture(phase: string): Promise<SortExecutionSnapshot>;
  move(step: SortMoveStep, evidenceHash: string): Promise<void>;
}

export interface SortExecutionGuards {
  cancelled(): boolean;
  killSwitchLatched(): boolean;
}

export interface SortExecutionResult {
  ok: boolean;
  reason: string;
  completedSteps: number;
  totalSteps: number;
  lastEvidenceHash?: string;
}

interface ExpectedItem {
  placement: SortPlacement;
  area: SortMoveArea;
  position: SortCell;
}

function key(cell: SortCell): string {
  return `${cell.row},${cell.col}`;
}

function setEquals(actual: SortCell[], expected: Set<string>): boolean {
  const actualSet = new Set(actual.map(key));
  if (actualSet.size !== expected.size) return false;
  return [...expected].every((cell) => actualSet.has(cell));
}

function expectedCells(
  items: ExpectedItem[],
  area: SortMoveArea,
  fixedBag: SortCell[],
): Set<string> {
  const result = new Set(area === "bag" ? fixedBag.map(key) : []);
  for (const item of items) {
    if (item.area !== area) continue;
    const w = area === "stash" ? item.placement.w : item.placement.bagW;
    const h = area === "stash" ? item.placement.h : item.placement.bagH;
    for (const cell of sortRectCells(item.position, w, h)) result.add(key(cell));
  }
  return result;
}

function sourceCells(step: SortMoveStep): SortCell[] {
  return sortRectCells(step.from, step.fromW, step.fromH);
}

function destinationCells(step: SortMoveStep): SortCell[] {
  return sortRectCells(step.to, step.toW, step.toH);
}

function targetVerifiedEmpty(snapshot: SortExecutionSnapshot, step: SortMoveStep): boolean {
  const occupied = new Set(
    (step.toArea === "stash" ? snapshot.occupiedStash : snapshot.occupiedBag).map(key),
  );
  if (step.fromArea === step.toArea) {
    for (const cell of sourceCells(step)) occupied.delete(key(cell));
  }
  return destinationCells(step).every((cell) => !occupied.has(key(cell)));
}

function sourceVerifiedPresent(snapshot: SortExecutionSnapshot, step: SortMoveStep): boolean {
  const occupied = new Set(
    (step.fromArea === "stash" ? snapshot.occupiedStash : snapshot.occupiedBag).map(key),
  );
  return sourceCells(step).every((cell) => occupied.has(key(cell)));
}

function observationMatches(
  snapshot: SortExecutionSnapshot,
  plan: StashSortPlan,
  expected: ExpectedItem[],
  fixedBag: SortCell[],
  requiredItemId?: string,
): string | undefined {
  if (snapshot.tabSignature !== plan.tab.signature) return "active-tab-changed";
  if (!snapshot.foreground) return "focus-lost";
  if (!snapshot.stable) return "ui-unstable";
  if (snapshot.stale) return "stale-perception";
  if (snapshot.heldItem !== "none") return `held-item-${snapshot.heldItem}`;
  if (!setEquals(snapshot.occupiedStash, expectedCells(expected, "stash", fixedBag))) {
    return "stash-occupancy-mismatch";
  }
  if (!setEquals(snapshot.occupiedBag, expectedCells(expected, "bag", fixedBag))) {
    return "bag-occupancy-mismatch";
  }
  if (requiredItemId) {
    const wanted = expected.find((item) => item.placement.id === requiredItemId);
    const identified = snapshot.identifiedItems.find((item) => item.itemId === requiredItemId);
    if (
      !wanted ||
      !identified ||
      identified.area !== wanted.area ||
      identified.position.row !== wanted.position.row ||
      identified.position.col !== wanted.position.col
    ) {
      return "moved-item-identification-mismatch";
    }
  }
  return undefined;
}

function guardReason(guards: SortExecutionGuards): string | undefined {
  if (guards.killSwitchLatched()) return "kill-switch-latched";
  if (guards.cancelled()) return "cancelled";
  return undefined;
}

function failed(
  reason: string,
  completedSteps: number,
  schedule: SortMoveSchedule,
  lastEvidenceHash?: string,
): SortExecutionResult {
  return {
    ok: false,
    reason,
    completedSteps,
    totalSteps: schedule.steps.length,
    lastEvidenceHash,
  };
}

/**
 * Executes an immutable, preflighted schedule one move at a time.
 *
 * The adapter owns OS capture/input. Its move implementation must route through
 * GameInputController; this executor never imports or calls a native input API.
 */
export async function executeStashSort(
  plan: StashSortPlan,
  schedule: SortMoveSchedule,
  bag: SortBagState,
  adapter: SortExecutionAdapter,
  guards: SortExecutionGuards,
): Promise<SortExecutionResult> {
  if (!plan.executable) return failed("plan-not-executable", 0, schedule);
  if (!schedule.ok) return failed(schedule.reason, 0, schedule);
  const beforeGuard = guardReason(guards);
  if (beforeGuard) return failed(beforeGuard, 0, schedule);

  const expected: ExpectedItem[] = plan.placements.map((placement) => ({
    placement,
    area: "stash",
    position: { ...placement.source },
  }));
  let snapshot = await adapter.capture("sort-preflight");
  if (snapshot.planSnapshotHash !== plan.snapshotHash) {
    return failed("stale-plan", 0, schedule, snapshot.evidenceHash);
  }
  const preflightMismatch = observationMatches(snapshot, plan, expected, bag.occupied);
  if (preflightMismatch) return failed(preflightMismatch, 0, schedule, snapshot.evidenceHash);

  for (const step of schedule.steps) {
    const blocked = guardReason(guards);
    if (blocked) return failed(blocked, step.index, schedule, snapshot.evidenceHash);
    if (!sourceVerifiedPresent(snapshot, step)) {
      return failed("source-footprint-mismatch", step.index, schedule, snapshot.evidenceHash);
    }
    if (!targetVerifiedEmpty(snapshot, step)) {
      return failed("target-footprint-not-empty", step.index, schedule, snapshot.evidenceHash);
    }
    const item = expected.find((entry) => entry.placement.id === step.itemId);
    if (
      !item ||
      item.area !== step.fromArea ||
      item.position.row !== step.from.row ||
      item.position.col !== step.from.col
    ) {
      return failed("move-dependency-state-mismatch", step.index, schedule, snapshot.evidenceHash);
    }

    await adapter.move(step, snapshot.evidenceHash);
    const afterInputGuard = guardReason(guards);
    if (afterInputGuard) return failed(afterInputGuard, step.index, schedule, snapshot.evidenceHash);
    item.area = step.toArea;
    item.position = { ...step.to };
    snapshot = await adapter.capture(`sort-reconcile-${step.index + 1}`);
    const mismatch = observationMatches(
      snapshot,
      plan,
      expected,
      bag.occupied,
      step.itemId,
    );
    if (mismatch) return failed(mismatch, step.index, schedule, snapshot.evidenceHash);
  }

  return {
    ok: true,
    reason: schedule.steps.length === 0 ? "already-sorted" : "sorted",
    completedSteps: schedule.steps.length,
    totalSteps: schedule.steps.length,
    lastEvidenceHash: snapshot.evidenceHash,
  };
}

export function sortTargetIsVerifiedEmpty(
  snapshot: SortExecutionSnapshot,
  step: SortMoveStep,
): boolean {
  return targetVerifiedEmpty(snapshot, step);
}
