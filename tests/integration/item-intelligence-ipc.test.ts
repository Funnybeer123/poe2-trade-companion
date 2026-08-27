import { afterEach, describe, expect, it } from "vitest";
import { registerItemIntelligenceIpc } from "../../src/main/itemIntelligenceIpc.js";
import { ItemIntelligenceService } from "../../src/main/itemIntelligenceService.js";
import {
  openLocalPersistence,
  type LocalPersistenceDatabase,
} from "../../src/main/persistence/index.js";
import { ITEM_INTELLIGENCE_CHANNELS } from "../../src/shared/ipc.js";

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

class FakeIpcRegistrar {
  readonly handlers = new Map<string, IpcHandler>();
  readonly removed: string[] = [];

  handle(channel: string, handler: IpcHandler): void {
    if (this.handlers.has(channel)) {
      throw new Error(`duplicate-handler:${channel}`);
    }
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

const MAIN_OWNED_CHANNELS = new Set([
  "runtime:mode",
  "item:from-clipboard",
  "item:evaluate-text",
]);

let persistence: LocalPersistenceDatabase | undefined;

afterEach(() => {
  persistence?.close();
  persistence = undefined;
});

describe("item-intelligence IPC registration", () => {
  it("registers every service-owned typed channel exactly once and tears down", async () => {
    persistence = openLocalPersistence(":memory:", {
      clock: () => "2026-08-27T16:00:00.000Z",
    });
    const service = new ItemIntelligenceService({ persistence });
    const registrar = new FakeIpcRegistrar();
    const expected = ITEM_INTELLIGENCE_CHANNELS.filter(
      (channel) => !MAIN_OWNED_CHANNELS.has(channel),
    );

    const dispose = registerItemIntelligenceIpc(
      registrar as unknown as Parameters<typeof registerItemIntelligenceIpc>[0],
      service,
    );

    expect([...registrar.handlers]).toHaveLength(expected.length);
    expect([...registrar.handlers.keys()]).toEqual(expected);
    expect(registrar.removed).toEqual(expected);

    const validation = await registrar.invoke(
      "rules:validate",
      "maximum Life\nFire Resistance",
    );
    expect(validation).toMatchObject({ valid: true, safe: true });

    const saved = await registrar.invoke("rules:save", {
      name: "Life",
      rules: [{ name: "Life", regex: "maximum Life" }],
    });
    expect(saved).toMatchObject({ name: "Life", active: true });
    await expect(registrar.invoke("rules:remove", "   ")).rejects.toThrow(
      "ipc-id-required",
    );

    dispose();
    expect(registrar.handlers.size).toBe(0);
    expect(registrar.removed).toEqual([...expected, ...expected]);
  });

  it("rejects malformed object requests before reaching the service", async () => {
    persistence = openLocalPersistence(":memory:");
    const registrar = new FakeIpcRegistrar();
    registerItemIntelligenceIpc(
      registrar as unknown as Parameters<typeof registerItemIntelligenceIpc>[0],
      new ItemIntelligenceService({ persistence }),
    );

    await expect(registrar.invoke("rules:save", null)).rejects.toThrow(
      "rule-save-request-object-required",
    );
    await expect(registrar.invoke("builds:import-targets", [])).rejects.toThrow(
      "build-import-request-object-required",
    );
  });
});
