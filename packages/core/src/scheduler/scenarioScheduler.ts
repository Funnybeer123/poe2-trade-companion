import type { AutomationStateId, WorldState } from "../world-state/types.js";
import { AUTOMATION_STATE_IDS, STATE_PRIORITY } from "./priorities.js";
import {
  eligibilityReason,
  evaluateInterruptWhen,
  isStateEligible,
} from "./predicates.js";
import type {
  AutomationScenario,
  InterruptRule,
  ScenarioScheduler,
  SchedulerSelection,
} from "./types.js";

function matchingInterruptRule(
  selected: AutomationStateId,
  current: AutomationStateId,
  world: WorldState,
  rules: InterruptRule[],
): InterruptRule | undefined {
  return rules.find(
    (rule) =>
      rule.higher === selected &&
      rule.lower === current &&
      evaluateInterruptWhen(rule.when, world),
  );
}

export function selectAutomationState(
  world: WorldState,
  scenario: AutomationScenario,
): SchedulerSelection {
  const current = world.selectedState ?? "Idle";
  const rules = scenario.interruptRules ?? [];

  // Step 1: emergency latch always wins. No randomness.
  if (world.flags?.emergencyStopLatched === true) {
    return selection("EmergencyStop", world, current, rules);
  }

  // Step 2: eligible states whose predicates are true and whose module is enabled.
  const eligible = AUTOMATION_STATE_IDS.filter((state) => isStateEligible(state, world, scenario));

  if (eligible.length === 0) {
    return selection("Idle", world, current, rules);
  }

  // Step 3: lowest STATE_PRIORITY number wins.
  let bestPriority = Number.POSITIVE_INFINITY;
  for (const state of eligible) {
    const priority = STATE_PRIORITY[state];
    if (priority < bestPriority) {
      bestPriority = priority;
    }
  }

  const tied = eligible.filter((state) => STATE_PRIORITY[state] === bestPriority);

  // Step 5: tie-break keeps current if still eligible at that priority; otherwise Idle.
  let selected: AutomationStateId;
  if (tied.includes(current)) {
    selected = current;
  } else if (tied.length === 1) {
    selected = tied[0]!;
  } else {
    selected = "Idle";
  }

  return selection(selected, world, current, rules);
}

function selection(
  selected: AutomationStateId,
  world: WorldState,
  current: AutomationStateId,
  rules: InterruptRule[],
): SchedulerSelection {
  const selectedPriority = STATE_PRIORITY[selected];
  const currentPriority = STATE_PRIORITY[current] ?? STATE_PRIORITY.Idle;
  // Step 4: strictly higher priority (lower number) is an interrupt.
  const priorityInterrupt = selectedPriority < currentPriority;
  const rule = matchingInterruptRule(selected, current, world, rules);
  return {
    state: selected,
    reason: eligibilityReason(selected, world),
    interrupt: priorityInterrupt || rule !== undefined,
  };
}

export class PriorityScenarioScheduler implements ScenarioScheduler {
  select(world: WorldState, scenario: AutomationScenario): SchedulerSelection {
    return selectAutomationState(world, scenario);
  }
}

export function createScenarioScheduler(): ScenarioScheduler {
  return new PriorityScenarioScheduler();
}
