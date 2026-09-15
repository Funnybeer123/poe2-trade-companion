// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HotkeyBindingView, HotkeyValidation } from "../../src/shared/hotkeys.js";

const bridge = vi.hoisted(() => ({
  available: true,
  bindings: [] as HotkeyBindingView[],
  listError: "" as string,
  validate: vi.fn<(accelerator: string, forId?: string) => Promise<HotkeyValidation>>(),
  rebind: vi.fn<(id: string, accelerator: string | null) => Promise<HotkeyBindingView[]>>(),
  reset: vi.fn<(id?: string) => Promise<HotkeyBindingView[]>>(),
  listeners: new Map<string, (payload: unknown) => void>(),
}));

vi.mock("../../src/renderer/services/featureApi", () => ({
  createFeatureApi: () =>
    bridge.available
      ? {
          invoke: (channel: string, ...args: unknown[]) => {
            switch (channel) {
              case "hotkeys:list":
                return bridge.listError ? Promise.reject(new Error(bridge.listError)) : Promise.resolve(bridge.bindings);
              case "hotkeys:validate":
                return bridge.validate(args[0] as string, args[1] as string | undefined);
              case "hotkeys:rebind":
                return bridge.rebind(args[0] as string, args[1] as string | null);
              case "hotkeys:reset":
                return bridge.reset(args[0] as string | undefined);
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

import OverlayHotkeysSection from "../../src/renderer/features/hotkeys/OverlayHotkeysSection.vue";

const EVALUATE: HotkeyBindingView = {
  id: "evaluate",
  label: "Evaluate",
  detail: "Price-check the item under the cursor.",
  group: "Overlay",
  defaultAccelerator: "Alt+E",
  accelerator: "Alt+E",
  registered: true,
};

const HIDE_ALL: HotkeyBindingView = {
  id: "overlay.hide-all",
  label: "Hide all overlay panels",
  group: "Overlay",
  defaultAccelerator: null,
  accelerator: null,
  registered: false,
};

const BROKEN: HotkeyBindingView = {
  id: "commands.hello",
  label: "Say hello",
  group: "Commands",
  defaultAccelerator: null,
  accelerator: "Alt+H",
  registered: false,
  error: "Alt+H could not be registered — another application may already use it.",
};

async function mountSection() {
  const wrapper = mount(OverlayHotkeysSection, { attachTo: document.body });
  await flushPromises();
  return wrapper;
}

function row(wrapper: ReturnType<typeof mount>, id: string) {
  return wrapper.get(`tr[data-action-id="${id}"]`);
}

function buttonIn(scope: ReturnType<typeof row>, text: string) {
  const button = scope.findAll("button").find((candidate) => candidate.text() === text);
  if (!button) throw new Error(`no button "${text}"`);
  return button;
}

describe("OverlayHotkeysSection", () => {
  beforeEach(() => {
    bridge.available = true;
    bridge.bindings = [EVALUATE, HIDE_ALL, BROKEN];
    bridge.listError = "";
    bridge.listeners.clear();
    bridge.validate.mockReset().mockResolvedValue({ ok: true });
    bridge.rebind.mockReset().mockImplementation(async (id, accelerator) =>
      bridge.bindings.map((binding) =>
        binding.id === id ? { ...binding, accelerator, registered: accelerator !== null, error: undefined } : binding,
      ),
    );
    bridge.reset.mockReset().mockImplementation(async (id) =>
      bridge.bindings.map((binding) =>
        !id || binding.id === id
          ? { ...binding, accelerator: binding.defaultAccelerator, registered: binding.defaultAccelerator !== null, error: undefined }
          : binding,
      ),
    );
    document.body.innerHTML = "";
  });

  it("renders the desktop-only state without the bridge", async () => {
    bridge.available = false;
    const wrapper = await mountSection();
    expect(wrapper.text()).toContain("managed by the desktop app");
    expect(wrapper.find("table").exists()).toBe(false);
    wrapper.unmount();
  });

  it("lists bindings grouped, with status chips and registration errors", async () => {
    const wrapper = await mountSection();
    expect(wrapper.findAll("h3").map((heading) => heading.text())).toEqual(["Overlay", "Commands"]);
    expect(row(wrapper, "evaluate").find("kbd").text()).toBe("Alt+E");
    expect(row(wrapper, "evaluate").find(".status-chip").text()).toBe("Active");
    expect(row(wrapper, "overlay.hide-all").text()).toContain("Unbound");
    expect(row(wrapper, "commands.hello").find(".status-chip").classes()).toContain("danger");
    expect(row(wrapper, "commands.hello").text()).toContain("another application may already use it");
    // Reset only shows when the binding deviates from its default.
    expect(row(wrapper, "evaluate").findAll("button").map((button) => button.text())).toEqual(["Rebind", "Clear"]);
    expect(row(wrapper, "commands.hello").findAll("button").map((button) => button.text())).toEqual(["Rebind", "Clear", "Reset"]);
    wrapper.unmount();
  });

  it("captures a key combination, validates it and rebinds", async () => {
    const wrapper = await mountSection();
    await buttonIn(row(wrapper, "evaluate"), "Rebind").trigger("click");
    const input = row(wrapper, "evaluate").get("input.capture-input");
    expect(row(wrapper, "evaluate").text()).toContain("Press the key combination");
    // Modifier alone: keep listening.
    await input.trigger("keydown", { key: "Alt", code: "AltLeft", altKey: true });
    expect(bridge.validate).not.toHaveBeenCalled();
    expect(row(wrapper, "evaluate").text()).toContain("Hold a modifier, then press a key");
    await input.trigger("keydown", { key: "q", code: "KeyQ", altKey: true });
    await flushPromises();
    expect(bridge.validate).toHaveBeenCalledWith("Alt+Q", "evaluate");
    expect(bridge.rebind).toHaveBeenCalledWith("evaluate", "Alt+Q");
    expect(row(wrapper, "evaluate").find("input").exists()).toBe(false);
    expect(row(wrapper, "evaluate").find("kbd").text()).toBe("Alt+Q");
    expect(row(wrapper, "evaluate").findAll("button").map((button) => button.text())).toEqual(["Rebind", "Clear", "Reset"]);
    wrapper.unmount();
  });

  it("keeps capturing and shows the reason when validation fails; Escape cancels", async () => {
    bridge.validate.mockResolvedValue({ ok: false, reason: "Alt+E is already bound to Evaluate.", conflictsWith: "evaluate" });
    const wrapper = await mountSection();
    await buttonIn(row(wrapper, "overlay.hide-all"), "Rebind").trigger("click");
    const input = row(wrapper, "overlay.hide-all").get("input.capture-input");
    await input.trigger("keydown", { key: "e", code: "KeyE", altKey: true });
    await flushPromises();
    expect(bridge.rebind).not.toHaveBeenCalled();
    expect(row(wrapper, "overlay.hide-all").get(".capture-note").classes()).toContain("bad");
    expect(row(wrapper, "overlay.hide-all").text()).toContain("already bound to Evaluate");
    await input.trigger("keydown", { key: "Escape", code: "Escape" });
    expect(row(wrapper, "overlay.hide-all").find("input").exists()).toBe(false);
    wrapper.unmount();
  });

  it("clears, resets one, resets all, and follows hotkeys:changed events", async () => {
    const wrapper = await mountSection();
    await buttonIn(row(wrapper, "evaluate"), "Clear").trigger("click");
    await flushPromises();
    expect(bridge.rebind).toHaveBeenCalledWith("evaluate", null);
    expect(row(wrapper, "evaluate").text()).toContain("Unbound");
    await buttonIn(row(wrapper, "evaluate"), "Reset").trigger("click");
    await flushPromises();
    expect(bridge.reset).toHaveBeenCalledWith("evaluate");
    expect(row(wrapper, "evaluate").find("kbd").text()).toBe("Alt+E");
    const resetAll = wrapper.findAll("button").find((button) => button.text() === "Reset all");
    await resetAll!.trigger("click");
    await flushPromises();
    expect(bridge.reset).toHaveBeenLastCalledWith(undefined);
    expect(row(wrapper, "commands.hello").text()).toContain("Unbound");

    bridge.listeners.get("hotkeys:changed")!([{ ...EVALUATE, accelerator: "Alt+Z" }]);
    await flushPromises();
    expect(wrapper.findAll("tr[data-action-id]")).toHaveLength(1);
    expect(row(wrapper, "evaluate").find("kbd").text()).toBe("Alt+Z");
    wrapper.unmount();
  });

  it("shows the error state with a retry when the list cannot be loaded, then the empty state", async () => {
    bridge.listError = "ipc broke";
    const wrapper = await mountSection();
    expect(wrapper.get("[role=alert]").text()).toContain("ipc broke");
    expect(wrapper.find("table").exists()).toBe(false);
    bridge.listError = "";
    bridge.bindings = [];
    await buttonIn(wrapper.get("[role=alert]") as never, "Retry").trigger("click");
    await flushPromises();
    expect(wrapper.find("[role=alert]").exists()).toBe(false);
    expect(wrapper.text()).toContain("No feature has contributed a hotkey action yet.");
    wrapper.unmount();
  });
});
