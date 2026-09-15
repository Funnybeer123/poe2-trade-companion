// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DANGEROUS_MAP_MODS } from "../../src/data/inspect/dangerousMapMods.js";

const bridge = vi.hoisted(() => ({
  appAvailable: true,
  inspectAvailable: true,
  snapshot: {} as Record<string, unknown>,
  settingsError: "",
  setRaw: vi.fn<(id: string, patch: unknown) => Promise<unknown>>(),
  listeners: new Map<string, (payload: unknown) => void>(),
}));

vi.mock("../../src/renderer/services/featureApi", () => ({
  getAppFeatureApi: () =>
    bridge.appAvailable
      ? {
          invoke: (channel: string, ...args: unknown[]) => {
            if (channel === "settings:get") {
              return bridge.settingsError
                ? Promise.reject(new Error(bridge.settingsError))
                : Promise.resolve(bridge.snapshot);
            }
            if (channel === "settings:set") return bridge.setRaw(args[0] as string, args[1]);
            return Promise.reject(new Error(`unexpected ${channel}`));
          },
          on: (channel: string, callback: (payload: unknown) => void) => {
            bridge.listeners.set(channel, callback);
            return () => bridge.listeners.delete(channel);
          },
        }
      : null,
  createFeatureApi: () =>
    bridge.inspectAvailable
      ? {
          invoke: (channel: string) => {
            if (channel === "inspect:map-mods") {
              return Promise.resolve(
                DANGEROUS_MAP_MODS.map((mod) => ({ ...mod, effectiveSeverity: mod.severity })),
              );
            }
            return Promise.reject(new Error(`unexpected ${channel}`));
          },
          on: () => () => undefined,
        }
      : null,
}));

import InspectSettingsSection from "../../src/renderer/features/inspect/InspectSettingsSection.vue";

async function mountSection() {
  const wrapper = mount(InspectSettingsSection);
  await flushPromises();
  return wrapper;
}

describe("InspectSettingsSection", () => {
  beforeEach(() => {
    bridge.appAvailable = true;
    bridge.inspectAvailable = true;
    bridge.snapshot = { inspect: { anchor: "cursor" } };
    bridge.settingsError = "";
    bridge.listeners.clear();
    bridge.setRaw.mockReset().mockResolvedValue({});
  });

  it("renders the desktop-only state without the settings bridge", async () => {
    bridge.appAvailable = false;
    const wrapper = await mountSection();
    expect(wrapper.text()).toContain("Inspect settings need the desktop app");
    expect(wrapper.find("select").exists()).toBe(false);
    wrapper.unmount();
  });

  it("loads the sanitized settings and the map modifier table", async () => {
    const wrapper = await mountSection();
    expect(wrapper.get("select").element.value).toBe("cursor");
    expect(wrapper.findAll("tr[data-map-mod-id]")).toHaveLength(DANGEROUS_MAP_MODS.length);
    expect(wrapper.text()).toContain("Reads the clipboard only");
    wrapper.unmount();
  });

  it("saves the anchor and each toggle as it changes", async () => {
    const wrapper = await mountSection();
    await wrapper.get("select").setValue("top-right");
    await flushPromises();
    expect(bridge.setRaw).toHaveBeenCalledWith("inspect", { anchor: "top-right" });

    const toggles = wrapper.findAll(".toggle-field input");
    await toggles[0]!.setValue(false);
    await flushPromises();
    expect(bridge.setRaw).toHaveBeenLastCalledWith("inspect", { showQualityNormalised: false });

    await toggles[2]!.setValue(true);
    await flushPromises();
    expect(bridge.setRaw).toHaveBeenLastCalledWith("inspect", { copyOnHotkey: true });
    expect(wrapper.text()).toContain("Saved.");
    wrapper.unmount();
  });

  it("writes and clears one map modifier override", async () => {
    const wrapper = await mountSection();
    const row = wrapper.get('tr[data-map-mod-id="no-regen"]');
    await row.get("select").setValue("ignore");
    await flushPromises();
    expect(bridge.setRaw).toHaveBeenLastCalledWith("inspect", { mapModOverrides: { "no-regen": "ignore" } });

    await row.get("select").setValue("");
    await flushPromises();
    expect(bridge.setRaw).toHaveBeenLastCalledWith("inspect", { mapModOverrides: {} });
    wrapper.unmount();
  });

  it("follows a settings:changed event from another window", async () => {
    const wrapper = await mountSection();
    bridge.listeners.get("settings:changed")!({ id: "inspect", value: { anchor: "left" } });
    await flushPromises();
    expect(wrapper.get("select").element.value).toBe("left");
    wrapper.unmount();
  });

  it("shows a load failure as an alert instead of an empty table", async () => {
    bridge.settingsError = "settings unavailable";
    const wrapper = await mountSection();
    expect(wrapper.get("[role=alert]").text()).toContain("settings unavailable");
    wrapper.unmount();
  });
});
