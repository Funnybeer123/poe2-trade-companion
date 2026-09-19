// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import FollowerTool from "../../src/renderer/components/tools/FollowerTool.vue";
import { defaultFollowerConfig } from "../../src/core/follower.js";
import type { Poe2Bridge } from "../../src/shared/ipc.js";
const wrappers: ReturnType<typeof mount>[] = [];
afterEach(() => { wrappers.splice(0).forEach(w => w.unmount()); delete window.poe2; });
describe("Follow & Loot screen", () => {
  it("clearly separates the synthetic route demo from live controls", async () => {
    const wrapper = mount(FollowerTool); wrappers.push(wrapper);
    expect(wrapper.text()).toContain("does not move a character");
    await wrapper.findAll("button").find(b => b.text() === "Run route demo")!.trigger("click");
    expect(wrapper.text()).toContain("Acquire and follow");
    const next = () => wrapper.findAll("button").find(b => b.text() === "Next step")!;
    await next().trigger("click"); expect(wrapper.text()).toContain("Collect Exalted Orb");
    await next().trigger("click"); expect(wrapper.text()).toContain("Waiting for pickup evidence");
    await next().trigger("click"); await next().trigger("click");
    expect(wrapper.find("svg").attributes("aria-label")).toContain("route around the wall");
    expect(wrapper.find("polyline").attributes("points")!.split(" ").length).toBeGreaterThan(8);
  });
  it("saves validated preferences then connects with the in-memory key", async () => {
    const status = { config: defaultFollowerConfig(), connection: "stopped", reason: "Stopped", addresses: [], capability: "connection-preview" };
    const follower = { status: vi.fn(async () => status), perception: vi.fn(async () => ({ observing: false, reason: "Stopped", inputCapability: "none" })), configure: vi.fn(async config => ({ ...status, config })), start: vi.fn(async () => ({ ...status, connection: "connecting" })), stop: vi.fn(async () => status), generateKey: vi.fn(async () => "a".repeat(64)) };
    window.poe2 = { follower } as unknown as Poe2Bridge;
    const wrapper = mount(FollowerTool); wrappers.push(wrapper); await flushPromises();
    await wrapper.findAll("button").find(b => b.text() === "Generate key")!.trigger("click"); await flushPromises();
    await wrapper.findAll("button").find(b => b.text() === "Connect to main PC")!.trigger("click"); await flushPromises();
    expect(follower.configure).toHaveBeenCalledWith(defaultFollowerConfig());
    expect(follower.start).toHaveBeenCalledWith("a".repeat(64));
    expect(wrapper.text()).toContain("connecting");
    await wrapper.findAll("button").find(b => b.text() === "Stop connection")!.trigger("click"); await flushPromises();
    expect(follower.stop).toHaveBeenCalledOnce();
  });
  it("calibrates from a screenshot and shows identity, evidence, confidence and age without any input control", async () => {
    const status = { config: { ...defaultFollowerConfig(), targetName: "Main" }, connection: "stopped", reason: "Stopped", addresses: [], capability: "connection-preview" };
    const idle = { observing: false, reason: "Capture the game view to calibrate.", inputCapability: "none" };
    const calibration = { targetName: "Main", view: { width: 1000, height: 500 }, searchArea: { x: 0, y: 0, width: 1000, height: 500 }, nameplate: { x: 100, y: 50, width: 101, height: 21 }, calibratedAt: "2026-09-19T00:00:00.000Z", templatePixels: 300 };
    const observing = { ...idle, observing: true, reason: "Tracking Main's nameplate. No game input is sent.", calibration, stats: { cycleMs: 21.5, observationsPerSecond: 30.3 },
      observation: { capturedAt: 1, ageMs: 18, view: calibration.view, identity: { name: "Main", method: "nameplate-template" }, found: true, position: { x: 150, y: 60 }, confidence: .62, evidence: { score: .91, runnerUp: .85, matchedPixels: 280, templatePixels: 300, candidates: 2, searched: "window" }, timing: { captureMs: 9, matchMs: 3.2 } } };
    let current: object = idle;
    const follower = { status: vi.fn(async () => status), perception: vi.fn(async () => current), capture: vi.fn(async () => ({ image: "data:image/png;base64,AAAA", width: 1000, height: 500, capturedAt: "2026-09-19T00:00:00.000Z" })),
      calibrate: vi.fn(async () => (current = { ...idle, calibration })), observe: vi.fn(async () => (current = observing)), stopObserving: vi.fn(async () => (current = { ...idle, calibration })), clearCalibration: vi.fn(async () => (current = idle)) };
    window.poe2 = { follower } as unknown as Poe2Bridge;
    const wrapper = mount(FollowerTool); wrappers.push(wrapper); await flushPromises();
    const button = (text: string) => wrapper.findAll("button").find(b => b.text() === text)!;
    expect(button("Start observation").attributes("disabled")).toBeDefined();
    await button("Capture game view").trigger("click"); await flushPromises();
    expect(button("Save calibration").attributes("disabled")).toBeDefined();
    const shot = wrapper.find(".follower-shot");
    shot.element.getBoundingClientRect = () => ({ left: 0, top: 0, width: 500, height: 250, right: 500, bottom: 250, x: 0, y: 0, toJSON: () => ({}) });
    await shot.trigger("click", { clientX: 50, clientY: 25 }); await shot.trigger("click", { clientX: 100, clientY: 35 });
    await button("Save calibration").trigger("click"); await flushPromises();
    expect(follower.calibrate).toHaveBeenCalledWith({ nameplate: { x: 100, y: 50, width: 101, height: 21 }, searchArea: undefined });
    expect(wrapper.text()).toContain("Calibrated for Main at 1000 × 500");
    await button("Start observation").trigger("click"); await flushPromises();
    const text = wrapper.text();
    for (const expected of ["Main · nameplate template", "Nameplate at 150, 60 px", "62%", "below your 85% minimum", "Match 0.91 · next best 0.85", "280 / 300 text pixels", "2 candidate(s)", "tracking window", "18 ms", "Capture 9 ms · match 3.2 ms", "30.3 observations/s", "sends no game input"]) expect(text).toContain(expected);
    await button("Stop observation").trigger("click"); await flushPromises();
    expect(follower.stopObserving).toHaveBeenCalledOnce();
    expect(wrapper.find("dl").exists()).toBe(false);
  });
});
