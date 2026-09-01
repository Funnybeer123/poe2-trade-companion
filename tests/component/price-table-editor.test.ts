// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PriceTable } from "../../src/core/priceTable.js";

const bridge = vi.hoisted(() => ({
  table: undefined as unknown as PriceTable,
  savePrices: vi.fn(),
  feedStatus: {
    config: { league: "auto", autoRefreshDaily: false, poesessid: "" },
    resolvedLeague: "Runes of Aldur",
    feedEntryCount: 2,
    feedAgeHours: 3,
    refreshing: false,
  },
  refresh: vi.fn(),
}));

vi.mock("../../src/renderer/services/rendererApi", () => ({
  rendererApi: {
    intelligence: {
      prices: {
        get: vi.fn(async () => bridge.table),
        save: bridge.savePrices,
        onChanged: vi.fn(() => () => undefined),
      },
    },
  },
  getPriceFeedApi: () => ({
    status: vi.fn(async () => bridge.feedStatus),
    refresh: bridge.refresh,
    configure: vi.fn(),
    comps: vi.fn(),
  }),
}));

import PriceTableEditor from "../../src/renderer/components/PriceTableEditor.vue";

function makeTable(): PriceTable {
  return {
    schemaVersion: 1,
    currency: "exalted",
    entries: [
      { id: "manual-1", match: { name: "My Divine" }, value: 500, note: "mine" },
      {
        id: "feed:poe2scout:divine",
        match: { name: "Divine Orb" },
        value: 404.62,
        note: "poe2scout · Runes of Aldur · 2026-08-30",
      },
      {
        id: "feed:poe2scout:temporalis-silk-robe",
        match: { name: "Temporalis", baseType: "Silk Robe", rarity: "Unique" },
        value: 1602665,
        note: "poe2scout · Runes of Aldur · 2026-08-30",
      },
    ],
  };
}

describe("PriceTableEditor with feed entries", () => {
  beforeEach(() => {
    bridge.table = makeTable();
    bridge.savePrices.mockReset();
    bridge.savePrices.mockImplementation(async (table: PriceTable) => table);
  });

  it("shows manual rows as editable and feed rows read-only", async () => {
    const wrapper = mount(PriceTableEditor);
    await flushPromises();
    // Only the manual entry appears in the editable table.
    const inputs = wrapper.findAll("tbody input");
    const values = inputs.map((input) => (input.element as HTMLInputElement).value);
    expect(values).toContain("My Divine");
    expect(values).not.toContain("Divine Orb");
    // Feed rows render read-only in the disclosure.
    expect(wrapper.text()).toContain("Market prices from the feed (2)");
    expect(wrapper.text()).toContain("Temporalis");
    wrapper.unmount();
  });

  it("save keeps every feed entry — the regression that once deleted 800 rows", async () => {
    const wrapper = mount(PriceTableEditor);
    await flushPromises();
    const save = wrapper
      .findAll("button")
      .find((button) => button.text().includes("Save prices"))!;
    await save.trigger("click");
    await flushPromises();
    expect(bridge.savePrices).toHaveBeenCalledOnce();
    const saved = bridge.savePrices.mock.calls[0]![0] as PriceTable;
    const ids = saved.entries.map((entry) => entry.id).sort();
    expect(ids).toEqual([
      "feed:poe2scout:divine",
      "feed:poe2scout:temporalis-silk-robe",
      "manual-1",
    ]);
    // Feed rows pass through byte-identical.
    expect(saved.entries.find((entry) => entry.id === "feed:poe2scout:divine")?.value).toBe(404.62);
    wrapper.unmount();
  });

  it("surfaces feed status and refreshes on demand", async () => {
    bridge.refresh.mockResolvedValue({ ...bridge.feedStatus, feedEntryCount: 811 });
    const wrapper = mount(PriceTableEditor);
    await flushPromises();
    expect(wrapper.text()).toContain("2 market prices");
    expect(wrapper.text()).toContain("Runes of Aldur");
    const refresh = wrapper
      .findAll("button")
      .find((button) => button.text().includes("Refresh market prices"))!;
    await refresh.trigger("click");
    await flushPromises();
    expect(bridge.refresh).toHaveBeenCalledOnce();
    expect(wrapper.text()).toContain("811 market prices");
    wrapper.unmount();
  });
});
