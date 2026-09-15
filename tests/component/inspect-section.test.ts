// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import path from "node:path";
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectItemText } from "../../src/core/inspect.js";

const bridge = vi.hoisted(() => ({
  available: true,
  invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock("../../src/renderer/services/featureApi", () => ({
  createFeatureApi: () =>
    bridge.available ? { invoke: bridge.invoke, on: () => () => undefined } : null,
  getAppFeatureApi: () => null,
}));

import InspectSection from "../../src/renderer/features/inspect/InspectSection.vue";

function fixture(name: string): string {
  return readFileSync(path.join(process.cwd(), "fixtures", "inspect", name), "utf8");
}

const RING = fixture("plain-rare-ring.txt");
const ARMOUR = fixture("armour-quality-12.txt");
const RING_REPORT = inspectItemText(RING)!;
const ARMOUR_REPORT = inspectItemText(ARMOUR)!;

function buttonByText(wrapper: ReturnType<typeof mount>, text: string) {
  const button = wrapper.findAll("button").find((candidate) => candidate.text() === text);
  if (!button) throw new Error(`no button "${text}"`);
  return button;
}

async function mountSection(raw = RING) {
  vi.useFakeTimers();
  const wrapper = mount(InspectSection, { props: { raw } });
  await vi.advanceTimersByTimeAsync(200);
  await flushPromises();
  return wrapper;
}

describe("InspectSection", () => {
  beforeEach(() => {
    bridge.available = true;
    bridge.invoke.mockReset().mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === "inspect:analyze") {
        return args[0] === ARMOUR ? ARMOUR_REPORT : RING_REPORT;
      }
      if (channel === "inspect:show") return { shown: true, fingerprint: RING_REPORT.fingerprint };
      if (channel === "inspect:open-link") return { ok: true };
      throw new Error(`unexpected ${channel}`);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("analyses the raw text through main and renders the card", async () => {
    const wrapper = await mountSection();
    expect(bridge.invoke).toHaveBeenCalledWith("inspect:analyze", RING);
    expect(wrapper.text()).toContain("Storm Coil");
    expect(wrapper.find(".spinner").exists()).toBe(false);
    wrapper.unmount();
  });

  it("opens the overlay panel for the same text", async () => {
    const wrapper = await mountSection();
    await buttonByText(wrapper, "Open in overlay").trigger("click");
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith("inspect:show", RING);
    expect(wrapper.text()).toContain("Opened over the game.");
    wrapper.unmount();
  });

  it("re-analyses once when the item changes and drops the stale answer", async () => {
    const wrapper = await mountSection();
    bridge.invoke.mockClear();
    await wrapper.setProps({ raw: ARMOUR } as never);
    await wrapper.setProps({ raw: RING } as never);
    await vi.advanceTimersByTimeAsync(200);
    await flushPromises();
    const analyses = bridge.invoke.mock.calls.filter(([channel]) => channel === "inspect:analyze");
    expect(analyses).toHaveLength(1);
    expect(analyses[0]![1]).toBe(RING);
    expect(wrapper.text()).toContain("Storm Coil");
    wrapper.unmount();
  });

  it("reports a rejected analysis with a retry instead of hanging on the spinner", async () => {
    bridge.invoke.mockRejectedValue(new Error("ipc down"));
    const wrapper = await mountSection();
    expect(wrapper.get("[role=alert]").text()).toContain("ipc down");
    expect(wrapper.find(".spinner").exists()).toBe(false);
    expect(buttonByText(wrapper, "Retry").exists()).toBe(true);
    wrapper.unmount();
  });

  it("analyses locally in the browser preview and disables the overlay button", async () => {
    bridge.available = false;
    const wrapper = await mountSection();
    expect(bridge.invoke).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("Storm Coil");
    const button = buttonByText(wrapper, "Open in overlay");
    expect(button.attributes("disabled")).toBeDefined();
    expect(button.attributes("title")).toBe("Needs the desktop app");
    expect(wrapper.text()).toContain("analyses locally with no learned tier data");
    wrapper.unmount();
  });

  it("surfaces a link main refused instead of leaving a dead button", async () => {
    const wrapper = await mountSection();
    bridge.invoke.mockImplementation(async (channel: string) => {
      if (channel === "inspect:open-link") return { ok: false, reason: "not-allowed" };
      return RING_REPORT;
    });
    const link = wrapper.findAll(".inspect-links button")[0]!;
    await link.trigger("click");
    await flushPromises();
    expect(wrapper.get("[role=alert]").text()).toContain("outside the allowed wiki hosts");
    wrapper.unmount();
  });

  it("shows the empty state for text that is not an item", async () => {
    bridge.invoke.mockResolvedValue(null);
    const wrapper = await mountSection("just chat");
    expect(wrapper.text()).toContain("Nothing to inspect");
    wrapper.unmount();
  });
});
