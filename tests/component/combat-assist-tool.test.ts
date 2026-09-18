// @vitest-environment happy-dom
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import CombatAssistTool from "../../src/renderer/components/tools/CombatAssistTool.vue";
import { defaultCombatConfig, type CombatConfig, type CombatStatus } from "../../src/core/combatAssist.js";
import { calibratedCombat, color } from "../combatFixtures.js";
import { useCombatDraft } from "../../src/renderer/composables/useCombatDraft.js";

afterEach(() => { delete window.poe2; vi.useRealTimers(); vi.restoreAllMocks(); });
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
    await wrapper.get('select[aria-label="health flask key"]').setValue("Q");
    await wrapper.get('select[aria-label="mana flask key"]').setValue("2");
    await wrapper.get('select[aria-label="mana flask key"]').setValue("MOUSE5");
    await wrapper.findAll('input[type="checkbox"]')[0].setValue(true);
    await wrapper.findAll('input[type="checkbox"]')[2].setValue(true);
    const startButton = wrapper.findAll("button").find((b) => b.text() === "Save & start")!;
    await startButton.trigger("click"); await flushPromises();
    expect(configure).toHaveBeenCalledWith(expect.objectContaining({
      health: expect.objectContaining({ enabled: true, key: "Q", threshold: 25 }),
      mana: expect.objectContaining({ enabled: false, key: "MOUSE5" }),
      unleash: expect.objectContaining({ enabled: true, key: "R" }),
      verisium: expect.objectContaining({ enabled: false, key: "T" }),
    }));
    expect(wrapper.get('select[aria-label="Powered by Verisium key"]').element).toHaveProperty("value", "T");
    expect(start).toHaveBeenCalledOnce();
    await wrapper.findAll("button").find((b) => b.text() === "Stop")!.trigger("click"); await flushPromises();
    expect(stop).toHaveBeenCalledOnce(); wrapper.unmount();
  });
  it("saves the manual Sigil macro, enables its skills and preserves timings across navigation", async () => {
    let state: CombatStatus = { config: defaultCombatConfig(), running: false, reason: "Stopped", actions: 0 };
    const configure = vi.fn(async (config: CombatConfig) => state = { ...state, config });
    window.poe2 = { combat: { status: async () => structuredClone(state), configure } } as unknown as NonNullable<typeof window.poe2>;
    let wrapper = mount(CombatAssistTool); await flushPromises();
    await wrapper.get('.sigil-sequence input[type="checkbox"]').setValue(true);
    await wrapper.get('input[aria-label="Sigil cast delay"]').setValue(320);
    wrapper.unmount(); wrapper = mount(CombatAssistTool); await flushPromises();
    expect(wrapper.get('input[aria-label="Sigil cast delay"]').element).toHaveProperty("value", "320");
    await wrapper.findAll("button").find((b) => b.text() === "Save settings")!.trigger("click"); await flushPromises();
    expect(state.config.sigilSequence).toEqual({ enabled: true, swapKey: "X", castMs: 320, swapMs: 100 });
    expect(state.config.unleash.enabled && state.config.verisium.enabled).toBe(true);
    expect(wrapper.text()).toContain("One cycle per press");
    expect(wrapper.text()).toContain("Your R press reaches the game normally");
    expect(wrapper.text()).toContain("Skill calibration is not required");
    expect(wrapper.text()).not.toContain("Casts when ready");
    expect(wrapper.find('#combat-cooldown-tab').exists()).toBe(false);
    expect(wrapper.find('input[aria-label="Sigil of Power minimum gap"]').exists()).toBe(false);
    expect(wrapper.findAll("button").some((button) => button.text() === "Save & arm")).toBe(true);
    expect(wrapper.get("details").attributes("open")).toBeUndefined();
    await wrapper.get('.sigil-sequence input[type="checkbox"]').setValue(false);
    await wrapper.findAll("button").find((b) => b.text() === "Save settings")!.trigger("click"); await flushPromises();
    expect(state.config.sigilSequence.enabled).toBe(false);
    expect(state.config.unleash.enabled || state.config.verisium.enabled).toBe(false);
    expect(wrapper.text()).toContain("Casts when ready");
    wrapper.unmount();
  });
  it("shows actionable calibration failures instead of appearing to start", async () => {
    const state: CombatStatus = { config: defaultCombatConfig(), running: false, reason: "Stopped", actions: 0 };
    window.poe2 = { combat: { status: async () => state, configure: async () => { throw new Error("Select a full health strip"); } } } as unknown as NonNullable<typeof window.poe2>;
    const wrapper = mount(CombatAssistTool); await flushPromises();
    await wrapper.findAll("button").find((b) => b.text() === "Save & start")!.trigger("click"); await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain("Select a full health strip"); wrapper.unmount();
  });
});

describe("separate calibration screenshots and session drafts", () => {
  function bridge(config = calibratedCombat()) {
    let state: CombatStatus = { config, running: false, reason: "Stopped", actions: 0 };
    const api = {
      status: vi.fn(async () => structuredClone(state)),
      configure: vi.fn(async (next: CombatConfig) => state = { ...state, config: next }),
      start: vi.fn(async () => state), stop: vi.fn(async () => state),
      preview: vi.fn(), setGlobalDryRun: vi.fn(),
    };
    window.poe2 = { combat: api } as unknown as NonNullable<typeof window.poe2>;
    return api;
  }
  async function button(wrapper: VueWrapper, label: string) {
    await wrapper.findAll("button").find((b) => b.text() === label)!.trigger("click");
    await flushPromises();
  }
  async function capture(wrapper: VueWrapper, label: string) {
    await button(wrapper, label);
    await vi.advanceTimersByTimeAsync(3000);
    await flushPromises();
  }
  function loadedScreenshot(wrapper: VueWrapper) {
    const img = wrapper.get<HTMLImageElement>(".hud-preview img").element;
    Object.defineProperty(img, "complete", { configurable: true, value: true });
    Object.defineProperty(img, "naturalWidth", { configurable: true, value: 2560 });
  }
  it("shows exact saved ready and cooldown RGB references without session screenshots", async () => {
    const api = bridge();
    const wrapper = mount(CombatAssistTool); await flushPromises();
    const ready = wrapper.get('svg[aria-label^="Recorded ready reference"]');
    const cooldown = wrapper.get('svg[aria-label^="Recorded cooldown reference"]');
    expect(ready.findAll("rect")).toHaveLength(256);
    expect(ready.get("rect").attributes("fill")).toBe("rgb(180,70,220)");
    expect(cooldown.findAll("rect")).toHaveLength(256);
    expect(cooldown.get("rect").attributes("fill")).toBe("rgb(40,15,50)");
    expect(wrapper.find(".hud-preview").exists()).toBe(false);
    expect(api.preview).not.toHaveBeenCalled();
    wrapper.unmount();
  });
  it("keeps independent screenshots, capture times and unsaved detector data across navigation", async () => {
    vi.useFakeTimers();
    const api = bridge();
    const readyShot = { image: "data:image/png;base64,ready-shot", width: 2560, height: 1440 };
    const cooldownShot = { ...readyShot, image: "data:image/png;base64,cooldown-shot" };
    api.preview.mockResolvedValueOnce(readyShot).mockResolvedValueOnce(cooldownShot);
    let drawnImage = "";
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ({
      drawImage: (img: HTMLImageElement) => { drawnImage = img.getAttribute("src")!; },
      getImageData: (_x: number, _y: number, width: number, height: number) => ({
        data: new Uint8ClampedArray(Array.from({ length: width * height }, () => drawnImage === cooldownShot.image ? [12, 23, 34, 255] : [180, 70, 220, 255]).flat()),
      }),
    }) as unknown as CanvasRenderingContext2D);
    let wrapper = mount(CombatAssistTool); await flushPromises();
    await wrapper.get('input[aria-label="health threshold"]').setValue(29);
    await capture(wrapper, "Capture HUD / ready in 3 seconds");
    const readyTime = wrapper.get(".capture-time time").attributes("datetime");
    await button(wrapper, "Unleash cooldown");
    expect(wrapper.find(".hud-preview").exists()).toBe(false);
    expect(wrapper.findAll("button").find((b) => b.text() === "Record cooldown from screenshot")!.attributes()).toHaveProperty("disabled");
    await capture(wrapper, "Capture cooldown in 3 seconds");
    const cooldownTime = wrapper.get(".capture-time time").attributes("datetime");
    expect(cooldownTime).not.toBe(readyTime);
    loadedScreenshot(wrapper);
    await button(wrapper, "Record cooldown from screenshot");
    expect(drawnImage).toBe(cooldownShot.image);
    expect(wrapper.get('svg[aria-label^="Recorded cooldown reference"] rect').attributes("fill")).toBe("rgb(12,23,34)");
    expect(wrapper.get('svg[aria-label^="Recorded ready reference"] rect').attributes("fill")).toBe("rgb(180,70,220)");
    expect(api.configure).not.toHaveBeenCalled();
    wrapper.unmount();
    wrapper = mount(CombatAssistTool); await flushPromises();
    expect(wrapper.get('input[aria-label="health threshold"]').element).toHaveProperty("value", "29");
    expect(wrapper.get('#combat-cooldown-tab').attributes("aria-selected")).toBe("true");
    expect(wrapper.get(".hud-preview img").attributes("src")).toBe(cooldownShot.image);
    expect(wrapper.get(".capture-time time").attributes("datetime")).toBe(cooldownTime);
    expect(wrapper.get('svg[aria-label^="Recorded cooldown reference"] rect').attributes("fill")).toBe("rgb(12,23,34)");
    await button(wrapper, "HUD / ready");
    expect(wrapper.get(".hud-preview img").attributes("src")).toBe(readyShot.image);
    expect(wrapper.get(".capture-time time").attributes("datetime")).toBe(readyTime);
    await button(wrapper, "Save settings");
    expect(api.configure).toHaveBeenCalledWith(expect.objectContaining({
      health: expect.objectContaining({ threshold: 29 }),
      regions: expect.objectContaining({ unleash: expect.objectContaining({ reference: color(180, 70, 220), cooldown: color(12, 23, 34) }) }),
    }));
    expect(api.start).not.toHaveBeenCalled();
    wrapper.unmount();
  });
  it("blocks a different-resolution cooldown screenshot without clearing the HUD calibration", async () => {
    vi.useFakeTimers();
    const config = calibratedCombat(); delete config.regions.unleash!.cooldown;
    const api = bridge(config);
    api.preview.mockResolvedValue({ image: "data:image/png;base64,wrong-size", width: 1920, height: 1080 });
    const wrapper = mount(CombatAssistTool); await flushPromises();
    await button(wrapper, "Unleash cooldown");
    await capture(wrapper, "Capture cooldown in 3 seconds");
    expect(wrapper.text()).toContain("Screenshot size differs from the calibrated HUD");
    expect(wrapper.findAll("button").find((b) => b.text() === "Record cooldown from screenshot")!.attributes()).toHaveProperty("disabled");
    expect(wrapper.find('svg[aria-label^="Recorded cooldown reference · Unleash"]').exists()).toBe(false);
    expect(wrapper.get('svg[aria-label^="Recorded cooldown reference · Powered by Verisium"] rect').attributes("fill")).toBe("rgb(20,45,55)");
    expect(wrapper.get('svg[aria-label^="Recorded ready reference"] rect').attributes("fill")).toBe("rgb(180,70,220)");
    await button(wrapper, "Save settings");
    expect(api.configure).toHaveBeenCalledWith(config);
    wrapper.unmount();
  });
  it("records a Powered by Verisium cooldown from its own screenshot tab", async () => {
    vi.useFakeTimers();
    const config = calibratedCombat(); delete config.regions.verisium!.cooldown;
    const api = bridge(config);
    api.preview.mockResolvedValue({ image: "data:image/png;base64,verisium-shot", width: 2560, height: 1440 });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ({
      drawImage: () => {},
      getImageData: (_x: number, _y: number, width: number, height: number) => ({ data: new Uint8ClampedArray(Array.from({ length: width * height }, () => [7, 8, 9, 255]).flat()) }),
    }) as unknown as CanvasRenderingContext2D);
    const wrapper = mount(CombatAssistTool); await flushPromises();
    await button(wrapper, "Powered by Verisium cooldown");
    expect(wrapper.get("#combat-cooldown-verisium-tab").attributes("aria-selected")).toBe("true");
    expect(wrapper.text()).toContain("just after you cast Powered by Verisium (T)");
    await capture(wrapper, "Capture cooldown in 3 seconds");
    loadedScreenshot(wrapper);
    await button(wrapper, "Record cooldown from screenshot");
    expect(wrapper.get('svg[aria-label^="Recorded cooldown reference · Powered by Verisium"] rect').attributes("fill")).toBe("rgb(7,8,9)");
    expect(wrapper.get('svg[aria-label^="Recorded cooldown reference · Unleash"] rect').attributes("fill")).toBe("rgb(40,15,50)");
    await button(wrapper, "Save settings");
    expect(api.configure).toHaveBeenCalledWith(expect.objectContaining({
      regions: expect.objectContaining({
        unleash: expect.objectContaining({ cooldown: color(40, 15, 50) }),
        verisium: expect.objectContaining({ cooldown: color(7, 8, 9) }),
      }),
    }));
    wrapper.unmount();
  });
  it("retains failed-save draft values and their error after leaving and returning", async () => {
    const api = bridge();
    api.configure.mockRejectedValue(new Error("Ready and cooldown images are too similar."));
    let wrapper = mount(CombatAssistTool); await flushPromises();
    await wrapper.get('input[aria-label="mana threshold"]').setValue(24);
    await button(wrapper, "Save settings");
    wrapper.unmount();
    wrapper = mount(CombatAssistTool); await flushPromises();
    expect(wrapper.get('input[aria-label="mana threshold"]').element).toHaveProperty("value", "24");
    expect(wrapper.get('[role="alert"]').text()).toContain("Ready and cooldown images are too similar");
    expect(api.start).not.toHaveBeenCalled();
    wrapper.unmount();
  });
  it("reconciles dashboard toggles and new saved calibration while retaining unsaved edits and screenshots", async () => {
    const api = bridge();
    let wrapper = mount(CombatAssistTool); await flushPromises();
    await wrapper.get('input[aria-label="health threshold"]').setValue(29);
    await wrapper.get('select[aria-label="Powered by Verisium key"]').setValue("Y");
    const session = useCombatDraft(api);
    const screenshot = { image: "data:image/png;base64,pending-shot", width: 2560, height: 1440, capturedAt: "2026-09-09T12:00:00.000Z" };
    session.screenshots.value.cooldown = screenshot;
    session.activeTab.value = "cooldown";
    session.draft.value.regions.unleash!.cooldown = color(12, 23, 34);
    session.draft.value.regions.verisium!.cooldown = color(1, 2, 3);
    wrapper.unmount();
    const externallySaved = calibratedCombat();
    externallySaved.health.enabled = false;
    externallySaved.mana.key = "Q";
    externallySaved.regions.anchor!.x = 2300;
    await api.configure(externallySaved);
    api.configure.mockClear();
    wrapper = mount(CombatAssistTool); await flushPromises();
    expect(wrapper.findAll('input[type="checkbox"]')[0].element).toHaveProperty("checked", false);
    expect(wrapper.get('input[aria-label="health threshold"]').element).toHaveProperty("value", "29");
    expect(wrapper.get('select[aria-label="mana flask key"]').element).toHaveProperty("value", "Q");
    expect(wrapper.get('select[aria-label="Powered by Verisium key"]').element).toHaveProperty("value", "Y");
    expect(wrapper.get(".hud-preview img").attributes("src")).toBe(screenshot.image);
    expect(session.draft.value.regions.anchor?.x).toBe(2300);
    expect(session.draft.value.regions.unleash?.cooldown).toEqual(color(12, 23, 34));
    expect(session.draft.value.regions.verisium?.cooldown).toEqual(color(1, 2, 3));
    // An external save after entry must also be respected by the next save.
    externallySaved.mana.enabled = false;
    await api.configure(externallySaved);
    api.configure.mockClear();
    await button(wrapper, "Save settings");
    expect(api.configure).toHaveBeenCalledWith(expect.objectContaining({
      health: expect.objectContaining({ enabled: false, threshold: 29 }),
      mana: expect.objectContaining({ enabled: false, key: "Q" }),
      verisium: expect.objectContaining({ key: "Y" }),
      regions: expect.objectContaining({
        anchor: expect.objectContaining({ x: 2300 }),
        unleash: expect.objectContaining({ cooldown: color(12, 23, 34) }),
        verisium: expect.objectContaining({ cooldown: color(1, 2, 3) }),
      }),
    }));
    wrapper.unmount();
  });
  it("adopts saved HUD dimensions without overwriting unrelated unsaved settings", async () => {
    const api = bridge();
    let wrapper = mount(CombatAssistTool); await flushPromises();
    await wrapper.get('input[aria-label="mana threshold"]').setValue(24);
    wrapper.unmount();
    const changed = calibratedCombat();
    changed.width = 3840; changed.height = 2160;
    changed.regions.anchor!.x = 3000;
    await api.configure(changed);
    wrapper = mount(CombatAssistTool); await flushPromises();
    const session = useCombatDraft(api);
    expect(session.draft.value.width).toBe(3840);
    expect(session.draft.value.height).toBe(2160);
    expect(session.draft.value.regions).toEqual(changed.regions);
    expect(session.draft.value.mana.threshold).toBe(24);
    wrapper.unmount();
  });
  it("blocks mixing unsaved calibration with externally changed HUD dimensions", async () => {
    const api = bridge();
    let wrapper = mount(CombatAssistTool); await flushPromises();
    const session = useCombatDraft(api);
    session.draft.value.regions.unleash!.cooldown = color(12, 23, 34);
    wrapper.unmount();
    const changed = calibratedCombat(); changed.width = 3840; changed.height = 2160;
    await api.configure(changed);
    api.configure.mockClear();
    wrapper = mount(CombatAssistTool); await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain("Saved HUD resolution changed");
    await button(wrapper, "Save settings");
    expect(api.configure).not.toHaveBeenCalled();
    expect(session.draft.value.regions.unleash?.cooldown).toEqual(color(12, 23, 34));
    wrapper.unmount();
  });
});
