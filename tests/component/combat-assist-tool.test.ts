// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import CombatAssistTool from "../../src/renderer/components/tools/CombatAssistTool.vue";
import { defaultCombatConfig, type CombatConfig, type CombatStatus } from "../../src/core/combatAssist.js";

afterEach(() => { delete window.poe2; vi.useRealTimers(); });
describe("combat controls", () => {
  it("shows a no-input fallback without the native bridge", () => {
    const wrapper = mount(CombatAssistTool);
    expect(wrapper.text()).toContain("Open the desktop app");
    expect(wrapper.get("fieldset").attributes()).toHaveProperty("disabled");
    wrapper.unmount();
  });
  it("saves independent toggles and keys, starts explicitly, and stops", async () => {
    let state: CombatStatus = { config: defaultCombatConfig(), running: false, reason: "Stopped", actions: 0 };
    const configure = vi.fn(async (config: CombatConfig) => state = { ...state, config });
    const start = vi.fn(async () => state = { ...state, running: true });
    const stop = vi.fn(async () => state = { ...state, running: false });
    window.poe2 = { combat: { status: async () => structuredClone(state), configure, start, stop, preview: vi.fn(), setGlobalDryRun: vi.fn() } } as unknown as NonNullable<typeof window.poe2>;
    const wrapper = mount(CombatAssistTool); await flushPromises();
    await wrapper.get('input[aria-label="health flask key"]').setValue("Q");
    await wrapper.findAll('input[type="checkbox"]')[0].setValue(true);
    await wrapper.findAll('input[type="checkbox"]')[2].setValue(true);
    const startButton = wrapper.findAll("button").find((b) => b.text() === "Save & start")!;
    await startButton.trigger("click"); await flushPromises();
    expect(configure).toHaveBeenCalledWith(expect.objectContaining({
      health: expect.objectContaining({ enabled: true, key: "Q", threshold: 25 }),
      mana: expect.objectContaining({ enabled: false, key: "2" }),
      unleash: expect.objectContaining({ enabled: true, key: "R" }),
    }));
    expect(start).toHaveBeenCalledOnce();
    await wrapper.findAll("button").find((b) => b.text() === "Stop")!.trigger("click"); await flushPromises();
    expect(stop).toHaveBeenCalledOnce(); wrapper.unmount();
  });
  it("shows actionable calibration failures instead of appearing to start", async () => {
    const state: CombatStatus = { config: defaultCombatConfig(), running: false, reason: "Stopped", actions: 0 };
    window.poe2 = { combat: { status: async () => state, configure: async () => { throw new Error("Select a full health strip"); } } } as unknown as NonNullable<typeof window.poe2>;
    const wrapper = mount(CombatAssistTool); await flushPromises();
    await wrapper.findAll("button").find((b) => b.text() === "Save & start")!.trigger("click"); await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain("Select a full health strip"); wrapper.unmount();
  });
});
