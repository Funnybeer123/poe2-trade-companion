import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RuntimeCapabilities } from "../src/core/capabilities.js";
import { GameInputController } from "../src/core/gameInputController.js";
import { FakeInputSink } from "../src/core/inputSink.js";
import { KillSwitch } from "../src/core/killSwitch.js";
import { RecordedFrameSource } from "../src/core/perception.js";
import { replayScenario } from "../src/core/replay.js";
import { PRESET_SCENARIOS } from "../src/core/scenarios.js";
import type { PerceptionFrame } from "../src/core/types.js";

const frames = JSON.parse(
  readFileSync(path.join(process.cwd(), "fixtures", "perception", "full-loop.json"), "utf8"),
) as PerceptionFrame[];

function qaCaps() {
  return new RuntimeCapabilities({
    mode: "authorized-qa",
    buildAllowsQa: true,
    qaAcknowledged: true,
    assistiveAcknowledged: false,
    allowlist: ["PathOfExile.exe"],
    bannerVisible: true,
    emergencyStopRegistered: true,
  });
}

describe("replay harness", () => {
  it("runs a full-loop scenario without native input in dry-run", async () => {
    const sink = new FakeInputSink();
    const controller = new GameInputController(sink, new KillSwitch(), "authorized-qa");
    const scenario = PRESET_SCENARIOS.find((entry) => entry.id === "full-loop")!;
    const steps = await replayScenario(new RecordedFrameSource(frames), scenario, controller, qaCaps(), "abc");
    expect(steps).toBe(3);
    expect(sink.emitted).toHaveLength(0);
    expect(controller.actionTraces.length).toBeGreaterThan(0);
    expect(controller.actionTraces.every((trace) => trace.result === "blocked")).toBe(true);
  });

  it("emits intended actions when live and not dry-run", async () => {
    const sink = new FakeInputSink();
    const controller = new GameInputController(sink, new KillSwitch(), "authorized-qa");
    const scenario = {
      ...PRESET_SCENARIOS.find((entry) => entry.id === "full-loop")!,
      dryRun: false,
    };
    await replayScenario(new RecordedFrameSource(frames), scenario, controller, qaCaps(), "abc");
    expect(sink.emitted.length).toBeGreaterThan(0);
  });

  it("clears queue and blocks after kill switch", async () => {
    const sink = new FakeInputSink();
    const kill = new KillSwitch();
    const controller = new GameInputController(sink, kill, "authorized-qa");
    kill.trip();
    const scenario = { ...PRESET_SCENARIOS.find((entry) => entry.id === "loot-only")!, dryRun: false };
    await replayScenario(new RecordedFrameSource(frames.slice(0, 1)), scenario, controller, qaCaps());
    expect(sink.emitted).toHaveLength(0);
    expect(controller.actionTraces[0]?.reason).toContain("kill-switch-latched");
  });

  it("does not emit when the process is not allowlisted", async () => {
    const sink = new FakeInputSink();
    const controller = new GameInputController(sink, new KillSwitch(), "public-companion");
    const scenario = { ...PRESET_SCENARIOS.find((entry) => entry.id === "loot-only")!, dryRun: false };
    await replayScenario(
      new RecordedFrameSource(frames.slice(0, 1)),
      scenario,
      controller,
      new RuntimeCapabilities({
        mode: "public-companion",
        buildAllowsQa: false,
        qaAcknowledged: false,
        assistiveAcknowledged: false,
        allowlist: [],
        bannerVisible: false,
        emergencyStopRegistered: false,
      }),
    );
    expect(sink.emitted).toHaveLength(0);
  });
});
