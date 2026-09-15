// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OverlayPanelCommand } from "../../src/shared/overlay.js";

const bridge = vi.hoisted(() => ({
  available: true,
  calls: [] as Array<[string, unknown[]]>,
  listeners: new Map<string, (payload: unknown) => void>(),
}));

vi.mock("../../src/renderer/services/featureApi", () => ({
  createFeatureApi: () =>
    bridge.available
      ? {
          invoke: vi.fn(async (channel: string, ...args: unknown[]) => {
            bridge.calls.push([channel, args]);
            return undefined;
          }),
          on: (channel: string, callback: (payload: unknown) => void) => {
            bridge.listeners.set(channel, callback);
            return () => bridge.listeners.delete(channel);
          },
        }
      : null,
}));

import OverlayApp from "../../src/renderer/overlay/OverlayApp.vue";

function emit(command: OverlayPanelCommand): void {
  const listener = bridge.listeners.get("overlay:panel");
  if (!listener) throw new Error("OverlayApp did not subscribe to overlay:panel");
  listener(command);
}

const STYLE = { scale: 1.25, opacity: 0.8, closeOnClickOutside: true };

function showNotice(overrides: Partial<OverlayPanelCommand> = {}): void {
  emit({
    action: "show",
    panelId: "notice",
    payload: { title: "Sold", body: "1 exalted", tone: "ok" },
    position: { x: 40, y: 50 },
    size: { width: 300, height: 100 },
    pinned: false,
    focus: false,
    style: STYLE,
    ...overrides,
  });
}

function calls(channel: string) {
  return bridge.calls.filter(([name]) => name === channel).map(([, args]) => args);
}

let current: ReturnType<typeof mount> | undefined;

async function mountOverlay() {
  const wrapper = mount(OverlayApp, { attachTo: document.body });
  current = wrapper;
  await flushPromises();
  return wrapper;
}

/** The panel component is loaded lazily (defineAsyncComponent): wait for its text. */
async function settle(wrapper: ReturnType<typeof mount>, selector: string, text: string) {
  await vi.waitFor(() => expect(wrapper.get(selector).text()).toContain(text));
}

describe("OverlayApp", () => {
  beforeEach(() => {
    bridge.available = true;
    bridge.calls.length = 0;
    bridge.listeners.clear();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    // Unmount even when an assertion failed, or the window keydown listener leaks into the next test.
    current?.unmount();
    current = undefined;
  });

  it("renders the desktop-only state without the bridge", async () => {
    bridge.available = false;
    const wrapper = await mountOverlay();
    expect(wrapper.text()).toContain("runs inside the desktop app");
  });

  it("shows the notice panel from an overlay:panel command with the style variables", async () => {
    const wrapper = await mountOverlay();
    showNotice();
    await flushPromises();
    const panel = wrapper.find('[data-panel-id="notice"]');
    expect(panel.exists()).toBe(true);
    expect(panel.attributes("style")).toContain("left: 40px");
    expect(panel.attributes("style")).toContain("top: 50px");
    await settle(wrapper, '[data-panel-id="notice"]', "Sold");
    expect(panel.text()).toContain("1 exalted");
    expect(panel.find(".notice.tone-ok").exists()).toBe(true);
    const root = wrapper.get('[data-testid="overlay-root"]');
    expect(root.attributes("style")).toContain("--overlay-scale: 1.25");
    expect(root.attributes("style")).toContain("--overlay-opacity: 0.8");
    expect(calls("overlay:panel-event")).toEqual([[{ panelId: "notice", kind: "shown" }]]);

    emit({ action: "update", panelId: "notice", payload: { title: "Updated", body: "" } });
    await settle(wrapper, '[data-panel-id="notice"]', "Updated");
  });

  it("closes the topmost unpinned panel on Escape and asks main to hide-all when none is left", async () => {
    const wrapper = await mountOverlay();
    showNotice({ panelId: "notice" });
    showNotice({ panelId: "pinned-one", pinned: true });
    await flushPromises();
    expect(wrapper.findAll(".overlay-panel")).toHaveLength(2);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await flushPromises();
    expect(wrapper.findAll(".overlay-panel")).toHaveLength(1);
    expect(calls("overlay:panel-event").at(-1)).toEqual([{ panelId: "notice", kind: "closed-by-user" }]);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await flushPromises();
    expect(wrapper.findAll(".overlay-panel")).toHaveLength(1);
    expect(calls("overlay:hide-all")).toEqual([[]]);
  });

  it("flips ignore-mouse on pointer enter/leave and reports the events", async () => {
    const wrapper = await mountOverlay();
    showNotice();
    await flushPromises();
    const panel = wrapper.get('[data-panel-id="notice"]');
    await panel.trigger("pointerenter");
    expect(calls("overlay:set-ignore-mouse")).toEqual([[false]]);
    expect(calls("overlay:panel-event").at(-1)).toEqual([{ panelId: "notice", kind: "pointer-enter" }]);
    await panel.trigger("pointerleave");
    expect(calls("overlay:set-ignore-mouse")).toEqual([[false], [true]]);
    expect(calls("overlay:panel-event").at(-1)).toEqual([{ panelId: "notice", kind: "pointer-leave" }]);
  });

  it("leaves panels alone on a click outside (the game keeps its clicks), and the × / pin buttons work", async () => {
    const wrapper = await mountOverlay();
    showNotice({ panelId: "a" });
    showNotice({ panelId: "b", pinned: true });
    await flushPromises();
    await wrapper.get('[data-testid="overlay-root"]').trigger("click");
    expect(wrapper.findAll(".overlay-panel").map((panel) => panel.attributes("data-panel-id"))).toEqual(["a", "b"]);
    expect(calls("overlay:panel-event").at(-1)).toEqual([{ panelId: "b", kind: "shown" }]);

    const pin = wrapper.get('[data-panel-id="b"] button[aria-pressed]');
    expect(pin.attributes("aria-pressed")).toBe("true");
    await pin.trigger("click");
    expect(pin.attributes("aria-pressed")).toBe("false");
    await wrapper.get('[data-panel-id="b"] button[aria-label="Close"]').trigger("click");
    expect(wrapper.findAll(".overlay-panel").map((panel) => panel.attributes("data-panel-id"))).toEqual(["a"]);
    expect(calls("overlay:panel-event").at(-1)).toEqual([{ panelId: "b", kind: "closed-by-user" }]);
  });

  it("applies hide / hide-all commands from main without reporting them as user closes", async () => {
    const wrapper = await mountOverlay();
    showNotice({ panelId: "a" });
    showNotice({ panelId: "b", pinned: true });
    showNotice({ panelId: "c" });
    await flushPromises();
    bridge.calls.length = 0;
    emit({ action: "hide", panelId: "c" });
    emit({ action: "hide-all" });
    await flushPromises();
    expect(wrapper.findAll(".overlay-panel").map((panel) => panel.attributes("data-panel-id"))).toEqual(["b"]);
    emit({ action: "hide-all", pinned: true });
    await flushPromises();
    expect(wrapper.findAll(".overlay-panel")).toHaveLength(0);
    expect(calls("overlay:panel-event")).toEqual([]);
  });

  it("renders a placeholder for an unregistered panel id and auto-closes a notice after its ttl", async () => {
    vi.useFakeTimers();
    try {
      const wrapper = await mountOverlay();
      showNotice({ panelId: "mystery" });
      showNotice({ panelId: "notice", payload: { title: "Bye", ttlMs: 500 } });
      await flushPromises();
      expect(wrapper.get('[data-panel-id="mystery"]').text()).toContain('No panel is registered as "mystery"');
      // Let the lazy component resolve under fake timers before the ttl elapses.
      for (let i = 0; i < 10; i += 1) await flushPromises();
      expect(wrapper.get('[data-panel-id="notice"]').text()).toContain("Bye");
      await vi.advanceTimersByTimeAsync(600);
      expect(wrapper.find('[data-panel-id="notice"]').exists()).toBe(false);
      expect(calls("overlay:panel-event").at(-1)).toEqual([{ panelId: "notice", kind: "closed-by-user" }]);
    } finally {
      vi.useRealTimers();
    }
  });
});
