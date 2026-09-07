// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LootFilterOutput, LootFilterRequest } from "../../src/core/lootFilter.js";
import type { LootFilterSaveResult } from "../../src/shared/ipc.js";

const bridge = vi.hoisted(() => ({
  generateFilter: vi.fn(),
  saveFilter: vi.fn(),
  canSave: true,
  feedStatus: vi.fn(),
  configure: vi.fn(),
  leagues: vi.fn(),
}));

vi.mock("../../src/renderer/services/rendererApi", () => ({
  rendererApi: {
    isNative: true,
    mode: vi.fn(async () => "public-companion"),
    windows: vi.fn(async () => []),
    killLatched: vi.fn(async () => false),
    rearm: vi.fn(async () => false),
    generateFilter: bridge.generateFilter,
    canSaveFilter: () => bridge.canSave,
    saveFilter: bridge.saveFilter,
  },
  getPriceFeedApi: () => ({
    status: bridge.feedStatus,
    leagues: bridge.leagues,
    refresh: vi.fn(),
    configure: bridge.configure,
    comps: vi.fn(),
  }),
}));

import FilterSettingsTool from "../../src/renderer/components/tools/FilterSettingsTool.vue";

function output(text: string): LootFilterOutput {
  return {
    text,
    summary: {
      highlightedBases: 1,
      priceRows: 1,
      feedRows: 1,
      skippedEntries: 0,
      tiers: {
        chase: { uniqueBases: 1, currency: 0, bases: 0 },
        valuable: { uniqueBases: 0, currency: 0, bases: 0 },
        pickup: { uniqueBases: 0, currency: 0, bases: 0 },
      },
    },
  } as LootFilterOutput;
}

const FEED_STATUS = {
  config: { league: "auto", autoRefreshDaily: false, poesessid: "" },
  resolvedLeague: "Runes of Aldur",
  leagueCandidates: [{ value: "Runes of Aldur", divinePrice: 624 }],
  leagueAmbiguous: false,
  feedEntryCount: 2,
  refreshing: false,
};

describe("FilterSettingsTool", () => {
  beforeEach(() => {
    bridge.canSave = true;
    bridge.generateFilter.mockReset().mockImplementation(async (request: LootFilterRequest) =>
      output(`# ${request.name} chase>=${request.tiers?.chaseAtOrAbove ?? "default"}`),
    );
    bridge.saveFilter.mockReset();
    bridge.feedStatus.mockReset().mockResolvedValue(FEED_STATUS);
    bridge.configure.mockReset().mockResolvedValue(FEED_STATUS);
    bridge.leagues.mockReset().mockResolvedValue(FEED_STATUS.leagueCandidates);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the newest preview when an older build finishes last", async () => {
    // Only setTimeout is faked: the 250 ms preview debounce runs on it, while
    // flushPromises keeps its real scheduler.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let releaseFirst: (value: LootFilterOutput) => void = () => undefined;
    bridge.generateFilter.mockImplementationOnce(
      () =>
        new Promise<LootFilterOutput>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    const wrapper = mount(FilterSettingsTool, { props: { panel: "filter" } });
    await flushPromises();
    expect(bridge.generateFilter).toHaveBeenCalledOnce();

    await wrapper.find('input[step="1"]').setValue(80);
    vi.advanceTimersByTime(300);
    await flushPromises();
    expect(bridge.generateFilter).toHaveBeenCalledTimes(2);
    expect(wrapper.find(".filter-output").text()).toBe("# poe2-companion chase>=80");

    releaseFirst(output("# STALE"));
    await flushPromises();
    expect(wrapper.find(".filter-output").text()).toBe("# poe2-companion chase>=80");
    expect(wrapper.text()).not.toContain("STALE");
    wrapper.unmount();
  });

  it("opens the save dialog once per click and reports the chosen path", async () => {
    let release: (value: LootFilterSaveResult) => void = () => undefined;
    bridge.saveFilter.mockImplementation(
      () =>
        new Promise<LootFilterSaveResult>((resolve) => {
          release = resolve;
        }),
    );
    const wrapper = mount(FilterSettingsTool, { props: { panel: "filter" } });
    await flushPromises();
    const save = wrapper.findAll("button").find((button) => button.text() === "Save…")!;
    await save.trigger("click");
    await save.trigger("click");
    await flushPromises();
    expect(bridge.saveFilter).toHaveBeenCalledOnce();
    expect(save.text()).toBe("Saving…");
    expect(save.attributes("disabled")).toBeDefined();
    release({ saved: true, path: "C:\\Games\\poe2-companion.filter" });
    await flushPromises();
    expect(wrapper.find('[role="status"]').text()).toContain("poe2-companion.filter");
    expect(save.attributes("disabled")).toBeUndefined();
    wrapper.unmount();
  });

  it("hides Save… in the browser preview and surfaces a failed generation", async () => {
    bridge.canSave = false;
    bridge.generateFilter.mockRejectedValueOnce(new Error("no price table"));
    const wrapper = mount(FilterSettingsTool, { props: { panel: "filter" } });
    await flushPromises();
    expect(wrapper.findAll("button").some((button) => button.text() === "Save…")).toBe(false);
    expect(wrapper.find('[role="alert"]').text()).toBe("no price table");
    expect(wrapper.text()).toContain("No filter yet");
    wrapper.unmount();
  });

  it("reports a failed market-settings save instead of an unhandled rejection", async () => {
    bridge.configure.mockRejectedValueOnce(new Error("config dir read-only"));
    const wrapper = mount(FilterSettingsTool, { props: { panel: "settings" } });
    await flushPromises();
    expect(wrapper.text()).toContain("Pricing league: Runes of Aldur (auto)");
    const save = wrapper.findAll("button").find((button) => button.text() === "Save market settings")!;
    await save.trigger("click");
    await flushPromises();
    expect(bridge.configure).toHaveBeenCalledWith({ league: "auto", autoRefreshDaily: false });
    expect(wrapper.find('[role="alert"]').text()).toBe("config dir read-only");
    wrapper.unmount();
  });
});
