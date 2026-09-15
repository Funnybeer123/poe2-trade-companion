// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { emptyPriceTable } from "../../src/core/priceTable.js";
import type { TradeListing } from "../../src/core/tradeListings.js";
import type { MarketLiveView } from "../../src/shared/market.js";
import LiveSearchColumn from "../../src/renderer/features/market/components/LiveSearchColumn.vue";

function listing(id: string): TradeListing {
  return {
    id,
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
  };
}

function view(overrides: Partial<MarketLiveView> = {}): MarketLiveView {
  return {
    id: "live-1",
    handle: { id: "h1", searchId: "SID", league: "Runes of Aldur", label: "Rings", state: "open", resultsSeen: 3 },
    label: "Rings",
    sound: true,
    notify: false,
    results: [listing("ring-1")],
    unread: 3,
    startedAt: "2026-09-10T12:00:00.000Z",
    ...overrides,
  };
}

interface ColumnProps {
  live: MarketLiveView[];
  capacity: { open: number; max: number };
  hasSession: boolean;
  priceTable: ReturnType<typeof emptyPriceTable>;
  staleAfterHours: number;
  canStart: boolean;
  startHint?: string;
  rateNote?: string;
  dryRun?: boolean;
  busy?: boolean;
}

function column(props: Partial<ColumnProps> = {}) {
  const merged: ColumnProps = {
    live: [view()],
    capacity: { open: 1, max: 20 },
    hasSession: true,
    priceTable: emptyPriceTable(),
    staleAfterHours: 24,
    canStart: true,
    ...props,
  };
  return mount(LiveSearchColumn, { props: merged });
}

describe("LiveSearchColumn", () => {
  it("shows the capacity chip", () => {
    expect(column().text()).toContain("1 / 20");
  });

  it("says a session cookie is needed and disables Start", () => {
    const wrapper = column({ hasSession: false });
    expect(wrapper.text()).toMatch(/POESESSID/);
    const start = wrapper.findAll("button").find((button) => button.text() === "Start from this tab");
    expect(start?.attributes("disabled")).toBeDefined();
  });

  it("explains why Start is off without a searched tab", () => {
    const wrapper = column({ canStart: false, startHint: "Search this tab first" });
    const start = wrapper.findAll("button").find((button) => button.text() === "Start from this tab");
    expect(start?.attributes("disabled")).toBeDefined();
    expect(start?.attributes("title")).toBe("Search this tab first");
  });

  it("shows the unread badge and the row", () => {
    const wrapper = column();
    expect(wrapper.text()).toContain("3 new");
    expect(wrapper.text()).toContain("Ruby Ring");
  });

  it("surfaces results the budget guard dropped", () => {
    const wrapper = column({
      live: [view({ handle: { ...view().handle, skippedResults: 7, error: "trade2 budget" } })],
    });
    expect(wrapper.text()).toContain("7 result(s) not fetched — trade2 budget.");
  });

  it("shows a stopped-on-penalty live search as an error", () => {
    const wrapper = column({
      live: [
        view({
          handle: {
            ...view().handle,
            state: "error",
            error: "trade2 rate limited until 12:30 — live searches stopped",
          },
        }),
      ],
    });
    expect(wrapper.text()).toContain("live searches stopped");
  });

  it("emits the toggles, clear, seen and stop", async () => {
    const wrapper = column();
    const checkboxes = wrapper.findAll("input[type='checkbox']");
    await checkboxes[0]!.setValue(false);
    expect(wrapper.emitted("set")?.[0]).toEqual(["live-1", { sound: false }]);
    await checkboxes[1]!.setValue(true);
    expect(wrapper.emitted("set")?.[1]).toEqual(["live-1", { notify: true }]);
    await wrapper.findAll("button").find((button) => button.text() === "Clear")!.trigger("click");
    expect(wrapper.emitted("clear")?.[0]).toEqual(["live-1"]);
    await wrapper.findAll("button").find((button) => button.text() === "Mark seen")!.trigger("click");
    expect(wrapper.emitted("seen")?.[0]).toEqual(["live-1"]);
    await wrapper.findAll("button").find((button) => button.text() === "Stop")!.trigger("click");
    expect(wrapper.emitted("stop")?.[0]).toEqual(["live-1"]);
  });

  it("passes a row action up with its live id", async () => {
    const wrapper = column();
    await wrapper.findAll("button").find((button) => button.text() === "Copy whisper")!.trigger("click");
    const emitted = wrapper.emitted("action")?.[0];
    expect(emitted?.[0]).toBe("copy-whisper");
    expect((emitted?.[1] as TradeListing).id).toBe("ring-1");
    expect(emitted?.[2]).toBe("live-1");
  });

  it("states the rate behind a fractional price, never a bare equality", () => {
    const table = emptyPriceTable();
    table.entries.push({ id: "divine", match: { name: "Divine Orb" }, value: 404.62 });
    const fractional = listing("ring-2");
    fractional.price = { amount: 1.5, currency: "divine" };
    fractional.priceExalted = 606.93;
    const wrapper = column({
      live: [view({ results: [fractional] })],
      priceTable: table,
      rateNote: "at 404.62 ex/div from the price table (feed 2 h old) — estimate",
    });
    const hint = wrapper.find(".fractional");
    expect(hint.exists()).toBe(true);
    expect(hint.attributes("title")).toBe("at 404.62 ex/div from the price table (feed 2 h old) — estimate");
  });

  it("renders an empty state with no live searches", () => {
    expect(column({ live: [], capacity: { open: 0, max: 20 } }).text()).toContain("No live search running.");
  });

  it("waits visibly for the first listing", () => {
    expect(column({ live: [view({ results: [], unread: 0 })] }).text()).toContain("Waiting for the first listing");
  });
});
