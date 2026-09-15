import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createFeatureRuntime, type IpcMainLike } from "../src/main/features/context.js";
import { createEvaluateModule } from "../src/main/features/evaluate/index.js";
import type { CoreServices, FeatureModule } from "../src/main/features/types.js";
import { SettingsStore } from "../src/main/settingsStore.js";
import { MOD_FAMILIES } from "../src/core/modKnowledge.js";
import { PRICE_TABLE_SCHEMA_VERSION, type PriceTable } from "../src/core/priceTable.js";
import { buildStatCatalogue } from "../src/core/statIds.js";
import { emptyLearnedTiers } from "../src/core/tierLearning.js";
import type { HotkeyAction } from "../src/main/hotkeyService.js";
import type { OverlayPanelEvent, OverlayShowOptions } from "../src/shared/overlay.js";
import type { EvaluateSession } from "../src/shared/evaluate.js";

const STATS = JSON.parse(
  readFileSync(new URL("../fixtures/trade/stats-subset.json", import.meta.url), "utf8"),
) as unknown;

function fixture(name: string): string {
  return readFileSync(new URL(`../fixtures/evaluate/${name}`, import.meta.url), "utf8");
}

const TABLE: PriceTable = { schemaVersion: PRICE_TABLE_SCHEMA_VERSION, currency: "exalted", entries: [] };

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

function harness(captureText = fixture("rare-ring-resists.txt")) {
  const { ipc, invoke, handlers } = fakeIpc();
  const files = new Map<string, string>();
  const settings = new SettingsStore({
    file: "settings.json",
    fs: { read: (file) => files.get(file), write: (file, text) => void files.set(file, text) },
  });

  const shown: Array<{ panelId: string; options?: OverlayShowOptions }> = [];
  const hidden: string[] = [];
  let panelListener: ((event: OverlayPanelEvent) => void) | undefined;
  const overlay = {
    show: vi.fn(async (panelId: string, options?: OverlayShowOptions) => {
      shown.push({ panelId, ...(options ? { options } : {}) });
    }),
    update: vi.fn(),
    hide: vi.fn((panelId: string) => void hidden.push(panelId)),
    hideAll: vi.fn(),
    toggle: vi.fn(),
    isVisible: () => shown.some((entry) => entry.panelId === "evaluate"),
    setFocus: vi.fn(),
    state: vi.fn(),
    onPanelEvent: (callback: (event: OverlayPanelEvent) => void) => {
      panelListener = callback;
      return () => {
        panelListener = undefined;
      };
    },
    onStateChange: () => () => undefined,
  };

  const actions = new Map<string, HotkeyAction>();
  const uncontributed: string[] = [];
  const hotkeys = {
    contribute: (action: HotkeyAction) => {
      actions.set(action.id, action);
      return () => {
        uncontributed.push(action.id);
        actions.delete(action.id);
      };
    },
    list: () => [],
    rebind: () => [],
    validate: () => ({ ok: true }),
    trigger: async () => true,
  };

  const copyHoveredItem = vi.fn(async () => ({
    ok: true,
    dryRun: false,
    at: "2026-09-07T12:00:00Z",
    text: captureText,
  }));
  const chatCommands = {
    send: vi.fn(),
    stashSearch: vi.fn(),
    copyHoveredItem,
    status: vi.fn(),
    resolvePlaceholders: vi.fn(),
  };

  const core = {
    priceFeed: {
      tradeSearch: vi.fn(async () => ({
        id: "search-1",
        total: 1,
        resultIds: ["id-0"],
        league: "Runes of Aldur",
        url: "https://www.pathofexile.com/trade2/search/poe2/Runes%20of%20Aldur/search-1",
        cached: false,
      })),
      tradeFetch: vi.fn(async () => []),
      tradeExchange: vi.fn(),
      tradeBudget: () => ({ lookups: 4, searchesSpare: 4, fetchesSpare: 4 }),
      hasSession: () => false,
      statCatalogue: async () => buildStatCatalogue(STATS, MOD_FAMILIES, ["explicit", "pseudo"]),
      learnedTiers: () => emptyLearnedTiers(),
      status: () => ({ resolvedLeague: "Runes of Aldur", leagueAmbiguous: false }),
    },
    itemIntelligence: {
      getPriceTable: () => TABLE,
      evaluateTier: () => ({ tier: "sell", source: "appraisal", reasons: [], matchedRules: [] }),
    },
    marketTrends: {
      series: async () => ({
        ok: true,
        stale: false,
        refreshing: false,
        source: "cache",
        categories: [],
        trends: [],
        series: [],
      }),
    },
    watchlist: { overview: () => ({ watches: [] }), save: vi.fn() },
  } as unknown as CoreServices;

  const clipboard = { readText: vi.fn(() => ""), writeText: vi.fn() };
  const events: Array<[string, unknown]> = [];
  const window = {
    isDestroyed: () => false,
    once: vi.fn(),
    webContents: { send: (channel: string, payload: unknown) => void events.push([channel, payload]) },
  };

  const runtime = createFeatureRuntime({
    ipcMain: ipc,
    configDir: "C:/cfg",
    userDataDir: "C:/user",
    repoRoot: "C:/repo",
    buildMode: "authorized-qa",
    core,
    settings,
    mainWindow: () => window as never,
    poeWindows: async () => [],
    killSwitchLatched: () => false,
    notify: vi.fn(),
    clipboard,
    openExternal: vi.fn(async () => undefined),
    openPath: vi.fn(async () => ""),
    log: vi.fn(),
  });

  const services: FeatureModule = {
    id: "fake-foundation",
    register(ctx) {
      ctx.provide("overlay", overlay as never);
      ctx.provide("hotkeys", hotkeys as never);
      ctx.provide("chatCommands", chatCommands as never);
    },
  };

  return {
    runtime,
    services,
    invoke,
    handlers,
    shown,
    hidden,
    actions,
    uncontributed,
    copyHoveredItem,
    clipboard,
    core,
    events,
    panelEvent: (event: OverlayPanelEvent) => panelListener?.(event),
    settings,
  };
}

async function registered(rig: ReturnType<typeof harness>) {
  const outcome = await rig.runtime.register([rig.services, createEvaluateModule()]);
  expect(outcome.failed).toEqual([]);
  return outcome;
}

describe("evaluate feature module", () => {
  it("registers exactly its eleven channels", async () => {
    const rig = harness();
    await registered(rig);
    const channels = [...rig.handlers.keys()].filter((channel) => channel.startsWith("evaluate:")).sort();
    expect(channels).toEqual([
      "evaluate:budget",
      "evaluate:close",
      "evaluate:copy",
      "evaluate:current",
      "evaluate:exchange",
      "evaluate:more",
      "evaluate:open",
      "evaluate:open-site",
      "evaluate:search",
      "evaluate:set-profile",
      "evaluate:watch",
    ]);
  });

  it("contributes both hotkey actions in the Overlay group", async () => {
    const rig = harness();
    await registered(rig);
    expect(rig.actions.get("evaluate")).toMatchObject({
      group: "Overlay",
      defaultAccelerator: "Alt+E",
    });
    expect(rig.actions.get("evaluate.clipboard")).toMatchObject({
      group: "Overlay",
      defaultAccelerator: null,
    });
  });

  it("the hotkey captures one item and shows the panel at the cursor with focus", async () => {
    const rig = harness();
    await registered(rig);
    await rig.actions.get("evaluate")!.run();
    expect(rig.copyHoveredItem).toHaveBeenCalledWith({
      reason: "evaluate hovered item",
      source: "evaluate",
    });
    const panel = rig.shown.find((entry) => entry.panelId === "evaluate");
    expect(panel?.options).toMatchObject({ anchor: "cursor", focus: true, width: 620, height: 560 });
    expect((panel?.options?.payload as { sessionId: string }).sessionId).toMatch(/^ev_/);
    expect(rig.events.some(([channel]) => channel === "evaluate:session")).toBe(true);
  });

  it("shows the panel BEFORE the auto-search answers", async () => {
    const rig = harness();
    const feed = rig.core.priceFeed as unknown as { tradeSearch: ReturnType<typeof vi.fn> };
    let release = (): void => undefined;
    feed.tradeSearch.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        id: "search-1",
        total: 1,
        resultIds: ["id-0"],
        league: "Runes of Aldur",
        url: "https://www.pathofexile.com/trade2/search/poe2/Runes%20of%20Aldur/search-1",
        cached: false,
      };
    });
    await registered(rig);
    await rig.actions.get("evaluate")!.run();
    // The search has not returned yet, and the panel is already up.
    expect(feed.tradeSearch).toHaveBeenCalledTimes(1);
    expect(rig.shown.map((entry) => entry.panelId)).toEqual(["evaluate"]);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("the clipboard hotkey reads the clipboard and never auto-searches", async () => {
    const rig = harness();
    rig.clipboard.readText.mockReturnValue(fixture("rare-ring-resists.txt"));
    await registered(rig);
    await rig.actions.get("evaluate.clipboard")!.run();
    expect(rig.copyHoveredItem).not.toHaveBeenCalled();
    expect(rig.clipboard.readText).toHaveBeenCalled();
    const search = (rig.core.priceFeed as unknown as { tradeSearch: ReturnType<typeof vi.fn> }).tradeSearch;
    expect(search).not.toHaveBeenCalled();
  });

  it("shows a notice instead of the panel when the capture was blocked", async () => {
    const rig = harness();
    rig.copyHoveredItem.mockResolvedValueOnce({
      ok: false,
      dryRun: false,
      at: "2026-09-07T12:00:00Z",
      blockedBy: "another-host",
    } as unknown as Awaited<ReturnType<typeof rig.copyHoveredItem>>);
    await registered(rig);
    await rig.actions.get("evaluate")!.run();
    expect(rig.shown.map((entry) => entry.panelId)).toEqual(["notice"]);
    expect((rig.shown[0]!.options?.payload as { body: string }).body).toContain("input host");
  });

  it("opens from a channel and keeps the session when the panel is closed by the user", async () => {
    const rig = harness();
    await registered(rig);
    const session = (await rig.invoke("evaluate:open", {
      text: fixture("rare-ring-resists.txt"),
      source: "item-log",
      autoSearch: false,
      showOverlay: false,
    })) as EvaluateSession;
    expect(session.id).toMatch(/^ev_/);
    expect(rig.shown).toEqual([]);
    rig.panelEvent({ panelId: "evaluate", kind: "closed-by-user" });
    expect(await rig.invoke("evaluate:current")).toMatchObject({ id: session.id });
    await rig.invoke("evaluate:close", session.id);
    expect(rig.hidden).toContain("evaluate");
  });

  it("coerces the arguments it is handed", async () => {
    const rig = harness();
    await registered(rig);
    const open = (await rig.invoke("evaluate:open", { source: "nope", text: 42 })) as { reason: string };
    expect(open.reason).toBe("empty");
    await expect(rig.invoke("evaluate:copy", "missing", { kind: "rm -rf" })).rejects.toThrow(
      /unknown evaluate session/,
    );
    expect(await rig.invoke("evaluate:budget")).toMatchObject({ lookups: 4, leagueAmbiguous: false });
  });

  it("registers the settings namespace with its defaults", async () => {
    const rig = harness();
    await registered(rig);
    expect(rig.settings.snapshot().evaluate).toMatchObject({ defaultProfile: "quick-price", pageSize: 10 });
  });

  it("un-contributes both hotkeys on dispose", async () => {
    const rig = harness();
    await registered(rig);
    await rig.runtime.dispose();
    expect(rig.uncontributed.sort()).toEqual(["evaluate", "evaluate.clipboard"]);
  });
});
