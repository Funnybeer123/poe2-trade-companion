import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AutomationScenario,
  AutomationStateId,
  WorldState,
} from "@poe2tc/core";

export interface SchedulerPriorityFixture {
  id: string;
  description: string;
  world: WorldState;
  scenario: AutomationScenario;
  expect: {
    state: AutomationStateId;
    interrupt?: boolean;
    reason?: string;
  };
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

export const SCHEDULER_PRIORITY_FIXTURE_DIR = join(
  repoRoot,
  "fixtures/replay/scheduler-priority",
);

export function loadSchedulerPriorityFixtures(): SchedulerPriorityFixture[] {
  const files = readdirSync(SCHEDULER_PRIORITY_FIXTURE_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort();
  if (files.length !== 8) {
    throw new Error(
      `expected 8 scheduler-priority fixtures, found ${String(files.length)}: ${files.join(", ")}`,
    );
  }
  return files.map((name) => {
    const raw = readFileSync(join(SCHEDULER_PRIORITY_FIXTURE_DIR, name), "utf8");
    return JSON.parse(raw) as SchedulerPriorityFixture;
  });
}
