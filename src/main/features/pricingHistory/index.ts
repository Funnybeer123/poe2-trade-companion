/**
 * Feature module "pricing-history" — Tools → Pricing.
 *
 * Reads the Market trends service's poe2scout cache (`marketTrends.series()`:
 * the same requests `getTrends()` would make, plus the daily bars), merges
 * those bars into one file per league so the timeline outgrows the ~7 days
 * poe2scout serves, and answers the `pricing:*` channels the desktop tool
 * uses. It sends NO game input, makes no trade2 request, and stores no
 * secrets; the hotkey only fronts our own window.
 */
import path from "node:path";
import {
  buildPricingRows,
  MAX_FAVORITES,
  type PricingRow,
} from "../../../core/pricingHistory.js";
import type { TrendPoint } from "../../../core/priceTrends.js";
import type { PriceTable } from "../../../core/priceTable.js";
import {
  normalizePricingSettings,
  type PricingHistoryView,
  type PricingLeagueFile,
  type PricingOverviewView,
  type PricingQuery,
  type PricingSettings,
} from "../../../shared/pricingHistory.js";
import type { FeatureContext, FeatureModule } from "../types.js";
import { PricingHistoryStore, type PricingHistoryFs } from "./historyStore.js";

export const PRICING_SETTINGS_NAMESPACE = "pricing-history";
export const PRICING_HISTORY_DIR = "pricing-history";
export const PRICING_OPEN_ACTION_ID = "pricing.open";
export const PRICING_ROUTE = "/tools/pricing";

export interface PricingHistoryModuleDeps {
  fs?: PricingHistoryFs;
  now?: () => Date;
}

function describe(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function coerceQuery(raw: unknown): PricingQuery {
  const source = (typeof raw === "object" && raw !== null ? raw : {}) as PricingQuery;
  const cachedOnly = source.cachedOnly === true;
  // cachedOnly wins: "never fetch" must never be overridden by a stray refresh.
  return cachedOnly ? { cachedOnly: true } : { refresh: source.refresh === true };
}

export function createPricingHistoryModule(deps: PricingHistoryModuleDeps = {}): FeatureModule {
  return {
    id: "pricing-history",
    register(ctx: FeatureContext) {
      const namespace = ctx.settings.namespace(PRICING_SETTINGS_NAMESPACE, normalizePricingSettings);
      const now = deps.now ?? (() => new Date());
      const store = new PricingHistoryStore({
        dir: path.join(ctx.userDataDir, PRICING_HISTORY_DIR),
        ...(deps.fs ? { fs: deps.fs } : {}),
        now,
      });

      const emitSettings = (value: PricingSettings): PricingSettings => {
        ctx.emit("pricing:settings", value);
        return value;
      };

      const priceTable = (): PriceTable | undefined => {
        try {
          return ctx.core.itemIntelligence.getPriceTable();
        } catch (error) {
          ctx.log({
            feature: "pricing-history",
            level: "warn",
            message: "price table unavailable; feed-only rows are omitted",
            detail: describe(error),
          });
          return undefined;
        }
      };

      async function overview(rawQuery?: unknown): Promise<PricingOverviewView> {
        const settings = namespace.get();
        const query = coerceQuery(rawQuery);
        const generatedAt = now().toISOString();
        let result: Awaited<ReturnType<typeof ctx.core.marketTrends.series>>;
        try {
          result = await ctx.core.marketTrends.series(query);
        } catch (error) {
          // A refusal (ambiguous league, HTTP) is a state, not a rejection.
          return {
            ok: false,
            stale: true,
            refreshing: false,
            source: "none",
            error: describe(error),
            divineRate: 0,
            divineRateSource: "fallback",
            categories: [],
            rows: [],
            settings,
            generatedAt,
          };
        }

        const league = result.league ?? "";
        const series = result.series ?? [];
        if (settings.keepHistory && league && series.length > 0 && result.fetchedAt) {
          const merged = store.merge(league, series, result.fetchedAt);
          if (merged.addedBars > 0 && result.source === "network") {
            ctx.emit("pricing:refreshed", {
              league,
              fetchedAt: result.fetchedAt,
              addedBars: merged.addedBars,
            });
          }
        }

        const table = priceTable();
        const built = buildPricingRows({
          series,
          ...(table ? { priceTable: table } : {}),
          favorites: settings.favorites,
          now: generatedAt,
        });
        // Report the file even while collection is paused: the bars are still
        // on disk, and hiding the stats reads as data loss.
        const stats = league ? store.stats(league) : undefined;

        return {
          ok: result.ok,
          ...(result.league ? { league: result.league } : {}),
          ...(result.fetchedAt ? { fetchedAt: result.fetchedAt } : {}),
          stale: result.stale,
          refreshing: result.refreshing,
          source: result.source,
          ...(result.error ? { error: result.error } : {}),
          divineRate: built.divineRate,
          divineRateSource: built.divineRateSource,
          categories: built.categories,
          rows: built.rows,
          ...(stats ? { history: stats } : {}),
          ...(store.lastError ? { historyError: store.lastError } : {}),
          settings,
          generatedAt,
        };
      }

      async function history(rawKey: unknown): Promise<PricingHistoryView | undefined> {
        const key = String(rawKey ?? "").trim();
        if (!key) return undefined;
        const settings = namespace.get();
        let result: Awaited<ReturnType<typeof ctx.core.marketTrends.series>>;
        try {
          result = await ctx.core.marketTrends.series({ cachedOnly: true });
        } catch {
          return undefined;
        }
        const league = result.league ?? "";
        if (settings.keepHistory && league) {
          const stored = store.read(league, key);
          if (stored && stored.points.length > 0) {
            return {
              key,
              name: stored.name,
              league,
              points: stored.points as TrendPoint[],
              source: "local-history",
              since: store.load(league).since,
            };
          }
        }
        const entry = result.series.find((candidate) => candidate.key === key);
        if (!entry) return undefined;
        return { key, name: entry.name, league, points: entry.points, source: "feed-cache" };
      }

      function toggleFavorite(rawKey: unknown): PricingSettings {
        const key = String(rawKey ?? "").trim().slice(0, 120);
        const settings = namespace.get();
        if (!key) return settings;
        if (settings.favorites.includes(key)) {
          return emitSettings(
            namespace.set({ favorites: settings.favorites.filter((entry) => entry !== key) }),
          );
        }
        if (settings.favorites.length >= MAX_FAVORITES) {
          ctx.log({
            feature: "pricing-history",
            level: "warn",
            message: `favorites are capped at ${MAX_FAVORITES}; "${key}" was not added`,
          });
          return settings;
        }
        return emitSettings(namespace.set({ favorites: [...settings.favorites, key] }));
      }

      function configure(rawPatch: unknown): PricingSettings {
        const patch =
          typeof rawPatch === "object" && rawPatch !== null && !Array.isArray(rawPatch)
            ? (rawPatch as Partial<PricingSettings>)
            : {};
        return emitSettings(namespace.set(patch));
      }

      function leagues(): PricingLeagueFile[] {
        return store.leagues();
      }

      function clearHistory(rawLeague?: unknown): number {
        const league = typeof rawLeague === "string" && rawLeague.trim() ? rawLeague.trim() : undefined;
        const removed = store.clear(league);
        emitSettings(namespace.get());
        return removed;
      }

      ctx.handle("pricing:overview", (query?: unknown) => overview(query));
      ctx.handle("pricing:history", (key: unknown) => history(key));
      ctx.handle("pricing:toggle-favorite", (key: unknown) => toggleFavorite(key));
      ctx.handle("pricing:configure", (patch: unknown) => configure(patch));
      ctx.handle("pricing:leagues", () => leagues());
      ctx.handle("pricing:clear-history", (league?: unknown) => clearHistory(league));

      // The tool must still work when the hotkey service failed to register.
      const hotkeys = ctx.get("hotkeys");
      const releaseHotkey = hotkeys?.contribute({
        id: PRICING_OPEN_ACTION_ID,
        label: "Open Pricing history",
        detail: "Brings the desktop window to front on Tools → Pricing.",
        group: "Desktop",
        defaultAccelerator: null,
        run: () => {
          const window = ctx.mainWindow();
          if (window) {
            try {
              if (window.isMinimized()) window.restore();
              window.show();
              window.focus();
            } catch (error) {
              ctx.log({
                feature: "pricing-history",
                level: "warn",
                message: "could not front the main window",
                detail: describe(error),
              });
            }
          }
          ctx.emit("app:navigate", { path: PRICING_ROUTE });
        },
      });

      return {
        dispose: () => {
          releaseHotkey?.();
        },
      };
    },
  };
}

export const pricingHistoryModule: FeatureModule = createPricingHistoryModule();

export type { PricingRow };
