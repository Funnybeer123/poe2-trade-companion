import { describe, expect, it, vi } from "vitest";
import type {
  AutomationScenario,
  BotDecision,
  QaActionTrace,
} from "../src/core/types.js";
import {
  ClipboardCopyService,
  type ClipboardTextPort,
  type ScanGameInputController,
} from "../src/main/clipboardCopyService.js";

const scenario: AutomationScenario = {
  id: "copy-test",
  name: "Copy test",
  enabledModules: ["stash"],
  dryRun: false,
  actionsPerMinute: 100,
  confidenceThreshold: 0.9,
  retryLimit: 1,
  timingProfile: "tight",
  lootScoreThreshold: 0,
  stashRules: {
    keep: "keep",
    sell: "sell",
    vendor: "vendor",
    craft: "craft",
    dump: "dump",
    bulk: "bulk",
  },
};

function request() {
  return {
    hoverPoint: { x: 100, y: 200 },
    hoverMs: 0,
    copyTimeoutMs: 10,
    pollIntervalMs: 5,
    afterCopyMs: 0,
    maxAttempts: 1,
    context: {
      scenario,
      processName: "PathOfExile.exe",
      processAllowed: true,
      evidenceHash: "evidence",
    },
  };
}

function trace(decision: BotDecision, result = "emitted"): QaActionTrace {
  return {
    timestamp: new Date(0).toISOString(),
    scenarioId: scenario.id,
    module: decision.module,
    mode: "authorized-qa",
    processName: "PathOfExile.exe",
    evidenceHash: "evidence",
    confidence: decision.confidence,
    decisionRule: decision.rule,
    reason: decision.reason,
    input: decision.intended[0] ?? null,
    result,
  };
}

describe("clipboard copy service", () => {
  it("routes hover and copy through the injected controller and restores clipboard text", async () => {
    let clipboardText = "operator clipboard";
    let sequence = 1;
    const clipboard: ClipboardTextPort = {
      readText: () => clipboardText,
      writeText: (text) => {
        clipboardText = text;
        sequence += 1;
      },
      sequenceNumber: () => sequence,
    };
    const decisions: BotDecision[] = [];
    const input: ScanGameInputController = {
      async execute(decision) {
        decisions.push(decision);
        if (decision.intended.some((action) => action.key === "ctrl+c")) {
          clipboardText = "Item Class: Currency\nRarity: Normal\nChaos Orb";
          sequence += 1;
        }
        return [trace(decision)];
      },
      clearQueue: vi.fn(),
    };
    const service = new ClipboardCopyService({
      input,
      clipboard,
      sentinelFactory: () => "sentinel",
    });

    const result = await service.copyHovered(request());

    expect(result).toMatchObject({
      status: "copied",
      reason: "clipboard-updated",
      text: "Item Class: Currency\nRarity: Normal\nChaos Orb",
    });
    expect(decisions.flatMap((decision) => decision.intended)).toEqual([
      { kind: "move", x: 100, y: 200 },
      { kind: "key", key: "ctrl+c" },
    ]);
    expect(clipboardText).toBe("operator clipboard");
  });

  it("returns a bounded timeout and restores the clipboard", async () => {
    let clipboardText = "operator clipboard";
    let now = 0;
    const service = new ClipboardCopyService({
      input: {
        async execute(decision) {
          return [trace(decision)];
        },
        clearQueue: vi.fn(),
      },
      clipboard: {
        readText: () => clipboardText,
        writeText: (text) => {
          clipboardText = text;
        },
      },
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      monotonicNow: () => now,
      sentinelFactory: () => "sentinel",
    });

    const result = await service.copyHovered(request());

    expect(result.status).toBe("copy-timeout");
    expect(result.traces).toHaveLength(2);
    expect(now).toBe(10);
    expect(clipboardText).toBe("operator clipboard");
  });

  it("rejects fresh non-item text and retries within the configured bound", async () => {
    let clipboardText = "operator clipboard";
    let now = 0;
    let copyAttempt = 0;
    const service = new ClipboardCopyService({
      input: {
        async execute(decision) {
          if (decision.intended.some((action) => action.key === "ctrl+c")) {
            copyAttempt += 1;
            clipboardText =
              copyAttempt === 1
                ? "fresh but unrelated text"
                : "Item Class: Currency\nRarity: Normal\nExalted Orb";
          }
          return [trace(decision)];
        },
        clearQueue: vi.fn(),
      },
      clipboard: {
        readText: () => clipboardText,
        writeText: (text) => {
          clipboardText = text;
        },
      },
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      monotonicNow: () => now,
      sentinelFactory: () => "sentinel",
    });

    const result = await service.copyHovered({
      ...request(),
      maxAttempts: 2,
    });

    expect(result).toMatchObject({
      status: "copied",
      text: "Item Class: Currency\nRarity: Normal\nExalted Orb",
    });
    expect(copyAttempt).toBe(2);
    expect(result.traces).toHaveLength(3);
    expect(clipboardText).toBe("operator clipboard");
  });

  it("stops when the audited controller blocks input", async () => {
    let clipboardText = "operator clipboard";
    const service = new ClipboardCopyService({
      input: {
        async execute(decision) {
          return [trace(decision, "blocked")];
        },
        clearQueue: vi.fn(),
      },
      clipboard: {
        readText: () => clipboardText,
        writeText: (text) => {
          clipboardText = text;
        },
      },
    });

    const result = await service.copyHovered(request());

    expect(result).toMatchObject({ status: "blocked", reason: "hover-blocked" });
    expect(clipboardText).toBe("operator clipboard");
  });
});
