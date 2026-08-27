import { describe, expect, it } from "vitest";
import { emptyProfile } from "../../src/core/calibrationProfile.js";
import { KillSwitch } from "../../src/core/killSwitch.js";
import { SCANNER_INVOKE_CHANNELS } from "../../src/shared/ipc.js";
import {
  InMemoryScanSessionStorage,
  ScanSessionStore,
} from "../../src/main/scanSessionStore.js";
import { registerScanIpc } from "../../src/main/scanIpc.js";
import { ScannerRuntimeService } from "../../src/main/scanRuntimeService.js";

type Handler = (event: unknown, ...args: unknown[]) => unknown;

class FakeRegistrar {
  readonly handlers = new Map<string, Handler>();
  readonly removed: string[] = [];

  handle(channel: string, handler: Handler): void {
    this.handlers.set(channel, handler);
  }

  removeHandler(channel: string): void {
    this.removed.push(channel);
    this.handlers.delete(channel);
  }

  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`missing-handler:${channel}`);
    return handler({}, ...args);
  }
}

function service() {
  const profile = {
    ...emptyProfile(1_200, 800),
    bagGrid: {
      x: 650,
      y: 300,
      w: 480,
      h: 200,
      cols: 12,
      rows: 5,
    },
  };
  return new ScannerRuntimeService({
    mode: "authorized-qa",
    qaOptIn: true,
    killSwitch: new KillSwitch(),
    sessions: new ScanSessionStore(new InMemoryScanSessionStorage()),
    clipboard: {
      readText: async () => "",
      writeText: async () => undefined,
    },
    profile: () => profile,
  });
}

describe("scanner IPC", () => {
  it("registers typed handlers and returns bounded run summaries", async () => {
    const registrar = new FakeRegistrar();
    const dispose = registerScanIpc(registrar, service());

    expect([...registrar.handlers.keys()]).toEqual(SCANNER_INVOKE_CHANNELS);
    expect(await registrar.invoke("scanner:status")).toMatchObject({
      schemaVersion: 1,
      running: false,
      mode: "authorized-qa",
    });
    await expect(registrar.invoke("scanner:start", null)).rejects.toThrow(
      "scanner-start-request-object-required",
    );

    const result = await registrar.invoke("scanner:start", {
      gridKind: "inventory",
      dryRun: true,
      qaAcknowledged: true,
      allowlist: ["PathOfExile.exe"],
    });
    expect(result).toMatchObject({
      schemaVersion: 1,
      status: "finished",
      sessionStatus: "finished",
      recordCount: 60,
      statusCounts: { blocked: 60 },
    });
    expect(result).not.toHaveProperty("session.slots");

    dispose();
    expect(registrar.handlers.size).toBe(0);
    expect(registrar.removed).toEqual([
      ...SCANNER_INVOKE_CHANNELS,
      ...SCANNER_INVOKE_CHANNELS,
    ]);
  });
});
