import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createFeatureRuntime, type IpcMainLike } from "../src/main/features/context.js";
import type { FeatureModule } from "../src/main/features/types.js";
import { SettingsStore } from "../src/main/settingsStore.js";
import { emptyPriceTable } from "../src/core/priceTable.js";
import { DEFAULT_MARKET_SETTINGS } from "../src/core/marketSettings.js";
import { parseTradeListings } from "../src/core/tradeListings.js";
import type { HotkeyAction } from "../src/main/hotkeyService.js";
import type { ChatCommandRequest } from "../src/shared/chatCommands.js";
import type { MarketStateView } from "../src/shared/market.js";
import { memoryMarketFs } from "../src/main/features/market/files.js";
import { createMarketModule } from "../src/main/features/market/index.js";

const LEAGUE = "Runes of Aldur";
const ROWS = parseTradeListings(
  JSON.parse(readFileSync(path.join(process.cwd(), "fixtures", "market", "fetch-ruby-ring.json"), "utf8")),
  LEAGUE,
);

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

function fakeWindow() {
  const sent: Array<[string, unknown]> = [];
  return {
    sent,
    isDestroyed: () => false,
    isMinimized: vi.fn(() => true),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    once: vi.fn(),
    webContents: {
      send: (channel: string, payload: unknown) => {
        sent.push([channel, payload]);
      },
    },
  };
}

function harness() {
  const { ipc, invoke, handlers } = fakeIpc();
  const settingsFiles = new Map<string, string>();
  const settings = new SettingsStore({
    file: "settings.json",
    fs: { read: (file) => settingsFiles.get(file), write: (file, text) => settingsFiles.set(file, text) },
  });
  const win = fakeWindow();
  const chatSends: ChatCommandRequest[] = [];
  const contributed: HotkeyAction[] = [];
  const liveStops: string[] = [];
  const marketFs = memoryMarketFs();

  const feed = {
    tradeSearch: vi.fn(async () => ({
      id: "SID",
      total: 10,
      resultIds: ROWS.map((row) => row.id),
      league: LEAGUE,
      url: "https://trade",
      cached: false,
    })),
    tradeFetch: vi.fn(async (ids: string[]) => ROWS.slice(0, ids.length)),
    tradeExchange: vi.fn(),
    tradeBudget: () => ({ lookups: 9, searchesSpare: 9, fetchesSpare: 9 }),
    hasSession: () => true,
    status: () => ({ resolvedLeague: LEAGUE, leagueAmbiguous: false, feedAgeHours: 1 }),
    statsPayloadCached: () => ({ result: [] }),
    fetchStats: vi.fn(async () => ({ result: [] })),
  };

  const fakes: FeatureModule[] = [
    {
      id: "liveSearch",
      register(ctx) {
        ctx.provide("liveSearch", {
          start: (input: { searchId: string; league: string; label: string }) => ({
            id: `h-${input.searchId}`,
            ...input,
            state: "open",
            resultsSeen: 0,
          }),
          stop: (id: string) => {
            liveStops.push(id);
          },
          list: () => [],
          capacity: () => ({ open: 0, max: 20 }),
        } as never);
      },
    },
    {
      id: "chatCommands",
      register(ctx) {
        ctx.provide("chatCommands", {
          send: async (request: ChatCommandRequest) => {
            chatSends.push(request);
            return { ok: true, dryRun: false, sent: request.text, at: "now" };
          },
          stashSearch: async () => ({ ok: true, dryRun: false, at: "now" }),
          copyHoveredItem: async () => ({ ok: true, dryRun: false, at: "now" }),
          status: () => ({ enabled: true, hostRunning: false, sentThisMinute: 0, maxPerMinute: 30, dryRun: false }),
          resolvePlaceholders: (template: string) => template,
        } as never);
      },
    },
    {
      id: "hotkeys",
      register(ctx) {
        ctx.provide("hotkeys", {
          contribute: (action: HotkeyAction) => {
            contributed.push(action);
            return () => {
              const at = contributed.indexOf(action);
              if (at >= 0) contributed.splice(at, 1);
            };
          },
          list: () => [],
          rebind: () => [],
          validate: () => ({ ok: true }),
          trigger: async () => true,
        } as never);
      },
    },
  ];

  const runtime = createFeatureRuntime({
    ipcMain: ipc,
    configDir: "C:/cfg",
    userDataDir: "C:/user",
    repoRoot: process.cwd(),
    appPath: process.cwd(),
    buildMode: "authorized-qa",
    core: {
      priceFeed: feed as never,
      itemIntelligence: { getPriceTable: () => emptyPriceTable() } as never,
      marketTrends: {} as never,
      watchlist: {} as never,
    },
    settings,
    mainWindow: () => win as never,
    poeWindows: async () => [],
    killSwitchLatched: () => false,
    notify: vi.fn(),
    clipboard: { readText: () => "", writeText: vi.fn() },
    openExternal: vi.fn(async () => undefined),
    openPath: vi.fn(async () => ""),
    log: vi.fn(),
  });

  return {
    runtime,
    invoke,
    handlers,
    win,
    chatSends,
    contributed,
    liveStops,
    settings,
    feed,
    modules: [...fakes, createMarketModule({ fs: marketFs, timers: false, now: () => new Date("2026-09-10T12:00:00Z") })],
  };
}

describe("market feature module", () => {
  it("registers every market channel", async () => {
    const h = harness();
    const result = await h.runtime.register(h.modules);
    expect(result.failed).toEqual([]);
    const channels = h.runtime.ctx.channels().filter((channel) => channel.startsWith("market:"));
    expect(channels).toEqual(
      [
        "market:close-tab",
        "market:collapse-account",
        "market:currencies",
        "market:exchange",
        "market:favorite-move",
        "market:favorite-open",
        "market:favorite-remove",
        "market:favorite-save",
        "market:favorites",
        "market:folder-move",
        "market:folder-remove",
        "market:folder-save",
        "market:import",
        "market:import-open",
        "market:listing-action",
        "market:live-clear",
        "market:live-seen",
        "market:live-set",
        "market:live-start",
        "market:live-stop",
        "market:load-more",
        "market:new-tab",
        "market:open-tab",
        "market:rename-tab",
        "market:search",
        "market:select-tab",
        "market:settings",
        "market:state",
        "market:stats",
        "market:tab",
        "market:update-draft",
        "market:weight-templates",
      ].sort(),
    );
    await h.runtime.dispose();
  });

  it("never registers the Market-trends channels main already owns", async () => {
    const h = harness();
    await h.runtime.register(h.modules);
    const channels = h.runtime.ctx.channels();
    expect(channels).not.toContain("market:trends");
    expect(channels).not.toContain("market:trends-refresh");
    await h.runtime.dispose();
  });

  it("publishes the market settings namespace with its defaults", async () => {
    const h = harness();
    await h.runtime.register(h.modules);
    const snapshot = (await h.invoke("settings:get")) as Record<string, unknown>;
    expect(snapshot.market).toEqual(DEFAULT_MARKET_SETTINGS);
    await h.invoke("settings:set", "market", { staleAfterHours: 48 });
    const state = (await h.invoke("market:state")) as MarketStateView;
    expect(state.settings.staleAfterHours).toBe(48);
    await h.runtime.dispose();
  });

  it("contributes market.open on Alt+M in the Desktop group", async () => {
    const h = harness();
    await h.runtime.register(h.modules);
    const action = h.contributed.find((entry) => entry.id === "market.open");
    expect(action).toMatchObject({ defaultAccelerator: "Alt+M", group: "Desktop", label: "Market" });
    await h.runtime.dispose();
  });

  it("fronts the window and asks the renderer to route on the hotkey", async () => {
    const h = harness();
    await h.runtime.register(h.modules);
    h.win.sent.length = 0;
    await h.contributed.find((entry) => entry.id === "market.open")!.run();
    expect(h.win.restore).toHaveBeenCalled();
    expect(h.win.show).toHaveBeenCalled();
    expect(h.win.sent.some(([channel, payload]) => channel === "app:navigate" && (payload as { path: string }).path === "/market")).toBe(
      true,
    );
    await h.runtime.dispose();
  });

  it("runs a whole search over the bridge", async () => {
    const h = harness();
    await h.runtime.register(h.modules);
    const opened = (await h.invoke("market:open-tab", { kind: "search", query: { stats: [], type: "Ruby Ring" } })) as MarketStateView;
    const tabId = opened.activeTabId!;
    await h.invoke("market:search", tabId);
    expect(h.feed.tradeSearch).toHaveBeenCalledTimes(1);
    expect(h.feed.tradeFetch).toHaveBeenCalledTimes(1);
    const outcome = (await h.invoke("market:listing-action", {
      action: "send-whisper",
      tabId,
      listingId: "ring-1",
    })) as { ok: boolean };
    expect(outcome.ok).toBe(true);
    expect(h.chatSends[0]).toMatchObject({ source: "market", focus: true });
    await h.runtime.dispose();
  });

  it("removes its handlers and un-contributes the hotkey on dispose", async () => {
    const h = harness();
    await h.runtime.register(h.modules);
    await h.runtime.dispose();
    expect(h.contributed.find((entry) => entry.id === "market.open")).toBeUndefined();
    expect([...h.handlers.keys()].some((channel) => channel.startsWith("market:"))).toBe(false);
  });

  it("registers even when the overlay service is absent", async () => {
    const h = harness();
    const result = await h.runtime.register(h.modules);
    expect(result.registered).toContain("market");
    await h.runtime.dispose();
  });
});
