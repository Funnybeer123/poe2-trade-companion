// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { DEFAULT_MARKET_SETTINGS, type MarketSettings } from "../../src/core/marketSettings.js";
import MarketSettingsSection from "../../src/renderer/features/market/settings/MarketSettingsSection.vue";

function section(overrides: Partial<MarketSettings> = {}) {
  return mount(MarketSettingsSection, { props: { settings: { ...DEFAULT_MARKET_SETTINGS, ...overrides } } });
}

describe("MarketSettingsSection", () => {
  it("keeps the everyday fields visible and the expert ones behind a disclosure", () => {
    const wrapper = section();
    expect(wrapper.text()).toContain("Default seller status");
    const nested = wrapper.find("details.nested");
    expect(nested.exists()).toBe(true);
    expect(nested.text()).toContain("Fetch slots kept spare");
    expect(nested.text()).toContain("Stop live searches after");
  });

  it("spells out what resuming live searches does", () => {
    expect(section().text()).toContain("opens websockets to pathofexile.com with your POESESSID on every app start");
  });

  it("emits a patch for a select", async () => {
    const wrapper = section();
    const status = wrapper.findAll("select")[0]!;
    await status.setValue("any");
    expect(wrapper.emitted("patch")?.at(-1)?.[0]).toEqual({ defaultStatus: "any" });
  });

  it("emits a clamped number", async () => {
    const wrapper = section();
    const stale = wrapper.find("input[type='number']");
    await stale.setValue("100000");
    await stale.trigger("change");
    expect(wrapper.emitted("patch")?.at(-1)?.[0]).toEqual({ staleAfterHours: 720 });
  });

  it("emits a toggle", async () => {
    const wrapper = section();
    const collapse = wrapper.findAll("input[type='checkbox']")[0]!;
    await collapse.setValue(false);
    expect(wrapper.emitted("patch")?.at(-1)?.[0]).toEqual({ collapseAfterOffer: false });
  });

  it("flags the unverified buyout mapping and closes with the estimate line", () => {
    const wrapper = section();
    expect(wrapper.text()).toContain("unverified mapping");
    expect(wrapper.text()).toContain("never guaranteed sale prices");
  });
});
