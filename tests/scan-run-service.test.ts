import { describe, expect, it, vi } from "vitest";
import type { AutomationScenario } from "../src/core/types.js";
import {
  InMemoryScanSessionStorage,
  ScanSessionStore,
} from "../src/main/scanSessionStore.js";
import { ScanRunService } from "../src/main/scanRunService.js";
import { TEST_SCAN_CONTEXT } from "./scanFixtures.js";

const scenario: AutomationScenario = {
  id: "scanner-test",
  name: "Scanner test",
  enabledModules: ["stash"],
  dryRun: false,
  actionsPerMinute: 600,
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

function clock() {
  let tick = 0;
  return () => new Date(1_800_000_000_000 + tick++).toISOString();
}

function baseRequest() {
  return {
    context: TEST_SCAN_CONTEXT,
    scenario,
    capabilityArmed: true,
    processName: "PathOfExile.exe",
    processAllowed: true,
    evidenceHash: "frame-evidence",
    pointForCell: ({ row, col }: { row: number; col: number }) => ({
      clientPoint: { x: col * 10 + 5, y: row * 10 + 5 },
      controllerPoint: { x: col * 10 + 105, y: row * 10 + 205 },
    }),
  };
}

describe("scan run service skeleton", () => {
  it("completes dry-run without invoking clipboard/input", async () => {
    const copyHovered = vi.fn(() => {
      throw new Error("clipboard must not run in dry-run");
    });
    const sessions = new ScanSessionStore(new InMemoryScanSessionStorage(), {
      clock: clock(),
    });
    const service = new ScanRunService({
      sessions,
      clipboard: { copyHovered },
      clock: clock(),
    });

    const result = await service.start({
      ...baseRequest(),
      sessionId: "dry-run",
      scenario: { ...scenario, dryRun: true },
    });

    expect(result).toMatchObject({
      status: "finished",
      reason: "scan-complete",
      planner: { phase: "finished" },
      session: { status: "finished" },
    });
    expect(copyHovered).not.toHaveBeenCalled();
    expect(result.session.slots).toHaveLength(60);
    expect(result.session.slots.every((slot) => slot.status === "blocked")).toBe(
      true,
    );
    expect(result.traces).toHaveLength(60);
    expect(result.traces.every((trace) => trace.result === "blocked")).toBe(true);
  });

  it("records known footprints and skips covered cells before later copies", async () => {
    const copyHovered = vi.fn(async () => ({
      status: "copied" as const,
      text: "known item",
      reason: "clipboard-updated",
      traces: [],
    }));
    const sessions = new ScanSessionStore(new InMemoryScanSessionStorage(), {
      clock: clock(),
    });
    const service = new ScanRunService({
      sessions,
      clipboard: { copyHovered },
      clock: clock(),
    });

    const result = await service.start({
      ...baseRequest(),
      sessionId: "known-footprint",
      occupancyAt: ({ row, col }) => row === 0 && col === 0,
      interpretCopiedText: () => ({
        fingerprint: "known-fingerprint",
        footprint: { width: 2, height: 1, source: "measured" as const },
        ruleMatched: false,
      }),
    });

    expect(result.status).toBe("finished");
    expect(copyHovered).toHaveBeenCalledTimes(1);
    expect(result.session.summary?.statuses).toMatchObject({
      copied: 1,
      "skipped-footprint": 1,
      empty: 58,
    });
    expect(result.session.slots.slice(0, 2).map((slot) => slot.status)).toEqual([
      "copied",
      "skipped-footprint",
    ]);
  });

  it("persists a cancellation snapshot and aborts without input", async () => {
    const abort = new AbortController();
    abort.abort();
    const copyHovered = vi.fn();
    const sessions = new ScanSessionStore(new InMemoryScanSessionStorage(), {
      clock: clock(),
    });
    const service = new ScanRunService({
      sessions,
      clipboard: { copyHovered },
      clock: clock(),
    });

    const result = await service.start({
      ...baseRequest(),
      sessionId: "cancelled-run",
      signal: abort.signal,
    });

    expect(result).toMatchObject({
      status: "aborted",
      reason: "scan-abort-signal",
      planner: { phase: "cancelled" },
      session: { status: "aborted" },
    });
    expect(result.session.slots).toMatchObject([
      { status: "cancelled", cell: { row: 0, col: 0 } },
    ]);
    expect(copyHovered).not.toHaveBeenCalled();
  });

  it("refuses to run when the authorized capability boundary is not armed", async () => {
    const sessions = new ScanSessionStore(new InMemoryScanSessionStorage());
    const service = new ScanRunService({
      sessions,
      clipboard: { copyHovered: vi.fn() },
    });

    await expect(
      service.start({ ...baseRequest(), capabilityArmed: false }),
    ).rejects.toThrow("scan-capability-not-armed");
    expect(await sessions.listSessions()).toEqual([]);
  });
});
