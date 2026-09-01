// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

const rail = vi.hoisted(() => ({
  dryRun: { value: false },
  killLatched: { value: false },
  canStop: { value: false },
  canStartEmpty: { value: true },
  canStartFill: { value: true },
  canStartSort: { value: true },
  overlayVisible: { value: false },
  canSendToCursor: { value: false },
  sendingToCursor: { value: false },
  transferStatus: { value: { overlaySelection: undefined as undefined | { area: string }[] } },
  railStatus: { value: "Normal stash · grids ready" },
  transferBlockReason: vi.fn(() => "Calibrate first"),
  sortBlockReason: vi.fn(() => "Calibrate first"),
  cursorHandoffBlockReason: vi.fn(() => "Label Wrong cells on the overlay"),
  initializeGameActions: vi.fn(async () => undefined),
  startAssistive: vi.fn(async () => null),
  sortStash: vi.fn(async () => null),
  stopGameActions: vi.fn(async () => undefined),
  rearmKillSwitch: vi.fn(async () => undefined),
  labelOverlayCell: vi.fn(async () => undefined),
  sendToCursor: vi.fn(async () => undefined),
}));

vi.mock("../../src/renderer/composables/useGameActions", async () => {
  const { ref } = await import("vue");
  rail.dryRun = ref(false);
  rail.killLatched = ref(false);
  rail.canStop = ref(false);
  rail.canStartEmpty = ref(true);
  rail.canStartFill = ref(true);
  rail.canStartSort = ref(true);
  rail.overlayVisible = ref(false);
  rail.canSendToCursor = ref(false);
  rail.sendingToCursor = ref(false);
  rail.transferStatus = ref({ overlaySelection: undefined });
  rail.railStatus = ref("Normal stash · grids ready");
  return { useGameActions: () => rail };
});

import GameActionRail from "../../src/renderer/components/GameActionRail.vue";

describe("GameActionRail", () => {
  afterEach(() => {
    rail.dryRun.value = false;
    rail.killLatched.value = false;
    rail.canStop.value = false;
    rail.canStartEmpty.value = true;
    rail.canStartFill.value = true;
    rail.canStartSort.value = true;
    rail.overlayVisible.value = false;
    rail.canSendToCursor.value = false;
    rail.sendingToCursor.value = false;
    rail.startAssistive.mockClear();
    rail.sortStash.mockClear();
    rail.stopGameActions.mockClear();
    rail.rearmKillSwitch.mockClear();
    rail.sendToCursor.mockClear();
  });

  it("renders compact game actions and starts Empty from the rail", async () => {
    const wrapper = mount(GameActionRail);
    await flushPromises();

    expect(rail.initializeGameActions).toHaveBeenCalled();
    // The rail mirrors the shared top-bar switch as a passive mode chip.
    expect(wrapper.get('[aria-label="Game actions"]').text()).toContain("Live");
    rail.dryRun.value = true;
    await wrapper.vm.$nextTick();
    expect(wrapper.get('[aria-label="Game actions"]').text()).toContain("Dry-run");
    rail.dryRun.value = false;
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).not.toContain("Listen once");

    const labels = wrapper.findAll("button").map((button) => button.text());
    expect(labels).toEqual(["Empty", "Fill", "2-cycle", "Sort", "Stop"]);

    await wrapper.get("button.primary").trigger("click");
    expect(rail.startAssistive).toHaveBeenCalledWith({ kind: "empty" });
    wrapper.unmount();
  });

  it("starts Fill, two-cycle, and Sort without leaving the current page", async () => {
    const wrapper = mount(GameActionRail);
    const buttons = wrapper.findAll("button");
    await buttons[1]?.trigger("click");
    await buttons[2]?.trigger("click");
    await buttons[3]?.trigger("click");
    expect(rail.startAssistive).toHaveBeenNthCalledWith(1, { kind: "fill" });
    expect(rail.startAssistive).toHaveBeenNthCalledWith(2, { kind: "two-cycle" });
    expect(rail.sortStash).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it("shows Re-arm only when the kill switch is latched", async () => {
    const wrapper = mount(GameActionRail);
    expect(wrapper.text()).not.toContain("Re-arm");
    rail.killLatched.value = true;
    await wrapper.vm.$nextTick();
    const rearm = wrapper.findAll("button").find((button) => button.text() === "Re-arm");
    expect(rearm).toBeTruthy();
    await rearm?.trigger("click");
    expect(rail.rearmKillSwitch).toHaveBeenCalled();
    wrapper.unmount();
  });

  it("sends overlay findings to Cursor when Fix in Cursor is enabled", async () => {
    rail.canSendToCursor.value = true;
    const wrapper = mount(GameActionRail);
    const fix = wrapper.findAll("button").find((button) => button.text() === "Fix in Cursor");
    expect(fix).toBeTruthy();
    expect(fix?.attributes("disabled")).toBeUndefined();
    await fix?.trigger("click");
    expect(rail.sendToCursor).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });
});
