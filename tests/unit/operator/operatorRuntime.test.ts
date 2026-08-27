import {
  FrozenClock,
  MemorySettingsStore,
  createFixtureMarketProvider,
  createFixtureReplayCatalog,
  createOperatorRuntime,
  EmergencyStop,
} from "@poe2tc/core";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { itemFixturePath, marketFixtureDir, REPO_ROOT } from "../../helpers/fixturePaths.js";
import { join } from "node:path";

function createRuntime(mode: "public-companion" | "authorized-qa", extras: { acknowledged?: boolean } = {}) {
  const emergencyStop = new EmergencyStop();
  const runtime = createOperatorRuntime({
    mode,
    clock: new FrozenClock(50_000),
    emergencyStop,
    settingsStore: new MemorySettingsStore(),
    market: createFixtureMarketProvider(marketFixtureDir(), () => 50_000),
    replayCatalog: createFixtureReplayCatalog({
      fixturesDir: join(REPO_ROOT, "fixtures/replay"),
      scenariosDir: join(REPO_ROOT, "fixtures/scenarios"),
    }),
    clipboard: { readText: () => readFileSync(itemFixturePath("rare-ring.txt"), "utf8") },
    hotkeyRegistered: true,
    initialArming: { acknowledged: extras.acknowledged ?? true },
  });
  return { runtime, emergencyStop };
}

describe("OperatorRuntime", () => {
  it("cannot arm public companion", () => {
    const { runtime } = createRuntime("public-companion");
    const result = runtime.armQa();
    expect(result.ok).toBe(false);
    expect(result.armed).toBe(false);
    expect(result.reasons).toContain("public-mode");
    expect(runtime.getCapabilities().canEmitNativeInput).toBe(false);
  });

  it("binds arm/disarm and kill-switch to Phase 03 objects", () => {
    const { runtime, emergencyStop } = createRuntime("authorized-qa");
    const armed = runtime.armQa();
    expect(armed.ok).toBe(true);
    expect(armed.armed).toBe(true);

    const stopped = runtime.tripStop();
    expect(emergencyStop.isLatched()).toBe(true);
    expect(stopped.latched).toBe(true);
    expect(stopped.armed).toBe(false);
    expect(runtime.armQa().ok).toBe(false);

    runtime.rearmStop();
    expect(emergencyStop.isLatched()).toBe(false);
    expect(runtime.disarmQa().armed).toBe(false);
  });

  it("parses clipboard without generating game actions", async () => {
    const { runtime } = createRuntime("public-companion");
    const result = await runtime.parseClipboard();
    expect(result.generatedGameActions).toBe(false);
    expect(result.ok).toBe(true);
    expect(result.item?.name).toBe("Storm Grip");
    expect(result.estimate?.isGuaranteedSalePrice).toBe(false);
    expect(result.estimate?.summary).toMatch(/not a guaranteed sale price/);
    expect(runtime.getCatalog()).toHaveLength(1);
  });

  it("runs a replay id and exposes selected states", async () => {
    const { runtime } = createRuntime("authorized-qa");
    const replay = await runtime.runReplay("full-loop");
    expect(replay.sinkKind).toBe("noop");
    expect(replay.selectedStates).toContain("Follow");
    expect(replay.selectedStates).toContain("LootPickup");
    expect(replay.traces.every((trace) => trace.executed === false)).toBe(true);
    expect(runtime.getTraces().length).toBeGreaterThan(0);
    expect(runtime.getWorldState().selectedState).toBe(replay.selectedStates.at(-1));
  });

  it("exports a local filter without OAuth", () => {
    const { runtime } = createRuntime("public-companion");
    const exported = runtime.exportFilter();
    expect(exported.oauthSync).toBe(false);
    expect(exported.body).toContain("No OAuth filter sync");
    expect(exported.fileName.endsWith(".filter")).toBe(true);
  });
});
