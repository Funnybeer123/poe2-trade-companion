// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computed, ref } from "vue";
import { DEFAULT_MARKET_SETTINGS } from "../../src/core/marketSettings.js";
import type { MarketStateView, MarketTabView } from "../../src/shared/market.js";

const bridge = vi.hoisted(() => ({
  available: true,
  calls: [] as Array<[string, unknown[]]>,
  listeners: new Map<string, (payload: unknown) => void>(),
  state: null as MarketStateView | null,
  tab: null as MarketTabView | null,
  action: null as unknown,
  dryRun: { value: false },
}));

vi.mock("../../src/renderer/services/featureApi", () => ({
  createFeatureApi: () =>
    bridge.available
      ? {
          invoke: vi.fn(async (channel: string, ...args: unknown[]) => {
            bridge.calls.push([channel, args]);
            if (channel === "market:state") return bridge.state;
            if (channel === "market:tab") return bridge.tab;
            if (channel === "market:stats") return [];
            if (channel === "market:currencies") return [];
            if (channel === "market:weight-templates") return [];
            if (channel === "market:listing-action") return bridge.action;
            if (channel === "market:update-draft") return bridge.tab;
            return bridge.state;
          }),
          on: (channel: string, callback: (payload: unknown) => void) => {
            bridge.listeners.set(channel, callback);
            return () => bridge.listeners.delete(channel);
          },
        }
      : null,
}));

vi.mock("../../src/renderer/services/rendererApi", () => ({
  getPriceFeedApi: () => undefined,
}));

vi.mock("../../src/renderer/composables/useGameActions", () => ({
  // A computed so the view's template unwraps it exactly as it does the
  // real top-bar Dry-run switch.
  useGameActions: () => ({ dryRun: computed(() => bridge.dryRun.value) }),
}));

vi.mock("../../src/renderer/composables/useIntelligenceStore", () => ({
  useIntelligenceStore: () => ({ currentItem: ref(null) }),
}));

function stateView(overrides: Partial<MarketStateView> = {}): MarketStateView {
  return {
    tabs: [],
    favorites: { schemaVersion: 1, folders: [], favorites: [] },
    live: [],
    liveCapacity: { open: 0, max: 20 },
    budget: { lookups: 9, searchesSpare: 9, fetchesSpare: 9 },
    league: "Runes of Aldur",
    leagueAmbiguous: false,
    hasSession: true,
    statsReady: true,
    settings: { ...DEFAULT_MARKET_SETTINGS },
    currencyRates: [{ id: "divine", name: "Divine Orb", exalted: 404.62, fromTable: true }],
    feedAgeHours: 2,
    fileIssues: [],
    ...overrides,
  };
}

function tabView(overrides: Partial<MarketTabView> = {}): MarketTabView {
  return {
    id: "tab-1",
    kind: "search",
    label: "Ruby Ring",
    colour: "gold",
    temporary: false,
    dirty: false,
    draft: { kind: "search", query: { stats: [], type: "Ruby Ring" } },
    state: "idle",
    createdAt: "2026-09-10T12:00:00.000Z",
    lastUsedAt: "2026-09-10T12:00:00.000Z",
    ...overrides,
  };
}

const LISTING = {
  id: "ring-1",
  league: "Runes of Aldur",
  price: { amount: 5, currency: "exalted" },
  priceExalted: 5,
  seller: { account: "SellerOne", character: "OneChar", online: true },
  listingType: "whisper" as const,
  whisper: "@OneChar hi",
  item: {
    typeLine: "Ruby Ring",
    rarity: "Rare",
    identified: true,
    properties: [],
    requirements: [],
    implicitMods: [],
    explicitMods: [],
    enchantMods: [],
    runeMods: [],
    desecratedMods: [],
    fracturedMods: [],
  },
};

function summary(overrides: Partial<MarketStateView["tabs"][number]> = {}): MarketStateView["tabs"][number] {
  return {
    id: "tab-1",
    kind: "search",
    label: "Ruby Ring",
    colour: "gold",
    temporary: false,
    dirty: false,
    state: "ready",
    resultCount: 1,
    lastUsedAt: "2026-09-10T12:00:00.000Z",
    ...overrides,
  };
}

/** A tab with one row on screen, so the per-row buttons are mountable. */
function resultTab(query: MarketTabView["draft"]["query"]): MarketTabView {
  return tabView({
    state: "ready",
    draft: { kind: "search", query } as MarketTabView["draft"],
    result: {
      searchId: "SID",
      league: "Runes of Aldur",
      url: "https://trade",
      total: 1,
      resultIds: ["ring-1"],
      listings: [LISTING],
      nextOffset: 1,
      fetchedAt: "2026-09-10T12:00:00.000Z",
      cached: false,
      collapsedAccounts: [],
    },
  });
}

async function mountView() {
  vi.resetModules();
  const module = await import("../../src/renderer/features/market/views/MarketView.vue");
  const wrapper = mount(module.default);
  await flushPromises();
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  bridge.available = true;
  bridge.calls = [];
  bridge.listeners.clear();
  bridge.state = stateView();
  bridge.tab = null;
  bridge.action = null;
  bridge.dryRun.value = false;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("MarketView", () => {
  it("renders the desktop-only state without a bridge", async () => {
    bridge.available = false;
    const wrapper = await mountView();
    expect(wrapper.text()).toContain("Market needs the desktop app");
  });

  it("renders the empty state the packaged e2e asserts on", async () => {
    const wrapper = await mountView();
    expect(wrapper.text()).toContain("No tabs yet — start a search or open a favourite.");
  });

  it("shows the tab cap counter and the budget chip", async () => {
    bridge.state = stateView({
      tabs: [
        {
          id: "tab-1",
          kind: "search",
          label: "Ruby Ring",
          colour: "gold",
          temporary: false,
          dirty: false,
          state: "idle",
          lastUsedAt: "2026-09-10T12:00:00.000Z",
        },
      ],
      activeTabId: "tab-1",
    });
    bridge.tab = tabView();
    const wrapper = await mountView();
    expect(wrapper.text()).toContain("1 / 10");
    expect(wrapper.text()).toContain("9 search / 9 fetch spare");
  });

  it("disables Search with a reason inside a penalty window", async () => {
    bridge.state = stateView({
      tabs: [
        {
          id: "tab-1",
          kind: "search",
          label: "Ruby Ring",
          colour: "gold",
          temporary: false,
          dirty: false,
          state: "idle",
          lastUsedAt: "2026-09-10T12:00:00.000Z",
        },
      ],
      activeTabId: "tab-1",
      budget: { lookups: 0, searchesSpare: 0, fetchesSpare: 0, restrictedUntilIso: "2099-01-01T00:00:00.000Z" },
    });
    bridge.tab = tabView();
    const wrapper = await mountView();
    const search = wrapper.findAll("button").find((button) => button.text() === "Search");
    expect(search?.attributes("disabled")).toBeDefined();
    expect(search?.attributes("title")).toMatch(/wait/);
    expect(wrapper.text()).toMatch(/trade2 asked us to wait/);
  });

  it("warns when the league is ambiguous", async () => {
    bridge.state = stateView({ leagueAmbiguous: true });
    const wrapper = await mountView();
    expect(wrapper.text()).toMatch(/Two current leagues/);
  });

  it("says so when no session cookie is set", async () => {
    bridge.state = stateView({ hasSession: false });
    const wrapper = await mountView();
    expect(wrapper.text()).toContain("No POESESSID");
  });

  it("shows a tab error with a Retry", async () => {
    bridge.state = stateView({
      tabs: [
        {
          id: "tab-1",
          kind: "search",
          label: "Ruby Ring",
          colour: "gold",
          temporary: false,
          dirty: false,
          state: "error",
          error: "trade2 search → HTTP 503",
          lastUsedAt: "2026-09-10T12:00:00.000Z",
        },
      ],
      activeTabId: "tab-1",
    });
    bridge.tab = tabView({ state: "error", error: "trade2 search → HTTP 503" });
    const wrapper = await mountView();
    expect(wrapper.text()).toContain("trade2 search → HTTP 503");
    expect(wrapper.findAll("button").some((button) => button.text() === "Retry")).toBe(true);
  });

  it("labels the whisper button for the global dry-run switch", async () => {
    bridge.dryRun.value = true;
    bridge.state = stateView({
      tabs: [
        {
          id: "tab-1",
          kind: "search",
          label: "Ruby Ring",
          colour: "gold",
          temporary: false,
          dirty: false,
          state: "ready",
          resultCount: 1,
          lastUsedAt: "2026-09-10T12:00:00.000Z",
        },
      ],
      activeTabId: "tab-1",
    });
    bridge.tab = tabView({
      state: "ready",
      result: {
        searchId: "SID",
        league: "Runes of Aldur",
        url: "https://trade",
        total: 1,
        resultIds: ["ring-1"],
        listings: [
          {
            id: "ring-1",
            league: "Runes of Aldur",
            price: { amount: 5, currency: "exalted" },
            priceExalted: 5,
            seller: { account: "SellerOne", character: "OneChar", online: true },
            listingType: "whisper",
            whisper: "@OneChar hi",
            item: {
              typeLine: "Ruby Ring",
              rarity: "Rare",
              identified: true,
              properties: [],
              requirements: [],
              implicitMods: [],
              explicitMods: [],
              enchantMods: [],
              runeMods: [],
              desecratedMods: [],
              fracturedMods: [],
            },
          },
        ],
        nextOffset: 1,
        fetchedAt: "2026-09-10T12:00:00.000Z",
        cached: false,
        collapsedAccounts: [],
      },
    });
    const wrapper = await mountView();
    expect(wrapper.text()).toContain("Send whisper (dry-run)");
    expect(wrapper.text()).toContain("Listings are other players’ asks");
  });

  it("carries the Market settings disclosure on the view, not in Tools", async () => {
    const wrapper = await mountView();
    expect(wrapper.text()).toContain("Market settings");
  });

  it("arms a stat-group replacement and applies it on the second click", async () => {
    bridge.state = stateView({ tabs: [summary()], activeTabId: "tab-1" });
    bridge.tab = resultTab({ stats: [{ type: "and", filters: [{ id: "explicit.stat_old" }] }], type: "Ruby Ring" });
    bridge.action = {
      ok: true,
      action: "copy-stats",
      statGroups: [{ type: "and", filters: [{ id: "explicit.stat_new" }] }],
    };
    const wrapper = await mountView();
    const useAsFilters = () => wrapper.findAll("button").find((button) => button.text() === "Use as filters")!;

    await useAsFilters().trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("Replace 1 stat group(s)? Click again to confirm.");
    expect(bridge.calls.some(([channel]) => channel === "market:update-draft")).toBe(false);

    await useAsFilters().trigger("click");
    await flushPromises();
    const update = bridge.calls.find(([channel]) => channel === "market:update-draft");
    expect(update).toBeDefined();
    expect(JSON.stringify(update![1])).toContain("explicit.stat_new");
  });

  it("replaces empty stat groups without asking", async () => {
    bridge.state = stateView({ tabs: [summary()], activeTabId: "tab-1" });
    bridge.tab = resultTab({ stats: [], type: "Ruby Ring" });
    bridge.action = {
      ok: true,
      action: "copy-stats",
      statGroups: [{ type: "and", filters: [{ id: "explicit.stat_new" }] }],
    };
    const wrapper = await mountView();
    await wrapper.findAll("button").find((button) => button.text() === "Use as filters")!.trigger("click");
    await flushPromises();
    expect(bridge.calls.some(([channel]) => channel === "market:update-draft")).toBe(true);
  });

  it("closes the listing peek on Escape, from the button that opened it", async () => {
    bridge.state = stateView({ tabs: [summary()], activeTabId: "tab-1" });
    bridge.tab = resultTab({ stats: [], type: "Ruby Ring" });
    const wrapper = await mountView();
    await wrapper.get('button[aria-label="Show Ruby Ring"]').trigger("click");
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);
    // Focus never left the row button, so the key has to be heard at the
    // document — which is what the panel promises.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await flushPromises();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
  });

  it("closes the import dialog on Escape before anything is typed", async () => {
    const wrapper = await mountView();
    await wrapper.findAll("button").find((button) => button.text() === "Import…")!.trigger("click");
    expect(wrapper.text()).toContain("From the trade site");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await flushPromises();
    expect(wrapper.text()).not.toContain("From the trade site");
  });

  it("says a share-link tab carries only a search id", async () => {
    bridge.state = stateView({ tabs: [summary({ idOnly: true, state: "idle" })], activeTabId: "tab-1" });
    bridge.tab = tabView({ idOnly: { searchId: "AbCdEfGh", league: "Runes of Aldur" } });
    const wrapper = await mountView();
    expect(wrapper.text()).toContain("only carries a search id");
  });

  it("re-enables Search once the penalty instant has passed", async () => {
    bridge.state = stateView({
      tabs: [summary({ state: "idle", resultCount: undefined })],
      activeTabId: "tab-1",
      budget: { lookups: 4, searchesSpare: 4, fetchesSpare: 4, restrictedUntilIso: "2020-01-01T00:00:00.000Z" },
    });
    bridge.tab = tabView();
    const wrapper = await mountView();
    const search = wrapper.findAll("button").find((button) => button.text() === "Search");
    expect(search?.attributes("disabled")).toBeUndefined();
    expect(wrapper.text()).not.toMatch(/trade2 asked us to wait/);
  });

  it("opens a new tab through the channel that seeds the Market defaults", async () => {
    const wrapper = await mountView();
    await wrapper.findAll("button").find((button) => button.text() === "+ Search")!.trigger("click");
    await flushPromises();
    expect(bridge.calls.some(([channel, args]) => channel === "market:new-tab" && args[0] === "search")).toBe(true);
    expect(bridge.calls.some(([channel]) => channel === "market:open-tab")).toBe(false);
  });

  it("renames a favourite without naming a tab, so its saved query is untouched", async () => {
    bridge.state = stateView({
      tabs: [summary()],
      activeTabId: "tab-1",
      favorites: {
        schemaVersion: 1,
        folders: [],
        favorites: [
          {
            id: "fav_1",
            name: "Doom Loop",
            colour: "grey",
            order: 0,
            folderId: null,
            draft: { kind: "search", query: { stats: [], type: "Doom Loop" } },
            createdAt: "2026-09-10T12:00:00.000Z",
            updatedAt: "2026-09-10T12:00:00.000Z",
          },
        ],
      },
    });
    bridge.tab = resultTab({ stats: [], type: "Ruby Ring" });
    const wrapper = await mountView();
    await wrapper.get('button[aria-label="Rename Doom Loop"]').trigger("click");
    const field = wrapper.get('input[aria-label="Rename Doom Loop"]');
    await field.setValue("Better name");
    await field.trigger("keydown", { key: "Enter" });
    await flushPromises();
    const save = bridge.calls.find(([channel]) => channel === "market:favorite-save");
    expect(save).toBeDefined();
    expect(save![1][0]).toMatchObject({ tabId: "", favoriteId: "fav_1", name: "Better name" });
    expect((save![1][0] as { fromTab?: boolean }).fromTab).toBeUndefined();
  });
});
