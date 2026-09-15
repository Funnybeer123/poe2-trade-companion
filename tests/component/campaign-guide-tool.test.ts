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
  type CampaignGuideSettings,
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

import CampaignGuideTool from "../../src/renderer/features/campaignGuide/CampaignGuideTool.vue";
import { disposeCampaignGuide } from "../../src/renderer/features/campaignGuide/useCampaignGuide";

function routeView(settings: CampaignGuideSettings = defaultCampaignGuideSettings(), revision = 1): CampaignRouteView {
  return {
    merged: mergeCampaignRoute(ROUTE, settings),
    bundled: { source: "file", path: "mini", issues: [], areaCount: 5, updatedAt: "2026-09-12" },
    settings,
    progressRevision: revision,
    generatedAt: "2026-09-12T21:00:00.000Z",
  };
}

function stateView(areaId = "G1_3", revision = 1): CampaignStateView {
  const settings = defaultCampaignGuideSettings();
  const merged = mergeCampaignRoute(ROUTE, settings);
  const resolution = resolveArea(merged, areaId, areaInfo(areaId));
  return {
    current: { ...resolution, observedLevel: 3, at: "2026-09-12T18:00:00.000Z", seed: 1 },
    character: { name: "Tester", className: "Warrior", level: 12, seenAt: "2026-09-12T18:00:00.000Z", source: "log" },
    experience: experienceBand(12, 3),
    ...(resolution.area ? { next: nextStep(merged, resolution.area, settings) } : {}),
    overlay: { visible: false, autoShown: false },
    progressRevision: revision,
    clientLog: { watching: true },
    generatedAt: "2026-09-12T21:00:00.000Z",
  };
}

function wireBridge(overrides: Partial<Record<string, unknown>> = {}): void {
  bridge.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    if (channel in overrides) {
      const value = overrides[channel];
      if (typeof value === "function") return (value as (...a: unknown[]) => unknown)(...args);
      if (value instanceof Error) throw value;
      return value;
    }
    switch (channel) {
      case "campaign:route":
        return routeView();
      case "campaign:state":
        return stateView();
      case "campaign:customise":
        return routeView();
      case "settings:set":
        return {};
      default:
        throw new Error(`unexpected ${channel}`);
    }
  });
}

beforeEach(() => {
  bridge.available = true;
  bridge.listeners.clear();
  bridge.invoke.mockReset();
  wireBridge();
});

afterEach(() => {
  disposeCampaignGuide();
});

async function mountTool(overrides: Partial<Record<string, unknown>> = {}) {
  wireBridge(overrides);
  const wrapper = mount(CampaignGuideTool);
  await flushPromises();
  return wrapper;
}

describe("CampaignGuideTool", () => {
  it("renders the desktop-only state without a bridge", async () => {
    bridge.available = false;
    const wrapper = mount(CampaignGuideTool);
    await flushPromises();
    expect(wrapper.text()).toContain("Campaign guide needs the desktop app");
    wrapper.unmount();
  });

  it("shows the heading, the community chip and the XP estimate", async () => {
    const wrapper = await mountTool();
    expect(wrapper.find("h2#campaign-title").text()).toBe("Campaign guide");
    expect(wrapper.text()).toContain("Community-maintained · verify in game");
    expect(wrapper.text()).toContain("% XP");
    expect(wrapper.text()).toContain("estimates from the community formula");
    wrapper.unmount();
  });

  it("warns when the bundled route file is missing", async () => {
    const wrapper = await mountTool({
      "campaign:route": {
        ...routeView(),
        bundled: { source: "missing", path: "C:/app/src/data/campaign/route.json", issues: ["gone"], areaCount: 0, updatedAt: "" },
      },
    });
    expect(wrapper.text()).toContain("Bundled route not found at");
    wrapper.unmount();
  });

  it("shows the error state with a retry button", async () => {
    const wrapper = await mountTool({ "campaign:route": new Error("boom") });
    expect(wrapper.find("[role=alert]").text()).toContain("boom");
    expect(wrapper.text()).toContain("Retry");
    wrapper.unmount();
  });

  it("opens the act the current area is in", async () => {
    const wrapper = await mountTool();
    const acts = wrapper.findAll("details.campaign-act");
    expect(acts).toHaveLength(2);
    expect((acts[0].element as HTMLDetailsElement).open).toBe(true);
    expect((acts[1].element as HTMLDetailsElement).open).toBe(false);
    wrapper.unmount();
  });

  it("hides an objective through campaign:customise", async () => {
    const wrapper = await mountTool();
    const row = wrapper.find('[data-objective-id="G1_1.miller"]');
    const hide = row.findAll("button").find((button) => button.text() === "Hide");
    await hide!.trigger("click");
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith("campaign:customise", {
      op: "hide-objective",
      id: "G1_1.miller",
    });
    wrapper.unmount();
  });

  it("sends the whole order when an objective moves down", async () => {
    const wrapper = await mountTool();
    const row = wrapper.find('[data-objective-id="G1_1.miller"]');
    const down = row.findAll("button").find((button) => button.text() === "Down");
    await down!.trigger("click");
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith("campaign:customise", {
      op: "move-objective",
      areaId: "G1_1",
      orderedIds: ["G1_1.reach-G1_2", "G1_1.miller"],
    });
    wrapper.unmount();
  });

  it("writes a reward filter through settings:set", async () => {
    const wrapper = await mountTool();
    const checkbox = wrapper
      .findAll(".check-row .toggle-field")
      .find((label) => label.text().trim() === "gems")!
      .find("input");
    await checkbox.setValue(false);
    await flushPromises();
    const call = bridge.invoke.mock.calls.find(
      (entry) => entry[0] === "settings:set" && entry[1] === "campaign-guide",
    );
    expect((call?.[2] as { rewardFilters: Record<string, boolean> }).rewardFilters.gems).toBe(false);
    wrapper.unmount();
  });

  it("writes the overlay anchor from the Guide settings section", async () => {
    const wrapper = await mountTool();
    const select = wrapper.find(".campaign-guide-settings select");
    await select.setValue("left");
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith("settings:set", "campaign-guide", {
      overlayAnchor: "left",
    });
    wrapper.unmount();
  });

  it("needs two clicks to reset progress", async () => {
    const wrapper = await mountTool();
    const button = () =>
      wrapper.findAll("button").find((entry) => entry.text().startsWith("Reset progress") || entry.text() === "Confirm reset")!;
    await button().trigger("click");
    await flushPromises();
    expect(bridge.invoke.mock.calls.some((entry) => entry[0] === "campaign:customise")).toBe(false);
    expect(button().text()).toBe("Confirm reset");
    await button().trigger("click");
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith("campaign:customise", { op: "reset", what: "progress" });
    wrapper.unmount();
  });

  it("offers to add an area the route does not know", async () => {
    const wrapper = await mountTool({ "campaign:state": stateView("G4_99") });
    expect(wrapper.text()).toContain("Unknown area G4_99");
    const add = wrapper.findAll("button").find((button) => button.text() === "Add this area");
    await add!.trigger("click");
    await flushPromises();
    const idInput = wrapper.find(".campaign-editor input");
    expect((idInput.element as HTMLInputElement).value).toBe("G4_99");
    wrapper.unmount();
  });

  it("sends BOTH the area edit and the note when an area is saved", async () => {
    // The editor fires two patches in one tick; a drop-while-busy guard used to
    // swallow the second, so the note box accepted text and saved nothing.
    const wrapper = await mountTool();
    const editArea = wrapper.findAll("button").find((button) => button.text() === "Edit area");
    await editArea!.trigger("click");
    await flushPromises();

    const note = wrapper.find(".campaign-editor textarea");
    await note.setValue("Portal out before the boss.");
    const save = wrapper.findAll(".campaign-editor button").find((button) => button.text() === "Save");
    await save!.trigger("click");
    await flushPromises();

    const patches = bridge.invoke.mock.calls
      .filter((entry) => entry[0] === "campaign:customise")
      .map((entry) => entry[1] as { op: string });
    expect(patches.map((patch) => patch.op)).toEqual(["edit-area", "set-note"]);
    expect(patches[1]).toEqual({ op: "set-note", areaId: "G1_3", note: "Portal out before the boss." });
    wrapper.unmount();
  });

  it("disables the act placement fields while editing an existing area", async () => {
    const wrapper = await mountTool();
    const editArea = wrapper.findAll("button").find((button) => button.text() === "Edit area");
    await editArea!.trigger("click");
    await flushPromises();

    // `part`/`act` are not override keys, so an edit could not send them.
    const half = wrapper.find(".campaign-editor select");
    expect((half.element as HTMLSelectElement).disabled).toBe(true);
    const numbers = wrapper.findAll(".campaign-editor input[type=number]");
    expect((numbers[0].element as HTMLInputElement).disabled).toBe(true);
    expect((numbers[1].element as HTMLInputElement).disabled).toBe(false);
    wrapper.unmount();
  });

  it("moves an objective past a filtered-out one", async () => {
    const base = defaultCampaignGuideSettings();
    const settings: CampaignGuideSettings = {
      ...base,
      showOptional: false,
      customisations: {
        ...base.customisations,
        customObjectives: {
          G1_3: [{ id: "c_mine", title: "My own step", kind: "note", rewards: [], verified: false }],
        },
      },
    };
    const wrapper = await mountTool({ "campaign:route": routeView(settings) });
    const row = wrapper.find('[data-objective-id="G1_3.devourer"]');
    const down = row.findAll("button").find((button) => button.text() === "Down");
    await down!.trigger("click");
    await flushPromises();

    // The hidden optional row keeps its slot; the swap is with the next
    // VISIBLE objective, so the list the user sees actually changes.
    expect(bridge.invoke).toHaveBeenCalledWith("campaign:customise", {
      op: "move-objective",
      areaId: "G1_3",
      orderedIds: ["c_mine", "G1_3.optional", "G1_3.devourer"],
    });
    wrapper.unmount();
  });

  it("re-reads the route exactly once when the progress revision moves", async () => {
    // Main answers with the revision it is actually at, so a second event at
    // the same revision must NOT pull again.
    let routeRevision = 1;
    const wrapper = await mountTool({ "campaign:route": () => routeView(defaultCampaignGuideSettings(), routeRevision) });
    const before = bridge.invoke.mock.calls.filter((entry) => entry[0] === "campaign:route").length;
    routeRevision = 5;
    bridge.listeners.get("campaign:state")?.(stateView("G1_3", 5));
    await flushPromises();
    const after = bridge.invoke.mock.calls.filter((entry) => entry[0] === "campaign:route").length;
    expect(after - before).toBe(1);

    bridge.listeners.get("campaign:state")?.(stateView("G1_3", 5));
    await flushPromises();
    const again = bridge.invoke.mock.calls.filter((entry) => entry[0] === "campaign:route").length;
    expect(again - after).toBe(0);
    wrapper.unmount();
  });
});
