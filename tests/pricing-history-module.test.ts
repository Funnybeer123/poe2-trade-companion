import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrendSeries } from "../src/core/priceTrends.js";
import { PRICE_TABLE_SCHEMA_VERSION, type PriceTable } from "../src/core/priceTable.js";
import { createFeatureRuntime, type IpcMainLike } from "../src/main/features/context.js";
import type { CoreServices, FeatureModule } from "../src/main/features/types.js";
import {
  createPricingHistoryModule,
  PRICING_OPEN_ACTION_ID,
} from "../src/main/features/pricingHistory/index.js";
import type { PricingHistoryFs } from "../src/main/features/pricingHistory/historyStore.js";
import { SettingsStore } from "../src/main/settingsStore.js";
import type { HotkeyAction, HotkeyService } from "../src/main/hotkeyService.js";
import type {
  PricingHistoryView,
  PricingOverviewView,
  PricingSettings,
} from "../src/shared/pricingHistory.js";

const LEAGUE = "Runes of Aldur";
const FETCHED_AT = "2026-09-12T06:00:00.000Z";
const NOW = new Date("2026-09-12T12:00:00.000Z");

function fixtureSeries(): TrendSeries[] {
  const cache = JSON.parse(
    readFileSync(new URL("../fixtures/pricing-history/price-trends.cache.json", import.meta.url), "utf8"),
  ) as { series: TrendSeries[] };
  return cache.series;
}

function priceTable(): PriceTable {
  return {
    schemaVersion: PRICE_TABLE_SCHEMA_VERSION,
    currency: "exalted",
    entries: [
      { id: "feed:poe2scout:perfect-jewellers-orb", match: { name: "Perfect Jeweller's Orb" }, value: 20 },
    ],
  };
}

function fakeIpc() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const ipc: IpcMainLike = {
    handle: (channel, listener) => {
      if (handlers.has(channel)) throw new Error(`duplicate ${channel}`);
      handlers.set(channel, listener);
    },
    removeHandler: (channel) => void handlers.delete(channel),
  };
  const invoke = async (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler({}, ...args);
  };
  return { ipc, invoke, handlers };
}

function fakeWindow() {
  const sent: Array<[string, unknown]> = [];
  return {
    sent,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    isMinimized: vi.fn(() => true),
    isDestroyed: () => false,
    once: vi.fn(),
    webContents: { send: (channel: string, payload: unknown) => void sent.push([channel, payload]) },
  };
}

function memoryFs() {
  const files = new Map<string, string>();
  const fs: PricingHistoryFs = {
    read: (file) => files.get(file),
    write: (file, text) => void files.set(file, text),
    remove: (file) => void files.delete(file),
    list: () => [...files.keys()].map((file) => path.basename(file)),
  };
  return { files, fs };
}

interface HarnessOptions {
  series?: TrendSeries[];
  withHotkeys?: boolean;
  getPriceTable?: () => PriceTable;
}

function harness(options: HarnessOptions = {}) {
  const { ipc, invoke } = fakeIpc();
  const settingsFiles = new Map<string, string>();
  const settings = new SettingsStore({
    file: "settings.json",
    fs: {
      read: (file) => settingsFiles.get(file),
      write: (file, text) => void settingsFiles.set(file, text),
    },
  });
  const main = fakeWindow();
  const log = vi.fn();
  const disk = memoryFs();
  const series = vi.fn(async (query?: { refresh?: boolean; cachedOnly?: boolean }) => ({
    ok: true,
    league: LEAGUE,
    fetchedAt: FETCHED_AT,
    stale: false,
    refreshing: false,
    source: query?.refresh ? ("network" as const) : ("cache" as const),
    categories: ["currency"],
    trends: [],
    series: options.series ?? fixtureSeries(),
  }));
  const getPriceTable = vi.fn(options.getPriceTable ?? priceTable);
  const contributed: HotkeyAction[] = [];
  const release = vi.fn();
  const hotkeys = {
    contribute: (action: HotkeyAction) => {
      contributed.push(action);
      return release;
    },
    list: () => [],
    rebind: () => [],
    validate: () => ({ ok: true }),
    trigger: async () => true,
  } as unknown as HotkeyService;

  const runtime = createFeatureRuntime({
    ipcMain: ipc,
    configDir: "C:/cfg",
    userDataDir: "C:/user",
    repoRoot: "C:/repo",
    appPath: "C:/app",
    buildMode: "authorized-qa",
    core: { marketTrends: { series }, itemIntelligence: { getPriceTable } } as unknown as CoreServices,
    settings,
    mainWindow: () => main as never,
    poeWindows: async () => [],
    killSwitchLatched: () => false,
    notify: vi.fn(),
    clipboard: { readText: () => "", writeText: vi.fn() },
    openExternal: vi.fn(async () => undefined),
    openPath: vi.fn(async () => ""),
    log,
  });

  const modules: FeatureModule[] = [];
  if (options.withHotkeys !== false) {
    modules.push({ id: "hotkeys", register: (ctx) => void ctx.provide("hotkeys", hotkeys) });
  }
  modules.push(createPricingHistoryModule({ fs: disk.fs, now: () => NOW }));

  return { runtime, modules, invoke, series, getPriceTable, main, log, disk, contributed, release, settings };
}

type Harness = ReturnType<typeof harness>;

async function start(options: HarnessOptions = {}): Promise<Harness> {
  const bundle = harness(options);
  const result = await bundle.runtime.register(bundle.modules);
  expect(result.failed).toEqual([]);
  return bundle;
}

function events(bundle: Harness, channel: string): unknown[] {
  return bundle.main.sent.filter(([name]) => name === channel).map(([, payload]) => payload);
}

describe("pricing-history module", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers exactly its own channels", async () => {
    const bundle = await start();
    const channels = (await bundle.invoke("app:feature-channels")) as string[];
    expect(channels.filter((channel) => channel.startsWith("pricing:"))).toEqual([
      "pricing:clear-history",
      "pricing:configure",
      "pricing:history",
      "pricing:leagues",
      "pricing:overview",
      "pricing:toggle-favorite",
    ]);
    await bundle.runtime.dispose();
  });

  it("builds the overview from the trends series and merges the bars once per snapshot", async () => {
    const bundle = await start();
    const first = (await bundle.invoke("pricing:overview")) as PricingOverviewView;
    expect(bundle.series).toHaveBeenCalledWith({ refresh: false });
    expect(first.ok).toBe(true);
    expect(first.league).toBe(LEAGUE);
    expect(first.fetchedAt).toBe(FETCHED_AT);
    expect(first.rows).toHaveLength(7);
    expect(first.divineRate).toBe(649.45);
    expect(first.divineRateSource).toBe("feed");
    expect(first.history).toMatchObject({ keys: 6, bars: 30 });
    expect(first.history!.file).toBe(path.join("C:/user", "pricing-history", "runes-of-aldur.json"));
    expect(first.settings.favorites).toEqual([]);
    expect(first.generatedAt).toBe(NOW.toISOString());

    const second = (await bundle.invoke("pricing:overview")) as PricingOverviewView;
    expect(second.history).toMatchObject({ keys: 6, bars: 30 });
    expect(bundle.disk.files.size).toBe(1);
    await bundle.runtime.dispose();
  });

  it("passes refresh and cachedOnly straight through, with cachedOnly winning", async () => {
    const bundle = await start();
    await bundle.invoke("pricing:overview", { refresh: true });
    expect(bundle.series).toHaveBeenLastCalledWith({ refresh: true });
    await bundle.invoke("pricing:overview", { cachedOnly: true });
    expect(bundle.series).toHaveBeenLastCalledWith({ cachedOnly: true });
    await bundle.invoke("pricing:overview", { refresh: true, cachedOnly: true });
    expect(bundle.series).toHaveBeenLastCalledWith({ cachedOnly: true });
    await bundle.invoke("pricing:overview", "junk");
    expect(bundle.series).toHaveBeenLastCalledWith({ refresh: false });
    await bundle.runtime.dispose();
  });

  it("announces new bars only when a refresh actually fetched", async () => {
    const bundle = await start();
    await bundle.invoke("pricing:overview", { refresh: true });
    expect(events(bundle, "pricing:refreshed")).toEqual([
      { league: LEAGUE, fetchedAt: FETCHED_AT, addedBars: 30 },
    ]);
    await bundle.invoke("pricing:overview", { refresh: true });
    expect(events(bundle, "pricing:refreshed")).toHaveLength(1);
    await bundle.runtime.dispose();
  });

  it("merges nothing when the cached snapshot is for another league", async () => {
    const bundle = await start();
    // What MarketTrendsService.cacheMatches() does on a league change: the
    // snapshot comes back empty rather than carrying the other league's bars.
    bundle.series.mockResolvedValueOnce({
      ok: false,
      league: "Forbidden Rites",
      fetchedAt: FETCHED_AT,
      stale: true,
      refreshing: false,
      source: "cache" as const,
      categories: [],
      trends: [],
      series: [],
    } as unknown as Awaited<ReturnType<typeof bundle.series>>);
    const view = (await bundle.invoke("pricing:overview")) as PricingOverviewView;
    expect(view.league).toBe("Forbidden Rites");
    expect(view.rows.map((entry) => entry.key)).toEqual(["perfect-jewellers-orb"]);
    expect(bundle.disk.files.size).toBe(0);
    expect(view.history).toBeUndefined();
    await bundle.runtime.dispose();
  });

  it("still reports the stored file while collection is paused", async () => {
    const bundle = await start();
    await bundle.invoke("pricing:overview");
    await bundle.invoke("pricing:configure", { keepHistory: false });
    const paused = (await bundle.invoke("pricing:overview")) as PricingOverviewView;
    // The bars are still on disk; hiding the stats would read as data loss.
    expect(paused.history).toMatchObject({ keys: 6, bars: 30 });
    expect(bundle.disk.files.size).toBe(1);
    await bundle.runtime.dispose();
  });

  it("never rejects when the trends service refuses", async () => {
    const bundle = await start();
    bundle.series.mockRejectedValueOnce(
      new Error("poe2scout lists 2 current softcore leagues — set the league explicitly"),
    );
    const view = (await bundle.invoke("pricing:overview")) as PricingOverviewView;
    expect(view.ok).toBe(false);
    expect(view.rows).toEqual([]);
    expect(view.source).toBe("none");
    expect(view.error).toContain("2 current softcore leagues");
    await bundle.runtime.dispose();
  });

  it("keeps working when the price table is unavailable", async () => {
    const bundle = await start({
      getPriceTable: () => {
        throw new Error("no database");
      },
    });
    const view = (await bundle.invoke("pricing:overview")) as PricingOverviewView;
    expect(view.rows).toHaveLength(6);
    expect(bundle.log).toHaveBeenCalledWith(
      expect.objectContaining({ feature: "pricing-history", level: "warn" }),
    );
    await bundle.runtime.dispose();
  });

  it("prefers the local timeline for one item and falls back to the feed bars", async () => {
    const bundle = await start();
    await bundle.invoke("pricing:overview");
    const stored = (await bundle.invoke("pricing:history", "divine")) as PricingHistoryView;
    expect(stored).toMatchObject({ key: "divine", name: "Divine Orb", source: "local-history", league: LEAGUE });
    expect(stored.points).toHaveLength(7);
    expect(stored.since).toBe(NOW.toISOString());

    await bundle.invoke("pricing:configure", { keepHistory: false });
    const fromFeed = (await bundle.invoke("pricing:history", "chaos")) as PricingHistoryView;
    expect(fromFeed.source).toBe("feed-cache");
    expect(await bundle.invoke("pricing:history", "  ")).toBeUndefined();
    expect(await bundle.invoke("pricing:history", "unknown-key")).toBeUndefined();
    await bundle.runtime.dispose();
  });

  it("persists favorites, refuses past the cap, and announces every settings change", async () => {
    const bundle = await start();
    const added = (await bundle.invoke("pricing:toggle-favorite", "divine")) as PricingSettings;
    expect(added.favorites).toEqual(["divine"]);
    expect(events(bundle, "pricing:settings").at(-1)).toMatchObject({ favorites: ["divine"] });
    expect(bundle.settings.snapshot()["pricing-history"]).toMatchObject({ favorites: ["divine"] });

    const removed = (await bundle.invoke("pricing:toggle-favorite", "divine")) as PricingSettings;
    expect(removed.favorites).toEqual([]);
    expect(await bundle.invoke("pricing:toggle-favorite", "   ")).toMatchObject({ favorites: [] });

    const many = Array.from({ length: 200 }, (_unused, index) => `key-${index}`);
    await bundle.invoke("pricing:configure", { favorites: many });
    const capped = (await bundle.invoke("pricing:toggle-favorite", "one-too-many")) as PricingSettings;
    expect(capped.favorites).toHaveLength(200);
    expect(capped.favorites).not.toContain("one-too-many");
    expect(bundle.log).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("capped at 200") }),
    );
    await bundle.runtime.dispose();
  });

  it("sanitizes a junk configure patch", async () => {
    const bundle = await start();
    const settings = (await bundle.invoke("pricing:configure", {
      displayCurrency: "dogecoin",
      sort: { key: "moon", direction: "sideways" },
      category: "Not A Category",
      nonsense: true,
    })) as PricingSettings;
    expect(settings).toEqual({
      favorites: [],
      displayCurrency: "auto",
      hideLowStock: true,
      sort: { key: "change3d", direction: "desc" },
      category: "all",
      keepHistory: true,
    });
    expect(await bundle.invoke("pricing:configure", "junk")).toMatchObject({ category: "all" });
    await bundle.runtime.dispose();
  });

  it("lists and clears the local history files", async () => {
    const bundle = await start();
    await bundle.invoke("pricing:overview");
    expect(await bundle.invoke("pricing:leagues")).toMatchObject([
      { league: LEAGUE, keys: 6, bars: 30 },
    ]);
    expect(await bundle.invoke("pricing:clear-history")).toBe(1);
    expect(bundle.disk.files.size).toBe(0);
    expect(await bundle.invoke("pricing:leagues")).toEqual([]);
    expect(events(bundle, "pricing:settings").at(-1)).toMatchObject({ keepHistory: true });
    await bundle.runtime.dispose();
  });

  it("contributes the Desktop hotkey, fronts the window and asks the renderer to navigate", async () => {
    const bundle = await start();
    expect(bundle.contributed).toHaveLength(1);
    const action = bundle.contributed[0]!;
    expect(action).toMatchObject({
      id: PRICING_OPEN_ACTION_ID,
      group: "Desktop",
      defaultAccelerator: null,
    });
    await action.run();
    expect(bundle.main.restore).toHaveBeenCalledTimes(1);
    expect(bundle.main.show).toHaveBeenCalledTimes(1);
    expect(bundle.main.focus).toHaveBeenCalledTimes(1);
    expect(events(bundle, "app:navigate")).toEqual([{ path: "/tools/pricing" }]);
    await bundle.runtime.dispose();
    expect(bundle.release).toHaveBeenCalledTimes(1);
  });

  it("registers without the hotkey service", async () => {
    const bundle = await start({ withHotkeys: false });
    expect(bundle.contributed).toEqual([]);
    const view = (await bundle.invoke("pricing:overview")) as PricingOverviewView;
    expect(view.rows).toHaveLength(7);
    await bundle.runtime.dispose();
  });

  it("sends no game input: nothing in the module touches the input host", () => {
    for (const file of ["index.ts", "historyStore.ts"]) {
      const source = readFileSync(
        new URL(`../src/main/features/pricingHistory/${file}`, import.meta.url),
        "utf8",
      );
      expect(source).not.toMatch(/startWinHost|host\.send|winHostInputSink|gameInputController/);
    }
  });
});
