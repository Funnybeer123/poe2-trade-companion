// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InventoryObservation, ValuedObservation } from "../../src/core/inventoryLedger.js";
import type { InventoryOverviewQuery, InventoryOverviewView } from "../../src/shared/ipc.js";

const bridge = vi.hoisted(() => ({
  overview: vi.fn(),
  refresh: vi.fn(),
  available: true,
}));

vi.mock("../../src/renderer/services/rendererApi", () => ({
  getInventoryApi: () =>
    bridge.available ? { overview: bridge.overview, refresh: bridge.refresh } : undefined,
}));

import WealthView from "../../src/renderer/views/WealthView.vue";

function observation(partial: Partial<InventoryObservation> & Pick<InventoryObservation, "fingerprint" | "location" | "name">): InventoryObservation {
  return {
    at: "2026-09-07T10:00:00.000Z",
    cells: [{ row: 0, col: 0 }],
    itemClass: "Rings",
    rarity: "Rare",
    identified: true,
    runId: "r1",
    count: 1,
    ...partial,
  };
}

const HEADHUNTER: ValuedObservation = {
  observation: observation({ fingerprint: "hh", location: "Belts", name: "Headhunter", itemClass: "Belts", rarity: "Unique" }),
  valueExalted: 1234.5,
  source: "price-table",
};

const LOOP: ValuedObservation = {
  observation: observation({ fingerprint: "loop", location: "Rings", name: "Storm Loop" }),
  valueExalted: 3.333,
  source: "estimate",
};

function overview(partial: Partial<InventoryOverviewView> = {}): InventoryOverviewView {
  return {
    generatedAt: "2026-09-07T12:00:00.000Z",
    file: "artifacts/tab-admin/inventory.jsonl",
    recordCount: 12,
    observationCount: 2,
    worth: {
      totalExalted: 1237.83,
      totalDivine: 3.0946,
      divineRate: 400,
      items: 2,
      priced: 2,
      unpriced: 0,
      locations: [
        { location: "Belts", items: 1, priced: 1, unpriced: 0, valueExalted: 1234.5, lastScanAt: "2026-09-07T10:00:00.000Z", runId: "r1" },
        { location: "bag", items: 1, priced: 1, unpriced: 0, valueExalted: 3.33, lastScanAt: "2026-09-07T10:00:00.000Z", runId: "r1" },
      ],
      valued: [HEADHUNTER, LOOP],
    },
    topItems: [HEADHUNTER, LOOP],
    sellCandidates: [LOOP],
    staleness: [{ location: "Belts", lastScanAt: "2026-09-07T10:00:00.000Z", runId: "r1", ageMs: 2 * 3_600_000 }],
    ...partial,
  };
}

async function mountView() {
  const wrapper = mount(WealthView, {
    global: { stubs: { RouterLink: { template: "<a><slot /></a>" } } },
  });
  await flushPromises();
  return wrapper;
}

describe("WealthView", () => {
  beforeEach(() => {
    bridge.available = true;
    bridge.overview.mockReset().mockImplementation(async () => overview());
    bridge.refresh.mockReset().mockImplementation(async () => overview({ catalogUpserts: 2 }));
  });

  it("formats every amount through formatAmount and labels the bag as in transit", async () => {
    const wrapper = await mountView();
    const text = wrapper.text();
    // 1237.83 ex / 3.0946 div / 400 ex per div — two decimals, grouped, no raw floats.
    expect(text).toContain("1,237.83 ex");
    expect(text).toContain("3.09 div");
    expect(text).toContain("400 ex / div");
    expect(text).not.toContain("3.0946");
    expect(text).toContain("1,234.5 ex");
    expect(text).toContain("3.33 ex");
    expect(text).not.toContain("3.333");
    expect(text).toContain("bag (in transit)");
    expect(text).toContain("2h ago");
    expect(text).toContain("12 record(s) · 2 current");
    expect(bridge.overview).toHaveBeenCalledWith({ minExalted: 1, maxExalted: 5, excludeLocations: [] });
    wrapper.unmount();
  });

  it("passes the sell band and skipped locations through, and only the newest reply lands", async () => {
    const wrapper = await mountView();
    // Hold the reply for the max=50 band change only; the min=2 change that
    // follows (max still 50) answers first.
    let releaseSlow: (value: InventoryOverviewView) => void = () => undefined;
    bridge.overview.mockImplementation(async (query: InventoryOverviewQuery) => {
      if (query.maxExalted === 50 && query.minExalted === 1) {
        return new Promise<InventoryOverviewView>((resolve) => {
          releaseSlow = resolve;
        });
      }
      return overview({ sellCandidates: [], recordCount: 99 });
    });
    await wrapper.find('input[placeholder="Review, Shop"]').setValue("Review, Shop");
    await wrapper.find('input[placeholder="Review, Shop"]').trigger("change");
    await flushPromises();
    expect(bridge.overview).toHaveBeenLastCalledWith({
      minExalted: 1,
      maxExalted: 5,
      excludeLocations: ["Review", "Shop"],
    });
    expect(wrapper.text()).toContain("99 record(s)");

    const max = wrapper.findAll('input[type="number"]')[1]!;
    await max.setValue(50);
    await max.trigger("change");
    await flushPromises();
    const min = wrapper.findAll('input[type="number"]')[0]!;
    await min.setValue(2);
    await min.trigger("change");
    await flushPromises();
    expect(wrapper.text()).toContain("99 record(s)");
    // The slow (older) reply arrives last and must be ignored.
    releaseSlow(overview({ recordCount: 7 }));
    await flushPromises();
    expect(wrapper.text()).toContain("99 record(s)");
    expect(wrapper.text()).not.toContain("7 record(s)");
    wrapper.unmount();
  });

  it("shows the loading panel first, then the refresh notice, and reports a failed read", async () => {
    let release: (value: InventoryOverviewView) => void = () => undefined;
    bridge.overview.mockImplementation(
      () =>
        new Promise<InventoryOverviewView>((resolve) => {
          release = resolve;
        }),
    );
    const wrapper = mount(WealthView, {
      global: { stubs: { RouterLink: { template: "<a><slot /></a>" } } },
    });
    await flushPromises();
    expect(wrapper.text()).toContain("Reading the inventory ledger…");
    expect(wrapper.find(".spinner").exists()).toBe(true);
    release(overview());
    await flushPromises();
    expect(wrapper.find(".spinner").exists()).toBe(false);

    const refresh = wrapper.findAll("button").find((button) => button.text() === "Refresh")!;
    await refresh.trigger("click");
    await flushPromises();
    expect(bridge.refresh).toHaveBeenCalledOnce();
    expect(wrapper.text()).toContain("2 catalog row(s) updated with current locations.");

    bridge.refresh.mockRejectedValueOnce(new Error("ledger locked"));
    await refresh.trigger("click");
    await flushPromises();
    expect(wrapper.find('[role="alert"]').text()).toBe("ledger locked");
    wrapper.unmount();
  });

  it("explains the empty ledger and the empty sell band", async () => {
    bridge.overview.mockImplementation(async () =>
      overview({
        recordCount: 0,
        observationCount: 0,
        worth: { totalExalted: 0, totalDivine: 0, divineRate: 40, items: 0, priced: 0, unpriced: 0, locations: [], valued: [] },
        topItems: [],
        sellCandidates: [],
        staleness: [],
      }),
    );
    const wrapper = await mountView();
    expect(wrapper.text()).toContain("Nothing in the ledger yet");
    expect(wrapper.text()).toContain("Nothing priced in this band");
    const copy = wrapper.findAll("button").find((button) => button.text() === "Copy names")!;
    expect(copy.attributes("disabled")).toBeDefined();
    wrapper.unmount();
  });

  it("is a notice without the desktop bridge and never calls it", async () => {
    bridge.available = false;
    const wrapper = await mountView();
    expect(wrapper.text()).toContain("The Wealth page needs the desktop app");
    expect(wrapper.find(".spinner").exists()).toBe(false);
    const refresh = wrapper.findAll("button").find((button) => button.text() === "Refresh")!;
    expect(refresh.attributes("disabled")).toBeDefined();
    expect(bridge.overview).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
