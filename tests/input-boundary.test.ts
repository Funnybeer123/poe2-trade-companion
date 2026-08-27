import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("input boundary", () => {
  it("only GameInputController and inputSink mention native emit", () => {
    const controller = readFileSync("src/core/gameInputController.ts", "utf8");
    const sink = readFileSync("src/core/inputSink.ts", "utf8");
    const winSink = readFileSync("src/adapters/winHostInputSink.ts", "utf8");
    const service = readFileSync("src/main/assistiveRunService.ts", "utf8");
    const cycle = readFileSync("scripts/assistive-cycle.ts", "utf8");
    const deposit = readFileSync("scripts/assistive-deposit.ts", "utf8");
    const hands = readFileSync("scripts/assistive-hands.ts", "utf8");
    const sizes = readFileSync("scripts/assistive-item-sizes.ts", "utf8");
    const calibrate = readFileSync("scripts/calibrate-ui.ts", "utf8");
    const follow = readFileSync("src/core/controllers.ts", "utf8");
    expect(controller).toContain("sink.emit");
    expect(sink).toContain("NativeInputSink");
    expect(winSink).toContain("ctrlburst");
    expect(service).toContain("GameInputController");
    expect(service).not.toMatch(/host\.send\(\{\s*op:\s*"(?:click|ctrlburst|rightclick|drag|hotkey|type|move)"/);
    expect(cycle).not.toContain("startWinHost");
    expect(deposit).not.toContain("startWinHost");
    expect(cycle).toContain('process.argv.push("--dry-run")');
    expect(cycle).not.toContain('process.argv.push("--live")');
    for (const script of [hands, sizes, calibrate]) {
      expect(script).not.toMatch(
        /(?:host|win)\.send\(\{\s*op:\s*"(?:click|ctrlclick|ctrlburst|rightclick|drag|hotkey|type|move|focus)"/,
      );
    }
    expect(follow).not.toContain("NativeInputSink");
    expect(follow).not.toContain("user32");
  });
});
