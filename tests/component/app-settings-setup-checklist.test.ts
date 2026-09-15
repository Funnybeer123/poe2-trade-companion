// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SetupChecklist } from "../../src/shared/appSettings.js";

const CHECKLIST = JSON.parse(
  readFileSync(path.join(process.cwd(), "fixtures/app-settings/checklist.json"), "utf8"),
) as SetupChecklist;

const bridge = vi.hoisted(() => ({
  available: true,
  checklist: null as unknown,
  invoke: vi.fn<(channel: string, ...args: unknown[]) => unknown>(),
  listeners: new Map<string, (payload: unknown) => void>(),
  leagues: vi.fn(async () => [{ value: "Runes of Aldur" }]),
  status: vi.fn(async () => ({})),
  refresh: vi.fn(async () => ({})),
}));

vi.mock("../../src/renderer/services/featureApi", () => {
  const api = {
    invoke: (channel: string, ...args: unknown[]) => Promise.resolve(bridge.invoke(channel, ...args)),
    on: (channel: string, callback: (payload: unknown) => void) => {
      bridge.listeners.set(channel, callback);
      return () => bridge.listeners.delete(channel);
    },
  };
  return {
    createFeatureApi: () => (bridge.available ? api : null),
    getAppFeatureApi: () => (bridge.available ? api : null),
  };
});

vi.mock("../../src/renderer/services/rendererApi", () => ({
  getPriceFeedApi: () => ({ status: bridge.status, leagues: bridge.leagues, refresh: bridge.refresh }),
}));

import SetupChecklistCard from "../../src/renderer/features/appSettings/SetupChecklistCard.vue";

function defaultInvoke(channel: string): unknown {
  switch (channel) {
    case "app:setup-checklist":
      return bridge.checklist;
    case "app:elevation":
      return { appElevated: false, poeRunning: false, poeElevated: "unknown", processes: [], checkedAt: "" };
    case "app:test-overlay":
    case "client-log:browse-file":
      return undefined;
    default:
      throw new Error(`unexpected ${channel}`);
  }
}

async function mountCard(props: Record<string, unknown> = {}) {
  const wrapper = mount(SetupChecklistCard, { props, attachTo: document.body });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  bridge.available = true;
  bridge.checklist = JSON.parse(JSON.stringify(CHECKLIST)) as SetupChecklist;
  bridge.listeners.clear();
  bridge.invoke.mockImplementation(defaultInvoke);
});

describe("SetupChecklistCard", () => {
  it("renders every step with a state dot and the progress badge", async () => {
    const wrapper = await mountCard();
    const items = wrapper.findAll("li");
    expect(items).toHaveLength(10);
    expect(wrapper.findAll(".step-dot")).toHaveLength(10);
    expect(wrapper.find(".count-badge").text()).toBe("2/5");
    expect(wrapper.find("ol").attributes("aria-label")).toBe("Setup checklist");
    expect(wrapper.text()).toContain("Optional steps only matter for the flows that need them.");
  });

  it("never probes the administrator rights on its own", async () => {
    await mountCard();
    // The probe opens a handle on the live game client; it belongs to the
    // button in Settings → Game client, not to mounting a card.
    expect(bridge.invoke.mock.calls.filter(([channel]) => channel === "app:elevation")).toHaveLength(0);
  });

  it("maps check-leagues onto one poe2scout read followed by a status refresh", async () => {
    bridge.checklist = {
      ...CHECKLIST,
      steps: CHECKLIST.steps.map((step) =>
        step.id === "league" ? { ...step, action: "check-leagues" as const } : step,
      ),
    };
    const wrapper = await mountCard();
    await wrapper.findAll("button").find((button) => button.text() === "Check leagues")!.trigger("click");
    await flushPromises();
    expect(bridge.leagues).toHaveBeenCalledTimes(1);
    expect(bridge.status).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain("1 current league listed.");
  });

  it("maps the remaining actions onto their channels", async () => {
    bridge.checklist = {
      ...CHECKLIST,
      steps: CHECKLIST.steps.map((step) =>
        step.id === "client-log" ? { ...step, state: "todo" as const } : step,
      ),
    };
    const wrapper = await mountCard();
    await wrapper.findAll("button").find((button) => button.text() === "Browse…")!.trigger("click");
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith("client-log:browse-file");

    await wrapper.findAll("button").find((button) => button.text() === "Refresh prices")!.trigger("click");
    await flushPromises();
    expect(bridge.refresh).toHaveBeenCalled();

    await wrapper.findAll("button").find((button) => button.text() === "Test overlay")!.trigger("click");
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith("app:test-overlay");
  });

  it("emits navigate for the routed actions instead of invoking anything", async () => {
    bridge.checklist = {
      ...CHECKLIST,
      steps: CHECKLIST.steps.map((step) =>
        step.id === "hotkeys" ? { ...step, state: "warn" as const } : step,
      ),
    };
    const wrapper = await mountCard();
    await wrapper.findAll("button").find((button) => button.text() === "Open hotkeys")!.trigger("click");
    expect(wrapper.emitted("navigate")?.[0]).toEqual(["/tools/hotkeys"]);
    await wrapper.findAll("button").find((button) => button.text() === "Open calibration")!.trigger("click");
    expect(wrapper.emitted("navigate")?.[1]).toEqual(["/tools/calibration"]);
    await wrapper.findAll("button").find((button) => button.text() === "Open market data")!.trigger("click");
    expect(wrapper.emitted("navigate")?.[2]).toEqual(["/tools/settings#market-data"]);
    expect(bridge.invoke).not.toHaveBeenCalledWith("app:test-overlay");
  });

  it("hides an ok step's action button", async () => {
    const wrapper = await mountCard();
    const clientLogRow = wrapper.find('li[data-step="client-log"]');
    expect(clientLogRow.find("button").exists()).toBe(false);
  });

  it("dismisses to a one-line summary that can be re-opened", async () => {
    const dismissed: SetupChecklist = {
      ...CHECKLIST,
      done: 5,
      complete: true,
      dismissedAt: "2026-09-12T10:00:00.000Z",
    };
    bridge.invoke.mockImplementation((channel) => {
      if (channel === "app:dismiss-checklist") return dismissed;
      return defaultInvoke(channel);
    });
    const wrapper = await mountCard();
    await wrapper.findAll("button").find((button) => button.text() === "Dismiss")!.trigger("click");
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith("app:dismiss-checklist", true);
    expect(wrapper.text()).toContain("Setup complete");
    await wrapper.findAll("button").find((button) => button.text() === "Show checklist")!.trigger("click");
    expect(wrapper.findAll("li").length).toBe(10);
  });

  it("drops the per-step detail text in compact mode", async () => {
    const wrapper = await mountCard({ compact: true });
    expect(wrapper.text()).not.toContain("Press Test overlay once");
    expect(wrapper.findAll("li")).toHaveLength(10);
  });

  it("re-renders when main announces a new checklist", async () => {
    const wrapper = await mountCard();
    const changed: SetupChecklist = { ...CHECKLIST, done: 5, required: 5, complete: true };
    bridge.listeners.get("app:checklist-changed")?.(changed);
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".count-badge").text()).toBe("5/5");
  });

  it("shows the failure instead of throwing", async () => {
    bridge.invoke.mockImplementation((channel) => {
      if (channel === "app:setup-checklist") throw new Error("checklist unavailable");
      return defaultInvoke(channel);
    });
    const wrapper = await mountCard();
    expect(wrapper.find("[role=alert]").text()).toContain("checklist unavailable");
  });

  it("renders nothing at all in the browser preview", async () => {
    bridge.available = false;
    const wrapper = await mountCard();
    expect(wrapper.find("section").exists()).toBe(false);
  });
});
