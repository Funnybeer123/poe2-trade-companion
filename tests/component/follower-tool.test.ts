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
      calibrate: vi.fn(async () => (current = { ...idle, calibration })), observe: vi.fn(async () => (current = observing)), stopObserving: vi.fn(async (): Promise<object> => (current = { ...idle, calibration })), clearCalibration: vi.fn(async () => (current = idle)) };
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
    const record = vi.fn(async () => (current = { ...idle, recording: { directory: "C:\\data\\recordings\\r1", frames: 3, remainingMs: 16400 } }));
    Object.assign(follower, { record });
    await button("Record 20 s for testing").trigger("click"); await flushPromises();
    expect(record).toHaveBeenCalledWith({ seconds: 20 });
    expect(wrapper.text()).toContain("Stop recording (17 s)");
    follower.stopObserving.mockImplementation(async () => (current = { ...idle, lastRecording: { directory: "C:\\data\\recordings\\r1", frames: 80 } }));
    await button("Stop recording (17 s)").trigger("click"); await flushPromises();
    expect(wrapper.text()).toContain("80 frames in C:\\data\\recordings\\r1");
    expect(wrapper.text()).toContain("never sent to the other PC");
  });
  it("follows by the overlay map as a preview by default and shows decision, confidence, speed and input counts", async () => {
    const status = { config: { ...defaultFollowerConfig(), targetName: "Main" }, connection: "stopped", reason: "Stopped", addresses: [], capability: "connection-preview" };
    const settings = { version: 1, dryRun: true, mapScale: 7, clickIntervalMs: 110 };
    const calibration = { targetName: "Main", view: { width: 2560, height: 1440 }, origin: { x: 1279, y: 700 }, markerOffset: { dx: 33, dy: 16 }, labelPixels: 260, labelMask: [".##.", "#..#"], calibratedAt: "2026-09-19T00:00:00.000Z" };
    const idle = { running: false, reason: "Calibrate on the overlay map, then start following.", settings, dryRun: true };
    let current: object = idle;
    const running = (dryRun: boolean) => ({ running: true, reason: "Move toward Main: 69 map px away.", settings: { ...settings, dryRun }, dryRun, calibration, decision: { kind: "move", x: 1371, y: 337, distance: 69.1, reason: "Move toward Main: 69 map px away." },
      observation: { capturedAt: 1, ageMs: 9, view: calibration.view, identity: { name: "Main", method: "map-label-template" }, leaderFound: true, origin: calibration.origin, leader: { x: 1296, y: 633 }, offset: { dx: 17, dy: -67, distance: 69.1 }, confidence: .97, originVerified: true,
        evidence: { score: .97, runnerUp: 0, candidates: 1, keyPixels: 426, originScore: 1, originSeenAgoMs: 0, searched: "window", overflow: false }, timing: { captureMs: 12, matchMs: 1.1 } },
      stats: { cycles: 300, clicks: dryRun ? 0 : 41, previewed: dryRun ? 41 : 0, refused: 1, manualTakeovers: 2, observationsPerSecond: 31.5, cycleMsP50: 22.1, cycleMsP95: 48.3, captureToInputMsP50: dryRun ? undefined : 38, captureToInputMsP95: dryRun ? undefined : 61 } });
    const follower = { status: vi.fn(async () => status), perception: vi.fn(async () => ({ observing: false, reason: "Stopped", inputCapability: "none" })), driveStatus: vi.fn(async () => current),
      driveCalibrate: vi.fn(async () => (current = { ...idle, calibration })), driveStart: vi.fn(async () => (current = running(true))), driveStop: vi.fn(async (): Promise<object> => (current = { ...idle, calibration })),
      driveConfigure: vi.fn(async (next: typeof settings) => (current = { ...idle, calibration, settings: next, dryRun: next.dryRun })) };
    window.poe2 = { follower } as unknown as Poe2Bridge;
    const wrapper = mount(FollowerTool); wrappers.push(wrapper); await flushPromises();
    const button = (text: string) => wrapper.findAll("button").find(b => b.text() === text)!;
    expect(button("Start preview (no clicks)").attributes("disabled")).toBeDefined();
    await button("Calibrate on overlay map").trigger("click"); await flushPromises();
    expect(follower.driveCalibrate).toHaveBeenCalledWith();
    expect(wrapper.text()).toContain("Calibrated on Main's map label at 2560 × 1440 · map centre 1279, 700");
    expect(wrapper.find(".follower-mask").text()).toBe("██ \n█  █");
    expect(wrapper.text()).toContain("Check that the captured label above reads Main");
    await button("Start preview (no clicks)").trigger("click"); await flushPromises();
    for (const expected of ["Main · 69.1 map px away", "move — Move toward Main", "97% · match 0.97", "Your marker is in place", "31.5 observations/s · cycle 22.1 / 48.3 ms", "0 clicks · 41 previewed · 1 refused · 2 manual takeovers"]) expect(wrapper.text()).toContain(expected);
    expect(wrapper.text()).not.toContain("capture→click");
    await button("Stop following").trigger("click"); await flushPromises();
    const checks = wrapper.findAll(".follower-drive-fields input[type=checkbox]");
    await checks[0].setValue(false);
    await button("Save follow settings").trigger("click"); await flushPromises();
    expect(follower.driveConfigure).toHaveBeenCalledWith({ version: 1, dryRun: false, mapScale: 7, clickIntervalMs: 110, sprint: false });
    // Sprint is saved with the rest: configuring from the app used to drop it and quietly turn it off.
    await checks[1].setValue(true);
    await button("Save follow settings").trigger("click"); await flushPromises();
    expect(follower.driveConfigure).toHaveBeenLastCalledWith({ version: 1, dryRun: false, mapScale: 7, clickIntervalMs: 110, sprint: true });
    follower.driveStart.mockImplementation(async () => (current = running(false)));
    await button("Start following").trigger("click"); await flushPromises();
    expect(wrapper.text()).toContain("41 clicks · 0 previewed");
    expect(wrapper.text()).toContain("capture→click 38 / 61 ms");
    expect(wrapper.text()).toContain("Ctrl+Shift+Esc stops everything");
  });
});
