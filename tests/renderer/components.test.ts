// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";
import { afterEach, describe, expect, it } from "vitest";
import type {
  DesirabilityResult,
  NormalizedItem,
  ValuationResult,
} from "../../src/core/types.js";
import ItemDetail from "../../src/renderer/components/ItemDetail.vue";
import { useIntelligenceStore } from "../../src/renderer/composables/useIntelligenceStore.js";
import FinderView from "../../src/renderer/views/FinderView.vue";
import { ITEM_INTELLIGENCE_IPC_VERSION } from "../../src/shared/ipc.js";

const item: NormalizedItem = {
  itemClass: "Rings",
  rarity: "Rare",
  name: "Storm Loop",
  baseType: "Ruby Ring",
  itemLevel: 82,
  quality: 20,
  requirements: { Level: 64 },
  properties: [
    {
      name: "Requires Level",
      value: "64",
      text: "Requires Level: 64",
      rawText: "Requires Level: 64",
      block: 1,
      order: 0,
      line: 5,
      values: [64],
      rolls: [],
    },
  ],
  mods: [
    {
      text: "+35% to Fire Resistance",
      value: 35,
      values: [35],
      rolls: [{ index: 0, value: 35, raw: "+35", unit: "%", start: 0, end: 3 }],
      kind: "explicit",
      order: 1,
    },
    {
      text: "+92 to maximum Life",
      value: 92,
      values: [92],
      rolls: [{ index: 0, value: 92, raw: "+92", start: 0, end: 3 }],
      kind: "explicit",
      order: 0,
    },
  ],
  identified: true,
  fingerprint: "renderer-ring",
  rawText: [
    "Item Class: Rings",
    "Rarity: Rare",
    "Storm Loop",
    "Ruby Ring",
    "--------",
    "+35% to Fire Resistance",
    "+92 to maximum Life",
  ].join("\n"),
};

const valuation: ValuationResult = {
  itemIdentifier: item.fingerprint,
  itemType: item.itemClass,
  normalizedKeyStats: { itemLevel: 82 },
  providerName: "fixture",
  marketTimestamp: "2026-08-27T12:00:00.000Z",
  candidateCount: 12,
  comparablesUsed: 9,
  low: 8,
  fair: 10,
  high: 13,
  recommendedListing: 9.5,
  currency: "exalted",
  confidence: "high",
};

const desirability: DesirabilityResult = {
  score: 82,
  category: "keep",
  reasons: ["rare rarity", "high item level"],
};

afterEach(() => {
  const store = useIntelligenceStore();
  store.currentEvaluation.value = null;
  store.currentCatalogItem.value = null;
  store.ruleSets.value = [];
  localStorage.clear();
});

describe("renderer item intelligence components", () => {
  it("renders explicit estimate language and parser ordering", () => {
    const wrapper = mount(ItemDetail, {
      props: { item, valuation, desirability },
    });

    expect(wrapper.text()).toContain("Estimated value");
    expect(wrapper.text()).toContain("9 usable comparables from 12 candidates");
    // Fixture-provider valuations must announce themselves as demo data.
    expect(wrapper.text()).toContain("demo prices");
    expect(wrapper.text()).toContain("not market data");
    expect(wrapper.text()).toContain("Requires Level");
    expect(
      wrapper.findAll(".affix-list strong").map((entry) => entry.text()),
    ).toEqual(["+92 to maximum Life", "+35% to Fire Resistance"]);
    wrapper.unmount();
  });

  it("generates copy-ready non-truncated stash query cards", async () => {
    const store = useIntelligenceStore();
    store.currentEvaluation.value = {
      schemaVersion: ITEM_INTELLIGENCE_IPC_VERSION,
      parsed: true,
      raw: item.rawText!,
      item,
      valuation,
      desirability,
    };

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/finder", component: FinderView },
        { path: "/rules", component: RouterView },
      ],
    });
    await router.push("/finder");
    await router.isReady();
    const wrapper = mount(FinderView, {
      global: { plugins: [router] },
    });

    await wrapper.get(".finder-builder .button.primary").trigger("click");
    await flushPromises();

    const queries = wrapper.findAll(".query-card > code");
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.every((entry) => entry.text().length <= 50)).toBe(true);
    expect(queries.every((entry) => !entry.text().includes("..."))).toBe(true);
    expect(wrapper.text()).not.toContain("failed representative-line validation");
    wrapper.unmount();
  });
});
