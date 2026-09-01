import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SortHarness, SortStop } from "../src/adapters/sortHarness.js";
import type { WinReply } from "../src/adapters/winHost.js";
import { parseCorrections } from "../src/core/gearSort.js";

type Payload = Record<string, unknown>;

class FakeHost {
  calls: Payload[] = [];
  constructor(private readonly respond?: (payload: Payload) => WinReply | undefined) {}
  async send(payload: Payload): Promise<WinReply> {
    this.calls.push(payload);
    return this.respond?.(payload) ?? { ok: true };
  }
  ops(): string[] {
    return this.calls.map((call) => String(call.op));
  }
}

/**
 * Control host: waitkey pops from a key queue (a held queue releases only
 * after `release()`, like a user reacting to the overlay); record pops from
 * an event queue. Empty polls yield a real timer tick so polling loops in
 * the harness cannot starve the listener.
 */
class FakeControl extends FakeHost {
  private released: boolean;
  constructor(
    private readonly keys: number[] = [],
    private readonly recordings: Array<Array<Payload>> = [],
    hold = false,
  ) {
    super();
    this.released = !hold;
  }
  release(): void {
    this.released = true;
  }
  override async send(payload: Payload): Promise<WinReply> {
    this.calls.push(payload);
    if (payload.op === "waitkey") {
      const key = this.released ? this.keys.shift() : undefined;
      if (key === undefined) {
        await new Promise((resolve) => setTimeout(resolve, 2));
        return { ok: false, error: "timeout" };
      }
      return { ok: true, key };
    }
    if (payload.op === "record") {
      return { ok: true, events: this.recordings.shift() ?? [] };
    }
    return { ok: true };
  }
}

/** Fast sleeper that still yields the event loop, so timers keep firing. */
const instant = () => new Promise<void>((resolve) => setImmediate(resolve));

function makeHarness(
  host: FakeHost,
  control: FakeControl,
  overrides: Partial<ConstructorParameters<typeof SortHarness>[2]> = {},
) {
  const outDir = mkdtempSync(path.join(tmpdir(), "poe2-sort-harness-"));
  const harness = new SortHarness(host, control, {
    outDir,
    sleeper: instant,
    log: () => {},
    initialPace: 1,
    ...overrides,
  });
  return { harness, outDir };
}

describe("overlay hygiene", () => {
  it("shows a bullseye before every click and clears it before the click lands", async () => {
    const host = new FakeHost();
    const { harness } = makeHarness(host, new FakeControl());
    const result = await harness.click(500, 600, "open stash chest");
    expect(result).toBe("clicked");
    expect(host.ops()).toEqual(["marks", "hidemark", "click"]);
    const marks = host.calls[0]!.rects as Array<Record<string, unknown>>;
    expect(marks[0]!.label).toBe("open stash chest");
    expect(harness.hasOverlay).toBe(false);
  });

  it("clears the overlay when stop arrives after the bullseye is shown", async () => {
    const host = new FakeHost((payload) => {
      if (payload.op === "marks") {
        harness.stopRequested = true;
        harness.stopWhy = "Numpad 0 pressed";
      }
      return undefined;
    });
    const { harness } = makeHarness(host, new FakeControl());
    await expect(harness.click(1, 1, "doomed")).rejects.toThrow(SortStop);
    expect(host.ops()).toEqual(["marks", "hidemark"]); // no click ever sent
    expect(harness.hasOverlay).toBe(false);
  });
});

describe("bursts", () => {
  it("shows lime found cells and red targets, then chunks so stop can land mid-burst", async () => {
    const host = new FakeHost();
    const { harness } = makeHarness(host, new FakeControl());
    const targets = Array.from({ length: 7 }, (_, i) => ({ x: 100 + i * 56, y: 400 }));
    const found = [...targets, { x: 900, y: 900 }];
    const sent = await harness.burst(targets, { found, cellW: 56, cellH: 56, label: "withdraw 7" });
    expect(sent).toBe(7);
    const marks = host.calls[0]!.rects as Array<Record<string, unknown>>;
    expect(marks.filter((rect) => rect.kind === "found")).toHaveLength(1); // the non-target
    expect(marks.filter((rect) => rect.kind === "click")).toHaveLength(7);
    const bursts = host.calls.filter((call) => call.op === "ctrlburst");
    expect(bursts.map((call) => (call.points as unknown[]).length)).toEqual([3, 3, 1]);
    expect(host.ops().at(-1)).toBe("hidemark");
  });

  it("dry-run shows the full overlay but sends no clicks", async () => {
    const host = new FakeHost();
    const { harness } = makeHarness(host, new FakeControl(), { dryRun: true });
    const sent = await harness.burst([{ x: 100, y: 400 }], {
      cellW: 56,
      cellH: 56,
      label: "withdraw 1",
    });
    expect(sent).toBe(0);
    expect(host.ops()).toContain("marks");
    expect(host.ops()).not.toContain("ctrlburst");
    expect(host.ops().at(-1)).toBe("hidemark");
  });

  it("stops mid-burst when the panic key arrives", async () => {
    const host = new FakeHost((payload) => {
      if (payload.op === "ctrlburst") {
        harness.stopRequested = true;
        harness.stopWhy = "Numpad 0 pressed";
      }
      return undefined;
    });
    const { harness } = makeHarness(host, new FakeControl());
    const targets = Array.from({ length: 9 }, (_, i) => ({ x: 100 + i * 56, y: 400 }));
    await expect(
      harness.burst(targets, { cellW: 56, cellH: 56, label: "withdraw 9" }),
    ).rejects.toThrow(SortStop);
    expect(host.calls.filter((call) => call.op === "ctrlburst")).toHaveLength(1);
    expect(host.ops().at(-1)).toBe("hidemark");
  });
});

describe("control keys", () => {
  it("Numpad 0 aborts a paced sleep within the ~100ms check interval", async () => {
    const host = new FakeHost();
    const control = new FakeControl([0]);
    const { harness } = makeHarness(host, control);
    harness.startKeyListener();
    await expect(harness.sleep(60_000)).rejects.toThrow(SortStop);
    await harness.dispose();
  });

  it("step mode executes a click only after Numpad 8", async () => {
    const control = new FakeControl([8], [], true);
    // The user presses 8 in reaction to seeing the bullseye.
    const host = new FakeHost((payload) => {
      if (payload.op === "marks") control.release();
      return undefined;
    });
    const { harness } = makeHarness(host, control, { stepMode: true });
    harness.startKeyListener();
    const result = await harness.click(500, 600, "select tab Rings");
    expect(result).toBe("clicked");
    expect(host.ops()).toContain("click");
    await harness.dispose();
  });

  it("Numpad 9 skips the click and records the user's box correction", async () => {
    const control = new FakeControl(
      [9],
      [[
        { kind: "ldown", x: 100, y: 200 },
        { kind: "lup", x: 300, y: 460 },
      ]],
      true,
    );
    const host = new FakeHost((payload) => {
      if (payload.op === "marks") control.release();
      return undefined;
    });
    const { harness, outDir } = makeHarness(host, control, { stepMode: true });
    harness.startKeyListener();
    const result = await harness.click(500, 600, "open Gear folder");
    expect(result).toBe("corrected");
    expect(host.ops()).not.toContain("click");
    const records = parseCorrections(
      readFileSync(path.join(outDir, "corrections.jsonl"), "utf8"),
    );
    expect(records).toHaveLength(1);
    expect(records[0]!.why).toBe("open Gear folder");
    expect(records[0]!.planned).toEqual({ x: 500, y: 600 });
    expect(records[0]!.box).toEqual({ x: 100, y: 200, w: 200, h: 260 });
    expect(harness.hasOverlay).toBe(false); // "learned" flash cleaned up
    await harness.dispose();
  });

  it("a short correction gesture is recorded as a point, not a box", async () => {
    const host = new FakeHost();
    const control = new FakeControl(
      [],
      [[
        { kind: "ldown", x: 1005, y: 1790 },
        { kind: "lup", x: 1010, y: 1792 },
      ]],
    );
    const { harness, outDir } = makeHarness(host, control);
    const record = await harness.captureCorrection("focus search box", { x: 1035, y: 1786 });
    expect(record?.corrected).toEqual({ x: 1005, y: 1790 });
    expect(record?.box).toBeUndefined();
    expect(existsSync(path.join(outDir, "corrections.jsonl"))).toBe(true);
  });
});

describe("bench + guards", () => {
  it("logs phase timings and flushes guard check/fire tallies on dispose", async () => {
    const host = new FakeHost();
    const { harness, outDir } = makeHarness(host, new FakeControl());
    const end = harness.startPhase("goto:Rings");
    end();
    expect(harness.guard("remove-only-refused", false)).toBe(false);
    expect(harness.guard("remove-only-refused", true)).toBe(true);
    await harness.dispose({ outcome: "complete" });
    const lines = readFileSync(path.join(outDir, "bench.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.some((line) => line.kind === "phase" && line.phase === "goto:Rings")).toBe(true);
    expect(lines.some((line) => line.kind === "guard-fired")).toBe(true);
    const session = lines.find((line) => line.kind === "session")!;
    expect((session.guards as Record<string, unknown>)["remove-only-refused"]).toEqual({
      checks: 2,
      fires: 1,
    });
    expect(session.outcome).toBe("complete");
  });
});
