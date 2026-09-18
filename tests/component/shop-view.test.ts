// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { ref, type Ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  dryRun: undefined as unknown as Ref<boolean>,
  running: false,
  overview: vi.fn(),
  runScript: vi.fn(),
}));

vi.mock("../../src/renderer/composables/useGameActions", () => ({
  useGameActions: () => ({ dryRun: state.dryRun }),
}));

vi.mock("../../src/renderer/services/rendererApi", () => ({
  getShopApi: () => ({
    overview: state.overview,
    saveConfig: async (config: unknown) => ({ config, issues: [] }),
  }),
  getStashTabAdminApi: () => ({
    status: async () => ({ running: state.running, phase: state.running ? "applying" : "idle" }),
    runScript: state.runScript,
    onEvent: () => () => undefined,
  }),
}));

import ShopView from "../../src/renderer/views/ShopView.vue";

const listing = (name: string, currency?: string, amount = 1) => ({
  fingerprint: name,
  name,
  itemClass: "Rings",
  count: 1,
  ...(currency ? { price: { amount, currency } } : {}),
  listedAt: "2026-09-18T00:00:00.000Z",
  pricedAt: "2026-09-18T00:00:00.000Z",
  by: "app" as const,
});

beforeEach(() => {
  state.dryRun = ref(true);
  state.running = false;
  state.overview.mockReset().mockResolvedValue({
    config: { shopTab: "Shop", returnTab: "Dump", maxAutoList: { amount: 1, currency: "divine" }, bucketTabs: [] },
    state: [
      listing("Kept Amulet", "divine"),
      listing("Kept Chaos", "chaos", 3),
      listing("One Chaos Ring", "chaos", 1),
      listing("Exalted Ring", "exalted"),
      listing("Unpriced Wand"),
    ],
  });
  state.runScript.mockReset().mockResolvedValue({ started: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("shop view currency sweep", () => {
  it("flags ledger rows the sweep would remove and previews in dry-run", async () => {
    const wrapper = mount(ShopView);
    await flushPromises();
    expect(wrapper.text()).toContain("Ledger currently flags 3 listing(s) the sweep would remove");
    expect(wrapper.get('[data-test="currency-sweep"]').text()).toBe("Preview Chaos/Divine sweep");
    expect(wrapper.findAll("li.foreign")).toHaveLength(3);
    expect(wrapper.text()).toContain("1 chaos");
    await wrapper.get('[data-test="currency-sweep"]').trigger("click");
    await flushPromises();
    expect(state.runScript).toHaveBeenCalledExactlyOnceWith("shop-currency-sweep-dry");
    wrapper.unmount();
  });

  it("runs the live sweep when dry-run is off", async () => {
    state.dryRun.value = false;
    const wrapper = mount(ShopView);
    await flushPromises();
    expect(wrapper.get('[data-test="currency-sweep"]').text()).toBe("Remove non-Chaos/Divine");
    await wrapper.get('[data-test="currency-sweep"]').trigger("click");
    await flushPromises();
    expect(state.runScript).toHaveBeenCalledExactlyOnceWith("shop-currency-sweep");
    wrapper.unmount();
  });
});
