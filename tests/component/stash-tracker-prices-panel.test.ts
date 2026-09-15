// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PriceOverlayStatus } from "../../src/shared/stashTracker.js";

const bridge = vi.hoisted(() => ({
  available: true,
  invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(),
  listeners: new Map<string, (payload: unknown) => void>(),
}));

vi.mock("../../src/renderer/services/featureApi", () => ({
  createFeatureApi: () =>
    bridge.available
      ? {
          invoke: (channel: string, ...args: unknown[]) => bridge.invoke(channel, ...args),
          on: (channel: string, callback: (payload: unknown) => void) => {
            bridge.listeners.set(channel, callback);
            return () => bridge.listeners.delete(channel);
          },
        }
      : null,
}));

import StashPricesPanel from "../../src/renderer/features/stashTracker/panels/StashPricesPanel.vue";

function status(partial: Partial<PriceOverlayStatus> = {}): PriceOverlayStatus {
  return {
    visible: true,
    legendVisible: true,
    tab: "Rings",
    topLevel: false,
    tabs: ["Belts", "Rings"],
    lastScanAt: "2026-09-12T18:31:55.000Z",
    ageMs: 3 * 60 * 60_000,
    totalExalted: 212.5,
    priced: 30,
    unpriced: 11,
    items: 41,
    geometrySource: "taught",
    poeRunning: true,
    ...partial,
  };
}

function mountPanel(payload: unknown = status()) {
  return mount(StashPricesPanel, {
    props: { panelId: "stash-prices", payload, visible: true },
  });
}

function buttonByLabel(wrapper: ReturnType<typeof mount>, label: string) {
  const found = wrapper
    .findAll("button")
    .find((candidate) => candidate.attributes("aria-label") === label);
  if (!found) throw new Error(`no button "${label}"`);
  return found;
}

describe("StashPricesPanel", () => {
  beforeEach(() => {
    bridge.available = true;
    bridge.listeners.clear();
    bridge.invoke.mockReset().mockResolvedValue(status());
  });

  it("renders the tab, its scan age and the totals from the payload", () => {
    const wrapper = mountPanel();
    expect(wrapper.text()).toContain("Rings");
    expect(wrapper.text()).toContain("3h ago");
    expect(wrapper.text()).toContain("212.5 ex");
    expect(wrapper.text()).toContain("30 priced");
    expect(wrapper.text()).toContain("11 unpriced");
    expect(wrapper.text()).toContain("not guaranteed prices");
    wrapper.unmount();
  });

  it("cycles tabs, toggles top-level and refreshes", async () => {
    const wrapper = mountPanel();
    await buttonByLabel(wrapper, "Previous tab").trigger("click");
    expect(bridge.invoke).toHaveBeenCalledWith("stash-tracker:overlay-next", -1);
    await buttonByLabel(wrapper, "Next tab").trigger("click");
    expect(bridge.invoke).toHaveBeenCalledWith("stash-tracker:overlay-next", 1);
    await buttonByLabel(wrapper, "Top-level tab").trigger("click");
    expect(bridge.invoke).toHaveBeenCalledWith("stash-tracker:overlay-top-level", "Rings", true);
    await buttonByLabel(wrapper, "Refresh").trigger("click");
    expect(bridge.invoke).toHaveBeenCalledWith("stash-tracker:overlay-show", "Rings");
    wrapper.unmount();
  });

  it("shows an error payload to a screen reader", () => {
    const wrapper = mountPanel(status({ error: "Path of Exile is not running." }));
    expect(wrapper.find('[role="alert"]').text()).toBe("Path of Exile is not running.");
    wrapper.unmount();
  });

  it("follows the stash-tracker:overlay event and unsubscribes on unmount", async () => {
    const wrapper = mountPanel();
    const listener = bridge.listeners.get("stash-tracker:overlay")!;
    listener(status({ tab: "Belts", totalExalted: 999, ageMs: 60_000 }));
    await flushPromises();
    expect(wrapper.text()).toContain("Belts");
    expect(wrapper.text()).toContain("999 ex");
    wrapper.unmount();
    expect(bridge.listeners.has("stash-tracker:overlay")).toBe(false);
  });

  it("renders a safe default when the payload is junk", () => {
    const wrapper = mountPanel("not an object");
    expect(wrapper.text()).toContain("No tab");
    expect(wrapper.text()).toContain("age unknown");
    expect(wrapper.text()).toContain("— ex");
    wrapper.unmount();
  });

  it("does nothing without the desktop bridge", async () => {
    bridge.available = false;
    const wrapper = mountPanel();
    await buttonByLabel(wrapper, "Next tab").trigger("click");
    expect(bridge.invoke).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
