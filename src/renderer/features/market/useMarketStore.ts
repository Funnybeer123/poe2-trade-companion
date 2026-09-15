/**
 * Module-level state for the Market view: the state summary main pushes,
 * the active tab's rows, the stat index, the currency list and the scroll
 * position per tab.
 *
 * It is module-level (not per-component) so switching routes and coming
 * back keeps the tabs, the rows and the scroll offset — the "result
 * retention" the site's own browser has. Nothing here fetches from the
 * network; every read is one `market:*` invoke.
 */
import { computed, ref, shallowRef } from "vue";
import {
  indexStatOptions,
  type MarketStatOption,
  type StatIndex,
} from "@core/marketStatSearch";
import { emptyPriceTable, type PriceTable } from "@core/priceTable";
import type {
  ExchangeCurrencyOption,
  MarketStateView,
  MarketTabView,
  WeightTemplateView,
} from "../../../shared/market.js";
import { getMarketApi, type MarketApi } from "./marketApi";
import { playLiveChime } from "./marketSound";

const state = ref<MarketStateView | null>(null);
const activeTab = shallowRef<MarketTabView | null>(null);
const statOptions = shallowRef<MarketStatOption[]>([]);
const statIndex = shallowRef<StatIndex | null>(null);
const currencies = shallowRef<ExchangeCurrencyOption[]>([]);
const templates = shallowRef<WeightTemplateView[]>([]);
const loading = ref(true);
const busy = ref(false);
const error = ref("");
const notice = ref("");
const scrollTops = new Map<string, number>();

let api: MarketApi | null | undefined;
let unsubscribers: Array<() => void> = [];
let initialized = false;

function marketApi(): MarketApi | null {
  if (api === undefined) api = getMarketApi();
  return api;
}

export function describeError(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

async function loadTab(tabId: string | undefined): Promise<void> {
  const client = marketApi();
  if (!client || !tabId) {
    activeTab.value = null;
    return;
  }
  try {
    activeTab.value = (await client.invoke("market:tab", tabId)) ?? null;
  } catch (reason) {
    error.value = describeError(reason, "That tab could not be read.");
  }
}

function applyState(next: MarketStateView): void {
  state.value = next;
  if (!next.activeTabId) activeTab.value = null;
  else if (activeTab.value?.id !== next.activeTabId) void loadTab(next.activeTabId);
}

/** One invoke, with the busy flag and the error line handled once. */
export async function run<T>(action: (client: MarketApi) => Promise<T>, fallback: string): Promise<T | undefined> {
  const client = marketApi();
  if (!client || busy.value) return undefined;
  busy.value = true;
  error.value = "";
  try {
    return await action(client);
  } catch (reason) {
    error.value = describeError(reason, fallback);
    return undefined;
  } finally {
    busy.value = false;
  }
}

/** Run and adopt the returned state view (most mutating channels answer one). */
export async function mutate(
  action: (client: MarketApi) => Promise<MarketStateView | undefined>,
  fallback: string,
): Promise<void> {
  const next = await run(action, fallback);
  if (next) applyState(next);
}

export async function refresh(): Promise<void> {
  const client = marketApi();
  if (!client) return;
  try {
    const next = await client.invoke("market:state");
    applyState(next);
    error.value = "";
  } catch (reason) {
    error.value = describeError(reason, "Market could not be loaded.");
  }
}

export async function loadStats(): Promise<void> {
  const client = marketApi();
  if (!client || statOptions.value.length > 0) return;
  try {
    const options = await client.invoke("market:stats");
    statOptions.value = options;
    statIndex.value = indexStatOptions(options);
  } catch (reason) {
    error.value = describeError(reason, "The trade2 stat catalogue could not be read.");
  }
}

export async function loadCurrencies(): Promise<void> {
  const client = marketApi();
  if (!client || currencies.value.length > 0) return;
  try {
    currencies.value = await client.invoke("market:currencies");
  } catch {
    currencies.value = [];
  }
}

export async function loadTemplates(): Promise<void> {
  const client = marketApi();
  if (!client || templates.value.length > 0) return;
  try {
    templates.value = await client.invoke("market:weight-templates");
  } catch {
    templates.value = [];
  }
}

export async function initializeMarket(): Promise<void> {
  const client = marketApi();
  if (!client) {
    loading.value = false;
    return;
  }
  if (!initialized) {
    initialized = true;
    unsubscribers.push(
      client.on("market:state", (next) => applyState(next)),
      client.on("market:tab", (tab) => {
        if (!state.value || tab.id === state.value.activeTabId) activeTab.value = tab;
      }),
      client.on("market:live-listing", (event) => {
        if (event.sound) playLiveChime();
      }),
    );
  }
  loading.value = true;
  await refresh();
  await Promise.all([loadCurrencies(), loadTemplates()]);
  loading.value = false;
  void loadStats();
}

export function disposeMarketStore(): void {
  for (const stop of unsubscribers) stop();
  unsubscribers = [];
  initialized = false;
}

export function rememberScroll(tabId: string, top: number): void {
  scrollTops.set(tabId, top);
}

export function scrollFor(tabId: string): number {
  return scrollTops.get(tabId) ?? 0;
}

/**
 * A minimal price table rebuilt from the rates main sent, so the row
 * helpers (`describeListing`, `splitFractionalPrice`) do the same maths
 * here as they do in main instead of falling back to the crafting defaults.
 */
export const priceTable = computed<PriceTable>(() => {
  const table = emptyPriceTable();
  for (const rate of state.value?.currencyRates ?? []) {
    if (!rate.fromTable) continue;
    table.entries.push({ id: `market-${rate.id}`, match: { name: rate.name }, value: rate.exalted });
  }
  return table;
});

/** The rate one currency is worth, and whether it came from the feed. */
export function rateFor(currency: string): { exalted: number; fromTable: boolean } | undefined {
  const id = currency.trim().toLowerCase();
  const hit = state.value?.currencyRates.find((rate) => rate.id === id);
  return hit ? { exalted: hit.exalted, fromTable: hit.fromTable } : undefined;
}

export function useMarketStore() {
  return {
    api: marketApi(),
    priceTable,
    state,
    activeTab,
    statOptions,
    statIndex,
    currencies,
    templates,
    loading,
    busy,
    error,
    notice,
    activeSummary: computed(() =>
      state.value?.tabs.find((tab) => tab.id === state.value?.activeTabId),
    ),
    refresh,
    run,
    mutate,
    loadTab,
    loadStats,
    rememberScroll,
    scrollFor,
  };
}
