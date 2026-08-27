import { GameInputController } from "./gameInputController.js";
import { Orchestrator } from "./orchestrator.js";
import type { FrameSource } from "./perception.js";
import { RuntimeCapabilities } from "./capabilities.js";
import type { AutomationScenario } from "./types.js";

export async function replayScenario(
  frames: FrameSource,
  scenario: AutomationScenario,
  controller: GameInputController,
  capabilities: RuntimeCapabilities,
  expectedTradeItem?: string,
): Promise<number> {
  const orchestrator = new Orchestrator();
  let steps = 0;
  for (;;) {
    const frame = await frames.next();
    if (!frame) break;
    const decision = orchestrator.choose(frame, scenario, expectedTradeItem);
    await controller.execute(
      decision,
      scenario,
      frame.processName,
      frame.evidenceHash,
      capabilities.isProcessAllowed(frame.processName),
    );
    steps += 1;
  }
  return steps;
}
