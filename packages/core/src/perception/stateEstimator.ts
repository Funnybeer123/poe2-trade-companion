import type { Clock } from "../clock.js";
import type { QaArmingState } from "../capabilities/createCapabilities.js";
import { estimateInventory } from "../inventory/estimateInventory.js";
import { DEFAULT_SHADOW_STALE_AFTER_MS } from "../inventory/reconcile.js";
import { ShadowState } from "../inventory/shadowState.js";
import { estimateLootPickup } from "../loot/estimateLootPickup.js";
import { estimateStuckObservation } from "../navigation/estimateNavigation.js";
import {
  DEFAULT_FOLLOW_CONFIG,
  type FollowConfig,
} from "../navigation/followConfig.js";
import { computeFreshness } from "../world-state/freshness.js";
import type { Freshness, Observation, WorldState } from "../world-state/types.js";
import { isProcessAllowlistedByArming } from "./allowlist.js";
import { clampConfidence } from "./confidence.js";
import type { PerceptionFrame, StateEstimator } from "./types.js";

export interface StateEstimatorOptions {
  clock: Clock;
  arming: QaArmingState;
  followConfig?: FollowConfig;
  shadowState?: ShadowState;
  staleAfterMs?: number;
}

function effectivePrevFreshness<T>(prev: Observation<T>, nowMs: number): Freshness {
  if (prev.freshness === "missing") {
    return "missing";
  }
  return computeFreshness(prev.observedAtMs, nowMs);
}

function recomputeFreshness<T>(observation: Observation<T>, nowMs: number): Observation<T> {
  return {
    ...observation,
    confidence: clampConfidence(observation.confidence),
    freshness: computeFreshness(observation.observedAtMs, nowMs),
  };
}

function shouldReplace<T>(
  prev: Observation<T>,
  incoming: Observation<T>,
  nowMs: number,
): boolean {
  if (incoming.confidence >= prev.confidence) {
    return true;
  }
  const prevFreshness = effectivePrevFreshness(prev, nowMs);
  return prevFreshness === "stale" || prevFreshness === "missing";
}

function mergeObservation<T>(
  prev: Observation<T>,
  incoming: Observation<T> | undefined,
  nowMs: number,
  options: { absentToMissing?: boolean } = {},
): Observation<T> {
  if (incoming === undefined) {
    const freshness = effectivePrevFreshness(prev, nowMs);
    if (options.absentToMissing && (freshness === "stale" || freshness === "missing")) {
      return {
        ...prev,
        value: (null as T),
        confidence: 0,
        freshness: "missing",
      };
    }
    return {
      ...prev,
      freshness,
    };
  }

  const chosen = shouldReplace(prev, incoming, nowMs) ? incoming : prev;
  return recomputeFreshness(chosen, nowMs);
}

function withAllowlist(
  observation: Observation<WorldState["process"]["value"]>,
  arming: QaArmingState,
): Observation<WorldState["process"]["value"]> {
  return {
    ...observation,
    value: {
      ...observation.value,
      allowlisted: isProcessAllowlistedByArming(observation.value, arming),
    },
  };
}

export class DefaultStateEstimator implements StateEstimator {
  readonly #clock: Clock;
  readonly #arming: QaArmingState;
  readonly #followConfig: FollowConfig;
  readonly #shadow: ShadowState;
  readonly #staleAfterMs: number;

  constructor(options: StateEstimatorOptions) {
    this.#clock = options.clock;
    this.#arming = options.arming;
    this.#followConfig = options.followConfig ?? DEFAULT_FOLLOW_CONFIG;
    this.#shadow = options.shadowState ?? new ShadowState();
    this.#staleAfterMs = options.staleAfterMs ?? DEFAULT_SHADOW_STALE_AFTER_MS;
  }

  get shadow(): ShadowState {
    return this.#shadow;
  }

  estimate(prev: WorldState, frame: PerceptionFrame): WorldState {
    const nowMs = this.#clock.nowMs();
    const target = mergeObservation(prev.target, frame.target, nowMs, {
      absentToMissing: true,
    });
    const process = withAllowlist(
      mergeObservation(prev.process, frame.process, nowMs),
      this.#arming,
    );
    const loot = mergeObservation(prev.loot, frame.loot, nowMs);
    const estimatedGrid = estimateInventory({
      flags: {
        ...prev.flags,
        ...(frame.flags ?? {}),
      },
      inventory: mergeObservation(prev.inventory, frame.inventory, nowMs),
      stash: mergeObservation(prev.stash, frame.stash, nowMs),
      shadow: this.#shadow,
      nowMs,
      staleAfterMs: this.#staleAfterMs,
    });
    const estimatedLoot = estimateLootPickup({
      flags: estimatedGrid.flags,
      loot,
      inventory: estimatedGrid.inventory,
      nowMs,
    });

    return {
      ...prev,
      tickId: frame.tickId,
      capturedAtMs: frame.capturedAtMs,
      clockMs: nowMs,
      process,
      target,
      loot: estimatedLoot.loot,
      inventory: estimatedGrid.inventory,
      stash: estimatedGrid.stash,
      trade: mergeObservation(prev.trade, frame.trade, nowMs),
      listing: mergeObservation(prev.listing, frame.listing, nowMs),
      ui: mergeObservation(prev.ui, frame.ui, nowMs),
      stuck:
        frame.stuck !== undefined
          ? mergeObservation(prev.stuck, frame.stuck, nowMs)
          : {
              value: estimateStuckObservation(prev.stuck, prev.target, target, this.#followConfig),
              confidence: 1,
              observedAtMs: nowMs,
              freshness: "fresh" as const,
            },
      flags: estimatedLoot.flags,
    };
  }
}

export function createStateEstimator(options: StateEstimatorOptions): StateEstimator {
  return new DefaultStateEstimator(options);
}
