// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PricingHistoryView,
  PricingOverviewView,
  PricingRow,
  PricingSettings,
} from "../../src/shared/pricingHistory.js";

const bridge = vi.hoisted(() => ({
  available: true,
  overviewError: "",
  overview: vi.fn(),
  history: vi.fn(),
  toggleFavorite: vi.fn(),
  configure: vi.fn(),
  leagues: vi.fn(),
  clearHistory: vi.fn(),
  listeners: new Map<string, (payload: unknown) => void>(),
  query: {} as Record<string, string>,
}));

vi.mock("../../src/renderer/services/featureApi", () => ({
  createFeatureApi: () =>
    bridge.available
      ? {
          invoke: (channel: string, ...args: unknown[]) => {
            switch (channel) {
              case "pricing:overview":
                return bridge.overviewError
                  ? Promise.reject(new Error(bridge.overviewError))
                  : bridge.overview(args[0]);
              case "pricing:history":
                return bridge.history(args[0]);
              case "pricing:toggle-favorite":
                return bridge.toggleFavorite(args[0]);
              case "pricing:configure":
                return bridge.configure(args[0]);
              case "pricing:leagues":
                return bridge.leagues();
              case "pricing:clear-history":
                return bridge.clearHistory(args[0]);
              default:
                return Promise.reject(new Error(`unexpected ${channel}`));
            }
          },
          on: (channel: string, callback: (payload: unknown) => void) => {
            bridge.listeners.set(channel, callback);
            return () => bridge.listeners.delete(channel);
          },
        }
      : null,
}));

vi.mock("vue-router", () => ({ useRoute: () => ({ query: bridge.query }) }));

import PricingHistoryTool from "../../src/renderer/features/pricingHistory/PricingHistoryTool.vue";

const SETTINGS: PricingSettings = {
  favorites: [],
  displayCurrency: "auto",
  hideLowStock: true,
  sort: { key: "change3d", direction: "desc" },
  category: "all",
  keepHistory: true,
};

function row(partial: Partial<PricingRow> & { key: string; name: string }): PricingRow {
  return {
    category: "currency",
    current: 1,
    hasHistory: true,
    lowStock: false,
    spark: [1, 2, 3],
    favorite: false,
    volume7d: 1_000,
    sampleSize: 7,
    trend: "stable",
    liquidity: "deep",
    ...partial,
  };
}

const ROWS: PricingRow[] = [
  row({ key: "divine", name: "Divine Orb", current: 649.45, change3d: 3.1, change1d: 0.7, volume7d: 800_000 }),
  row({ key: "chaos", name: "Chaos Orb", current: 44.8, change3d: -6, volume7d: 900_000 }),
  row({
    key: "ruin",
    name: "Essence of Ruin",
    category: "essences",
    current: 12.5,
    volume7d: 4,
    sampleSize: 2,
    lowStock: true,
  }),
  row({
    key: "temporalis",
    name: "Temporalis",
    baseType: "Silk Robe",
    category: "uniques",
    current: 1_602_665,
    hasHistory: false,
    spark: [],
    volume7d: 0,
    sampleSize: 0,
  }),
];

function view(partial: Partial<PricingOverviewView> = {}): PricingOverviewView {
  return {
    ok: true,
    league: "Runes of Aldur",
    fetchedAt: "2026-09-12T06:00:00.000Z",
    stale: false,
    refreshing: false,
    source: "cache",
    divineRate: 649.45,
    divineRateSource: "feed",
    categories: [
      { id: "currency", label: "Currency", count: 2 },
      { id: "essences", label: "Essences", count: 1 },
      { id: "uniques", label: "Uniques (no history)", count: 1 },
    ],
    rows: ROWS,
    history: {
      since: "2026-08-23T06:00:00.000Z",
      keys: 6,
      bars: 120,
      file: "C:/user/pricing-history/runes-of-aldur.json",
      bytes: 40_960,
    },
    settings: SETTINGS,
    generatedAt: "2026-09-12T12:00:00.000Z",
    ...partial,
  };
}

const HISTORY: PricingHistoryView = {
  key: "divine",
  name: "Divine Orb",
  league: "Runes of Aldur",
  source: "local-history",
  since: "2026-08-23T06:00:00.000Z",
  points: [
    { time: "2026-09-10T00:00:00.000Z", price: 640, quantity: 120_000 },
    { time: "2026-09-11T00:00:00.000Z", price: 645, quantity: 121_000 },
    { time: "2026-09-12T00:00:00.000Z", price: 649.45, quantity: 60_000 },
  ],
};

async function mountTool() {
  const wrapper = mount(PricingHistoryTool, { attachTo: document.body });
  await flushPromises();
  return wrapper;
}

function buttonByText(wrapper: ReturnType<typeof mount>, text: string) {
  const found = wrapper.findAll("button").find((candidate) => candidate.text() === text);
  if (!found) throw new Error(`no button "${text}"`);
  return found;
}

function rowKeys(wrapper: ReturnType<typeof mount>): string[] {
  return wrapper.findAll("tbody tr").map((entry) => entry.attributes("data-row-key") ?? "");
}

describe("PricingHistoryTool", () => {
  beforeEach(() => {
    bridge.available = true;
    bridge.overviewError = "";
    bridge.query = {};
    bridge.listeners.clear();
    bridge.overview.mockReset().mockResolvedValue(view());
    bridge.history.mockReset().mockResolvedValue(HISTORY);
    bridge.toggleFavorite
      .mockReset()
      .mockImplementation(async (key: string) => ({ ...SETTINGS, favorites: [key] }));
    bridge.configure
      .mockReset()
      .mockImplementation(async (patch: Partial<PricingSettings>) => ({ ...SETTINGS, ...patch }));
    bridge.leagues
      .mockReset()
      .mockResolvedValue([
        { league: "Runes of Aldur", since: "2026-08-23T06:00:00.000Z", keys: 6, bars: 120, file: "f", bytes: 40_960 },
      ]);
    bridge.clearHistory.mockReset().mockResolvedValue(1);
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the desktop-only state without the bridge", async () => {
    bridge.available = false;
    const wrapper = await mountTool();
    expect(wrapper.text()).toContain("needs the desktop app");
    expect(wrapper.find("table").exists()).toBe(false);
    expect(bridge.overview).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("shows the header stamp, category counts and the rows a cachedOnly load returned", async () => {
    const wrapper = await mountTool();
    expect(bridge.overview).toHaveBeenCalledWith({ cachedOnly: true });
    expect(wrapper.get("[role=status]").text()).toContain("Runes of Aldur · 4 items");
    expect(wrapper.findAll("nav.category-strip button").map((button) => button.text())).toEqual([
      "All 4",
      "★ Favorites 0",
      "Currency 2",
      "Essences 1",
      "Uniques (no history) 1",
    ]);
    // Low stock hidden by default, and the count says so.
    expect(rowKeys(wrapper)).toEqual(["divine", "chaos", "temporalis"]);
    expect(wrapper.get("tfoot").text()).toContain("1 low-stock rows hidden");
    expect(wrapper.get("tfoot").text()).toContain("1 div ≈ 649.45 ex (poe2scout divine)");
    // Auto units: over a divine reads in divine, under it in exalted.
    expect(wrapper.find("tbody tr").text()).toContain("1 div");
    expect(wrapper.findAll("tbody tr")[2]!.text()).toContain("no history");
    wrapper.unmount();
  });

  it("stars a row and lists it under Favorites after the settings event", async () => {
    const wrapper = await mountTool();
    await wrapper.get('button[aria-label="Star Divine Orb"]').trigger("click");
    await flushPromises();
    expect(bridge.toggleFavorite).toHaveBeenCalledWith("divine");

    bridge.listeners.get("pricing:settings")!({ ...SETTINGS, favorites: ["divine"], category: "favorites" });
    await flushPromises();
    expect(rowKeys(wrapper)).toEqual(["divine"]);
    expect(wrapper.get('button[aria-label="Unstar Divine Orb"]').text()).toBe("★");
    wrapper.unmount();
  });

  it("searches across every category and switches the strip to All", async () => {
    bridge.overview.mockResolvedValue(view({ settings: { ...SETTINGS, category: "currency" } }));
    const wrapper = await mountTool();
    expect(rowKeys(wrapper)).toEqual(["divine", "chaos"]);
    await wrapper.get('input[type="search"]').setValue("silk");
    await flushPromises();
    expect(bridge.configure).toHaveBeenCalledWith({ category: "all" });
    expect(rowKeys(wrapper)).toEqual(["temporalis"]);
    await wrapper.get('input[type="search"]').setValue("");
    await flushPromises();
    expect(bridge.configure).toHaveBeenLastCalledWith({ category: "currency" });
    wrapper.unmount();
  });

  it("keeps the category the user picked by hand when the search is cleared", async () => {
    bridge.overview.mockResolvedValue(view({ settings: { ...SETTINGS, category: "currency" } }));
    const wrapper = await mountTool();
    await wrapper.get('input[type="search"]').setValue("orb");
    await flushPromises();
    expect(bridge.configure).toHaveBeenLastCalledWith({ category: "all" });
    await buttonByText(wrapper, "Essences 1").trigger("click");
    await flushPromises();
    expect(bridge.configure).toHaveBeenLastCalledWith({ category: "essences" });
    await wrapper.get('input[type="search"]').setValue("");
    await flushPromises();
    // Not back to "currency": the hand-picked category wins over the memo.
    expect(bridge.configure).toHaveBeenLastCalledWith({ category: "essences" });
    wrapper.unmount();
  });

  it("counts the rows it hid using the favorite flags the user just set", async () => {
    const wrapper = await mountTool();
    // Essence of Ruin is low stock; starring it and switching to Favorites
    // must not leave the user with a bare "No items match".
    bridge.listeners.get("pricing:settings")!({ ...SETTINGS, favorites: ["ruin"], category: "favorites" });
    await flushPromises();
    expect(rowKeys(wrapper)).toEqual([]);
    expect(wrapper.text()).toContain("1 low-stock");
    wrapper.unmount();
  });

  it("says so when a favorite is refused at the cap", async () => {
    const wrapper = await mountTool();
    bridge.toggleFavorite.mockResolvedValueOnce({
      ...SETTINGS,
      favorites: Array.from({ length: 200 }, (_unused, index) => `k-${index}`),
    });
    await wrapper.get('button[aria-label="Star Divine Orb"]').trigger("click");
    await flushPromises();
    expect(wrapper.get(".danger-text").text()).toContain("capped at 200");
    wrapper.unmount();
  });

  it("lets an in-flight refresh finish instead of dropping it for the 60 s poll", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const wrapper = await mountTool();
    let settle: (value: PricingOverviewView) => void = () => undefined;
    bridge.overview.mockImplementationOnce(
      () =>
        new Promise<PricingOverviewView>((resolve) => {
          settle = resolve;
        }),
    );
    await buttonByText(wrapper, "Refresh").trigger("click");
    const callsBeforePoll = bridge.overview.mock.calls.length;
    vi.advanceTimersByTime(180_000);
    await flushPromises();
    // The poll skipped its turn instead of bumping the request sequence.
    expect(bridge.overview.mock.calls.length).toBe(callsBeforePoll);

    settle(view({ rows: [ROWS[0]!], fetchedAt: "2026-09-13T06:00:00.000Z" }));
    await flushPromises();
    expect(rowKeys(wrapper)).toEqual(["divine"]);
    expect(wrapper.get("[role=status]").text()).toContain("1 items");
    wrapper.unmount();
  });

  it("repaints when another screen refreshes the shared trends cache", async () => {
    const wrapper = await mountTool();
    bridge.overview.mockResolvedValue(view({ rows: [ROWS[1]!] }));
    bridge.listeners.get("pricing:refreshed")!({
      league: "Runes of Aldur",
      fetchedAt: "2026-09-13T06:00:00.000Z",
      addedBars: 3,
    });
    await flushPromises();
    expect(rowKeys(wrapper)).toEqual(["chaos"]);
    wrapper.unmount();
  });

  it("sorts, flips the direction and shows low-stock rows on demand", async () => {
    const wrapper = await mountTool();
    await wrapper.get(".pricing-toolbar select").setValue("price");
    await flushPromises();
    expect(bridge.configure).toHaveBeenCalledWith({ sort: { key: "price", direction: "desc" } });
    expect(rowKeys(wrapper)).toEqual(["temporalis", "divine", "chaos"]);

    await wrapper.get('button[aria-label="Sort ascending"]').trigger("click");
    await flushPromises();
    expect(bridge.configure).toHaveBeenLastCalledWith({ sort: { key: "price", direction: "asc" } });
    expect(rowKeys(wrapper)).toEqual(["chaos", "divine", "temporalis"]);

    await wrapper.get('.inline-toggle input[type="checkbox"]').setValue(false);
    await flushPromises();
    expect(bridge.configure).toHaveBeenLastCalledWith({ hideLowStock: false });
    expect(rowKeys(wrapper)).toContain("ruin");
    wrapper.unmount();
  });

  it("pages with Show more", async () => {
    const many = Array.from({ length: 130 }, (_unused, index) =>
      row({ key: `k-${index}`, name: `Item ${index}`, current: index + 1 }),
    );
    bridge.overview.mockResolvedValue(view({ rows: many, categories: [] }));
    const wrapper = await mountTool();
    expect(wrapper.findAll("tbody tr")).toHaveLength(100);
    await buttonByText(wrapper, "Show more").trigger("click");
    expect(wrapper.findAll("tbody tr")).toHaveLength(130);
    expect(wrapper.findAll("button").some((button) => button.text() === "Show more")).toBe(false);
    wrapper.unmount();
  });

  it("selects a row, draws the timeline and closes again", async () => {
    const wrapper = await mountTool();
    await wrapper.get("button.row-name").trigger("click");
    await flushPromises();
    expect(bridge.history).toHaveBeenCalledWith("divine");
    const detail = wrapper.get(".pricing-detail");
    expect(detail.text()).toContain("Divine Orb");
    expect(detail.text()).toContain("3 (local-history)");
    expect(detail.findAll("svg rect")).toHaveLength(3);
    // Each bar carries its own numbers for a reader without a mouse — and all
    // three read in ONE unit, chosen from the most expensive bar (649.45 ex is
    // exactly one divine here), never half the window in each.
    expect(detail.findAll("svg rect title").map((entry) => entry.text())).toEqual([
      "09-10 · 0.9854 div · 120000 traded",
      "09-11 · 0.9931 div · 121000 traded",
      "09-12 · 1 div · 60000 traded",
    ]);

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis.navigator, "clipboard", { value: { writeText }, configurable: true });
    await buttonByText(wrapper, "Copy name").trigger("click");
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith("Divine Orb");

    await buttonByText(wrapper, "Close").trigger("click");
    expect(wrapper.find(".pricing-detail").exists()).toBe(false);
    wrapper.unmount();
  });

  it("pre-fills the search from the route query", async () => {
    bridge.query = { q: "Divine" };
    const wrapper = await mountTool();
    expect((wrapper.get('input[type="search"]').element as HTMLInputElement).value).toBe("Divine");
    expect(rowKeys(wrapper)).toEqual(["divine"]);
    wrapper.unmount();
  });

  it("refreshes on demand and shows the stale chip and the last refresh error once", async () => {
    bridge.overview.mockResolvedValue(view({ stale: true, error: "poe2scout → HTTP 503" }));
    const wrapper = await mountTool();
    expect(wrapper.get(".status-chip.warning").text()).toBe("older than 12 h");
    expect(wrapper.findAll(".inline-notice.warning")).toHaveLength(1);
    await buttonByText(wrapper, "Refresh").trigger("click");
    expect(bridge.overview).toHaveBeenLastCalledWith({ refresh: true });
    wrapper.unmount();
  });

  it("offers the empty state with the request cost when nothing is cached", async () => {
    bridge.overview.mockResolvedValue(
      view({ ok: false, rows: [], categories: [], league: undefined, fetchedAt: undefined, history: undefined }),
    );
    const wrapper = await mountTool();
    expect(wrapper.text()).toContain("No price history yet");
    expect(wrapper.text()).toContain("~12 requests");
    expect(wrapper.text()).toContain("No items match");
    wrapper.unmount();
  });

  it("reports a thrown bridge error with a Retry instead of hanging on the spinner", async () => {
    bridge.overviewError = "ipc down";
    const wrapper = await mountTool();
    expect(wrapper.find(".spinner").exists()).toBe(false);
    expect(wrapper.get("[role=alert]").text()).toBe("ipc down");
    bridge.overviewError = "";
    await buttonByText(wrapper, "Retry").trigger("click");
    await flushPromises();
    expect(wrapper.find("table").exists()).toBe(true);
    wrapper.unmount();
  });

  it("clears the local history only on the second click", async () => {
    const wrapper = await mountTool();
    expect(wrapper.get("details.advanced-options").text()).toContain("40 KB");
    await buttonByText(wrapper, "Clear local history").trigger("click");
    expect(bridge.clearHistory).not.toHaveBeenCalled();
    await buttonByText(wrapper, "Confirm: delete every history file").trigger("click");
    await flushPromises();
    expect(bridge.clearHistory).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });
});
