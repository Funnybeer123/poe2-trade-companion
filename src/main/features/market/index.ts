/**
 * Feature module "market": the in-app trade browser.
 *
 * Registers the `market:*` channels, the `market` settings namespace and the
 * `market.open` hotkey (front the desktop window, then ask the renderer to
 * route — the scaffold's `app:navigate` event, one subscriber in App.vue).
 *
 * Market never opens an overlay panel: it is a desktop view. It never
 * touches game input except through `ctx.require("chatCommands")`, and
 * never touches the network except through `ctx.core.priceFeed`.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_MARKET_SETTINGS,
  normalizeMarketSettings,
  type MarketSettings,
} from "../../../core/marketSettings.js";
import type { MarketDraft } from "../../../core/marketQuery.js";
import type {
  MarketFavoriteSaveInput,
  MarketListingActionInput,
  MarketLiveStartInput,
  MarketOpenTabOptions,
} from "../../../shared/market.js";
import type { FeatureContext, FeatureModule } from "../types.js";
import { createMarketService, type MarketFeed, type MarketService } from "./service.js";
import type { MarketFs } from "./files.js";

declare module "../types.js" {
  interface FeatureServiceMap {
    market: MarketService;
  }
}

/** How often the "stop live searches after N hours" rule is re-checked. */
const LIVE_PRUNE_INTERVAL_MS = 5 * 60_000;

export interface MarketModuleDeps {
  /** Test seam: a memory filesystem instead of userData. */
  fs?: MarketFs;
  now?: () => Date;
  /** Test seam: skip the live-search prune timer. */
  timers?: boolean;
  /** Test seam: the curated data files, already parsed. */
  data?: { exchangeCurrencies?: unknown; weightTemplates?: unknown };
}

/**
 * The curated data ships next to the source (`src/data/market/`) and is
 * listed in electron-builder's `files:`, so it is read from `appPath` in a
 * packaged build and from the repo root in dev. A missing file is not an
 * error: the currency picker falls back to the trade2 ids we already know
 * and the templates list is simply empty.
 */
function readDataFile(ctx: FeatureContext, name: string): unknown {
  for (const root of [ctx.appPath, ctx.repoRoot]) {
    if (!root) continue;
    const file = path.join(root, "src", "data", "market", name);
    try {
      if (!existsSync(file)) continue;
      return JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      ctx.log({ feature: "market", level: "warn", message: `${name} could not be read`, detail: error });
      return undefined;
    }
  }
  return undefined;
}

export function createMarketModule(deps: MarketModuleDeps = {}): FeatureModule {
  return {
    id: "market",
    register(ctx) {
      const settings = ctx.settings.namespace<MarketSettings>(
        "market",
        (raw) => normalizeMarketSettings(raw).value,
      );
      const feed = ctx.core.priceFeed as unknown as MarketFeed;
      const liveSearch = ctx.require("liveSearch");
      const chat = ctx.require("chatCommands");
      const overlay = ctx.get("overlay");

      const data = deps.data ?? {
        exchangeCurrencies: readDataFile(ctx, "exchange-currencies.json"),
        weightTemplates: readDataFile(ctx, "weight-templates.json"),
      };

      const service = createMarketService({
        userDataDir: ctx.userDataDir,
        feed,
        liveSearch,
        chat,
        settings: () => settings.get(),
        priceTable: () => ctx.core.itemIntelligence.getPriceTable(),
        clipboard: ctx.clipboard,
        notify: (title, body) => ctx.notify(title, body),
        openExternal: (url) => ctx.openExternal(url),
        emit: (channel, payload) => ctx.emit(channel, payload),
        data,
        ...(deps.now ? { now: deps.now } : {}),
        ...(deps.fs ? { fs: deps.fs } : {}),
        dryRun: () => ctx.dryRun(),
        ...(overlay
          ? {
              overlayNotice: (title: string, body: string) => {
                try {
                  void overlay.show("notice", {
                    anchor: "top-right",
                    payload: { title, body, tone: "ok", ttlMs: 6000 },
                  });
                } catch {
                  // The overlay is optional; a live hit must never throw here.
                }
              },
            }
          : {}),
        log: (level, message, detail) => ctx.log({ feature: "market", level, message, detail }),
      });
      ctx.provide("market", service);

      // --- channels ---------------------------------------------------------
      ctx.handle("market:state", () => service.state());
      ctx.handle("market:tab", (tabId: string) => service.tab(String(tabId ?? "")));
      ctx.handle("market:open-tab", (draft: MarketDraft, opts?: MarketOpenTabOptions) =>
        service.openTab(draft, opts ?? {}),
      );
      ctx.handle("market:new-tab", (kind: "search" | "exchange") =>
        kind === "exchange" ? service.newExchangeTab() : service.newSearchTab(),
      );
      ctx.handle("market:close-tab", (tabId: string) => service.closeTab(String(tabId ?? "")));
      ctx.handle("market:select-tab", (tabId: string) => service.selectTab(String(tabId ?? "")));
      ctx.handle("market:update-draft", (tabId: string, draft: MarketDraft) =>
        service.updateDraft(String(tabId ?? ""), draft),
      );
      ctx.handle("market:rename-tab", (tabId: string, label: string, colour?: string) =>
        service.renameTab(String(tabId ?? ""), String(label ?? ""), typeof colour === "string" ? colour : undefined),
      );
      ctx.handle("market:search", (tabId: string) => service.search(String(tabId ?? "")));
      ctx.handle("market:load-more", (tabId: string) => service.loadMore(String(tabId ?? "")));
      ctx.handle("market:exchange", (tabId: string) => service.exchange(String(tabId ?? "")));
      ctx.handle("market:collapse-account", (tabId: string, account: string, collapsed: boolean) =>
        service.collapseAccount(String(tabId ?? ""), String(account ?? ""), collapsed !== false),
      );
      ctx.handle("market:favorites", () => service.favoritesFile());
      ctx.handle("market:favorite-save", (input: MarketFavoriteSaveInput) => service.favoriteSave(input ?? { tabId: "" }));
      ctx.handle("market:favorite-remove", (id: string) => service.favoriteRemove(String(id ?? "")));
      ctx.handle("market:favorite-move", (input: { id: string; folderId: string | null; index: number }) =>
        service.favoriteMove(input ?? { id: "", folderId: null, index: 0 }),
      );
      ctx.handle("market:favorite-open", (id: string, opts?: { temporary?: boolean }) =>
        service.favoriteOpen(String(id ?? ""), opts ?? {}),
      );
      ctx.handle("market:folder-save", (input: { id?: string; name: string; colour?: string; expanded?: boolean }) =>
        service.folderSave(input ?? { name: "Folder" }),
      );
      ctx.handle("market:folder-remove", (id: string) => service.folderRemove(String(id ?? "")));
      ctx.handle("market:folder-move", (input: { id: string; index: number }) =>
        service.folderMove(input ?? { id: "", index: 0 }),
      );
      ctx.handle("market:import", (text: string) => service.importText(String(text ?? "")));
      ctx.handle("market:import-open", (result: unknown, indexes: number[]) =>
        service.importOpen(result, Array.isArray(indexes) ? indexes : []),
      );
      ctx.handle("market:live-start", (input: MarketLiveStartInput) => service.liveStart(input ?? {}));
      ctx.handle("market:live-stop", (id: string) => service.liveStop(String(id ?? "")));
      ctx.handle("market:live-clear", (id?: string) => service.liveClear(typeof id === "string" && id ? id : undefined));
      ctx.handle("market:live-set", (id: string, patch: { sound?: boolean; notify?: boolean; label?: string }) =>
        service.liveSet(String(id ?? ""), patch ?? {}),
      );
      ctx.handle("market:live-seen", (id: string) => service.liveSeen(String(id ?? "")));
      ctx.handle("market:listing-action", (input: MarketListingActionInput) =>
        service.listingAction(input ?? { action: "copy-whisper", listingId: "" }),
      );
      ctx.handle("market:stats", () => service.statOptions());
      ctx.handle("market:currencies", () => service.currencyOptions());
      ctx.handle("market:weight-templates", () => service.weightTemplates());
      ctx.handle("market:settings", (patch?: Partial<MarketSettings>) => {
        if (patch && typeof patch === "object") settings.set(patch);
        return settings.get();
      });

      // --- hotkey -----------------------------------------------------------
      const hotkeys = ctx.get("hotkeys");
      const dropHotkey = hotkeys?.contribute({
        id: "market.open",
        label: "Market",
        detail: "Bring the app to the front on the Market browser.",
        group: "Desktop",
        defaultAccelerator: "Alt+M",
        run: () => {
          const win = ctx.mainWindow();
          if (win) {
            try {
              if (win.isMinimized()) win.restore();
              win.show();
              win.focus();
            } catch {
              // A window mid-teardown must not break the hotkey.
            }
          }
          ctx.emit("app:navigate", { path: "/market" });
        },
      });

      const stopSettings = settings.onChange(() => {
        service.pruneLiveSearches();
        ctx.emit("market:state", service.state());
      });

      let pruneTimer: ReturnType<typeof setInterval> | undefined;
      if (deps.timers !== false) {
        pruneTimer = setInterval(() => service.pruneLiveSearches(), LIVE_PRUNE_INTERVAL_MS);
        pruneTimer.unref?.();
      }

      service.resumeLiveSearches();

      return {
        dispose() {
          if (pruneTimer) clearInterval(pruneTimer);
          stopSettings();
          dropHotkey?.();
          service.dispose();
        },
      };
    },
  };
}

export const marketModule: FeatureModule = createMarketModule();
export { DEFAULT_MARKET_SETTINGS };
export type { MarketService } from "./service.js";
