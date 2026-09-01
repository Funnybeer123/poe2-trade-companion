import { describe, expect, it, vi } from "vitest";
import { emptyProfile, stashGridForKind } from "../src/core/calibrationProfile.js";
import { KillSwitch } from "../src/core/killSwitch.js";
import {
  InMemoryScanSessionStorage,
  ScanSessionStore,
} from "../src/main/scanSessionStore.js";
import { ScannerRuntimeService } from "../src/main/scanRuntimeService.js";

function profile() {
  return {
    ...emptyProfile(1_200, 800),
    stashGrid: {
      x: 20,
      y: 40,
      w: 600,
      h: 600,
      cols: 12,
      rows: 12,
    },
  };
}

function request() {
  return {
    gridKind: "stash-normal" as const,
    dryRun: true,
    qaAcknowledged: true,
    allowlist: ["PathOfExile.exe"],
    actionsPerMinute: 240,
  };
}

describe("scanner runtime integration", () => {
  it("scans a quad grid from one stamped stash panel", () => {
    const mark = stashGridForKind(profile(), "stash-quad");
    expect(mark).toMatchObject({ x: 20, y: 40, w: 600, h: 600, cols: 24, rows: 24 });
  });

  it("runs an authorized dry scan without touching clipboard or native input", async () => {
    const readText = vi.fn(async () => "keep");
    const writeText = vi.fn(async () => undefined);
    const persistSession = vi.fn(async () => undefined);
    const service = new ScannerRuntimeService({
      mode: "authorized-qa",
      qaOptIn: true,
      killSwitch: new KillSwitch(),
      sessions: new ScanSessionStore(new InMemoryScanSessionStorage()),
      clipboard: { readText, writeText },
      profile,
      persistSession,
    });

    const result = await service.start(request());

    expect(result.status).toBe("finished");
    expect(result.session.slots).toHaveLength(144);
    expect(
      result.session.slots.every((slot) => slot.status === "blocked"),
    ).toBe(true);
    expect(result.traces).toHaveLength(144);
    expect(result.traces.every((trace) => trace.result === "blocked")).toBe(
      true,
    );
    expect(readText).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
    expect(persistSession).toHaveBeenCalledOnce();
    expect(service.status).toMatchObject({
      running: false,
      lastResult: {
        status: "finished",
        records: 144,
      },
    });
  });

  it("refuses a scanner run without a process allowlist", async () => {
    const service = new ScannerRuntimeService({
      mode: "public-companion",
      qaOptIn: false,
      killSwitch: new KillSwitch(),
      sessions: new ScanSessionStore(new InMemoryScanSessionStorage()),
      clipboard: {
        readText: async () => "",
        writeText: async () => undefined,
      },
      profile,
    });
    await expect(
      service.start({ ...request(), allowlist: [] }),
    ).rejects.toThrow("scanner-process-allowlist-required");
  });

  it("cancels a scan through the shared abort and controller boundary", async () => {
    let service: ScannerRuntimeService;
    let stopped = false;
    service = new ScannerRuntimeService({
      mode: "authorized-qa",
      qaOptIn: true,
      killSwitch: new KillSwitch(),
      sessions: new ScanSessionStore(new InMemoryScanSessionStorage()),
      clipboard: {
        readText: async () => "",
        writeText: async () => undefined,
      },
      profile,
      onEvent: (event) => {
        if (event.phase === "decision" && !stopped) {
          stopped = true;
          service.stop("test-stop");
        }
      },
    });

    const result = await service.start(request());

    expect(result.status).toBe("aborted");
    expect(result.session.status).toBe("aborted");
    expect(result.session.slots.at(-1)?.status).toBe("cancelled");
  });
});
