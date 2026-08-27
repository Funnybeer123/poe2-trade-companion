import {
  MAX_FILL_CLICKS,
  planFillMoves,
  rememberItemCells,
  takeUntilBagCapacity,
  unusedStashItems,
  type StashItem,
} from "./bagPack.js";
import type { ReturnTarget } from "./assistiveMemory.js";
import { itemMatchesWantedClass } from "./itemClassFilter.js";
import { reconcileTransfer } from "./transferReconciler.js";
// import { stashClickFromNameplate } from "./nameplates.js";
import type { InputAction } from "./types.js";
import type { UiFacts } from "./uiPerception.js";

export type SkillStep =
  | { kind: "abort"; reason: string }
  | { kind: "done"; reason: string }
  | { kind: "wait"; reason: string; durationMs?: number }
  | { kind: "act"; reason: string; action: InputAction; settleMs?: number }
  | {
      kind: "burst";
      reason: string;
      actions: InputAction[];
      settleMs?: number;
      terminal?: boolean;
      shift?: boolean;
    };

export interface Skill {
  id: string;
  plan(facts: UiFacts): SkillStep;
}

interface PendingBurst {
  before: UiFacts;
  items: StashItem[];
  polls: number;
}

const MAX_ITEM_RETRIES = 3;
const MAX_RECONCILE_POLLS = 1;
const MAX_TRANSFER_BURSTS = 12;
const MAX_STAGNANT_BURSTS = 3;

function itemAnchor(item: StashItem): string {
  return `${item.grab.row},${item.grab.col}`;
}

function snapshotFacts(facts: UiFacts): UiFacts {
  return {
    ...facts,
    occupiedBag: facts.occupiedBag.map((cell) => ({ ...cell })),
    occupiedStash: facts.occupiedStash.map((cell) => ({ ...cell })),
    stashItems: facts.stashItems.map((item) => ({
      ...item,
      grab: { ...item.grab },
      cells: item.cells.map((cell) => ({ ...cell })),
    })),
    scores: { ...facts.scores },
  };
}

function occupiedBagCellsAsItems(facts: UiFacts): StashItem[] {
  return facts.occupiedBag
    .map((cell) => ({
      id: `bag-cell:${cell.row},${cell.col}`,
      w: 1,
      h: 1,
      grab: { ...cell, bag: "bag" as const },
      cells: [{ ...cell, bag: "bag" as const }],
    }))
    .sort((a, b) => a.grab.row - b.grab.row || a.grab.col - b.grab.col);
}

export class DepositBagToStash implements Skill {
  readonly id = "deposit-bag-to-stash";
  private bagKeyTries = 0;
  private bagLostWaits = 0;
  private stashLostWaits = 0;
  private awaiting: "stash" | "bag" | null = null;
  private awaitTicks = 0;
  private hasActed = false;
  private stableEmptyFrames = 0;
  private burstCount = 0;
  private stagnantBursts = 0;
  private bestBagCells = Number.POSITIVE_INFINITY;
  private pending: PendingBurst | null = null;
  private readonly retryCounts = new Map<string, number>();
  private readonly failed = new Set<string>();
  private readonly confirmed = new Set<string>();

  constructor(returnTo: ReturnTarget[] = []) {
    // Manual pickup/drop returns are intentionally disabled. Inferred bag
    // footprints cannot prove the size of the item under the cursor, so only
    // the game's own Ctrl-click placement is allowed for live deposits.
    void returnTo;
  }

  get returnedTo(): string[] {
    return [];
  }

  plan(facts: UiFacts): SkillStep {
    if (facts.optionsOpen || facts.loading) {
      return { kind: "abort", reason: facts.optionsOpen ? "options-open" : "loading" };
    }
    if (facts.vendorPanelOpen) {
      return { kind: "abort", reason: "vendor-open" };
    }

    if (this.awaiting) {
      const opened = this.awaiting === "stash" ? facts.stashPanelOpen : facts.inventoryPanelOpen;
      if (opened) {
        this.awaiting = null;
        this.awaitTicks = 0;
        return { kind: "wait", reason: "ui-settled", durationMs: 220 };
      }
      this.awaitTicks += 1;
      if (this.awaitTicks < 4) {
        return { kind: "wait", reason: `wait-${this.awaiting}-open`, durationMs: 350 };
      }
      this.awaiting = null;
    }

    if (!facts.stashPanelOpen) {
      this.stableEmptyFrames = 0;
      if (this.hasActed && this.stashLostWaits < 6) {
        this.stashLostWaits += 1;
        return { kind: "wait", reason: "confirm-stash", durationMs: 280 };
      }
      if (this.hasActed) {
        return { kind: "abort", reason: "failed" };
      }
      // STASH label click disabled — user opens stash. Do not click the world.
      // if (facts.stashChestVisible && facts.chest && this.chestTries < 4) {
      //   this.chestTries += 1;
      //   this.awaiting = "stash";
      //   this.awaitTicks = 0;
      //   const click = stashClickFromNameplate(facts.chest);
      //   return {
      //     kind: "act",
      //     reason: "click-stash-nameplate",
      //     settleMs: 700,
      //     action: { kind: "click", x: click.x, y: click.y },
      //   };
      // }
      return {
        kind: "abort",
        reason: facts.stashChestVisible ? "chest-click-disabled" : "looks-like-world",
      };
    }
    this.stashLostWaits = 0;

    if (facts.inventoryPanelOpen) this.bagLostWaits = 0;

    if (!facts.inventoryPanelOpen) {
      this.stableEmptyFrames = 0;
      if (this.hasActed) {
        if (facts.stashPanelOpen && this.bagLostWaits < 3) {
          this.bagLostWaits += 1;
          return { kind: "wait", reason: "wait-bag-reacquire", durationMs: 450 };
        }
        return { kind: "abort", reason: "failed" };
      }
      if (this.bagKeyTries < 2) {
        this.bagKeyTries += 1;
        this.awaiting = "bag";
        this.awaitTicks = 0;
        return { kind: "act", reason: "open-bag", settleMs: 450, action: { kind: "key", key: "I" } };
      }
      return { kind: "abort", reason: "bag-not-open" };
    }
    if (facts.confidence < 0.4) {
      return { kind: "abort", reason: "perception-confidence-low" };
    }

    if (!Number.isFinite(this.bestBagCells)) {
      this.bestBagCells = facts.occupiedBag.length;
    }

    if (facts.occupiedBag.length === 0) this.stableEmptyFrames += 1;
    else this.stableEmptyFrames = 0;

    if (this.pending) {
      const reconciliation = reconcileTransfer("bag-to-stash", this.pending.items, this.pending.before, facts);
      if (reconciliation.ambiguous.length > 0 && this.pending.polls < MAX_RECONCILE_POLLS) {
        this.pending.polls += 1;
        return {
          kind: "wait",
          reason: "confirm-deposit-burst",
          durationMs: 90 + (this.pending.polls - 1) * 60,
        };
      }
      for (const entry of reconciliation.moved) {
        const key = itemAnchor(entry.item);
        this.confirmed.add(key);
        this.retryCounts.delete(key);
      }
      for (const entry of [...reconciliation.rejected, ...reconciliation.ambiguous]) {
        const key = itemAnchor(entry.item);
        const retries = (this.retryCounts.get(key) ?? 0) + 1;
        this.retryCounts.set(key, retries);
        if (retries >= MAX_ITEM_RETRIES) this.failed.add(key);
      }
      const madeProgress =
        reconciliation.moved.length > 0 || facts.occupiedBag.length < this.bestBagCells;
      if (madeProgress) {
        this.bestBagCells = Math.min(this.bestBagCells, facts.occupiedBag.length);
        this.stagnantBursts = 0;
      } else {
        this.stagnantBursts += 1;
      }
      this.pending = null;
    }

    // Bag occupancy alone cannot distinguish touching item sprites. Clicking
    // occupied cells is redundant for large items, but guarantees each real
    // item receives a Ctrl-click without inventing an unsafe footprint.
    const items = occupiedBagCellsAsItems(facts);
    if (items.length === 0) {
      if (this.stableEmptyFrames < 2) {
        return { kind: "wait", reason: "confirm-bag-empty", durationMs: 90 };
      }
      return { kind: "done", reason: "bag-empty" };
    }
    if (
      this.burstCount >= MAX_TRANSFER_BURSTS ||
      this.stagnantBursts >= MAX_STAGNANT_BURSTS
    ) {
      return { kind: "done", reason: "failed" };
    }

    const retry = items.find((item) => {
      const count = this.retryCounts.get(itemAnchor(item)) ?? 0;
      return count > 0 && count < MAX_ITEM_RETRIES;
    });
    const fresh = items.filter((item) => {
      const key = itemAnchor(item);
      return !this.confirmed.has(key) && !this.failed.has(key) && !this.retryCounts.has(key);
    });
    const batch = retry ? [retry] : fresh.slice(0, MAX_FILL_CLICKS);
    if (batch.length > 0) {
      this.hasActed = true;
      this.burstCount += 1;
      this.pending = { before: snapshotFacts(facts), items: batch, polls: 0 };
      return {
        kind: "burst",
        reason: retry ? `deposit-retry-${batch.length}-items` : `deposit-${batch.length}-items`,
        settleMs: 90,
        actions: batch.map((item) => ({
          kind: "click" as const,
          x: item.grab.x,
          y: item.grab.y,
        })),
      };
    }

    return { kind: "done", reason: "failed" };
  }
}

function firstEmptyCell(
  region: NonNullable<UiFacts["inventoryRegion"]>,
  cols: number,
  rows: number,
  occupied: UiFacts["occupiedBag"],
): { x: number; y: number } | null {
  const used = new Set(occupied.map((cell) => `${cell.row},${cell.col}`));
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      if (used.has(`${row},${col}`)) continue;
      return {
        x: Math.round(region.x + ((col + 0.5) * region.w) / cols),
        y: Math.round(region.y + ((row + 0.5) * region.h) / rows),
      };
    }
  }
  return null;
}

/** Park on a perceived-empty calibrated cell so a right-click cannot hit the world or an item. */
export function parkOffGrid(facts: UiFacts): { x: number; y: number } | null {
  if (facts.inventoryRegion) {
    const bag = firstEmptyCell(facts.inventoryRegion, 12, 5, facts.occupiedBag);
    if (bag) return bag;
  }
  if (facts.stashRegion) {
    return firstEmptyCell(
      facts.stashRegion,
      facts.stashGridSize?.cols ?? 12,
      facts.stashGridSize?.rows ?? 12,
      facts.occupiedStash,
    );
  }
  return null;
}

function fillBurstReason(items: StashItem[], wantedClasses: string[]): string {
  const base = `fill-${items.length}-items`;
  if (!wantedClasses.length) return base;
  const classes = [...new Set(items.map((item) => item.itemClass).filter((value): value is string => Boolean(value)))];
  return classes.length ? `${base}:${classes.join(",")}` : base;
}

export class FillBagFromStash implements Skill {
  readonly id = "fill-bag-from-stash";
  private readonly confirmed = new Set<string>();
  private readonly failed = new Set<string>();
  private readonly retryCounts = new Map<string, number>();
  private pending: PendingBurst | null = null;
  private hasActed = false;
  private panelLostWaits = 0;
  private bagKeyTries = 0;
  private awaiting: "stash" | "bag" | null = null;
  private awaitTicks = 0;
  private burstCount = 0;
  private stagnantBursts = 0;
  private initialBagCells: number | undefined;
  private bestBagCells = 0;
  private oneCellProbeRejected = false;

  constructor(
    private readonly knownItems?: StashItem[],
    private readonly exclude: Set<string> = new Set(),
    private readonly greedy = false,
    private readonly withdrawn: StashItem[] = [],
    private readonly wantedClasses: string[] = [],
  ) {}

  plan(facts: UiFacts): SkillStep {
    if (facts.optionsOpen || facts.loading) {
      return { kind: "abort", reason: facts.optionsOpen ? "options-open" : "loading" };
    }
    if (facts.vendorPanelOpen) {
      return { kind: "abort", reason: "vendor-open" };
    }
    if (this.awaiting) {
      const opened = this.awaiting === "stash" ? facts.stashPanelOpen : facts.inventoryPanelOpen;
      if (opened) {
        this.awaiting = null;
        this.awaitTicks = 0;
        return { kind: "wait", reason: "ui-settled", durationMs: 220 };
      }
      this.awaitTicks += 1;
      if (this.awaitTicks < 4) {
        return { kind: "wait", reason: `wait-${this.awaiting}-open`, durationMs: 350 };
      }
      this.awaiting = null;
    }

    if (!facts.stashPanelOpen) {
      if (this.hasActed && this.panelLostWaits < 6) {
        this.panelLostWaits += 1;
        return { kind: "wait", reason: "confirm-panels", durationMs: 180 };
      }
      if (this.hasActed) {
        return { kind: "abort", reason: "failed" };
      }
      // STASH label click disabled — user opens stash. Do not click the world.
      // if (facts.stashChestVisible && facts.chest && this.chestTries < 4) {
      //   this.chestTries += 1;
      //   this.awaiting = "stash";
      //   this.awaitTicks = 0;
      //   const click = stashClickFromNameplate(facts.chest);
      //   return {
      //     kind: "act",
      //     reason: "click-stash-nameplate",
      //     settleMs: 700,
      //     action: { kind: "click", x: click.x, y: click.y },
      //   };
      // }
      return { kind: "abort", reason: facts.stashChestVisible ? "chest-click-disabled" : "looks-like-world" };
    }

    if (!facts.inventoryPanelOpen || !facts.inventoryRegion) {
      if (this.hasActed && this.panelLostWaits < 6) {
        this.panelLostWaits += 1;
        return { kind: "wait", reason: "confirm-panels", durationMs: 180 };
      }
      if (this.bagKeyTries < 2) {
        this.bagKeyTries += 1;
        this.awaiting = "bag";
        this.awaitTicks = 0;
        return { kind: "act", reason: "open-bag", settleMs: 450, action: { kind: "key", key: "I" } };
      }
      return { kind: "abort", reason: "bag-not-open" };
    }
    this.panelLostWaits = 0;
    if (facts.confidence < 0.4) {
      return { kind: "abort", reason: "perception-confidence-low" };
    }

    if (this.initialBagCells == null) {
      this.initialBagCells = facts.occupiedBag.length;
      this.bestBagCells = facts.occupiedBag.length;
    }

    if (this.pending) {
      const reconciliation = reconcileTransfer("stash-to-bag", this.pending.items, this.pending.before, facts);
      if (reconciliation.ambiguous.length > 0 && this.pending.polls < MAX_RECONCILE_POLLS) {
        this.pending.polls += 1;
        return {
          kind: "wait",
          reason: "confirm-fill-burst",
          durationMs: 90 + (this.pending.polls - 1) * 60,
        };
      }
      for (const entry of reconciliation.moved) {
        const key = itemAnchor(entry.item);
        if (!this.confirmed.has(key)) {
          this.confirmed.add(key);
          rememberItemCells(this.exclude, entry.item);
          this.withdrawn.push(entry.item);
        }
        this.retryCounts.delete(key);
      }
      for (const entry of reconciliation.rejected) {
        const key = itemAnchor(entry.item);
        const retries = (this.retryCounts.get(key) ?? 0) + 1;
        this.retryCounts.set(key, retries);
        if (retries >= MAX_ITEM_RETRIES) this.failed.add(key);
      }
      for (const entry of reconciliation.ambiguous) {
        const key = itemAnchor(entry.item);
        if (entry.sourceCellsAfter === 0) {
          // The source disappeared but destination growth never became visible.
          // Fail closed without clicking the now-empty source anchor.
          this.failed.add(key);
          continue;
        }
        const retries = (this.retryCounts.get(key) ?? 0) + 1;
        this.retryCounts.set(key, retries);
        if (retries >= MAX_ITEM_RETRIES) this.failed.add(key);
      }
      if (
        facts.occupiedBag.length >= 59 &&
        this.wantedClasses.length > 0 &&
        this.pending.items.every(
          (item) =>
            item.w === 1 &&
            item.h === 1 &&
            Boolean(item.itemClass) &&
            !/currency/i.test(item.itemClass ?? ""),
        ) &&
        reconciliation.rejected.length > 0
      ) {
        this.oneCellProbeRejected = true;
      }
      const madeProgress =
        reconciliation.moved.length > 0 || facts.occupiedBag.length > this.bestBagCells;
      if (madeProgress) {
        this.bestBagCells = Math.max(this.bestBagCells, facts.occupiedBag.length);
        this.stagnantBursts = 0;
      } else {
        this.stagnantBursts += 1;
      }
      this.pending = null;
    }

    const finish = (reason: "bag-full" | "no-more-auto-fit" | "source-empty" | "filter-exhausted" | "failed"): SkillStep => {
      return { kind: "done", reason };
    };

    if (facts.occupiedBag.length >= 60) return finish("bag-full");
    if (this.oneCellProbeRejected) return finish("no-more-auto-fit");
    const hasProgress =
      this.bestBagCells > (this.initialBagCells ?? this.bestBagCells) ||
      this.confirmed.size > 0;
    if (
      this.burstCount >= MAX_TRANSFER_BURSTS ||
      this.stagnantBursts >= MAX_STAGNANT_BURSTS
    ) {
      return finish(hasProgress ? "no-more-auto-fit" : "failed");
    }

    const occupiedStash = facts.occupiedStash ?? [];
    const source = this.knownItems ?? (this.wantedClasses.length ? [] : facts.stashItems);
    const pool = unusedStashItems(
      source.filter((item) => {
        const key = itemAnchor(item);
        if (this.confirmed.has(key) || this.failed.has(key)) return false;
        if (!this.wantedClasses.length) return true;
        return Boolean(item.itemClass && itemMatchesWantedClass(item.itemClass, this.wantedClasses));
      }),
      this.exclude,
    );
    const stashCols = facts.stashGridSize?.cols ?? 12;
    const remaining = Math.max(0, 60 - facts.occupiedBag.length);
    pool.sort((a, b) =>
      this.greedy && remaining < 16
        ? a.w * a.h - b.w * b.h || a.id.localeCompare(b.id)
        : b.w * b.h - a.w * a.h || a.id.localeCompare(b.id),
    );

    if (pool.length === 0) {
      if (this.failed.size > 0 && !hasProgress) return finish("failed");
      if (this.wantedClasses.length) return finish("filter-exhausted");
      if (occupiedStash.length === 0 || (this.knownItems?.length ?? 0) === this.confirmed.size) {
        return finish("source-empty");
      }
      return finish("no-more-auto-fit");
    }

    const moves = planFillMoves(occupiedStash, facts.occupiedBag, facts.inventoryRegion, stashCols, pool);
    if (moves.length === 0) return finish("no-more-auto-fit");

    const retryMove = moves.find((move) => {
      const count = this.retryCounts.get(itemAnchor(move.item)) ?? 0;
      return count > 0 && count < MAX_ITEM_RETRIES;
    });
    const batch = retryMove
      ? [retryMove.item]
      : takeUntilBagCapacity(
          moves.filter((move) => !this.retryCounts.has(itemAnchor(move.item))).map((move) => move.item),
          remaining,
          stashCols,
          12,
        );
    if (batch.length === 0) {
      return finish(this.failed.size > 0 && !hasProgress ? "failed" : "no-more-auto-fit");
    }

    this.hasActed = true;
    this.burstCount += 1;
    this.pending = { before: snapshotFacts(facts), items: batch, polls: 0 };
    return {
      kind: "burst",
      reason: retryMove ? `fill-retry-${batch.length}-items` : fillBurstReason(batch, this.wantedClasses),
      settleMs: 90,
      actions: batch.map((item) => ({ kind: "click" as const, x: item.grab.x, y: item.grab.y })),
    };
  }
}

export function depositUsesCtrlClick(step: SkillStep): boolean {
  return (
    (step.kind === "act" || step.kind === "burst") &&
    (step.reason.startsWith("deposit-") || step.reason.startsWith("withdraw-") || step.reason.startsWith("fill-"))
  );
}
