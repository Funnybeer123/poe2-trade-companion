import { readdirSync } from "node:fs";
import { join } from "node:path";
import { loadAutomationScenarioFile } from "../replay/loadAutomationScenario.js";
import { loadReplayManifestFile } from "../replay/loadReplayManifest.js";
import { runReplay, type ReplayRunResult } from "../replay/replayRunner.js";

export interface ReplayCatalog {
  listIds(): string[];
  run(id: string): Promise<ReplayRunResult>;
}

export function createFixtureReplayCatalog(options: {
  fixturesDir: string;
  scenariosDir: string;
}): ReplayCatalog {
  return {
    listIds(): string[] {
      return readdirSync(options.fixturesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
    },
    async run(id: string): Promise<ReplayRunResult> {
      const manifest = loadReplayManifestFile(join(options.fixturesDir, id, "manifest.json"));
      const scenario = loadAutomationScenarioFile(
        join(options.scenariosDir, `${manifest.scenarioId}.json`),
      );
      return runReplay({ manifest, scenario });
    },
  };
}
