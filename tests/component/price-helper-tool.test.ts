// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import PriceHelperTool from "../../src/renderer/components/tools/PriceHelperTool.vue";
import { EXCHANGE_CATEGORIES, helperDefaults, type HelperStatus } from "../../src/core/priceHelper.js";

afterEach(() => { delete window.poe2; });
describe("price helper controls", () => {
  it("explains the desktop requirement in browser preview", async () => {
    const wrapper = mount(PriceHelperTool); await flushPromises();
    expect(wrapper.text()).toContain("Open the desktop companion");
    expect(wrapper.get("fieldset").attributes("disabled")).toBeDefined(); wrapper.unmount();
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
