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
    const follower = { status: vi.fn(async () => status), configure: vi.fn(async config => ({ ...status, config })), start: vi.fn(async () => ({ ...status, connection: "connecting" })), stop: vi.fn(async () => status), generateKey: vi.fn(async () => "a".repeat(64)) };
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
});
