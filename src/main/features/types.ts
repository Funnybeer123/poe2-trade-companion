/**
 * Feature modules: the extension point every ported overlay feature plugs
 * into (see docs/HANDOFF-overlay-port.md). A module registers its invoke
 * channels, subscribes to what it needs, and may publish a service for the
 * modules registered after it. Nothing here imports a feature.
 */
import type { BrowserWindow } from "electron";
import type { RuntimeMode } from "../../core/types.js";
import type { SettingsStore } from "../settingsStore.js";
import type { ItemIntelligenceService } from "../itemIntelligenceService.js";
import type { MarketTrendsService } from "../marketTrendsService.js";
import type { PriceFeedService } from "../priceFeedService.js";
import type { WatchlistService } from "../watchlistService.js";

/**
 * Services a foundation module publishes for later modules. Foundation
 * modules add their own key by module augmentation from their own file:
 *
 *   declare module "../types.js" {
 *     interface FeatureServiceMap { clientLog: ClientLogService }
 *   }
 */
export interface FeatureServiceMap {
  /** Always present: the scaffold publishes the settings store itself. */
  settings: SettingsStore;
}

/** Existing main-process services, constructed before any feature registers. */
export interface CoreServices {
  priceFeed: PriceFeedService;
  itemIntelligence: ItemIntelligenceService;
  marketTrends: MarketTrendsService;
  watchlist: WatchlistService;
}

export type FeatureHandler<Args extends readonly unknown[], Result> = (
  ...args: Args
) => Result | Promise<Result>;

export interface FeatureLogEntry {
  feature: string;
  level: "info" | "warn" | "error";
  message: string;
  detail?: unknown;
}

export interface FeatureContext {
  /** artifacts/tab-admin — shared with the CLIs (feeds, caches, ledgers). */
  readonly configDir: string;
  /** Electron userData — per-user private state (settings, histories, secrets). */
  readonly userDataDir: string;
  /** The repo / packaged-app root (process.cwd()). */
  readonly repoRoot: string;
  /**
   * Electron's `app.getAppPath()` — the directory the app was loaded from
   * (the repo root in dev, `resources/app` in a packaged build). Use it to
   * find files listed in electron-builder's `files:` (bundled data,
   * CHANGELOG.md) instead of importing Electron from a feature.
   */
  readonly appPath: string;
  readonly buildMode: RuntimeMode;
  readonly core: CoreServices;
  readonly settings: SettingsStore;

  /** Register one invoke channel (`pkg:verb`). Throws on an invalid or duplicate channel. */
  handle<Args extends readonly unknown[], Result>(
    channel: string,
    handler: FeatureHandler<Args, Result>,
  ): void;
  /** Push an event to every registered app window (main + overlay). */
  emit(channel: string, payload: unknown): void;
  /** Every channel registered so far (diagnostics). */
  channels(): string[];

  /** Publish a service for modules registered later. */
  provide<K extends keyof FeatureServiceMap>(id: K, service: FeatureServiceMap[K]): void;
  /** A service published earlier, or undefined. */
  get<K extends keyof FeatureServiceMap>(id: K): FeatureServiceMap[K] | undefined;
  /** A service published earlier; throws with the missing id otherwise. */
  require<K extends keyof FeatureServiceMap>(id: K): FeatureServiceMap[K];

  /** The main app window when it exists. */
  mainWindow(): BrowserWindow | undefined;
  /** Windows `emit` reaches; the overlay module adds its own. */
  windows(): BrowserWindow[];
  registerWindow(window: BrowserWindow): void;

  /** Path of Exile processes currently running (memoized, cheap). */
  poeWindows(): Promise<Array<{ name: string; title: string }>>;
  killSwitchLatched(): boolean;
  /** The renderer's top-bar Dry-run switch, mirrored into main. */
  dryRun(): boolean;

  notify(title: string, body: string): void;
  readonly clipboard: { readText(): string; writeText(text: string): void };
  openExternal(url: string): Promise<void>;
  /**
   * Open a local file or folder with the OS default handler
   * (Electron `shell.openPath` semantics): resolves to `""` on success and
   * to the error text otherwise — it never rejects. Prefer this over
   * `openExternal(pathToFileURL(...))` for anything on disk.
   */
  openPath(target: string): Promise<string>;
  log(entry: FeatureLogEntry): void;
}

export interface FeatureHandle {
  dispose?(): void | Promise<void>;
}

export interface FeatureModule {
  /** Short id; also the recommended channel prefix (`trade` → `trade:*`). */
  readonly id: string;
  register(ctx: FeatureContext): FeatureHandle | void | Promise<FeatureHandle | void>;
}
