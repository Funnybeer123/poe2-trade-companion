// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => {
  const assistiveStatus = {
    running: false,
    killLatched: false,
    mode: "authorized-qa",
    qaOptIn: true,
    stashTab: "normal" as const,
    gridsCalibrated: true,
    searchCalibrated: false,
    overlayVisible: false,
  };
  const sortStatus = {
    running: false,
    killLatched: false,
    mode: "authorized-qa",
    qaOptIn: true,
    stashTab: "normal" as const,
    calibrated: true,
    previewPlanId: undefined as string | undefined,
  };
  return {
    assistive: {
      status: vi.fn(async () => ({ ...assistiveStatus })),
      start: vi.fn(),
      stop: vi.fn(async () => ({ ...assistiveStatus, running: false })),
      hideOverlay: vi.fn(async () => ({ running: false, overlayVisible: false })),
      rearm: vi.fn(async () => true),
      sendToCursor: vi.fn(),
      onEvent: vi.fn(() => () => undefined),
    },
    sort: {
      status: vi.fn(async () => ({ ...sortStatus })),
      start: vi.fn(),
      stop: vi.fn(async () => ({ ...sortStatus, running: false })),
      rearm: vi.fn(async () => true),
      onEvent: vi.fn(() => () => undefined),
    },
    renderer: {
      isNative: false,
      rearm: vi.fn(async () => true),
      mode: vi.fn(async () => "authorized-qa" as const),
      killLatched: vi.fn(async () => false),
      windows: vi.fn(async () => []),
    },
    assistiveStatus,
    sortStatus,
  };
});

vi.mock("../../src/renderer/services/rendererApi", () => ({
  rendererApi: bridge.renderer,
  getAssistiveApi: () => bridge.assistive,
  getStashSortApi: () => bridge.sort,
}));

vi.mock("../../src/renderer/composables/useRuntimeState", () => ({
  useRuntimeState: () => ({
    refreshRuntime: vi.fn(async () => undefined),
  }),
}));

import {
  disposeGameActions,
  useGameActions,
} from "../../src/renderer/composables/useGameActions.js";

function transferResult(reason: string) {
  return {
    ok: reason === "ok",
    reason,
    kind: "empty" as const,
    dryRun: false,
    cycles: 1,
    elapsedMs: 12,
    bagCells: 0,
    stashCells: 4,
    traces: [],
  };
}

function sortPreview(executable = true) {
  return {
    ok: executable,
    reason: executable ? "preview-ready" : "blocked",
    action: "preview" as const,
    dryRun: true,
    plan: {
      id: "plan-1",
      generatedAt: "2026-08-27T00:00:00.000Z",
      snapshotHash: "hash",
      executable,
      blockers: executable
        ? []
        : [{ code: "blocked", message: "Not enough space", blocking: true }],
      warnings: [],
      placements: [],
      groups: [],
      diagnostics: {
        capacityCells: 144,
        itemCells: 4,
        occupiedCells: 4,
        freeCells: 140,
        groupCount: 1,
        moveCount: 1,
        plannedRows: 12,
        plannedCols: 12,
        compactness: 1,
        qualityScore: 80,
        groupPaddingReserved: false,
      },
      tab: {
        signature: "tab",
        label: "Normal",
        kind: "normal" as const,
        cols: 12,
        rows: 12,
        writable: true,
      },
    },
    schedule: {
      ok: executable,
      reason: executable ? "ok" : "blocked",
      steps: [],
      peakStagedItems: 0,
      peakStagedCells: 0,
    },
  };
}

describe("useGameActions", () => {
  beforeEach(() => {
    disposeGameActions();
    bridge.assistiveStatus.running = false;
    bridge.assistiveStatus.killLatched = false;
    bridge.assistiveStatus.gridsCalibrated = true;
    bridge.assistiveStatus.searchCalibrated = false;
    bridge.assistiveStatus.overlayVisible = false;
    bridge.sortStatus.running = false;
    bridge.sortStatus.killLatched = false;
    bridge.sortStatus.calibrated = true;
    bridge.sortStatus.previewPlanId = undefined;
    bridge.assistive.status.mockImplementation(async () => ({ ...bridge.assistiveStatus }));
    bridge.sort.status.mockImplementation(async () => ({ ...bridge.sortStatus }));
    bridge.assistive.start.mockReset();
    bridge.sort.start.mockReset();
    bridge.assistive.sendToCursor.mockReset();
    bridge.assistive.start.mockResolvedValue(transferResult("ok"));
    bridge.sort.start.mockResolvedValue(sortPreview());
    useGameActions().dryRun.value = false;
  });

  afterEach(() => {
    disposeGameActions();
  });

  it("starts Empty without requiring occupied bag cells or stash search", async () => {
    const actions = useGameActions();
    await actions.initializeGameActions();
    expect(actions.canStartEmpty.value).toBe(true);
    await actions.startAssistive({ kind: "empty" });
    expect(bridge.assistive.start).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "empty",
        wantedClasses: [],
        dryRun: false,
      }),
    );
  });

  it("allows unfiltered Fill when grids are ready even if search is missing", async () => {
    const actions = useGameActions();
    await actions.initializeGameActions();
    expect(actions.canStartFill.value).toBe(true);
    expect(actions.canStartFillNow(["Belts"])).toBe(false);
    expect(actions.transferBlockReason(["Belts"])).toContain(
      "Class filters need the stash search box",
    );
    await actions.startAssistive({ kind: "fill" });
    expect(bridge.assistive.start).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "fill", wantedClasses: [] }),
    );
  });

  it("does not start when the kill switch is latched", async () => {
    bridge.assistiveStatus.killLatched = true;
    const actions = useGameActions();
    await actions.initializeGameActions();
    expect(actions.canStartEmpty.value).toBe(false);
    await actions.startAssistive({ kind: "empty" });
    expect(bridge.assistive.start).not.toHaveBeenCalled();
    expect(actions.actionError.value).toContain("Emergency stop is latched");
  });

  it("surfaces an empty-bag result without skipping the start call", async () => {
    bridge.assistive.start.mockResolvedValue(transferResult("bag-empty"));
    const actions = useGameActions();
    await actions.initializeGameActions();
    await actions.startAssistive({ kind: "empty" });
    expect(bridge.assistive.start).toHaveBeenCalledTimes(1);
    expect(actions.actionError.value).toBe("The bag already looks empty.");
  });

  it("previews sort only while Dry-run is on", async () => {
    const actions = useGameActions();
    actions.dryRun.value = true;
    await actions.initializeGameActions();
    await actions.sortStash();
    expect(bridge.sort.start).toHaveBeenCalledTimes(1);
    expect(bridge.sort.start).toHaveBeenCalledWith(
      expect.objectContaining({ action: "preview", tabSafety: "writable-grid" }),
    );
  });

  it("previews then executes sort when Dry-run is off and the plan is executable", async () => {
    bridge.sort.start
      .mockResolvedValueOnce(sortPreview(true))
      .mockResolvedValueOnce({
        ...sortPreview(true),
        action: "execute",
        dryRun: false,
        reason: "sorted",
        ok: true,
      });
    const actions = useGameActions();
    await actions.initializeGameActions();
    await actions.sortStash();
    expect(bridge.sort.start.mock.calls.map((call) => call[0].action)).toEqual([
      "preview",
      "execute",
    ]);
    expect(bridge.sort.start.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ action: "execute", planId: "plan-1" }),
    );
  });

  it("packages findings and reports whether Cursor opened or the prompt was copied", async () => {
    bridge.assistiveStatus.overlayVisible = true;
    bridge.assistive.sendToCursor.mockResolvedValue({
      ok: true,
      opened: true,
      copied: true,
      truncated: false,
      findings: true,
      method: "deeplink",
      message: "Opened Cursor with a Fix prompt. Confirm it in chat to start the agent. Full evidence is also on the clipboard.",
    });
    const actions = useGameActions();
    await actions.initializeGameActions();
    expect(actions.canSendToCursor.value).toBe(true);
    await actions.sendToCursor();
    expect(bridge.assistive.sendToCursor).toHaveBeenCalledTimes(1);
    expect(actions.railStatus.value).toContain("Opened Cursor");
  });
});
