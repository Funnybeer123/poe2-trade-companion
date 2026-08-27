import {
  createCapabilities,
  type InterlockContext,
  type RuntimeCapabilities,
  type RuntimeMode,
} from "@poe2tc/core";
import { createTestArming } from "./createTestArming.js";
import { createTestDecision } from "./createTestDecision.js";
import { createTestScenario } from "./createTestScenario.js";
import { createTestWorld } from "./createTestWorld.js";

export function createTestInterlock(
  overrides: {
    mode?: RuntimeMode;
    capabilities?: RuntimeCapabilities;
    arming?: Partial<InterlockContext["arming"]>;
    scenario?: Partial<InterlockContext["scenario"]>;
    world?: Parameters<typeof createTestWorld>[0];
    decision?: Partial<InterlockContext["decision"]>;
    retryIndex?: number;
    identity?: InterlockContext["identity"];
  } = {},
): InterlockContext {
  const mode = overrides.mode ?? "authorized-qa";
  return {
    capabilities: overrides.capabilities ?? createCapabilities(mode),
    arming: createTestArming(overrides.arming),
    scenario: createTestScenario(overrides.scenario),
    world: createTestWorld(overrides.world),
    decision: createTestDecision(overrides.decision),
    retryIndex: overrides.retryIndex,
    identity: overrides.identity,
  };
}
