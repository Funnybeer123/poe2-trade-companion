// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import PriceHelperTool from "../../src/renderer/components/tools/PriceHelperTool.vue";
import { EXCHANGE_CATEGORIES, helperDefaults, type HelperRow, type HelperStatus } from "../../src/core/priceHelper.js";

afterEach(() => { delete window.poe2; });
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
