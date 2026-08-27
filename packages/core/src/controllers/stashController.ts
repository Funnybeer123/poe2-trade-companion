import type { BotDecision, InputAction } from "../input/types.js";
import { SKIP_INVENTORY_FULL } from "../loot/skipReasons.js";
import { DEFAULT_RECOVERY } from "../recovery/defaultRecovery.js";
import type { AutomationScenario } from "../scheduler/types.js";
import { transferObservedInCells } from "../stash/confirmTransfer.js";
import { cellCenter, DEFAULT_INVENTORY_GRID, DEFAULT_STASH_GRID, tabClickPoint } from "../stash/geometry.js";
import {
  STASH_BACKOFF_REASON,
  STASH_FAILED_MOVE_KEY,
  STASH_FAILED_OR_TIMED_OUT_REASON,
  STASH_FALLBACK_TAB_FULL_REASON,
  STASH_PLAN_EMPTY_REASON,
  STASH_WRONG_TAB_KEY,
  stashMoveEvidence,
  stashMoveReason,
  stashTabEvidence,
  stashTabReason,
} from "../stash/reasons.js";
import { locationEvidenceKey } from "../stash/session.js";
import { DEFAULT_SORT_RULES } from "../stash/sortRules.js";
import { planTransfers } from "../stash/transferPlanner.js";
import type { SortRule, TransferPlanStep } from "../stash/types.js";
import type { GridCell, PendingStashTransfer, StashItemMeta, WorldState } from "../world-state/types.js";
import type { Controller } from "./types.js";

export interface StashControllerOptions {
  rules?: readonly SortRule[];
  catalog?: Record<string, StashItemMeta>;
}

function inventoryItems(world: WorldState) {
  return world.inventory.value.cells
    .filter((cell) => cell.occupied && cell.itemFingerprint !== undefined && cell.itemFingerprint.length > 0)
    .map((cell) => ({
      fingerprint: cell.itemFingerprint as string,
      location: { kind: "inventory" as const, tabId: cell.tabId, x: cell.x, y: cell.y },
      lastConfirmedMs: world.inventory.observedAtMs,
      stale: world.inventory.freshness !== "fresh",
      mismatch: false,
    }));
}

function visibleTabs(world: WorldState) {
  const tabId = world.stash.value.tabId ?? world.stash.value.cells[0]?.tabId;
  const byTab = new Map<string, GridCell[]>();
  for (const cell of world.stash.value.cells) {
    const id = cell.tabId ?? tabId;
    if (id === undefined) {
      continue;
    }
    const list = byTab.get(id) ?? [];
    list.push({ ...cell, tabId: id });
    byTab.set(id, list);
  }
  if (tabId !== undefined && !byTab.has(tabId)) {
    byTab.set(tabId, world.stash.value.cells.map((cell) => ({ ...cell, tabId })));
  }
  return [...byTab.entries()].map(([id, cells]) => ({
    tabId: id,
    cells,
    tabFull: id === world.stash.value.tabId ? world.stash.value.tabFull : cells.length > 0 && cells.every((c) => c.occupied),
  }));
}

function currentTabId(world: WorldState): string | undefined {
  return world.stash.value.tabId ?? world.stash.value.cells[0]?.tabId;
}

function findCell(cells: GridCell[], x: number, y: number): GridCell | undefined {
  return cells.find((cell) => cell.x === x && cell.y === y);
}

export class StashController implements Controller {
  readonly module = "stash" as const;
  readonly #rules: readonly SortRule[];
  readonly #catalog: Record<string, StashItemMeta>;

  constructor(options: StashControllerOptions = {}) {
    this.#rules = options.rules ?? DEFAULT_SORT_RULES;
    this.#catalog = options.catalog ?? {};
  }

  decide(world: WorldState, scenario: AutomationScenario): BotDecision {
    void scenario;
    const evidenceIds = [
      ...(world.inventory.evidenceId ? [world.inventory.evidenceId] : []),
      ...(world.stash.evidenceId ? [world.stash.evidenceId] : []),
    ];

    if (world.flags.emergencyStopLatched) {
      return {
        module: this.module,
        state: "EmergencyStop",
        reason: "emergency-stop",
        confidence: 1,
        intendedActions: [{ type: "noop", reason: "emergency-stop" }],
        evidenceIds,
      };
    }

    if (world.flags.stashSafetyHold === true) {
      return this.terminal(world, evidenceIds, STASH_FAILED_MOVE_KEY, world.flags.pendingStashTransfer?.attempts ?? 0);
    }

    const pending = world.flags.pendingStashTransfer;
    if (pending !== undefined && pending !== null) {
      const pendingDecision = this.continuePending(world, pending, evidenceIds);
      if (pendingDecision !== undefined) {
        return pendingDecision;
      }
    }

    const plan = this.plan(world);
    if (plan.blocked.some((entry) => entry.reason === STASH_FALLBACK_TAB_FULL_REASON) && plan.steps.length === 0) {
      return this.terminal(world, evidenceIds, STASH_FAILED_MOVE_KEY, 0, STASH_FALLBACK_TAB_FULL_REASON);
    }

    const step = plan.steps[0];
    if (step === undefined) {
      const reason = world.inventory.value.full
        ? `${SKIP_INVENTORY_FULL};${STASH_PLAN_EMPTY_REASON}`
        : STASH_PLAN_EMPTY_REASON;
      return {
        module: this.module,
        state: world.selectedState,
        reason,
        confidence: world.inventory.confidence,
        intendedActions: [{ type: "noop", reason }],
        evidenceIds,
      };
    }

    return this.actOnStep(world, step, 1, evidenceIds);
  }

  private plan(world: WorldState) {
    return planTransfers({
      inventory: inventoryItems(world),
      tabs: visibleTabs(world),
      rules: this.#rules,
      catalog: { ...this.#catalog, ...world.flags.stashItemCatalog },
    });
  }

  private continuePending(
    world: WorldState,
    pending: PendingStashTransfer,
    evidenceIds: string[],
  ): BotDecision | undefined {
    if (pending.kind === "tab-click") {
      if (currentTabId(world) === pending.destTabId) {
        if (world.stash.value.tabFull) {
          return this.terminal(
            world,
            evidenceIds,
            STASH_FAILED_MOVE_KEY,
            pending.attempts,
            STASH_FALLBACK_TAB_FULL_REASON,
          );
        }
        return this.emitMove(
          world,
          {
            fingerprint: pending.fingerprint,
            from: pending.from,
            to: pending.to,
            reason: pending.reason,
          },
          1,
          evidenceIds,
        );
      }
      return this.retryOrHold(world, pending, STASH_WRONG_TAB_KEY, evidenceIds, () =>
        this.emitTabClick(
          world,
          {
            fingerprint: pending.fingerprint,
            from: pending.from,
            to: pending.to,
            reason: pending.reason,
          },
          pending.attempts + 1,
          evidenceIds,
        ),
      );
    }

    if (transferObservedInCells(pending, world.inventory.value.cells, world.stash.value.cells)) {
      return undefined;
    }

    const stillAtFrom =
      world.inventory.value.cells.some(
        (cell) =>
          cell.occupied &&
          cell.itemFingerprint === pending.fingerprint &&
          cell.x === pending.from.x &&
          cell.y === pending.from.y,
      ) || pending.from.kind === "stash";

    if (!stillAtFrom && currentTabId(world) !== pending.destTabId) {
      return this.retryOrHold(world, pending, STASH_WRONG_TAB_KEY, evidenceIds, () =>
        this.emitTabClick(
          world,
          {
            fingerprint: pending.fingerprint,
            from: pending.from,
            to: pending.to,
            reason: pending.reason,
          },
          pending.attempts + 1,
          evidenceIds,
        ),
      );
    }

    return this.retryOrHold(world, pending, STASH_FAILED_MOVE_KEY, evidenceIds, () =>
      this.emitMove(
        world,
        {
          fingerprint: pending.fingerprint,
          from: pending.from,
          to: pending.to,
          reason: pending.reason,
        },
        pending.attempts + 1,
        evidenceIds,
      ),
    );
  }

  private retryOrHold(
    world: WorldState,
    pending: PendingStashTransfer,
    key: typeof STASH_FAILED_MOVE_KEY | typeof STASH_WRONG_TAB_KEY,
    evidenceIds: string[],
    retry: () => BotDecision,
  ): BotDecision {
    const policy = DEFAULT_RECOVERY[key];
    const maxAttempts = policy?.maxAttempts ?? 3;
    if (pending.attempts >= maxAttempts) {
      return this.terminal(world, evidenceIds, key, pending.attempts);
    }
    const backoff = policy?.backoffMs[Math.min(pending.attempts - 1, (policy.backoffMs.length || 1) - 1)] ?? 0;
    if (world.clockMs < pending.lastAttemptMs + backoff) {
      return {
        module: this.module,
        state: world.selectedState,
        reason: STASH_BACKOFF_REASON,
        confidence: world.stash.confidence,
        intendedActions: [{ type: "noop", reason: STASH_BACKOFF_REASON }],
        evidenceIds,
        recoveryOf: key,
        retryIndex: pending.attempts,
      };
    }
    return retry();
  }

  private actOnStep(
    world: WorldState,
    step: TransferPlanStep,
    attempts: number,
    evidenceIds: string[],
  ): BotDecision {
    const destTab = step.to.tabId;
    if (destTab !== undefined && currentTabId(world) !== destTab) {
      return this.emitTabClick(world, step, attempts, evidenceIds);
    }
    return this.emitMove(world, step, attempts, evidenceIds);
  }

  private emitTabClick(
    world: WorldState,
    step: TransferPlanStep,
    attempts: number,
    evidenceIds: string[],
  ): BotDecision {
    const tabId = step.to.tabId ?? "";
    const point = tabClickPoint(tabId);
    const reason = stashTabReason(tabId);
    return {
      module: this.module,
      state: world.selectedState,
      reason,
      confidence: world.stash.confidence,
      intendedActions: [{ type: "mouse-click", x: point.x, y: point.y, button: "left" }],
      evidenceIds: [
        ...evidenceIds,
        stashTabEvidence(
          tabId,
          step.fingerprint,
          locationEvidenceKey(step.from),
          locationEvidenceKey(step.to),
          attempts,
        ),
      ],
      recoveryOf: attempts > 1 ? STASH_WRONG_TAB_KEY : undefined,
      retryIndex: attempts > 1 ? attempts : undefined,
    };
  }

  private emitMove(
    world: WorldState,
    step: TransferPlanStep,
    attempts: number,
    evidenceIds: string[],
  ): BotDecision {
    const fromCell = findCell(world.inventory.value.cells, step.from.x, step.from.y) ?? {
      x: step.from.x,
      y: step.from.y,
      w: 50,
      h: 50,
      occupied: true,
      itemFingerprint: step.fingerprint,
    };
    const toCell = findCell(world.stash.value.cells, step.to.x, step.to.y) ?? {
      x: step.to.x,
      y: step.to.y,
      w: 50,
      h: 50,
      occupied: false,
      tabId: step.to.tabId,
    };
    const from = cellCenter(fromCell, DEFAULT_INVENTORY_GRID);
    const to = cellCenter(toCell, DEFAULT_STASH_GRID);
    const reason = stashMoveReason(step);
    const intendedActions: InputAction[] = [{ type: "mouse-drag", from, to, button: "left" }];
    return {
      module: this.module,
      state: world.selectedState,
      reason,
      confidence: world.stash.confidence || world.inventory.confidence,
      intendedActions,
      evidenceIds: [
        ...evidenceIds,
        stashMoveEvidence(
          step.fingerprint,
          locationEvidenceKey(step.from),
          locationEvidenceKey(step.to),
          attempts,
        ),
      ],
      recoveryOf: attempts > 1 ? STASH_FAILED_MOVE_KEY : undefined,
      retryIndex: attempts > 1 ? attempts : undefined,
    };
  }

  private terminal(
    world: WorldState,
    evidenceIds: string[],
    key: typeof STASH_FAILED_MOVE_KEY | typeof STASH_WRONG_TAB_KEY,
    retryIndex: number,
    extraReason = "",
  ): BotDecision {
    const reason = extraReason.length > 0
      ? `${STASH_FAILED_OR_TIMED_OUT_REASON};${extraReason}`
      : `${STASH_FAILED_OR_TIMED_OUT_REASON};${key}`;
    return {
      module: this.module,
      state: "SafetyHold",
      reason,
      confidence: world.stash.confidence,
      intendedActions: [{ type: "noop", reason }],
      evidenceIds,
      recoveryOf: key,
      retryIndex,
    };
  }
}
