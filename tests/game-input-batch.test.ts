import { afterEach, describe, expect, it, vi } from "vitest";
import { WinHostInputSink } from "../src/adapters/winHostInputSink.js";
import { GameInputController } from "../src/core/gameInputController.js";
import { FakeInputSink } from "../src/core/inputSink.js";
import { KillSwitch } from "../src/core/killSwitch.js";
import { scenario } from "../src/core/scenarios.js";

const decision = {
  module: "stash" as const,
  rule: "test-burst",
  reason: "test two checked clicks",
  confidence: 1,
  intended: [
    { kind: "click" as const, x: 10, y: 20 },
    { kind: "click" as const, x: 30, y: 40 },
  ],
};

describe("audited input batches", () => {
  afterEach(() => vi.useRealTimers());

  it("checks and emits a Ctrl-held batch once", async () => {
    const sink = new FakeInputSink();
    const controller = new GameInputController(sink, new KillSwitch(), "authorized-qa");
    const traces = await controller.executeBatch(
      decision,
      scenario({ id: "batch", name: "Batch", enabledModules: ["stash"], dryRun: false }),
      "PathOfExile.exe",
      "evidence",
      true,
      { ctrl: true },
    );

    expect(traces.map((trace) => trace.result)).toEqual(["emitted", "emitted"]);
    expect(sink.emitted).toEqual(decision.intended);
  });

  it("is atomic in dry-run and when the rate budget is too small", async () => {
    const drySink = new FakeInputSink();
    const dry = new GameInputController(drySink, new KillSwitch(), "authorized-qa");
    const dryTraces = await dry.executeBatch(
      decision,
      scenario({ id: "dry", name: "Dry", enabledModules: ["stash"], dryRun: true }),
      "PathOfExile.exe",
      "evidence",
      true,
      { ctrl: true },
    );
    expect(dryTraces.every((trace) => trace.result === "blocked")).toBe(true);
    expect(drySink.emitted).toEqual([]);

    const limitedSink = new FakeInputSink();
    const limited = new GameInputController(limitedSink, new KillSwitch(), "authorized-qa");
    const limitedTraces = await limited.executeBatch(
      decision,
      scenario({
        id: "limited",
        name: "Limited",
        enabledModules: ["stash"],
        dryRun: false,
        actionsPerMinute: 1,
      }),
      "PathOfExile.exe",
      "evidence",
      true,
      { ctrl: true },
    );
    expect(limitedTraces.every((trace) => trace.result === "blocked")).toBe(true);
    expect(limitedSink.emitted).toEqual([]);
  });

  it("opens a fresh action budget after one minute", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const sink = new FakeInputSink();
    const controller = new GameInputController(sink, new KillSwitch(), "authorized-qa");
    const limited = scenario({
      id: "windowed",
      name: "Windowed",
      enabledModules: ["stash"],
      dryRun: false,
      actionsPerMinute: 2,
    });

    expect(
      (await controller.executeBatch(decision, limited, "PathOfExile.exe", "first", true)).every(
        (trace) => trace.result === "emitted",
      ),
    ).toBe(true);
    expect(
      (await controller.executeBatch(decision, limited, "PathOfExile.exe", "blocked", true)).every(
        (trace) => trace.result === "blocked",
      ),
    ).toBe(true);

    vi.setSystemTime(60_000);
    expect(
      (await controller.executeBatch(decision, limited, "PathOfExile.exe", "next", true)).every(
        (trace) => trace.result === "emitted",
      ),
    ).toBe(true);
    expect(sink.emitted).toHaveLength(4);
  });

  it("uses one foreground-guarded WinHost Ctrl burst", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const host = {
      async send(payload: Record<string, unknown>) {
        sent.push(payload);
        if (payload.op === "rect") {
          return { ok: true, process: "PathOfExile", foregroundIsPoe: true, hwnd: 123 };
        }
        return { ok: true, focused: true };
      },
    };
    const sink = new WinHostInputSink(host, { allowedProcesses: ["PathOfExile.exe"] });
    await sink.emitBatch(decision.intended, { ctrl: true });

    expect(sent.filter((entry) => entry.op === "ctrlburst")).toEqual([
      expect.objectContaining({
        requireForeground: true,
        points: [{ x: 10, y: 20 }, { x: 30, y: 40 }],
      }),
    ]);
  });

  it("normalizes audited hotkeys to the host protocol", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const host = {
      async send(payload: Record<string, unknown>) {
        sent.push(payload);
        if (payload.op === "rect") {
          return { ok: true, process: "PathOfExile", foregroundIsPoe: true, hwnd: 123 };
        }
        return { ok: true, focused: true };
      },
    };
    const sink = new WinHostInputSink(host, { allowedProcesses: ["PathOfExile.exe"] });

    await sink.emit({ kind: "key", key: "Ctrl+A" });

    expect(sent.find((entry) => entry.op === "hotkey")).toEqual(
      expect.objectContaining({ keys: "ctrla", requireForeground: true }),
    );
  });

  it("fails closed before input when focus has been lost", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const host = {
      async send(payload: Record<string, unknown>) {
        sent.push(payload);
        return { ok: true, process: "PathOfExile", foregroundIsPoe: false, hwnd: 123 };
      },
    };
    const sink = new WinHostInputSink(host, { allowedProcesses: ["PathOfExile.exe"] });

    await expect(sink.emitBatch(decision.intended, { ctrl: true })).rejects.toThrow("focus-lost");
    expect(sent.some((entry) => entry.op === "ctrlburst")).toBe(false);
  });

  it("latches the kill switch when a native burst reports partial input", async () => {
    const host = {
      async send(payload: Record<string, unknown>) {
        if (payload.op === "rect") {
          return { ok: true, process: "PathOfExile", foregroundIsPoe: true, hwnd: 123 };
        }
        return { ok: false, error: "focus-lost", count: 1 };
      },
    };
    const kill = new KillSwitch();
    const controller = new GameInputController(
      new WinHostInputSink(host, { allowedProcesses: ["PathOfExile.exe"] }),
      kill,
      "authorized-qa",
    );
    const traces = await controller.executeBatch(
      decision,
      scenario({ id: "partial", name: "Partial", enabledModules: ["stash"], dryRun: false }),
      "PathOfExile.exe",
      "evidence",
      true,
      { ctrl: true },
    );
    expect(traces.every((trace) => trace.result === "failed")).toBe(true);
    expect(traces[0]?.reason).toContain("partial-input:1:focus-lost");
    expect(kill.isLatched()).toBe(true);
  });

  it("requires an exact non-empty process allowlist match", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const host = {
      async send(payload: Record<string, unknown>) {
        sent.push(payload);
        return { ok: true, process: "NotPathOfExile", foregroundIsPoe: true };
      },
    };

    await expect(
      new WinHostInputSink(host, { allowedProcesses: ["PathOfExile.exe"] }).emitBatch(
        decision.intended,
        { ctrl: true },
      ),
    ).rejects.toThrow("process-not-allowlisted");
    await expect(
      new WinHostInputSink(host, { allowedProcesses: [""] }).emitBatch(decision.intended, {
        ctrl: true,
      }),
    ).rejects.toThrow("process-not-allowlisted");
    await expect(
      new WinHostInputSink(host, { allowedProcesses: ["PathOfExile.exe"] }).emit({
        kind: "focus",
      }),
    ).rejects.toThrow("process-not-allowlisted");
    expect(sent.some((entry) => entry.op === "ctrlburst")).toBe(false);
    expect(sent.some((entry) => entry.op === "focus")).toBe(false);
  });

  it("pins the first target window handle for the sink lifetime", async () => {
    const sent: Array<Record<string, unknown>> = [];
    let hwnd = 101;
    const host = {
      async send(payload: Record<string, unknown>) {
        sent.push(payload);
        if (payload.op === "rect") {
          return { ok: true, process: "PathOfExile", foregroundIsPoe: true, hwnd };
        }
        return { ok: true, focused: true };
      },
    };
    const sink = new WinHostInputSink(host, { allowedProcesses: ["PathOfExile.exe"] });

    await sink.emit({ kind: "click", x: 10, y: 20 });
    expect(sent.find((entry) => entry.op === "click")).toEqual(
      expect.objectContaining({ expectedHwnd: "101" }),
    );

    hwnd = 202;
    await expect(sink.emit({ kind: "click", x: 30, y: 40 })).rejects.toThrow(
      "target-window-changed",
    );
    expect(sent.filter((entry) => entry.op === "click")).toHaveLength(1);
  });

  it("rejects input when the host cannot pin a target window handle", async () => {
    const host = {
      async send() {
        return { ok: true, process: "PathOfExile", foregroundIsPoe: true };
      },
    };
    const sink = new WinHostInputSink(host, { allowedProcesses: ["PathOfExile.exe"] });
    await expect(sink.emit({ kind: "click", x: 10, y: 20 })).rejects.toThrow(
      "target-window-unpinned",
    );
  });

  it("rejects an out-of-region action before contacting the native host", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const host = {
      async send(payload: Record<string, unknown>) {
        sent.push(payload);
        return { ok: true, process: "PathOfExile", foregroundIsPoe: true };
      },
    };
    const sink = new WinHostInputSink(host, {
      allowedProcesses: ["PathOfExile.exe"],
      actionGuard: () => ({ ok: false, reason: "click-outside-calibrated-transfer-regions" }),
    });

    await expect(sink.emit({ kind: "click", x: 900, y: 900 })).rejects.toThrow(
      "click-outside-calibrated-transfer-regions",
    );
    expect(sent).toEqual([]);
  });
});
