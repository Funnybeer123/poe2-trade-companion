import type { DesirabilityPort } from "../items/desirabilityPort.js";
import { createCompositeDesirability } from "../items/compositeDesirability.js";
import type { BotDecision, InputAction } from "../input/types.js";
import { annotateLoot } from "../loot/annotateLoot.js";
import { eligibleLoot, rankLoot } from "../loot/rankLoot.js";
import {
  LOOT_BACKOFF_REASON,
  LOOT_NONE_ELIGIBLE_REASON,
  LOOT_PICK_PREFIX,
  LOOT_RECOVERY_KEY,
  LOOT_SKIP_PREFIX,
  LOOT_UNREACHABLE_REASON,
  SKIP_INVENTORY_FULL,
  SKIP_UNREACHABLE,
} from "../loot/skipReasons.js";
import { DEFAULT_RECOVERY } from "../recovery/defaultRecovery.js";
import type { AutomationScenario } from "../scheduler/types.js";
import type { LootTarget, WorldState } from "../world-state/types.js";
import type { Controller } from "./types.js";

function evidenceIds(world: WorldState, lootId?: string): string[] {
  const ids: string[] = [];
  if (world.loot.evidenceId) {
    ids.push(world.loot.evidenceId);
  }
  if (lootId !== undefined) {
    ids.push(`loot:${lootId}`);
  }
  return ids;
}

function skipSummary(items: LootTarget[]): string {
  return items
    .filter((item) => item.skipReason !== undefined)
    .map((item) => `${LOOT_SKIP_PREFIX}${item.id}:${item.skipReason}`)
    .join(";");
}

function combineReasons(pick: string | undefined, skipped: LootTarget[]): string {
  const skips = skipSummary(skipped);
  if (pick !== undefined && skips.length > 0) {
    return `${pick};${skips}`;
  }
  if (pick !== undefined) {
    return pick;
  }
  return skips.length > 0 ? skips : LOOT_NONE_ELIGIBLE_REASON;
}

export class LootController implements Controller {
  readonly module = "loot" as const;
  readonly #port: DesirabilityPort;

  constructor(port: DesirabilityPort = createCompositeDesirability()) {
    this.#port = port;
  }

  decide(world: WorldState, scenario: AutomationScenario): BotDecision {
    if (world.flags.emergencyStopLatched) {
      return {
        module: this.module,
        state: world.selectedState,
        reason: "emergency-stop",
        confidence: 1,
        intendedActions: [{ type: "noop", reason: "emergency-stop" }],
        evidenceIds: evidenceIds(world),
      };
    }

    if (world.inventory.value.full) {
      return {
        module: this.module,
        state: world.selectedState,
        reason: SKIP_INVENTORY_FULL,
        confidence: world.loot.confidence,
        intendedActions: [{ type: "noop", reason: SKIP_INVENTORY_FULL }],
        evidenceIds: evidenceIds(world),
      };
    }

    const annotated = annotateLoot(world, scenario, this.#port);
    const ranked = rankLoot(eligibleLoot(annotated.loot.value));
    const skipped = rankLoot(annotated.loot.value.filter((item) => item.skipReason !== undefined));

    if (ranked.length === 0) {
      const unreachableIds = skipped
        .filter((item) => item.skipReason === SKIP_UNREACHABLE)
        .map((item) => item.id);
      const reason = combineReasons(undefined, skipped);
      return {
        module: this.module,
        state: world.selectedState,
        reason,
        confidence: world.loot.confidence,
        intendedActions: [{ type: "noop", reason }],
        evidenceIds: evidenceIds(world),
        suppressTargetIds: unreachableIds.length > 0 ? unreachableIds : undefined,
        recoveryOf: unreachableIds.length > 0 ? LOOT_RECOVERY_KEY : undefined,
      };
    }

    const top = ranked[0];
    if (top === undefined) {
      return {
        module: this.module,
        state: world.selectedState,
        reason: LOOT_NONE_ELIGIBLE_REASON,
        confidence: world.loot.confidence,
        intendedActions: [{ type: "noop", reason: LOOT_NONE_ELIGIBLE_REASON }],
        evidenceIds: evidenceIds(world),
      };
    }

    const policy = DEFAULT_RECOVERY[LOOT_RECOVERY_KEY];
    const maxAttempts = policy?.maxAttempts ?? 2;
    const attempts = world.flags.lootAttemptCounts?.[top.id] ?? 0;
    const lastAttemptMs = world.flags.lootLastAttemptMs?.[top.id] ?? 0;

    if (attempts >= maxAttempts) {
      const reason = `${LOOT_SKIP_PREFIX}${top.id}:${SKIP_UNREACHABLE}`;
      return {
        module: this.module,
        state: world.selectedState,
        reason,
        confidence: world.loot.confidence,
        intendedActions: [{ type: "noop", reason: LOOT_UNREACHABLE_REASON }],
        evidenceIds: evidenceIds(world, top.id),
        suppressTargetIds: [top.id],
        recoveryOf: LOOT_RECOVERY_KEY,
        retryIndex: attempts,
      };
    }

    if (attempts > 0) {
      const backoff = policy?.backoffMs[Math.min(attempts - 1, (policy.backoffMs.length || 1) - 1)] ?? 0;
      if (world.clockMs < lastAttemptMs + backoff) {
        return {
          module: this.module,
          state: world.selectedState,
          reason: LOOT_BACKOFF_REASON,
          confidence: world.loot.confidence,
          intendedActions: [{ type: "noop", reason: LOOT_BACKOFF_REASON }],
          evidenceIds: evidenceIds(world, top.id),
          recoveryOf: LOOT_RECOVERY_KEY,
          retryIndex: attempts,
        };
      }
    }

    const intendedActions: InputAction[] = [
      { type: "mouse-click", x: top.screenPoint.x, y: top.screenPoint.y, button: "left" },
    ];
    return {
      module: this.module,
      state: world.selectedState,
      reason: combineReasons(`${LOOT_PICK_PREFIX}${top.id}`, skipped),
      confidence: world.loot.confidence,
      intendedActions,
      evidenceIds: evidenceIds(world, top.id),
      recoveryOf: attempts > 0 ? LOOT_RECOVERY_KEY : undefined,
      retryIndex: attempts > 0 ? attempts + 1 : undefined,
    };
  }
}
