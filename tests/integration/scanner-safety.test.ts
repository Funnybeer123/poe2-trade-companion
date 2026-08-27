import { describe, expect, it, vi } from "vitest";
import { GameInputController } from "../../src/core/gameInputController.js";
import { FakeInputSink } from "../../src/core/inputSink.js";
import { KillSwitch } from "../../src/core/killSwitch.js";
import type { AutomationScenario } from "../../src/core/types.js";
import {
  ClipboardCopyService,
  type ClipboardTextPort,
} from "../../src/main/clipboardCopyService.js";
import {
  ScanRunService,
  type ScanRunRequest,
} from "../../src/main/scanRunService.js";
import {
  InMemoryScanSessionStorage,
  ScanSessionStore,
} from "../../src/main/scanSessionStore.js";
import { TEST_SCAN_CONTEXT } from "../scanFixtures.js";

const SCENARIO: AutomationScenario = {
  id: "scanner-safety",
  name: "Scanner safety",
  enabledModules: ["stash"],
  dryRun: false,
  actionsPerMinute: 120,
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

function request(
  overrides: Partial<ScanRunRequest> = {},
): ScanRunRequest {
  return {
    context: TEST_SCAN_CONTEXT,
    scenario: SCENARIO,
    capabilityArmed: true,
    processName: "PathOfExile.exe",
    processAllowed: true,
    evidenceHash: "scanner-safety-frame",
    pointForCell: ({ row, col }) => ({
      clientPoint: { x: col * 10 + 5, y: row * 10 + 5 },
      controllerPoint: { x: col * 10 + 105, y: row * 10 + 205 },
    }),
    occupancyAt: () => true,
    ...overrides,
  };
}

function inMemoryService(copyHovered = vi.fn()) {
  const sessions = new ScanSessionStore(new InMemoryScanSessionStorage());
  return {
    sessions,
    service: new ScanRunService({
      sessions,
      clipboard: { copyHovered },
    }),
  };
}

describe("scanner safety integration", () => {
  it("fails closed at public, module, and live-process gates before persistence", async () => {
    const cases: Array<[ScanRunRequest, string]> = [
      [
        request({
          scenario: { ...SCENARIO, enabledModules: [] },
        }),
        "scan-module-disabled",
      ],
      [
        request({
          context: {
            ...TEST_SCAN_CONTEXT,
            source: {
              ...TEST_SCAN_CONTEXT.source,
              sourceMode: "live",
            },
          },
          processAllowed: false,
        }),
        "scan-process-not-allowlisted",
      ],
    ];

    for (const [unsafeRequest, reason] of cases) {
      const copyHovered = vi.fn();
      const { service, sessions } = inMemoryService(copyHovered);
      await expect(service.start(unsafeRequest)).rejects.toThrow(reason);
      expect(copyHovered).not.toHaveBeenCalled();
      expect(await sessions.listSessions()).toEqual([]);
    }
  });

  it("stops before the next cell when the emergency signal is latched", async () => {
    const abort = new AbortController();
    const copyHovered = vi.fn(async () => {
      abort.abort();
      return {
        status: "copied" as const,
        text: "Item Class: Rings\nRarity: Rare\nStorm Loop\nRuby Ring",
        reason: "clipboard-updated",
        traces: [],
      };
    });
    const { service } = inMemoryService(copyHovered);

    const result = await service.start(
      request({ sessionId: "abort-after-first-cell", signal: abort.signal }),
    );

    expect(result).toMatchObject({
      status: "aborted",
      reason: "scan-abort-signal",
      session: { status: "aborted" },
      planner: { phase: "cancelled" },
    });
    expect(copyHovered).toHaveBeenCalledTimes(1);
    expect(result.session.slots.map((slot) => slot.status)).toEqual([
      "copied",
      "cancelled",
    ]);
  });

  it("enforces the controller action cap across a full scanner run", async () => {
    const sink = new FakeInputSink();
    const controller = new GameInputController(
      sink,
      new KillSwitch(),
      "authorized-qa",
    );
    let clipboardText = "operator clipboard";
    const clipboard: ClipboardTextPort = {
      readText: () => clipboardText,
      writeText: (text) => {
        clipboardText = text;
      },
    };
    const copy = new ClipboardCopyService({
      input: controller,
      clipboard,
      sleep: async () => undefined,
      monotonicNow: () => 0,
      sentinelFactory: () => "scanner-sentinel",
    });
    const sessions = new ScanSessionStore(new InMemoryScanSessionStorage());
    const service = new ScanRunService({ sessions, clipboard: copy });

    const result = await service.start(
      request({
        sessionId: "one-action-budget",
        scenario: { ...SCENARIO, actionsPerMinute: 1 },
      }),
    );

    expect(result.status).toBe("finished");
    expect(sink.emitted).toEqual([{ kind: "move", x: 105, y: 205 }]);
    expect(result.traces.filter((trace) => trace.result === "emitted")).toHaveLength(
      1,
    );
    expect(
      result.traces
        .filter((trace) => trace.result === "blocked")
        .every((trace) => trace.reason.includes("rate-limited")),
    ).toBe(true);
    expect(clipboardText).toBe("operator clipboard");
  });

  it("emits no scanner input while the kill switch is latched", async () => {
    const sink = new FakeInputSink();
    const killSwitch = new KillSwitch();
    killSwitch.trip();
    const controller = new GameInputController(
      sink,
      killSwitch,
      "authorized-qa",
    );
    let clipboardText = "operator clipboard";
    const copy = new ClipboardCopyService({
      input: controller,
      clipboard: {
        readText: () => clipboardText,
        writeText: (text) => {
          clipboardText = text;
        },
      },
      sleep: async () => undefined,
      monotonicNow: () => 0,
    });
    const sessions = new ScanSessionStore(new InMemoryScanSessionStorage());
    const result = await new ScanRunService({
      sessions,
      clipboard: copy,
    }).start(request({ sessionId: "latched-kill-switch" }));

    expect(result.status).toBe("finished");
    expect(sink.emitted).toEqual([]);
    expect(result.traces).toHaveLength(60);
    expect(
      result.traces.every(
        (trace) =>
          trace.result === "blocked" &&
          trace.reason.includes("kill-switch-latched"),
      ),
    ).toBe(true);
    expect(clipboardText).toBe("operator clipboard");
  });
});
