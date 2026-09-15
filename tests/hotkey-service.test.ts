import { describe, expect, it, vi } from "vitest";
import { createFeatureRuntime, type IpcMainLike } from "../src/main/features/context.js";
import { createHotkeysModule } from "../src/main/features/hotkeys/index.js";
import {
  createHotkeyService,
  hotkeyBindingsFilePath,
  type GlobalShortcutLike,
  type HotkeyAction,
} from "../src/main/hotkeyService.js";
import { SettingsStore } from "../src/main/settingsStore.js";
import type { HotkeyBindingView } from "../src/shared/hotkeys.js";

function fakeGlobalShortcut(options: { refuse?: string[] } = {}) {
  const registered = new Map<string, () => void>();
  const calls: string[] = [];
  const shortcut: GlobalShortcutLike = {
    register: (accelerator, callback) => {
      calls.push(`register ${accelerator}`);
      if (options.refuse?.includes(accelerator)) return false;
      registered.set(accelerator, callback);
      return true;
    },
    unregister: (accelerator) => {
      calls.push(`unregister ${accelerator}`);
      registered.delete(accelerator);
    },
    isRegistered: (accelerator) => registered.has(accelerator),
  };
  return { shortcut, registered, calls, press: (accelerator: string) => registered.get(accelerator)?.() };
}

function memoryFs(initial?: string) {
  const files = new Map<string, string>();
  if (initial !== undefined) files.set("hotkeys.json", initial);
  return {
    files,
    fs: {
      read: (file: string) => files.get(file),
      write: (file: string, text: string) => {
        files.set(file, text);
      },
    },
  };
}

function action(id: string, defaultAccelerator: string | null, run = vi.fn()): HotkeyAction {
  return { id, label: id[0]!.toUpperCase() + id.slice(1), group: "Overlay", defaultAccelerator, run };
}

function service(overrides: { file?: string; shortcut?: ReturnType<typeof fakeGlobalShortcut>; reserved?: Array<{ accelerator: string; label: string }> } = {}) {
  const shortcut = overrides.shortcut ?? fakeGlobalShortcut();
  const memory = memoryFs(overrides.file);
  const changes: HotkeyBindingView[][] = [];
  const svc = createHotkeyService({
    globalShortcut: shortcut.shortcut,
    file: "hotkeys.json",
    fs: memory.fs,
    reserved: () => overrides.reserved ?? [],
    onChange: (bindings) => changes.push(bindings),
  });
  return { svc, shortcut, memory, changes };
}

describe("HotkeyService", () => {
  it("binds the default accelerator on contribute and runs the action on press", async () => {
    const run = vi.fn();
    const { svc, shortcut, changes } = service();
    svc.contribute(action("evaluate", "Alt+E", run));
    expect(shortcut.registered.has("Alt+E")).toBe(true);
    expect(svc.list()).toEqual([
      { id: "evaluate", label: "Evaluate", group: "Overlay", defaultAccelerator: "Alt+E", accelerator: "Alt+E", registered: true },
    ]);
    shortcut.press("Alt+E");
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    expect(changes).toHaveLength(1);
    expect(await svc.trigger("evaluate")).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
    expect(await svc.trigger("missing")).toBe(false);
  });

  it("prefers the persisted binding (including an explicit null) over the default", () => {
    const { svc, shortcut } = service({
      file: JSON.stringify({ version: 1, bindings: { evaluate: "Alt+Q", market: null } }),
    });
    svc.contribute(action("evaluate", "Alt+E"));
    svc.contribute(action("market", "Alt+M"));
    svc.contribute(action("inspect", "Alt+I"));
    expect([...shortcut.registered.keys()]).toEqual(["Alt+Q", "Alt+I"]);
    expect(svc.list().map((view) => [view.id, view.accelerator, view.registered])).toEqual([
      ["evaluate", "Alt+Q", true],
      ["market", null, false],
      ["inspect", "Alt+I", true],
    ]);
  });

  it("rebinds by unregistering the old accelerator first and persists only deviations from the default", () => {
    const { svc, shortcut, memory, changes } = service();
    svc.contribute(action("evaluate", "Alt+E"));
    shortcut.calls.length = 0;
    const views = svc.rebind("evaluate", "Alt+Q");
    expect(shortcut.calls).toEqual(["unregister Alt+E", "register Alt+Q"]);
    expect(views[0]).toMatchObject({ accelerator: "Alt+Q", registered: true });
    expect(JSON.parse(memory.files.get("hotkeys.json")!)).toEqual({ version: 1, bindings: { evaluate: "Alt+Q" } });
    svc.rebind("evaluate", null);
    expect(shortcut.registered.size).toBe(0);
    expect(JSON.parse(memory.files.get("hotkeys.json")!)).toEqual({ version: 1, bindings: { evaluate: null } });
    svc.rebind("evaluate", "Alt+E");
    expect(JSON.parse(memory.files.get("hotkeys.json")!)).toEqual({ version: 1, bindings: {} });
    expect(changes.length).toBe(4);
    expect(() => svc.rebind("nope", "Alt+Z")).toThrow(/unknown hotkey action/);
  });

  it("keeps invalid, reserved and colliding accelerators unregistered with the reason", () => {
    const { svc, shortcut } = service({ reserved: [{ accelerator: "Ctrl+Alt+V", label: "the voice hotkey" }] });
    svc.contribute(action("evaluate", "Alt+E"));
    svc.contribute(action("market", "Alt+M"));
    expect(svc.rebind("market", "alt+e")[1]).toMatchObject({
      accelerator: "alt+e",
      registered: false,
      error: "Alt+E is already bound to Evaluate.",
    });
    expect(svc.rebind("market", "Ctrl+D")[1].error).toMatch(/reserved for Price check/);
    expect(svc.rebind("market", "CommandOrControl+Alt+V")[1].error).toMatch(/reserved for the voice hotkey/);
    expect(svc.rebind("market", "garbage+")[1].error).toMatch(/Not a valid shortcut/);
    expect([...shortcut.registered.keys()]).toEqual(["Alt+E"]);
    expect(svc.validate("Alt+E", "market")).toEqual({
      ok: false,
      reason: "Alt+E is already bound to Evaluate.",
      conflictsWith: "evaluate",
    });
    expect(svc.validate("Alt+E", "evaluate")).toEqual({ ok: true });
  });

  it("surfaces an OS refusal as an error and reset returns to the default", () => {
    const shortcut = fakeGlobalShortcut({ refuse: ["Alt+E"] });
    const { svc, memory } = service({ shortcut, file: JSON.stringify({ version: 1, bindings: { evaluate: "Alt+Q" } }) });
    svc.contribute(action("evaluate", "Alt+E"));
    expect(svc.list()[0]).toMatchObject({ accelerator: "Alt+Q", registered: true });
    const [view] = svc.reset("evaluate");
    expect(view).toMatchObject({ accelerator: "Alt+E", registered: false });
    expect(view!.error).toMatch(/could not be registered/);
    expect(JSON.parse(memory.files.get("hotkeys.json")!)).toEqual({ version: 1, bindings: {} });
    expect(shortcut.registered.size).toBe(0);
  });

  it("reset() with no id restores every action and un-contribute releases the key", () => {
    const { svc, shortcut } = service({
      file: JSON.stringify({ version: 1, bindings: { evaluate: "Alt+Q", market: null } }),
    });
    const release = svc.contribute(action("evaluate", "Alt+E"));
    svc.contribute(action("market", "Alt+M"));
    svc.reset();
    expect([...shortcut.registered.keys()].sort()).toEqual(["Alt+E", "Alt+M"]);
    release();
    expect([...shortcut.registered.keys()]).toEqual(["Alt+M"]);
    expect(svc.list().map((view) => view.id)).toEqual(["market"]);
    expect(() => svc.contribute(action("market", null))).toThrow(/already contributed/);
  });

  it("logs a failing action instead of throwing and tolerates a corrupt file", async () => {
    const log = vi.fn();
    const shortcut = fakeGlobalShortcut();
    const svc = createHotkeyService({
      globalShortcut: shortcut.shortcut,
      file: "hotkeys.json",
      fs: memoryFs("{oops").fs,
      log,
    });
    svc.contribute(
      action("boom", "Alt+B", vi.fn(async () => {
        throw new Error("kaboom");
      })),
    );
    expect(await svc.trigger("boom")).toBe(true);
    expect(log).toHaveBeenCalledWith("error", 'hotkey action "boom" failed', expect.any(Error));
    svc.dispose();
    expect(shortcut.registered.size).toBe(0);
  });

  it("names the persisted file under userData", () => {
    expect(hotkeyBindingsFilePath("C:/user").replace(/\\/g, "/")).toBe("C:/user/overlay-hotkeys.json");
  });
});

function fakeIpc() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const ipc: IpcMainLike = {
    handle: (channel, listener) => {
      handlers.set(channel, listener);
    },
    removeHandler: (channel) => {
      handlers.delete(channel);
    },
  };
  return {
    ipc,
    invoke: async (channel: string, ...args: unknown[]) => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`no handler for ${channel}`);
      return handler({}, ...args);
    },
  };
}

function runtime() {
  const { ipc, invoke } = fakeIpc();
  const sent: Array<[string, unknown]> = [];
  const main = {
    isDestroyed: () => false,
    once: vi.fn(),
    webContents: { send: (channel: string, payload: unknown) => sent.push([channel, payload]) },
  };
  const rt = createFeatureRuntime({
    ipcMain: ipc,
    configDir: "C:/cfg",
    userDataDir: "C:/user",
    repoRoot: "C:/repo",
    buildMode: "authorized-qa",
    core: {} as never,
    settings: new SettingsStore({ file: "settings.json", fs: { read: () => undefined, write: () => undefined } }),
    mainWindow: () => main as never,
    poeWindows: async () => [],
    killSwitchLatched: () => false,
    notify: vi.fn(),
    clipboard: { readText: () => "", writeText: vi.fn() },
    openExternal: vi.fn(async () => undefined),
    log: vi.fn(),
  });
  return { rt, invoke, sent };
}

describe("hotkeys feature module", () => {
  it("provides the service, serves the hotkeys:* channels and emits hotkeys:changed", async () => {
    const shortcut = fakeGlobalShortcut();
    const memory = memoryFs();
    const { rt, invoke, sent } = runtime();
    const module = createHotkeysModule({ globalShortcut: shortcut.shortcut, fs: memory.fs, reserved: () => [] });
    const result = await rt.register([
      module,
      {
        id: "consumer",
        register(ctx) {
          ctx.require("hotkeys").contribute(action("evaluate", "Alt+E"));
        },
      },
    ]);
    expect(result.failed).toEqual([]);
    expect(rt.ctx.channels()).toEqual(
      expect.arrayContaining(["hotkeys:list", "hotkeys:rebind", "hotkeys:validate", "hotkeys:trigger", "hotkeys:reset"]),
    );
    expect(await invoke("hotkeys:list")).toEqual([
      expect.objectContaining({ id: "evaluate", accelerator: "Alt+E", registered: true }),
    ]);
    expect(await invoke("hotkeys:validate", "Alt+E", "evaluate")).toEqual({ ok: true });
    expect(await invoke("hotkeys:validate", "Ctrl+D")).toMatchObject({ ok: false });
    await invoke("hotkeys:rebind", "evaluate", "Alt+Q");
    expect(sent.filter(([channel]) => channel === "hotkeys:changed")).toHaveLength(2);
    expect(shortcut.registered.has("Alt+Q")).toBe(true);
    expect([...memory.files.keys()][0]!.replace(/\\/g, "/")).toBe("C:/user/overlay-hotkeys.json");
    expect(await invoke("hotkeys:trigger", "evaluate")).toBe(true);
    expect(await invoke("hotkeys:reset", "evaluate")).toEqual([
      expect.objectContaining({ accelerator: "Alt+E", registered: true }),
    ]);
    await rt.dispose();
    expect(shortcut.registered.size).toBe(0);
  });
});
