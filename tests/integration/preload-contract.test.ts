import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Poe2Bridge } from "../../src/shared/ipc.js";

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(async (channel: string, ...args: unknown[]) => ({
    channel,
    args,
  })),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: electron.exposeInMainWorld,
  },
  ipcRenderer: {
    invoke: electron.invoke,
    on: electron.on,
    removeListener: electron.removeListener,
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("preload API exposure", () => {
  it("exposes the typed item-intelligence bridge without starting Electron", async () => {
    await import("../../src/main/preload.js");

    expect(electron.exposeInMainWorld).toHaveBeenCalledTimes(1);
    expect(electron.exposeInMainWorld).toHaveBeenCalledWith(
      "poe2",
      expect.any(Object),
    );
    const bridge = electron.exposeInMainWorld.mock.calls[0]![1] as Poe2Bridge;
    await bridge.combat!.status();
    expect(electron.invoke).toHaveBeenLastCalledWith("combat:status");
    await bridge.combat!.stop();
    expect(electron.invoke).toHaveBeenLastCalledWith("combat:stop");
    await bridge.combat!.setGlobalDryRun(true);
    expect(electron.invoke).toHaveBeenLastCalledWith("combat:global-dry-run", true);
    electron.invoke.mockClear();
    expect(Object.keys(bridge).sort()).toEqual(
      [
        "assistive",
        "bagTriage",
        "calibration",
        "combat",
        "deck",
        "evaluateText",
        "fromClipboard",
        "generateFilter",
        "hotkeys",
        "intelligence",
        "killLatched",
        "mode",
        "onItem",
        "priceFeed",
        "priceHelper",
        "rearm",
        "scanner",
        "shop",
        "stashSort",
        "stashTabs",
        "stashValuation",
        "windows",
      ].sort(),
    );
    expect(Object.keys(bridge.intelligence).sort()).toEqual(
      [
        "builds",
        "catalog",
        "exports",
        "imports",
        "prices",
        "rules",
        "scans",
        "tiers",
      ].sort(),
    );

    await bridge.mode();
    await bridge.evaluateText("Item Class: Rings");
    await bridge.intelligence.catalog.list();
    await bridge.intelligence.catalog.remove("item-1");
    await bridge.intelligence.rules.validate("maximum Life");
    await bridge.intelligence.scans.get("scan-1");
    await bridge.intelligence.tiers.get();
    await bridge.intelligence.tiers.evaluate("Item Class: Rings");
    await bridge.intelligence.prices.get();
    await bridge.scanner.status();
    await bridge.stashValuation!.overview();
    await bridge.stashValuation!.saveSettings({ league: "Forbidden Rites" });
    await bridge.stashTabs.runScript("value-dump-resume");

    expect(electron.invoke.mock.calls).toEqual([
      ["runtime:mode"],
      ["item:evaluate-text", "Item Class: Rings"],
      ["catalog:list"],
      ["catalog:remove", "item-1"],
      ["rules:validate", "maximum Life"],
      ["scans:get", "scan-1"],
      ["tiers:get"],
      ["tiers:evaluate", "Item Class: Rings"],
      ["prices:get"],
      ["scanner:status"],
      ["stash-valuation:overview"],
      ["stash-valuation:save-settings", { league: "Forbidden Rites" }],
      ["stash-tabs:run-script", "value-dump-resume"],
    ]);
  });

  it("adapts renderer events to payload-only callbacks and unsubscribes", async () => {
    await import("../../src/main/preload.js");
    const bridge = electron.exposeInMainWorld.mock.calls[0]![1] as Poe2Bridge;
    const callback = vi.fn();
    const dispose = bridge.intelligence.catalog.onChanged(callback);
    const registration = electron.on.mock.calls.find(
      ([channel]) => channel === "catalog:changed",
    );
    expect(registration).toBeDefined();

    const payload = [
      {
        id: "item-1",
        fingerprint: "fp",
        name: "Storm Loop",
        baseType: "Ruby Ring",
        itemClass: "Rings",
        currentLocation: "clipboard:latest",
        createdAt: "2026-08-27T16:00:00.000Z",
        updatedAt: "2026-08-27T16:00:00.000Z",
      },
    ];
    const listener = registration![1] as (
      event: unknown,
      value: typeof payload,
    ) => void;
    listener({ sender: "fake" }, payload);
    expect(callback).toHaveBeenCalledWith(payload);

    dispose();
    expect(electron.removeListener).toHaveBeenCalledWith(
      "catalog:changed",
      listener,
    );
  });

  it("exposes explicit bag stages and payload-only status subscriptions", async () => {
    await import("../../src/main/preload.js");
    const api = (electron.exposeInMainWorld.mock.calls[0]![1] as Poe2Bridge).bagTriage!;
    await api.status(); await api.select("live-adapter/bag-01.jsonl");
    for (const stage of ["capture", "identify", "drop", "reconcile"] as const) await api.start(stage);
    await api.stop();
    expect(electron.invoke.mock.calls).toEqual([["bag-triage:status"], ["bag-triage:select", "live-adapter/bag-01.jsonl"],
      ["bag-triage:start", "capture"], ["bag-triage:start", "identify"], ["bag-triage:start", "drop"], ["bag-triage:start", "reconcile"], ["bag-triage:stop"]]);
    const callback = vi.fn(), dispose = api.onStatus(callback), listener = electron.on.mock.calls.find(([channel]) => channel === "bag-triage:status-changed")![1];
    const payload = { running: false, phase: "complete", message: "Bag stage complete.", sessions: [] };
    listener({ sender: "fake" }, payload); expect(callback).toHaveBeenCalledWith(payload);
    dispose(); expect(electron.removeListener).toHaveBeenCalledWith("bag-triage:status-changed", listener);
  });
});
