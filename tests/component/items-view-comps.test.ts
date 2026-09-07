// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesirabilityResult, NormalizedItem, ValuationResult } from "../../src/core/types.js";
import type { CompsResultView } from "../../src/renderer/services/rendererApi.js";
import { ITEM_INTELLIGENCE_IPC_VERSION, type ParsedItemEvaluation } from "../../src/shared/ipc.js";

const bridge = vi.hoisted(() => ({
  comps: vi.fn(),
}));

vi.mock("../../src/renderer/services/rendererApi", () => ({
  rendererApi: {
    isNative: true,
    mode: vi.fn(async () => "public-companion"),
    windows: vi.fn(async () => []),
    killLatched: vi.fn(async () => false),
    rearm: vi.fn(async () => false),
    evaluateText: vi.fn(),
    fromClipboard: vi.fn(),
    onItem: vi.fn(() => () => undefined),
    intelligence: {
      catalog: { list: vi.fn(async () => []), remove: vi.fn(async () => true), onChanged: vi.fn(() => () => undefined) },
      rules: { list: vi.fn(async () => []), onChanged: vi.fn(() => () => undefined) },
      builds: { list: vi.fn(async () => []), onChanged: vi.fn(() => () => undefined) },
    },
  },
  getPriceFeedApi: () => ({
    status: vi.fn(),
    leagues: vi.fn(),
    refresh: vi.fn(),
    configure: vi.fn(),
    comps: bridge.comps,
  }),
  getWatchlistApi: () => undefined,
}));

import ItemsView from "../../src/renderer/views/ItemsView.vue";
import { disposeIntelligenceStore, useIntelligenceStore } from "../../src/renderer/composables/useIntelligenceStore.js";

function item(name: string, fingerprint: string): NormalizedItem {
  const rawText = ["Item Class: Rings", "Rarity: Rare", name, "Ruby Ring", "--------", "+92 to maximum Life"].join("\n");
  return {
    itemClass: "Rings",
    rarity: "Rare",
    name,
    baseType: "Ruby Ring",
    requirements: {},
    properties: [],
    mods: [{ text: "+92 to maximum Life", values: [92], rolls: [], kind: "explicit", order: 0 }],
    identified: true,
    fingerprint,
    rawText,
  };
}

const valuation: ValuationResult = {
  itemIdentifier: "x",
  itemType: "Rings",
  normalizedKeyStats: {},
  providerName: "appraisal",
  marketTimestamp: "2026-09-07T12:00:00.000Z",
  candidateCount: 0,
  comparablesUsed: 0,
  low: 1,
  fair: 2,
  high: 3,
  recommendedListing: 2,
  currency: "exalted",
  confidence: "low",
};

const desirability: DesirabilityResult = { score: 40, category: "sell", reasons: [] };

function evaluation(named: NormalizedItem): ParsedItemEvaluation {
  return {
    schemaVersion: ITEM_INTELLIGENCE_IPC_VERSION,
    parsed: true,
    raw: named.rawText!,
    item: named,
    valuation,
    desirability,
  };
}

function comps(median: number): CompsResultView {
  return {
    ok: true,
    league: "Runes of Aldur",
    summary: {
      sampleSize: 4,
      candidateCount: 9,
      lowest: median - 1,
      median,
      currency: "exalted",
      basis: "base-type",
      comps: [{ price: median, similarity: 1, name: "Comp", baseType: "Ruby Ring" }],
    },
  };
}

async function mountView() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/items", component: ItemsView },
      { path: "/tools/:tool?", component: RouterView },
    ],
  });
  await router.push("/items");
  await router.isReady();
  const wrapper = mount(ItemsView, { global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
}

describe("ItemsView market comps", () => {
  beforeEach(() => {
    disposeIntelligenceStore();
    bridge.comps.mockReset();
  });

  afterEach(() => {
    const store = useIntelligenceStore();
    store.currentEvaluation.value = null;
    store.currentCatalogItem.value = null;
  });

  it("discards comps that arrive for an item the user has already replaced", async () => {
    const store = useIntelligenceStore();
    const first = item("Storm Loop", "first");
    const second = item("Doom Turn", "second");
    store.currentEvaluation.value = evaluation(first);
    const wrapper = await mountView();

    let releaseFirst: (value: CompsResultView) => void = () => undefined;
    bridge.comps.mockImplementationOnce(
      () =>
        new Promise<CompsResultView>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    const fetch = wrapper.findAll("button").find((button) => button.text() === "Get market comps")!;
    await fetch.trigger("click");
    await flushPromises();
    expect(bridge.comps).toHaveBeenCalledWith(first.rawText);
    expect(fetch.text()).toBe("Fetching comps…");

    // The user evaluates another item while the lookup is still in flight.
    store.currentEvaluation.value = evaluation(second);
    await flushPromises();
    releaseFirst(comps(50));
    await flushPromises();
    expect(wrapper.find(".comps-band").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("50 ex");

    // A lookup for the current item still lands.
    bridge.comps.mockResolvedValueOnce(comps(7));
    await wrapper.findAll("button").find((button) => button.text() === "Get market comps")!.trigger("click");
    await flushPromises();
    expect(bridge.comps).toHaveBeenLastCalledWith(second.rawText);
    expect(wrapper.find(".comps-band").text()).toContain("median 7 ex");
    wrapper.unmount();
  });

  it("shows a failed lookup as an alert and keeps the button usable", async () => {
    const store = useIntelligenceStore();
    store.currentEvaluation.value = evaluation(item("Storm Loop", "first"));
    const wrapper = await mountView();
    bridge.comps.mockRejectedValueOnce(new Error("rate limited until 12:05"));
    await wrapper.findAll("button").find((button) => button.text() === "Get market comps")!.trigger("click");
    await flushPromises();
    expect(wrapper.find(".market-comps [role='alert']").text()).toBe("rate limited until 12:05");
    const again = wrapper.findAll("button").find((button) => button.text() === "Refresh comps")!;
    expect(again.attributes("disabled")).toBeUndefined();
    wrapper.unmount();
  });
});
