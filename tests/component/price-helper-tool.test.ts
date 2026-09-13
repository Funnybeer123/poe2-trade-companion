// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import PriceHelperTool from "../../src/renderer/components/tools/PriceHelperTool.vue";
import { EXCHANGE_CATEGORIES, helperDefaults, type HelperRow, type HelperStatus } from "../../src/core/priceHelper.js";

afterEach(() => { delete window.poe2; vi.useRealTimers(); });
describe("price helper controls", () => {
  it("explains the desktop requirement in browser preview", async () => {
    const wrapper = mount(PriceHelperTool); await flushPromises();
    expect(wrapper.text()).toContain("Open the desktop companion");
    expect(wrapper.get("fieldset").attributes("disabled")).toBeDefined(); wrapper.unmount();
  });
  it("explains value colors and highlights only current priced estimates", async () => {
    const row = (name: string, extra: Partial<HelperRow> = {}): HelperRow => ({ text: name, name, state: "priced", stale: false, detail: "1 div", ...extra });
    const state: HelperStatus = { config: helperDefaults(), running: false, refreshing: false, message: "Ready", categories: [], rows: [
      row("Ordinary item"), row("High value item", { valueTier: "high" }), row("Very high value item", { valueTier: "very-high" }),
      row("Old estimate", { stale: true, valueTier: "very-high" }), row("Unknown item", { state: "unknown", valueTier: "high" }),
      row("Missing price", { state: "no-data", valueTier: "high" }), row("Community rating", { state: "rumour", valueTier: "very-high" }),
    ], rumourCount: 0, hotkeyErrors: [] };
    window.poe2 = { priceHelper: { status: vi.fn(async () => state) } } as unknown as NonNullable<Window["poe2"]>;
    const wrapper = mount(PriceHelperTool); await flushPromises();
    const legend = wrapper.get('[aria-label="Price highlight legend"]');
    expect(legend.text()).toContain("Gold ≥ 1 divine"); expect(legend.text()).toContain("Pink ≥ 10 divine");
    expect(legend.text()).toContain("stack total"); expect(legend.text()).toContain("per-item estimate when quantity is unreadable");
    const cells = wrapper.findAll("tbody tr").map(tr => tr.findAll("td")[1]);
    expect(cells[0].classes()).toEqual([]);
    expect(cells[1].classes()).toEqual(["value-high"]); expect(cells[2].classes()).toEqual(["value-very-high"]);
    expect(cells[3].classes()).toEqual(["stale"]);
    for (const cell of cells.slice(4)) expect(cell.classes()).toEqual([]);
    wrapper.unmount();
  });
  it("keeps the price highlight legend out of rumour mode", async () => {
    const state: HelperStatus = { config: { ...helperDefaults(), mode: "rumours" }, running: false, refreshing: false, message: "Ready", categories: [], rows: [], rumourCount: 0, hotkeyErrors: [] };
    window.poe2 = { priceHelper: { status: vi.fn(async () => state) } } as unknown as NonNullable<Window["poe2"]>;
    const wrapper = mount(PriceHelperTool); await flushPromises();
    expect(wrapper.find('[aria-label="Price highlight legend"]').exists()).toBe(false);
    wrapper.unmount();
  });
  it("retains the last captured rows after focus loss and identifies them as an older list", async () => {
    vi.useFakeTimers();
    const captured: HelperRow = { text: "Skill Level 20: Rain of Blades", state: "no-data", stale: false, detail: "Not in the exchange feed", liveLookup: true };
    let state: HelperStatus = { config: helperDefaults(), running: true, refreshing: false, message: "Scanning prices", categories: [], rows: [captured], rumourCount: 0, hotkeyErrors: [] };
    const bridge = { status: vi.fn(async () => structuredClone(state)), lookup: vi.fn(async () => [{ text: "Manual item", state: "unknown" as const, stale: false, detail: "?" }]) };
    window.poe2 = { priceHelper: bridge } as unknown as NonNullable<Window["poe2"]>;
    const wrapper = mount(PriceHelperTool); await flushPromises();
    expect(wrapper.text()).not.toContain("Last captured list");
    state = { ...state, rows: [], lastRows: [captured], lastCaptureAt: "2026-09-13T01:00:00Z", message: "Paused: game focus changed." };
    await vi.advanceTimersByTimeAsync(1000); await flushPromises();
    expect(wrapper.get("tbody").text()).toContain(captured.text);
    expect(wrapper.text()).toContain("Last captured list"); expect(wrapper.text()).toContain("These rows are from the last successful capture.");
    expect(wrapper.findAll("button").some(button => button.text() === "Check live price")).toBe(true);
    await wrapper.get("textarea").setValue("Manual item");
    await wrapper.findAll("button").find(button => button.text() === "Look up list")!.trigger("click"); await flushPromises();
    expect(wrapper.get("tbody").text()).toContain("Manual item"); expect(wrapper.get("tbody").text()).not.toContain(captured.text);
    expect(wrapper.text()).not.toContain("Last captured list"); wrapper.unmount();
  });
  it("checks one exact reward through the bridge and shows the listing source, sample count and limitations", async () => {
    const captured: HelperRow = { text: "Skill Level 20: Rain of Blades", state: "no-data", stale: false, detail: "Live lookup available", liveLookup: true };
    const quote: HelperRow = { ...captured, state: "priced", source: "trade", sampleCount: 5, unit: 2, total: 2, quantity: 1, currency: "div", rangeHigh: 4, detail: "≈2–4 div · observed listings" };
    const state: HelperStatus = { config: helperDefaults(), running: false, refreshing: false, message: "Paused", categories: [], rows: [], lastRows: [captured], lastCaptureAt: "2026-09-13T01:00:00Z", catalogCount: 6, rumourCount: 0, hotkeyErrors: [] };
    let finish!: (row: HelperRow) => void;
    const bridge = { status: vi.fn(async () => structuredClone(state)), lookupLive: vi.fn(() => new Promise<HelperRow>(resolve => { finish = resolve; })), openTrade: vi.fn(async () => {}) };
    window.poe2 = { priceHelper: bridge } as unknown as NonNullable<Window["poe2"]>;
    const wrapper = mount(PriceHelperTool); await flushPromises();
    await wrapper.findAll("button").find(button => button.text() === "Check live price")!.trigger("click");
    expect(bridge.lookupLive).toHaveBeenCalledWith(captured.text);
    expect(wrapper.get("tbody").text()).toContain("Checking…");
    finish(quote); await flushPromises();
    expect(wrapper.get("tbody").text()).toContain("≈2–4 div");
    expect(wrapper.get("tbody").text()).toContain("Official trade listings · 5 samples");
    expect(wrapper.get("tbody").text()).toContain("quality, corruption and sockets can differ");
    expect(wrapper.text()).toContain("Live searches preserve the exact gem name and level");
    expect(wrapper.text()).toContain("6 official catalogue entries loaded for exact matching");
    await wrapper.findAll("button").find(button => button.text() === "Open trade search")!.trigger("click"); await flushPromises();
    expect(bridge.openTrade).toHaveBeenCalledWith(captured.text); wrapper.unmount();
  });
  it("shows a live lookup failure beside its row", async () => {
    const state: HelperStatus = { config: helperDefaults(), running: false, refreshing: false, message: "Ready", categories: [], rows: [{ text: "Skill Level 20: Hollow Shell", state: "no-data", stale: false, detail: "Live lookup available", liveLookup: true }], rumourCount: 0, hotkeyErrors: [] };
    const bridge = { status: vi.fn(async () => state), lookupLive: vi.fn(async () => { throw new Error("Trade lookup is rate limited. Try again later."); }) };
    window.poe2 = { priceHelper: bridge } as unknown as NonNullable<Window["poe2"]>;
    const wrapper = mount(PriceHelperTool); await flushPromises();
    await wrapper.findAll("button").find(button => button.text() === "Check live price")!.trigger("click"); await flushPromises();
    expect(wrapper.get('tbody [role="alert"]').text()).toContain("rate limited");
    expect(wrapper.findAll("button").find(button => button.text() === "Check live price")!.attributes("disabled")).toBeUndefined();
    wrapper.unmount();
  });
  it("saves the missing-reward live lookup preference", async () => {
    const state: HelperStatus = { config: { ...helperDefaults(), livePrices: true }, running: false, refreshing: false, message: "Ready", categories: [], rows: [], rumourCount: 0, hotkeyErrors: [] };
    const bridge = { status: vi.fn(async () => state), configure: vi.fn(async (config: HelperStatus["config"]) => ({ ...state, config })) };
    window.poe2 = { priceHelper: bridge } as unknown as NonNullable<Window["poe2"]>;
    const wrapper = mount(PriceHelperTool); await flushPromises();
    expect(wrapper.text()).toContain("Look up missing reward prices live");
    await wrapper.get("#helper-live-prices").setValue(false); await flushPromises();
    expect(bridge.configure).toHaveBeenCalledWith(expect.objectContaining({ livePrices: false })); wrapper.unmount();
  });
  it("uses the bridge for refresh and escaped lookup results", async () => {
    const state: HelperStatus = { config: helperDefaults(), running: false, refreshing: false, message: "Ready", categories: EXCHANGE_CATEGORIES.map(category => ({ category, count: 0 })), rows: [], rumourCount: 0, hotkeyErrors: [] };
    const bridge = { status: vi.fn(async () => state), refresh: vi.fn(async () => ({ ...state, message: "All five price categories refreshed." })), configure: vi.fn(async () => state), lookup: vi.fn(async () => [{ text: '<img src=x onerror="alert(1)">', state: "unknown" as const, stale: false, detail: "? — unknown" }]) };
    window.poe2 = { priceHelper: bridge } as unknown as NonNullable<Window["poe2"]>;
    const wrapper = mount(PriceHelperTool); await flushPromises();
    expect(wrapper.text()).toContain("Uncut gems");
    await wrapper.findAll("button").find(b => b.text() === "Refresh prices")!.trigger("click"); await flushPromises();
    expect(bridge.refresh).toHaveBeenCalledTimes(1);
    await wrapper.get("textarea").setValue("something");
    await wrapper.findAll("button").find(b => b.text() === "Look up list")!.trigger("click"); await flushPromises();
    expect(wrapper.find("img").exists()).toBe(false); expect(wrapper.text()).toContain('<img src=x onerror="alert(1)">');
    wrapper.unmount();
  });
});
