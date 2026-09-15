// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SnapshotDiff,
  SnapshotMeta,
  StashTrackerOverview,
  WealthSnapshot,
} from "../../src/shared/stashTracker.js";

const bridge = vi.hoisted(() => ({
  available: true,
  invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(),
  listeners: new Map<string, (payload: unknown) => void>(),
}));

vi.mock("../../src/renderer/services/featureApi", () => ({
  createFeatureApi: () =>
    bridge.available
      ? {
          invoke: (channel: string, ...args: unknown[]) => bridge.invoke(channel, ...args),
          on: (channel: string, callback: (payload: unknown) => void) => {
            bridge.listeners.set(channel, callback);
            return () => bridge.listeners.delete(channel);
          },
        }
      : null,
}));

vi.mock("vue-router", () => ({
  useRoute: () => ({ hash: "", path: "/tools/stash-tracker" }),
  RouterLink: { template: "<a><slot /></a>" },
}));

import StashTrackerTool from "../../src/renderer/features/stashTracker/StashTrackerTool.vue";
import SnapshotCompare from "../../src/renderer/features/stashTracker/components/SnapshotCompare.vue";
import type { StashTrackerApi } from "../../src/renderer/features/stashTracker/api";

function meta(partial: Partial<SnapshotMeta> = {}): SnapshotMeta {
  return {
    version: 1,
    id: "snap-1",
    at: "2026-09-12T18:40:03.120Z",
    kind: "manual",
    label: "before mapping",
    sessionId: "s-1",
    ledgerAt: "2026-09-12T18:31:55.000Z",
    recordCount: 12,
    divineRate: 98,
    totalExalted: 160,
    totalDivine: 1.63,
    itemCount: 4,
    locationCount: 3,
    effectiveExalted: 160,
    effectiveDivine: 1.63,
    ...partial,
  };
}

function current(): WealthSnapshot {
  return {
    version: 1,
    id: "current",
    at: "2026-09-12T19:00:00.000Z",
    kind: "auto",
    sessionId: "s-1",
    ledgerAt: "2026-09-12T18:31:55.000Z",
    recordCount: 12,
    divineRate: 98,
    totalExalted: 160,
    totalDivine: 1.63,
    items: [
      {
        fingerprint: "cafebabecafebabe",
        location: "Belts",
        name: "Headhunter",
        itemClass: "Belts",
        rarity: "Unique",
        identified: true,
        count: 1,
        units: 1,
        stackable: false,
        valueExalted: 120,
        source: "price-table",
        at: "2026-09-12T18:31:55.000Z",
        runId: "run-1",
      },
    ],
    locations: [
      {
        location: "Belts",
        items: 1,
        priced: 1,
        unpriced: 0,
        valueExalted: 120,
        lastScanAt: "2026-09-12T18:31:55.000Z",
        runId: "run-1",
      },
    ],
  };
}

function overview(partial: Partial<StashTrackerOverview> = {}): StashTrackerOverview {
  return {
    generatedAt: "2026-09-12T19:00:00.000Z",
    sessionId: "s-1",
    ledger: {
      file: "C:/cfg/inventory.jsonl",
      exists: true,
      recordCount: 12,
      observationCount: 4,
      newestAt: "2026-09-12T18:31:55.000Z",
      ageMs: 30 * 60_000,
      locations: ["Belts", "Rings"],
    },
    current: meta({ id: "current", kind: "auto" }),
    snapshots: [meta()],
    session: {
      sessionId: "s-1",
      start: meta({ id: "snap-start", kind: "session-start", effectiveExalted: 100 }),
      latest: meta({ id: "current", kind: "auto" }),
      deltaExalted: 60,
      deltaDivine: 0.61,
      divineRate: 98,
      elapsedMs: 3_600_000,
      topGains: [],
      topLosses: [],
    },
    settings: {
      excludedFingerprints: [],
      autoSnapshot: true,
      maxAutoSnapshots: 100,
      overlay: {
        topLevelTabs: [],
        fadeByValue: true,
        showUnpriced: true,
        minLabelExalted: 0,
        showLegend: true,
      },
    },
    overlay: {
      visible: false,
      legendVisible: false,
      topLevel: false,
      tabs: ["Belts", "Rings"],
      priced: 0,
      unpriced: 0,
      items: 0,
      poeRunning: true,
    },
    files: { snapshots: "C:/user/stash-tracker/snapshots.jsonl", summary: "C:/user/stash-tracker/summary.json" },
    ...partial,
  };
}

const DIFF: SnapshotDiff = {
  fromId: "snap-1",
  toId: "current",
  fromAt: "2026-09-12T18:40:03.120Z",
  toAt: "2026-09-12T19:00:00.000Z",
  totalDelta: 15,
  totalDeltaDivine: 0.15,
  divineRate: 98,
  added: 0,
  removed: 0,
  changed: 1,
  moved: 0,
  trimmed: false,
  deltas: [
    {
      kind: "changed",
      key: "ffffffffffffffff|Currency",
      fingerprint: "ffffffffffffffff",
      name: "Exalted Orb",
      itemClass: "Stackable Currency",
      rarity: "Currency",
      stackable: true,
      before: { location: "Currency", units: 37, valueExalted: 37 },
      after: { location: "Currency", units: 52, valueExalted: 52 },
      unitsDelta: 15,
      valueDelta: 15,
    },
  ],
};

function defaultInvoke(channel: string, ...args: unknown[]): Promise<unknown> {
  switch (channel) {
    case "stash-tracker:overview":
      return Promise.resolve(overview());
    case "stash-tracker:current":
      return Promise.resolve(current());
    case "stash-tracker:compare":
      return Promise.resolve(DIFF);
    case "stash-tracker:snapshot":
    case "stash-tracker:rename":
    case "stash-tracker:delete":
    case "stash-tracker:session-start":
      return Promise.resolve(overview());
    case "stash-tracker:exclude":
    case "stash-tracker:configure":
      return Promise.resolve(overview().settings);
    case "stash-tracker:overlay-toggle":
      return Promise.resolve(overview().overlay);
    default:
      return Promise.reject(new Error(`unexpected ${channel} ${JSON.stringify(args)}`));
  }
}

async function mountTool() {
  const wrapper = mount(StashTrackerTool);
  await flushPromises();
  return wrapper;
}

function buttonByText(wrapper: ReturnType<typeof mount>, text: string) {
  const found = wrapper.findAll("button").find((candidate) => candidate.text() === text);
  if (!found) throw new Error(`no button "${text}"`);
  return found;
}

function tabByLabel(wrapper: ReturnType<typeof mount>, label: string) {
  const found = wrapper
    .findAll('[role="tab"]')
    .find((candidate) => candidate.text().startsWith(label));
  if (!found) throw new Error(`no tab "${label}"`);
  return found;
}

describe("StashTrackerTool", () => {
  beforeEach(() => {
    bridge.available = true;
    bridge.listeners.clear();
    bridge.invoke.mockReset().mockImplementation(defaultInvoke);
  });

  it("renders the metrics and the history from the overview", async () => {
    const wrapper = await mountTool();
    expect(bridge.invoke).toHaveBeenCalledWith("stash-tracker:overview");
    expect(wrapper.find("h2").text()).toBe("Stash tracker");
    expect(wrapper.text()).toContain("160 ex");
    expect(wrapper.text()).toContain("+60 ex");
    expect(wrapper.text()).toContain("before mapping");
    expect(wrapper.text()).toContain("Estimates, never guarantees");
    wrapper.unmount();
  });

  it("takes a named snapshot through the bridge", async () => {
    const wrapper = await mountTool();
    await wrapper.find("#snapshot-name").setValue("  before mapping  ");
    await buttonByText(wrapper, "Take snapshot").trigger("click");
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith("stash-tracker:snapshot", "before mapping");
    wrapper.unmount();
  });

  it("renames and needs two clicks to delete", async () => {
    const wrapper = await mountTool();
    await buttonByText(wrapper, "Rename").trigger("click");
    await wrapper.find('input[maxlength="60"][id^="rename-"]').setValue("after mapping");
    await buttonByText(wrapper, "Save").trigger("click");
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith("stash-tracker:rename", "snap-1", "after mapping");

    await buttonByText(wrapper, "Delete").trigger("click");
    expect(bridge.invoke).not.toHaveBeenCalledWith("stash-tracker:delete", "snap-1");
    await buttonByText(wrapper, "Confirm").trigger("click");
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith("stash-tracker:delete", "snap-1");
    wrapper.unmount();
  });

  it("compares a snapshot against the live ledger", async () => {
    const wrapper = await mountTool();
    await tabByLabel(wrapper, "Compare").trigger("click");
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith("stash-tracker:compare", "snap-1", "current");
    expect(wrapper.text()).toContain("Exalted Orb");
    expect(wrapper.text()).toContain("+15");
    wrapper.unmount();
  });

  it("excludes an item from the per-tab list", async () => {
    const wrapper = await mountTool();
    await tabByLabel(wrapper, "Per tab").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("Headhunter");
    const checkbox = wrapper.find('input[aria-label="Exclude Headhunter from totals"]');
    await checkbox.setValue(true);
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith(
      "stash-tracker:exclude",
      "cafebabecafebabe",
      true,
    );
    wrapper.unmount();
  });

  it("draws the timeline as one accessible image", async () => {
    const wrapper = await mountTool();
    await tabByLabel(wrapper, "Timeline").trigger("click");
    await flushPromises();
    const svg = wrapper.find('svg[role="img"]');
    expect(svg.exists()).toBe(true);
    expect(svg.attributes("aria-label")).toBe("Stash worth over time");
    expect(wrapper.findAll("svg circle").length).toBeGreaterThan(0);
    wrapper.unmount();
  });

  it("keeps Save options disabled until something changes, then configures", async () => {
    const wrapper = await mountTool();
    const save = buttonByText(wrapper, "Save options");
    expect(save.attributes("disabled")).toBeDefined();
    const autoSnapshot = wrapper.findAll('input[type="checkbox"]')[0]!;
    await autoSnapshot.setValue(false);
    await flushPromises();
    expect(buttonByText(wrapper, "Save options").attributes("disabled")).toBeUndefined();
    await buttonByText(wrapper, "Save options").trigger("click");
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith(
      "stash-tracker:configure",
      expect.objectContaining({ autoSnapshot: false }),
    );
    wrapper.unmount();
  });

  it("re-renders when main pushes stash-tracker:changed", async () => {
    const wrapper = await mountTool();
    const listener = bridge.listeners.get("stash-tracker:changed")!;
    listener(overview({ snapshots: [meta({ id: "snap-2", label: "after mapping" })] }));
    await flushPromises();
    expect(wrapper.text()).toContain("after mapping");
    wrapper.unmount();
  });

  it("says the ledger is empty instead of pretending there is worth", async () => {
    bridge.invoke.mockImplementation((channel: string, ...args: unknown[]) => {
      if (channel === "stash-tracker:overview") {
        return Promise.resolve(
          overview({
            ledger: {
              file: "C:/cfg/inventory.jsonl",
              exists: false,
              recordCount: 0,
              observationCount: 0,
              locations: [],
            },
            snapshots: [],
          }),
        );
      }
      if (channel === "stash-tracker:current") return Promise.resolve(undefined);
      return defaultInvoke(channel, ...args);
    });
    const wrapper = await mountTool();
    expect(wrapper.text()).toContain("Nothing in the ledger yet");
    expect(buttonByText(wrapper, "Take snapshot").attributes("disabled")).toBeDefined();
    wrapper.unmount();
  });

  it("reports a thrown bridge error instead of hanging on the spinner", async () => {
    bridge.invoke.mockRejectedValue(new Error("ipc down"));
    const wrapper = await mountTool();
    expect(wrapper.find(".spinner").exists()).toBe(false);
    expect(wrapper.find('[role="alert"]').text()).toBe("ipc down");
    wrapper.unmount();
  });

  it("disables Show overlay while the game is not running, and enables it live", async () => {
    bridge.invoke.mockImplementation((channel: string, ...args: unknown[]) => {
      if (channel === "stash-tracker:overview") {
        return Promise.resolve(
          overview({ overlay: { ...overview().overlay, poeRunning: false } }),
        );
      }
      return defaultInvoke(channel, ...args);
    });
    const wrapper = await mountTool();
    const button = buttonByText(wrapper, "Show overlay");
    expect(button.attributes("disabled")).toBeDefined();
    expect(button.attributes("title")).toBe("Path of Exile is not running");

    // The overlay foundation's own poll is the only thing that notices the
    // game starting while the tool is open.
    bridge.listeners.get("stash-tracker:overlay")!({
      ...overview().overlay,
      poeRunning: true,
    });
    await flushPromises();
    expect(buttonByText(wrapper, "Show overlay").attributes("disabled")).toBeUndefined();
    wrapper.unmount();
  });

  it("switches the labelled tab from the selector while the overlay is up", async () => {
    bridge.invoke.mockImplementation((channel: string, ...args: unknown[]) => {
      if (channel === "stash-tracker:overview") {
        return Promise.resolve(
          overview({ overlay: { ...overview().overlay, visible: true, tab: "Belts" } }),
        );
      }
      if (channel === "stash-tracker:overlay-show") return Promise.resolve(overview().overlay);
      return defaultInvoke(channel, ...args);
    });
    const wrapper = await mountTool();
    await wrapper.find("#overlay-tab").setValue("Rings");
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith("stash-tracker:overlay-show", "Rings");
    wrapper.unmount();
  });

  it("is a desktop-only notice without the bridge", async () => {
    bridge.available = false;
    const wrapper = await mountTool();
    expect(wrapper.text()).toContain("needs the desktop app");
    expect(bridge.invoke).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});

describe("SnapshotCompare", () => {
  function mountCompare(hasCurrent: boolean, invoke = vi.fn().mockResolvedValue(DIFF)) {
    const api = { invoke, on: () => () => undefined } as unknown as StashTrackerApi;
    const wrapper = mount(SnapshotCompare, {
      props: {
        snapshots: [meta({ id: "snap-2" }), meta({ id: "snap-1" })],
        api,
        hasCurrent,
      },
    });
    return { wrapper, invoke };
  }

  it("compares against the live ledger when there is one", async () => {
    const { wrapper, invoke } = mountCompare(true);
    await flushPromises();
    expect(invoke).toHaveBeenCalledWith("stash-tracker:compare", "snap-1", "current");
    wrapper.unmount();
  });

  it("shows the empty state instead of a false 'no longer on disk' error", async () => {
    const { wrapper, invoke } = mountCompare(false);
    await flushPromises();
    // Without a current snapshot the option does not exist, so asking for it
    // would come back undefined and read as a deleted snapshot.
    expect(invoke).not.toHaveBeenCalled();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.text()).toContain("Pick two snapshots to compare.");

    // `as never`: the repo's convention for VTU's setProps on an SFC (see
    // tests/component/inspect-section.test.ts).
    await wrapper.setProps({ hasCurrent: true } as never);
    await flushPromises();
    expect(invoke).toHaveBeenCalledWith("stash-tracker:compare", "snap-1", "current");
    wrapper.unmount();
  });
});
