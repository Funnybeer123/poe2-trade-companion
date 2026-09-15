import { describe, expect, it, vi } from "vitest";
import { createFeatureRuntime, type IpcMainLike } from "../src/main/features/context.js";
import type { FeatureContext, FeatureModule } from "../src/main/features/types.js";
import { SettingsStore } from "../src/main/settingsStore.js";
import {
  bindFeatureApi,
  isFeatureChannel,
  type FeatureBridge,
  type FeatureCall,
} from "../src/shared/features.js";

declare module "../src/main/features/types.js" {
  interface FeatureServiceMap {
    "test-greeter": { greet(name: string): string };
  }
}

function fakeIpc() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const ipc: IpcMainLike = {
    handle: (channel, listener) => {
      if (handlers.has(channel)) throw new Error(`duplicate ${channel}`);
      handlers.set(channel, listener);
    },
    removeHandler: (channel) => {
      handlers.delete(channel);
    },
  };
  const invoke = async (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler({}, ...args);
  };
  return { ipc, invoke, handlers };
}

function memoryFs(initial?: string) {
  const files = new Map<string, string>();
  if (initial !== undefined) files.set("settings.json", initial);
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

function fakeWindow(name: string) {
  const sent: Array<[string, unknown]> = [];
  let destroyed = false;
  return {
    name,
    sent,
    destroy: () => {
      destroyed = true;
    },
    isDestroyed: () => destroyed,
    once: vi.fn(),
    webContents: {
      send: (channel: string, payload: unknown) => {
        sent.push([channel, payload]);
      },
    },
  };
}

function runtime(overrides: Partial<Parameters<typeof createFeatureRuntime>[0]> = {}) {
  const { ipc, invoke } = fakeIpc();
  const memory = memoryFs();
  const settings = new SettingsStore({ file: "settings.json", fs: memory.fs });
  const main = fakeWindow("main");
  const notify = vi.fn();
  const clipboard = { readText: vi.fn(() => "clip"), writeText: vi.fn() };
  const openExternal = vi.fn(async () => undefined);
  const openPath = vi.fn(async (_target: string) => "");
  const log = vi.fn();
  const rt = createFeatureRuntime({
    ipcMain: ipc,
    configDir: "C:/cfg",
    userDataDir: "C:/user",
    repoRoot: "C:/repo",
    appPath: "C:/app",
    buildMode: "authorized-qa",
    core: {} as never,
    settings,
    mainWindow: () => main as never,
    poeWindows: async () => [{ name: "PathOfExileSteam.exe", title: "Path of Exile 2" }],
    killSwitchLatched: () => false,
    notify,
    clipboard,
    openExternal,
    openPath,
    log,
    ...overrides,
  });
  return { rt, invoke, settings, main, notify, clipboard, openExternal, openPath, log, memory };
}

describe("feature channel names", () => {
  it("accepts pkg:verb and refuses anything else", () => {
    expect(isFeatureChannel("trade:offers")).toBe(true);
    expect(isFeatureChannel("campaign-guide:set-route")).toBe(true);
    expect(isFeatureChannel("Trade:offers")).toBe(false);
    expect(isFeatureChannel("trade")).toBe(false);
    expect(isFeatureChannel("trade:offers:all")).toBe(false);
    expect(isFeatureChannel("")).toBe(false);
    expect(isFeatureChannel(42)).toBe(false);
  });

  it("binds a typed api over the untyped bridge", async () => {
    const calls: Array<[string, unknown[]]> = [];
    const listeners = new Map<string, (payload: unknown) => void>();
    const bridge: FeatureBridge = {
      invoke: async (channel, ...args) => {
        calls.push([channel, args]);
        return `${channel}!`;
      },
      on: (channel, callback) => {
        listeners.set(channel, callback);
        return () => listeners.delete(channel);
      },
    };
    interface Contract {
      "demo:echo": FeatureCall<[text: string], string>;
    }
    interface Events {
      "demo:tick": number;
    }
    const api = bindFeatureApi<Contract, Events>(bridge);
    await expect(api.invoke("demo:echo", "hi")).resolves.toBe("demo:echo!");
    expect(calls).toEqual([["demo:echo", ["hi"]]]);
    const seen: number[] = [];
    const stop = api.on("demo:tick", (value) => seen.push(value));
    listeners.get("demo:tick")!(7);
    expect(seen).toEqual([7]);
    stop();
    expect(listeners.has("demo:tick")).toBe(false);
  });
});

describe("feature runtime", () => {
  it("registers modules in order, exposes provided services, and reports failures", async () => {
    const { rt, invoke } = runtime();
    const order: string[] = [];
    const greeter: FeatureModule = {
      id: "greeter",
      register(ctx) {
        order.push("greeter");
        ctx.provide("test-greeter", { greet: (name) => `hello ${name}` });
        ctx.handle("greeter:greet", (name: string) => ctx.require("test-greeter").greet(name));
      },
    };
    const consumer: FeatureModule = {
      id: "consumer",
      register(ctx) {
        order.push("consumer");
        const service = ctx.require("test-greeter");
        ctx.handle("consumer:hello", () => service.greet("consumer"));
        return {
          dispose: () => {
            order.push("consumer:disposed");
          },
        };
      },
    };
    const broken: FeatureModule = {
      id: "broken",
      register() {
        throw new Error("boom");
      },
    };
    const result = await rt.register([greeter, consumer, broken]);
    expect(order).toEqual(["greeter", "consumer"]);
    expect(result.registered).toEqual(["greeter", "consumer"]);
    expect(result.failed).toEqual([{ id: "broken", error: "boom" }]);
    expect(await invoke("greeter:greet", "exile")).toBe("hello exile");
    expect(await invoke("consumer:hello")).toBe("hello consumer");
    expect(await invoke("app:feature-channels")).toEqual([
      "app:dry-run",
      "app:feature-channels",
      "app:set-dry-run",
      "consumer:hello",
      "greeter:greet",
      "settings:get",
      "settings:set",
    ]);
    await rt.dispose();
    expect(order.at(-1)).toBe("consumer:disposed");
    await expect(invoke("greeter:greet", "x")).rejects.toThrow(/no handler/);
  });

  it("refuses invalid and duplicate channels and missing services", async () => {
    const { rt } = runtime();
    let captured: FeatureContext | undefined;
    await rt.register([
      {
        id: "probe",
        register(ctx) {
          captured = ctx;
          ctx.handle("probe:one", () => 1);
        },
      },
    ]);
    expect(() => captured!.handle("Probe:bad", () => 0)).toThrow(/invalid feature channel/);
    expect(() => captured!.handle("probe:one", () => 0)).toThrow(/already registered/);
    expect(() => captured!.emit("nope", 1)).toThrow(/invalid feature event/);
    expect(captured!.get("test-greeter")).toBeUndefined();
    expect(() => captured!.require("test-greeter")).toThrow(/not available/);
    expect(captured!.require("settings")).toBeInstanceOf(SettingsStore);
  });

  it("emits to the main window and every registered window, skipping destroyed ones", async () => {
    const { rt, main } = runtime();
    const overlay = fakeWindow("overlay");
    const gone = fakeWindow("gone");
    await rt.register([
      {
        id: "emitter",
        register(ctx) {
          ctx.registerWindow(overlay as never);
          ctx.registerWindow(gone as never);
          gone.destroy();
          ctx.emit("emitter:ping", { n: 1 });
        },
      },
    ]);
    expect(main.sent).toEqual([["emitter:ping", { n: 1 }]]);
    expect(overlay.sent).toEqual([["emitter:ping", { n: 1 }]]);
    expect(gone.sent).toEqual([]);
  });

  it("passes openPath through to the host and falls back to an error string without one", async () => {
    const { rt, openPath } = runtime();
    openPath.mockResolvedValueOnce("");
    await expect(rt.ctx.openPath("C:/user/deaths/2026-09-14.jpg")).resolves.toBe("");
    expect(openPath).toHaveBeenCalledWith("C:/user/deaths/2026-09-14.jpg");
    openPath.mockResolvedValueOnce("Windows cannot find that file");
    await expect(rt.ctx.openPath("C:/nope")).resolves.toBe("Windows cannot find that file");

    const bare = runtime({ openPath: undefined });
    await expect(bare.rt.ctx.openPath("C:/nope")).resolves.toMatch(/not available/);
  });

  it("exposes appPath, defaulting to the repo root", async () => {
    const { rt } = runtime();
    expect(rt.ctx.appPath).toBe("C:/app");
    expect(runtime({ appPath: undefined }).rt.ctx.appPath).toBe("C:/repo");
  });

  it("mirrors the renderer's dry-run switch and announces changes once", async () => {
    const { rt, invoke, main } = runtime();
    expect(await invoke("app:dry-run")).toBe(false);
    expect(await invoke("app:set-dry-run", true)).toBe(true);
    expect(await invoke("app:set-dry-run", true)).toBe(true);
    expect(rt.ctx.dryRun()).toBe(true);
    expect(main.sent).toEqual([["app:dry-run-changed", true]]);
  });

  it("serves settings snapshots and patches through the generic channels", async () => {
    const { rt, invoke, main, settings } = runtime();
    interface Demo {
      scale: number;
      label: string;
    }
    const sanitize = (raw: unknown): Demo => {
      const source = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<Demo>;
      const scale = Number(source.scale);
      return {
        scale: Number.isFinite(scale) ? Math.min(3, Math.max(0.5, scale)) : 1,
        label: typeof source.label === "string" ? source.label.slice(0, 20) : "default",
      };
    };
    await rt.register([
      { id: "demo", register: (ctx) => void ctx.settings.namespace("demo", sanitize) },
    ]);
    expect(await invoke("settings:get")).toEqual({ demo: { scale: 1, label: "default" } });
    expect(await invoke("settings:set", "demo", { scale: 99, label: "x".repeat(40) })).toEqual({
      scale: 3,
      label: "x".repeat(20),
    });
    expect(main.sent).toEqual([
      ["settings:changed", { id: "demo", value: { scale: 3, label: "x".repeat(20) } }],
    ]);
    expect(settings.snapshot()).toEqual({ demo: { scale: 3, label: "x".repeat(20) } });
    await expect(invoke("settings:set", "unknown", {})).rejects.toThrow(/unknown settings namespace/);
  });
});

describe("settings store", () => {
  interface Prefs {
    opacity: number;
    sounds: boolean;
  }
  const sanitize = (raw: unknown): Prefs => {
    const source = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<Prefs>;
    const opacity = Number(source.opacity);
    return {
      opacity: Number.isFinite(opacity) ? Math.min(1, Math.max(0.2, opacity)) : 0.9,
      sounds: source.sounds !== false,
    };
  };

  it("loads a namespace through its sanitizer, keeps unknown namespaces, and tolerates corrupt files", () => {
    const corrupt = new SettingsStore({ file: "settings.json", fs: memoryFs("{not json").fs });
    expect(corrupt.namespace("prefs", sanitize).get()).toEqual({ opacity: 0.9, sounds: true });

    const memory = memoryFs(
      JSON.stringify({ version: 1, namespaces: { prefs: { opacity: 5, sounds: false }, other: { keep: 1 } } }),
    );
    const store = new SettingsStore({ file: "settings.json", fs: memory.fs });
    const prefs = store.namespace("prefs", sanitize);
    expect(prefs.get()).toEqual({ opacity: 1, sounds: false });
    expect(store.snapshot()).toEqual({ prefs: { opacity: 1, sounds: false }, other: { keep: 1 } });
  });

  it("persists patches atomically-shaped, notifies listeners, and rejects bad namespace ids", () => {
    const memory = memoryFs();
    const store = new SettingsStore({ file: "settings.json", fs: memory.fs });
    const prefs = store.namespace("prefs", sanitize);
    const seen: Array<[Prefs, Prefs]> = [];
    const stop = prefs.onChange((next, previous) => seen.push([next, previous]));
    expect(prefs.set({ opacity: 0.5 })).toEqual({ opacity: 0.5, sounds: true });
    expect(prefs.set((current) => ({ ...current, sounds: false }))).toEqual({ opacity: 0.5, sounds: false });
    expect(seen).toEqual([
      [{ opacity: 0.5, sounds: true }, { opacity: 0.9, sounds: true }],
      [{ opacity: 0.5, sounds: false }, { opacity: 0.5, sounds: true }],
    ]);
    stop();
    prefs.set({ opacity: 0.7 });
    expect(seen).toHaveLength(2);
    expect(JSON.parse(memory.files.get("settings.json")!)).toEqual({
      version: 1,
      namespaces: { prefs: { opacity: 0.7, sounds: false } },
    });
    expect(() => store.namespace("Bad Id", sanitize)).toThrow(/invalid settings namespace/);
    expect(() => store.setRaw("missing", {})).toThrow(/unknown settings namespace/);
    // Re-registering returns the same live value.
    expect(store.namespace("prefs", sanitize).get()).toEqual({ opacity: 0.7, sounds: false });
  });

  it("surfaces write failures instead of throwing", () => {
    const store = new SettingsStore({
      file: "settings.json",
      fs: {
        read: () => undefined,
        write: () => {
          throw new Error("disk full");
        },
      },
    });
    const prefs = store.namespace("prefs", sanitize);
    expect(prefs.set({ opacity: 0.3 })).toEqual({ opacity: 0.3, sounds: true });
    expect(store.lastWriteError).toBe("disk full");
  });
});
