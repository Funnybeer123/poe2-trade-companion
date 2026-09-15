/**
 * Builds the FeatureContext, registers every module in order, and exposes
 * the scaffold's own channels (settings, dry-run mirror, diagnostics).
 * Electron-free apart from the types so it can be exercised in tests with
 * a fake ipcMain.
 */
import type { BrowserWindow } from "electron";
import { isFeatureChannel, type SettingsChangedEvent } from "../../shared/features.js";
import type { RuntimeMode } from "../../core/types.js";
import type { SettingsStore } from "../settingsStore.js";
import type {
  CoreServices,
  FeatureContext,
  FeatureHandle,
  FeatureLogEntry,
  FeatureModule,
  FeatureServiceMap,
} from "./types.js";

/** The slice of Electron's ipcMain the context needs (fakeable). */
export interface IpcMainLike {
  handle(
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => unknown,
  ): void;
  removeHandler(channel: string): void;
}

export interface FeatureContextOptions {
  ipcMain: IpcMainLike;
  configDir: string;
  userDataDir: string;
  repoRoot: string;
  /** Electron `app.getAppPath()`; defaults to `repoRoot` when not supplied. */
  appPath?: string;
  buildMode: RuntimeMode;
  core: CoreServices;
  settings: SettingsStore;
  mainWindow: () => BrowserWindow | undefined;
  poeWindows: () => Promise<Array<{ name: string; title: string }>>;
  killSwitchLatched: () => boolean;
  notify: (title: string, body: string) => void;
  clipboard: { readText(): string; writeText(text: string): void };
  openExternal: (url: string) => Promise<void>;
  /**
   * Electron `shell.openPath`: resolves "" on success, the error text
   * otherwise. Omitted in tests; the default reports it is unavailable
   * rather than throwing.
   */
  openPath?: (target: string) => Promise<string>;
  log?: (entry: FeatureLogEntry) => void;
}

export interface FeatureRuntime {
  ctx: FeatureContext;
  /** Registers the modules in order; a module that throws is logged and skipped. */
  register(modules: readonly FeatureModule[]): Promise<{ registered: string[]; failed: Array<{ id: string; error: string }> }>;
  /** Disposes in reverse order and removes every registered handler. */
  dispose(): Promise<void>;
}

function isLive(window: BrowserWindow): boolean {
  try {
    return !window.isDestroyed();
  } catch {
    return false;
  }
}

export function createFeatureRuntime(options: FeatureContextOptions): FeatureRuntime {
  const channels = new Set<string>();
  const services = new Map<string, unknown>();
  const windows = new Set<BrowserWindow>();
  const handles: Array<{ id: string; handle: FeatureHandle }> = [];
  let dryRun = false;
  const log =
    options.log ??
    ((entry: FeatureLogEntry) => {
      const line = `[feature:${entry.feature}] ${entry.message}`;
      if (entry.level === "error") console.error(line, entry.detail ?? "");
      else if (entry.level === "warn") console.warn(line, entry.detail ?? "");
      else console.info(line);
    });

  const ctx: FeatureContext = {
    configDir: options.configDir,
    userDataDir: options.userDataDir,
    repoRoot: options.repoRoot,
    appPath: options.appPath ?? options.repoRoot,
    buildMode: options.buildMode,
    core: options.core,
    settings: options.settings,
    handle(channel, handler) {
      if (!isFeatureChannel(channel)) {
        throw new Error(`invalid feature channel "${channel}" (expected pkg:verb)`);
      }
      if (channels.has(channel)) {
        throw new Error(`feature channel "${channel}" is already registered`);
      }
      channels.add(channel);
      options.ipcMain.handle(channel, (_event, ...args) =>
        (handler as unknown as (...input: unknown[]) => unknown)(...args),
      );
    },
    emit(channel, payload) {
      if (!isFeatureChannel(channel)) {
        throw new Error(`invalid feature event "${channel}" (expected pkg:event)`);
      }
      for (const window of ctx.windows()) {
        try {
          window.webContents.send(channel, payload);
        } catch {
          // A window mid-teardown must never break the emitter.
        }
      }
    },
    channels: () => [...channels].sort(),
    provide(id, service) {
      services.set(id, service);
    },
    get(id) {
      return services.get(id) as FeatureServiceMap[typeof id] | undefined;
    },
    require(id) {
      const service = services.get(id);
      if (service === undefined) {
        throw new Error(`feature service "${String(id)}" is not available (registration order?)`);
      }
      return service as FeatureServiceMap[typeof id];
    },
    mainWindow: options.mainWindow,
    windows() {
      const main = options.mainWindow();
      const all = new Set<BrowserWindow>(windows);
      if (main) all.add(main);
      return [...all].filter(isLive);
    },
    registerWindow(window) {
      windows.add(window);
      try {
        window.once("closed", () => windows.delete(window));
      } catch {
        // Fakes in tests may not be event emitters.
      }
    },
    poeWindows: options.poeWindows,
    killSwitchLatched: options.killSwitchLatched,
    dryRun: () => dryRun,
    notify: options.notify,
    clipboard: options.clipboard,
    openExternal: options.openExternal,
    openPath:
      options.openPath ??
      (async (target: string) => `openPath is not available in this runtime (${target})`),
    log,
  };

  ctx.provide("settings", options.settings);

  // Scaffold channels.
  ctx.handle("app:feature-channels", () => ctx.channels());
  ctx.handle("app:dry-run", () => dryRun);
  ctx.handle("app:set-dry-run", (value: boolean) => {
    const next = Boolean(value);
    if (next !== dryRun) {
      dryRun = next;
      ctx.emit("app:dry-run-changed", dryRun);
    }
    return dryRun;
  });
  ctx.handle("settings:get", () => options.settings.snapshot());
  ctx.handle("settings:set", (id: string, patch: unknown) => options.settings.setRaw(id, patch));
  options.settings.onAnyChange((id, value) => {
    const event: SettingsChangedEvent = { id, value };
    ctx.emit("settings:changed", event);
  });

  return {
    ctx,
    async register(modules) {
      const registered: string[] = [];
      const failed: Array<{ id: string; error: string }> = [];
      for (const module of modules) {
        try {
          const handle = await module.register(ctx);
          handles.push({ id: module.id, handle: handle ?? {} });
          registered.push(module.id);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failed.push({ id: module.id, error: message });
          log({ feature: module.id, level: "error", message: `registration failed: ${message}`, detail: error });
        }
      }
      return { registered, failed };
    },
    async dispose() {
      for (const { id, handle } of handles.splice(0).reverse()) {
        try {
          await handle.dispose?.();
        } catch (error) {
          log({ feature: id, level: "warn", message: "dispose failed", detail: error });
        }
      }
      for (const channel of channels) {
        try {
          options.ipcMain.removeHandler(channel);
        } catch {
          // Already gone.
        }
      }
      channels.clear();
      services.clear();
    },
  };
}
