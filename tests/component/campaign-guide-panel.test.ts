// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import path from "node:path";
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { areaInfo } from "../../src/core/areaCatalog.js";
import {
  defaultCampaignGuideSettings,
  experienceBand,
  mergeCampaignRoute,
  nextStep,
  parseCampaignRoute,
  resolveArea,
} from "../../src/core/campaignGuide.js";
import type { CampaignRouteView, CampaignStateView } from "../../src/shared/campaignGuide.js";

const ROUTE = parseCampaignRoute(
  readFileSync(path.join(process.cwd(), "fixtures", "campaign-guide", "route-mini.json"), "utf8"),
).route;

const bridge = vi.hoisted(() => ({
  available: true,
  invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(),
  listeners: new Map<string, (payload: unknown) => void>(),
}));

vi.mock("../../src/renderer/services/featureApi", () => {
  const api = {
    invoke: (channel: string, ...args: unknown[]) => bridge.invoke(channel, ...args),
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

import CampaignPanel from "../../src/renderer/features/campaignGuide/CampaignPanel.vue";
import { disposeCampaignGuide } from "../../src/renderer/features/campaignGuide/useCampaignGuide";

const SETTINGS = defaultCampaignGuideSettings();
const MERGED = mergeCampaignRoute(ROUTE, SETTINGS);

function routeView(revision = 1): CampaignRouteView {
  return {
    merged: MERGED,
    bundled: { source: "file", path: "mini", issues: [], areaCount: 5, updatedAt: "2026-09-12" },
    settings: SETTINGS,
    progressRevision: revision,
    generatedAt: "2026-09-12T21:00:00.000Z",
  };
}

function stateView(areaId = "G1_3", characterLevel = 12, revision = 1): CampaignStateView {
  const resolution = resolveArea(MERGED, areaId, areaInfo(areaId));
  return {
    current: { ...resolution, observedLevel: 3, at: "2026-09-12T18:00:00.000Z", seed: 1 },
    character: { name: "Tester", level: characterLevel, source: "log" },
    experience: experienceBand(characterLevel, 3),
    ...(resolution.area ? { next: nextStep(MERGED, resolution.area, SETTINGS) } : {}),
    overlay: { visible: true, autoShown: true },
    progressRevision: revision,
    clientLog: { watching: true },
    generatedAt: "2026-09-12T21:00:00.000Z",
  };
}

beforeEach(() => {
  bridge.available = true;
  bridge.listeners.clear();
  bridge.invoke.mockReset();
  bridge.invoke.mockImplementation(async (channel: string) => {
    switch (channel) {
      case "campaign:route":
        return routeView();
      case "campaign:state":
        return stateView();
      case "campaign:customise":
        return routeView();
      default:
        throw new Error(`unexpected ${channel}`);
    }
  });
});

afterEach(() => {
  disposeCampaignGuide();
});

async function mountPanel(payload: unknown = { areaId: "G1_3", compact: false, reason: "auto" }) {
  const wrapper = mount(CampaignPanel, { props: { panelId: "campaign", payload, visible: true } });
  await flushPromises();
  return wrapper;
}

describe("CampaignPanel", () => {
  it("shows the area, the community note, the objectives and the next step", async () => {
    const wrapper = await mountPanel();
    expect(wrapper.text()).toContain("Mud Burrow");
    expect(wrapper.text()).toContain("Community route — verify in game");
    expect(wrapper.text()).toContain("Kill the Devourer");
    expect(wrapper.text()).toContain("Next (suggested): Kill the Devourer");
    wrapper.unmount();
  });

  it("says the XP percentage is an estimate", async () => {
    const wrapper = await mountPanel();
    // The panel is where the number is read while levelling, so it must carry
    // the same "estimate" wording as the tool.
    expect(wrapper.text()).toContain("XP % is an estimate");
    const chip = wrapper.find(".status-chip");
    expect(chip.attributes("title")).toContain("estimate, community formula");
    wrapper.unmount();
  });

  it("updates the XP chip from a campaign:state event", async () => {
    const wrapper = await mountPanel();
    const before = wrapper.find(".status-chip").text();
    bridge.listeners.get("campaign:state")?.(stateView("G1_3", 40));
    await flushPromises();
    const after = wrapper.find(".status-chip").text();
    expect(after).not.toBe(before);
    expect(after).toMatch(/~\d+ % XP/);
    wrapper.unmount();
  });

  it("hides the objective list in compact mode", async () => {
    const wrapper = await mountPanel({ areaId: "G1_3", compact: true, reason: "auto" });
    expect(wrapper.text()).toContain("Mud Burrow");
    expect(wrapper.find(".objective-list").exists()).toBe(false);
    wrapper.unmount();
  });

  it("browses the route and comes back to the current area", async () => {
    const wrapper = await mountPanel();
    const buttons = () => wrapper.findAll("button");
    const next = buttons().find((button) => button.text().includes("Next"))!;
    await next.trigger("click");
    await flushPromises();
    expect(wrapper.text()).not.toContain("Next (suggested)");
    const back = buttons().find((button) => button.text() === "Back to current");
    expect(back).toBeTruthy();
    await back!.trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("Mud Burrow");
    wrapper.unmount();
  });

  it("ticks an objective through campaign:customise", async () => {
    const wrapper = await mountPanel();
    const checkbox = wrapper.find('[data-objective-id="G1_3.devourer"] input[type=checkbox]');
    await checkbox.setValue(true);
    await flushPromises();
    const call = bridge.invoke.mock.calls.find((entry) => entry[0] === "campaign:customise");
    expect(call?.[1]).toMatchObject({ op: "set-done", id: "G1_3.devourer", done: true });
    wrapper.unmount();
  });

  it("renders a line instead of throwing on a junk payload", async () => {
    bridge.invoke.mockImplementation(async (channel: string) => {
      if (channel === "campaign:route") return routeView();
      if (channel === "campaign:state") {
        return { ...stateView("HideoutBeaconOfSalvation"), current: undefined };
      }
      throw new Error(`unexpected ${channel}`);
    });
    const wrapper = await mountPanel(42);
    expect(wrapper.text()).toContain("Not in a campaign area");
    wrapper.unmount();
  });

  it("says so when the bridge is missing", async () => {
    bridge.available = false;
    const wrapper = await mountPanel();
    expect(wrapper.text()).toContain("Campaign guide needs the desktop app");
    wrapper.unmount();
  });
});
