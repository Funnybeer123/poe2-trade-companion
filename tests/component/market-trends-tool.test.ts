// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PriceTable } from "../../src/core/priceTable.js";
import type { TrendReport } from "../../src/core/priceTrends.js";
import type { MarketTrendsView } from "../../src/shared/ipc.js";

const bridge = vi.hoisted(() => ({
  trends: vi.fn(),
  refresh: vi.fn(),
  prices: vi.fn(),
  available: true,
}));

vi.mock("../../src/renderer/services/rendererApi", () => ({
  rendererApi: {
    intelligence: {
      prices: { get: bridge.prices, save: vi.fn(), onChanged: vi.fn(() => () => undefined) },
    },
  },
  getMarketApi: () => (bridge.available ? { trends: bridge.trends, refresh: bridge.refresh } : undefined),
}));

import MarketTrendsTool from "../../src/renderer/components/tools/MarketTrendsTool.vue";

const DIVINE: TrendReport = {
  key: "divine",
  name: "Divine Orb",
  category: "currency",
  current: 649.45,
  change1d: 16.2,
  change3d: 40.3,
  change7d: 76.1,
  volatility7d: 0.17,
  volume7d: 19_083_150,
  sampleSize: 7,
  trend: "rising",
  liquidity: "deep",
};

const CHAOS: TrendReport = {
  key: "chaos",
  name: "Chaos Orb",
  category: "currency",
  current: 30,
  change1d: -2,
  change3d: -12,
  change7d: -20,
  volume7d: 500,
  sampleSize: 7,
  trend: "falling",
  liquidity: "thin",
};

const TEMPORALIS: TrendReport = {
  key: "temporalis-silk-robe",
  name: "Temporalis",
  unique: true,
  baseType: "Silk Robe",
  category: "uniques",
  current: 1_602_665,
  change3d: 1,
  change7d: 2,
  volume7d: 3,
  sampleSize: 7,
  trend: "stable",
  liquidity: "thin",
};

function view(partial: Partial<MarketTrendsView> = {}): MarketTrendsView {
  return {
    ok: true,
    league: "Runes of Aldur",
    fetchedAt: "2026-09-07T06:00:00.000Z",
    stale: false,
    refreshing: false,
    source: "cache",
    categories: ["currency", "uniques"],
    trends: [DIVINE, CHAOS, TEMPORALIS],
    ...partial,
  };
}

const TABLE: PriceTable = {
  schemaVersion: 1,
  currency: "exalted",
  entries: [
    { id: "feed:poe2scout:divine", match: { name: "Divine Orb" }, value: 649.45 },
    { id: "manual-chaos", match: { name: "Chaos Orb" }, value: 30 },
    { id: "feed:poe2scout:temporalis-silk-robe", match: { name: "Temporalis", baseType: "Silk Robe", rarity: "Unique" }, value: 1_602_665 },
  ],
};

async function mountTool() {
  const wrapper = mount(MarketTrendsTool);
  await flushPromises();
  return wrapper;
}

describe("MarketTrendsTool", () => {
  beforeEach(() => {
    bridge.available = true;
    bridge.prices.mockReset().mockResolvedValue(TABLE);
    bridge.trends.mockReset().mockResolvedValue(view());
    bridge.refresh.mockReset().mockResolvedValue(view({ source: "network", fetchedAt: "2026-09-07T12:00:00.000Z" }));
  });

  it("renders movers, stack advice for table currency only, and the farm ranking from the cache", async () => {
    const wrapper = await mountTool();
    expect(bridge.trends).toHaveBeenCalledWith();
    expect(bridge.refresh).not.toHaveBeenCalled();
    const text = wrapper.text();
    expect(text).toContain("Runes of Aldur · 3 items");
    expect(text).toContain("▲ +40.3%");
    expect(text).toContain("▼ -12%");
    // Stack advice covers the currencies the price table names — never the
    // unique — with "sell" (act now) rows ahead of "hold".
    const rows = wrapper.findAll(".trend-table tbody tr");
    expect(rows.map((row) => row.text().split(/\s+/)[0])).toEqual(["Chaos", "Divine"]);
    expect(rows[0]!.text()).toContain("sell");
    expect(rows[0]!.text()).toContain("thin market, move it in small lots");
    expect(rows[0]!.find(".status-chip").classes()).toContain("warning");
    expect(rows[1]!.text()).toContain("hold");
    expect(rows[1]!.text()).toContain("+40.3% over 3 d and rising");
    expect(rows[1]!.find(".status-chip").classes()).toContain("safe");
    // Renderer amounts go through formatAmount (grouped, ≤ 2 decimals).
    expect(text).toContain("649.45 ex · deep");
    expect(text).toContain("1,602,665 ex · thin");
    expect(text).toContain("19,083,150 · deep");
    // Farm ranking leads with the highest price × volume.
    const farm = wrapper.findAll(".farm-list li");
    expect(farm[0]!.text()).toContain("Divine Orb");
    expect(farm[0]!.text()).toContain("100");
    expect(text).toContain("Estimates, never guarantees");
    wrapper.unmount();
  });

  it("refreshes on demand and disables the button meanwhile", async () => {
    const wrapper = await mountTool();
    let release: (value: MarketTrendsView) => void = () => undefined;
    bridge.refresh.mockImplementation(
      () =>
        new Promise<MarketTrendsView>((resolve) => {
          release = resolve;
        }),
    );
    const refresh = wrapper.findAll("button").find((button) => button.text() === "Refresh")!;
    await refresh.trigger("click");
    await flushPromises();
    expect(refresh.text()).toBe("Refreshing…");
    expect(refresh.attributes("disabled")).toBeDefined();
    expect(wrapper.text()).toContain("Fetching price history from poe2scout…");
    release(view({ trends: [DIVINE], fetchedAt: "2026-09-07T12:00:00.000Z" }));
    await flushPromises();
    expect(bridge.refresh).toHaveBeenCalledOnce();
    expect(refresh.attributes("disabled")).toBeUndefined();
    expect(wrapper.text()).toContain("Runes of Aldur · 1 items");
    wrapper.unmount();
  });

  it("shows a failed load once, as an alert, with the empty-state hint", async () => {
    bridge.trends.mockResolvedValue(
      view({ ok: false, source: "none", trends: [], error: "league ambiguous — pick one" }),
    );
    const wrapper = await mountTool();
    expect(wrapper.find('[role="alert"]').text()).toBe("league ambiguous — pick one");
    expect(wrapper.text().split("league ambiguous — pick one")).toHaveLength(2);
    expect(wrapper.text()).toContain("No price history loaded.");
    wrapper.unmount();
  });

  it("reports a thrown bridge error instead of hanging on the spinner", async () => {
    bridge.trends.mockRejectedValue(new Error("ipc down"));
    const wrapper = await mountTool();
    expect(wrapper.find(".spinner").exists()).toBe(false);
    expect(wrapper.find('[role="alert"]').text()).toBe("ipc down");
    wrapper.unmount();
  });

  it("is a desktop-only notice without the bridge", async () => {
    bridge.available = false;
    const wrapper = await mountTool();
    expect(wrapper.text()).toContain("Market trends need the desktop app");
    expect(wrapper.findAll("button")).toHaveLength(0);
    expect(bridge.trends).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
