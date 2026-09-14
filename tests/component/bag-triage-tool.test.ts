// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import BagTriageTool from "../../src/renderer/components/tools/BagTriageTool.vue";
import type { BagTriageBridge, BagTriageStatus } from "../../src/shared/bagTriage.js";

afterEach(() => { delete window.poe2; });
describe("bag triage stage controls", () => {
  it("keeps every control disabled without the desktop bridge", () => {
    const wrapper = mount(BagTriageTool);
    expect(wrapper.text()).toContain("Open the desktop app"); expect(wrapper.get("fieldset").attributes()).toHaveProperty("disabled"); wrapper.unmount();
  });
  it("sends exactly the clicked stage and shows native status events", async () => {
    const state: BagTriageStatus = { running: false, phase: "idle", message: "Saved bag selected.", journal: "bag.jsonl", sessions: [{ id: "bag.jsonl", label: "Latest bag" }, { id: "other.jsonl", label: "Earlier bag" }] };
    let callback: (status: BagTriageStatus) => void = () => {};
    const unsubscribe = vi.fn(), start = vi.fn(async () => state), stop = vi.fn(async () => state), select = vi.fn(async () => state);
    const api: BagTriageBridge = { status: async () => state, start, stop, select, onStatus: fn => { callback = fn; return unsubscribe; } };
    window.poe2 = { bagTriage: api } as NonNullable<typeof window.poe2>;
    const wrapper = mount(BagTriageTool); await flushPromises();
    await wrapper.get('select[aria-label="Saved bag"]').setValue("other.jsonl"); await flushPromises();
    expect(select).toHaveBeenCalledWith("other.jsonl");
    for (const [label, stage] of [["Capture bag", "capture"], ["Identify one", "identify"], ["Drop one low-priority item", "drop"], ["Reconcile", "reconcile"]]) {
      await wrapper.findAll("button").find(button => button.text() === label)!.trigger("click"); await flushPromises();
      expect(start).toHaveBeenLastCalledWith(stage);
    }
    expect(start).toHaveBeenCalledTimes(4);
    callback({ ...state, running: true, phase: "running", message: "Reading your bag…", physicalItems: 16 }); await flushPromises();
    expect(wrapper.get('[role="status"]').text()).toBe("Reading your bag…");
    expect(wrapper.findAll("button").find(button => button.text() === "Identify one")!.attributes()).toHaveProperty("disabled");
    await wrapper.findAll("button").find(button => button.text() === "Stop")!.trigger("click"); await flushPromises(); expect(stop).toHaveBeenCalledOnce();
    wrapper.unmount(); expect(unsubscribe).toHaveBeenCalledOnce();
  });
  it("shows an actual preflight failure without calling other stages", async () => {
    const start = vi.fn(async () => { throw new Error("Inventory calibration is missing."); });
    window.poe2 = { bagTriage: { status: async () => ({ running: false, phase: "idle", message: "", sessions: [] }), start, onStatus: () => () => {} } } as unknown as NonNullable<typeof window.poe2>;
    const wrapper = mount(BagTriageTool); await flushPromises();
    await wrapper.findAll("button").find(button => button.text() === "Capture bag")!.trigger("click"); await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain("Inventory calibration is missing"); expect(start).toHaveBeenCalledOnce(); wrapper.unmount();
  });
  it("shows missing setup and disables starts until refreshed", async () => {
    const start = vi.fn(), state: BagTriageStatus = { running: false, phase: "idle", message: "Capture your bag to begin.", sessions: [], readiness: ["Inventory calibration is missing."] };
    const status = vi.fn(async () => state);
    window.poe2 = { bagTriage: { status, start, onStatus: () => () => {} } } as unknown as NonNullable<typeof window.poe2>;
    const wrapper = mount(BagTriageTool); await flushPromises();
    expect(wrapper.get('[aria-label="Bag setup needed"]').text()).toContain("Inventory calibration is missing");
    expect(wrapper.findAll("button").find(button => button.text() === "Capture bag")!.attributes()).toHaveProperty("disabled");
    await wrapper.findAll("button").find(button => button.text() === "Refresh setup")!.trigger("click"); await flushPromises();
    expect(status).toHaveBeenCalledTimes(2); expect(start).not.toHaveBeenCalled(); wrapper.unmount();
  });
});
