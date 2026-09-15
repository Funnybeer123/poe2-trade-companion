// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import path from "node:path";
import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

import InspectPanel from "../../src/renderer/features/inspect/InspectPanel.vue";

const REPORT = inspectItemText(
  readFileSync(path.join(process.cwd(), "fixtures", "inspect", "plain-rare-ring.txt"), "utf8"),
)!;

describe("InspectPanel", () => {
  beforeEach(() => {
    bridge.available = true;
    bridge.invoke.mockReset().mockResolvedValue({ ok: true });
  });

  it("renders the card for a valid payload", () => {
    const wrapper = mount(InspectPanel, {
      props: { panelId: "inspect", payload: REPORT, visible: true },
    });
    expect(wrapper.text()).toContain("Storm Coil");
    expect(wrapper.text()).toContain("Sapphire Ring");
    wrapper.unmount();
  });

  it("falls back to the empty notice for a payload that is not a report", () => {
    for (const payload of [undefined, null, "nonsense", { schemaVersion: 9 }]) {
      const wrapper = mount(InspectPanel, { props: { panelId: "inspect", payload, visible: true } });
      expect(wrapper.text()).toContain("Nothing to inspect");
      expect(wrapper.find("h2").exists()).toBe(false);
      wrapper.unmount();
    }
  });

  it("asks main to open a link rather than navigating itself", async () => {
    const wrapper = mount(InspectPanel, {
      props: { panelId: "inspect", payload: REPORT, visible: true },
    });
    await wrapper.findAll(".inspect-links button")[0]!.trigger("click");
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith(
      "inspect:open-link",
      "https://www.poe2wiki.net/wiki/Sapphire_Ring",
    );
    wrapper.unmount();
  });

  it("says so when main refuses or fails to open the link", async () => {
    bridge.invoke.mockResolvedValue({ ok: false, reason: "not-allowed" });
    const wrapper = mount(InspectPanel, {
      props: { panelId: "inspect", payload: REPORT, visible: true },
    });
    await wrapper.findAll(".inspect-links button")[0]!.trigger("click");
    await flushPromises();
    expect(wrapper.get(".inline-notice.danger").text()).toContain("outside the allowed wiki hosts");

    bridge.invoke.mockResolvedValue({ ok: false, reason: "failed" });
    await wrapper.findAll(".inspect-links button")[0]!.trigger("click");
    await flushPromises();
    expect(wrapper.get(".inline-notice.danger").text()).toContain("could not be opened");

    // A later success clears the notice rather than leaving it on screen.
    bridge.invoke.mockResolvedValue({ ok: true });
    await wrapper.findAll(".inspect-links button")[0]!.trigger("click");
    await flushPromises();
    expect(wrapper.find(".inline-notice.danger").exists()).toBe(false);
    wrapper.unmount();
  });

  it("does nothing on a link click without the bridge", async () => {
    bridge.available = false;
    const wrapper = mount(InspectPanel, {
      props: { panelId: "inspect", payload: REPORT, visible: true },
    });
    await wrapper.findAll(".inspect-links button")[0]!.trigger("click");
    await flushPromises();
    expect(bridge.invoke).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
