// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultStashValuationSettings, evaluateStashItem, unavailableStashQuote, type StashValuationReport, type StashValuationSettings } from "../../src/core/stashValuation.js";

const state = vi.hoisted(() => ({
  settings: {} as StashValuationSettings,
  profiles: {} as Record<string, StashValuationSettings>,
  report: null as StashValuationReport | null,
  save: vi.fn(), run: vi.fn(), overview: vi.fn(), running: false, dryRun: { value: false },
}));
vi.mock("../../src/renderer/services/rendererApi", () => ({
  getStashValuationApi: () => ({
    overview: state.overview,
    saveSettings: state.save,
  }),
  getStashTabAdminApi: () => ({ status: async () => ({ running: state.running }), runScript: state.run, onEvent: () => () => undefined }),
}));
vi.mock("../../src/renderer/composables/useRendererPreferences", async () => {
  const { ref } = await import("vue");
  return { useRendererPreferences: () => ({ defaultDryRun: ref(state.dryRun.value) }) };
});
import StashValuationPanel from "../../src/renderer/components/StashValuationPanel.vue";

beforeEach(() => {
  state.settings = { ...defaultStashValuationSettings(), league: "Forbidden Rites" };
  state.report = null;
  state.running = false;
  state.profiles = {};
  state.dryRun.value = false;
  state.save.mockReset().mockImplementation(async (settings: StashValuationSettings) => settings);
  state.run.mockReset().mockResolvedValue({ started: true });
  state.overview.mockReset().mockImplementation(async () => structuredClone({ settings: state.settings, profiles: state.profiles, report: state.report, issues: [] }));
});
afterEach(() => vi.useRealTimers());

function savedCapture(): StashValuationReport {
  const settings = { ...defaultStashValuationSettings(), league: "Forbidden Rites" };
  const at = "2026-09-14T12:00:00Z";
  const row = evaluateStashItem("Item Class: Rings\nRarity: Rare\nSaved Ring\nRuby Ring\n--------\n+18 to maximum Life",
    unavailableStashQuote(settings.league, "Earlier rate restriction.", at), settings, { id: "saved", row: 3, col: 2, at });
  return { schemaVersion: 1, id: "saved-capture", startedAt: at, league: settings.league, settings, scoreVersion: row.scoreVersion,
    sourceTab: "Dump", mode: "scan", status: "incomplete", scannedItems: 1, rows: [row], unreadCells: [], errors: [] };
}

describe("dump valuation panel", () => {
  it("disables saved pricing without a valid captured report or while another operation runs", async () => {
    const wrapper = mount(StashValuationPanel);
    await flushPromises();
    expect(wrapper.get('[data-test="resume-pricing"]').attributes("disabled")).toBeDefined();
    wrapper.unmount();
    state.report = savedCapture();
    state.running = true;
    const running = mount(StashValuationPanel);
    await flushPromises();
    expect(running.get('[data-test="resume-pricing"]').attributes("disabled")).toBeDefined();
    running.unmount();
  });

  it("saves an explicit local profile before starting only the selected pricing queue", async () => {
    state.report = savedCapture();
    state.dryRun.value = true;
    const wrapper = mount(StashValuationPanel);
    await flushPromises();
    expect(wrapper.get('[data-test="scan"]').attributes("disabled")).toBeUndefined();
    expect(wrapper.get('[data-test="resume-pricing"]').attributes("disabled")).toBeUndefined();
    await wrapper.get('[data-test="resume-pricing"]').trigger("click");
    await flushPromises();
    expect(state.run).toHaveBeenCalledExactlyOnceWith("value-dump-resume");
    expect(state.save).toHaveBeenCalled();
    expect(wrapper.text()).toContain("Pricing only the selected queue");
    expect(wrapper.text()).toContain("never enqueues every unpriced item afterward");
    expect(wrapper.get('[data-test="resume-pricing"]').attributes("disabled")).toBeDefined();
    wrapper.unmount();
  });

  it("shows saved pricing progress without describing it as a fresh item scan", async () => {
    state.report = Object.assign(savedCapture(), { pricingResume: { startedAt: "2026-09-14T13:00:00Z", pendingOnly: true,
      total: 1, completed: 0, retained: 0, previousStatus: "incomplete", previousErrors: [] } });
    const wrapper = mount(StashValuationPanel);
    await flushPromises();
    expect(wrapper.get('[data-test="pricing-progress"]').text()).toContain("0/1 selected lookups attempted");
    expect(wrapper.text()).toContain("This pricing pass did not scan the game");
    expect(wrapper.text()).not.toContain("Item coverage unconfirmed: scan");
    wrapper.unmount();
  });

  it("blocks scan and sort until a league is selected", async () => {
    state.settings.league = "";
    const wrapper = mount(StashValuationPanel);
    await flushPromises();
    expect(wrapper.get('[data-test="scan"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get('[data-test="sort"]').attributes("disabled")).toBeDefined();
    expect(wrapper.text()).toContain("exact league");
    expect(state.run).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("saves displayed settings before scanning and describes its clipboard input accurately", async () => {
    const wrapper = mount(StashValuationPanel);
    await flushPromises();
    await wrapper.get('[data-test="scan"]').trigger("click");
    await flushPromises();
    expect(state.save).toHaveBeenCalledWith(state.settings);
    expect(state.run).toHaveBeenCalledWith("value-dump");
    expect(state.save.mock.invocationCallOrder[0]).toBeLessThan(state.run.mock.invocationCallOrder[0]!);
    expect(wrapper.text()).toContain("copies item text using game input");
    expect(wrapper.text()).toContain("does not transfer items");
    wrapper.unmount();
  });

  it("does not launch the script when saving configuration fails", async () => {
    state.save.mockRejectedValue(new Error("Invalid sourceTab name."));
    const wrapper = mount(StashValuationPanel);
    await flushPromises();
    await wrapper.get('[data-test="scan"]').trigger("click");
    await flushPromises();
    expect(state.run).not.toHaveBeenCalled();
    expect(wrapper.get('[role="alert"]').text()).toContain("Invalid sourceTab");
    wrapper.unmount();
  });

  it("preserves the existing G folder and exact class names while selecting a league profile", async () => {
    state.profiles.Standard = { ...defaultStashValuationSettings(), league: "Standard", weights: { life: 2.5 } };
    const wrapper = mount(StashValuationPanel);
    await flushPromises();
    expect((wrapper.get('[data-test="destination-folder"]').element as HTMLInputElement).value).toBe("G");
    expect((wrapper.get('[data-test="class-Body Armor"]').element as HTMLInputElement).value).toBe("Body Armour");
    expect((wrapper.get('[data-test="class-QuarterStaff"]').element as HTMLInputElement).value).toBe("QuarterStaff");
    await wrapper.get('[data-test="league"]').setValue("Standard");
    await wrapper.get('[data-test="league"]').trigger("change");
    await wrapper.get('[data-test="scan"]').trigger("click");
    await flushPromises();
    expect(state.save).toHaveBeenCalledWith(expect.objectContaining({ league: "Standard", weights: { life: 2.5 } }));
    wrapper.unmount();
  });

  it("honors global dry-run for item transfers while leaving scan available", async () => {
    state.dryRun.value = true;
    const wrapper = mount(StashValuationPanel);
    await flushPromises();
    expect(wrapper.get('[data-test="sort"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get('[data-test="scan"]').attributes("disabled")).toBeUndefined();
    expect(wrapper.text()).toContain("Item transfers are disabled");
    wrapper.unmount();
  });

  it("starts the move command only from the explicit sort action", async () => {
    state.report = savedCapture();
    const wrapper = mount(StashValuationPanel);
    await flushPromises();
    await wrapper.get('[data-test="sort"]').trigger("click");
    await flushPromises();
    expect(state.run).toHaveBeenCalledWith("value-dump-sort");
    wrapper.unmount();
  });

  it("renders all item rows, unpriced evidence, actual movement status, and incomplete coverage", async () => {
    const row = {
      id: "one", rawText: "Item Class: Rings\nRarity: Rare\nStorm Loop\nRuby Ring", name: "Storm Loop", baseType: "Ruby Ring", itemClass: "Rings",
      sourceTab: "Dump", row: 0, col: 0, scoreVersion: "test-1", gearScore: 82, craftScore: 0, mods: [],
      quote: { state: "priced" as const, league: "Forbidden Rites", provider: "trade2", fetchedAt: "2026-09-14T12:00:00Z", currency: "chaos" as const,
        low: 2, fair: 3, high: 4, sampleSize: 5, candidateCount: 10, confidence: 80, reasons: [] },
      decision: "valuable" as const, destination: "Sell", status: "moved" as const, actualDestination: "Sell", reasons: ["Conservative estimate exceeds one chaos."],
    };
    state.report = {
      schemaVersion: 1, id: "scan", startedAt: "2026-09-14T12:00:00Z", league: "Forbidden Rites", settings: state.settings,
      scoreVersion: "test-1", mode: "move", status: "incomplete", sourceTab: "Dump", scannedItems: 2,
      unreadCells: [{ row: 1, col: 2 }], errors: [], rows: [row, {
        ...row, id: "two", name: "Unknown Wand", status: "stay", decision: "review", destination: "Dump", actualDestination: undefined,
        quote: { ...row.quote, state: "unavailable", low: undefined, fair: undefined, high: undefined, sampleSize: 0, candidateCount: 0, confidence: 0, reasons: ["Provider unavailable."] },
      }],
    };
    const wrapper = mount(StashValuationPanel);
    await flushPromises();
    expect(wrapper.findAll('[data-test="valuation-row"]')).toHaveLength(2);
    expect(wrapper.text()).toContain("3 chaos");
    expect(wrapper.text()).toContain("Unpriced · unavailable");
    expect(wrapper.text()).toContain("5 usable / 10 candidates");
    expect(wrapper.text()).toContain("valuable · moved");
    expect(wrapper.text()).toContain("Actual: Sell");
    expect(wrapper.text()).toContain("Provider unavailable.");
    expect(wrapper.text()).toContain("Item coverage incomplete: 1 unresolved cells");
    expect(wrapper.text()).toContain("2 items scanned · 2 rows recorded");
    wrapper.unmount();
  });

  it("separates completed item coverage from stale market evidence", async () => {
    state.report = {
      schemaVersion: 1, id: "stale-scan", startedAt: "2020-01-01T12:00:00Z", league: "Forbidden Rites", settings: state.settings,
      scoreVersion: "test-1", mode: "scan", status: "incomplete", sourceTab: "Dump", scannedItems: 1, unreadCells: [], errors: [],
      rows: [{ id: "stale", rawText: "copied item", name: "Old Ring", baseType: "Ruby Ring", itemClass: "Rings", sourceTab: "Dump",
        scoreVersion: "test-1", gearScore: 10, craftScore: 0, mods: [], decision: "review", destination: "Dump", status: "stay", reasons: [],
        quote: { state: "priced", league: "Forbidden Rites", provider: "trade2", fetchedAt: "2020-01-01T12:00:00Z", currency: "chaos",
          low: 2, fair: 3, high: 4, sampleSize: 5, candidateCount: 8, confidence: 80, reasons: [] },
      }],
    };
    const wrapper = mount(StashValuationPanel);
    await flushPromises();
    expect(wrapper.text()).toContain("Item scan coverage: no unresolved cells were reported");
    expect(wrapper.text()).toContain("1 quotes with limited or stale evidence");
    expect(wrapper.text()).toContain("Stale quote: older than 60 minutes");
    expect(wrapper.text()).not.toContain("coverage incomplete: 0 unresolved cells");
    wrapper.unmount();
  });

  it("shows a geometry failure with zero rows as an unconfirmed failed scan", async () => {
    state.report = {
      schemaVersion: 1, id: "failed-scan", startedAt: "2026-09-14T12:00:00Z", league: "Forbidden Rites", settings: state.settings,
      scoreVersion: "test-1", mode: "scan", status: "failed", sourceTab: "Dump", scannedItems: 0, unreadCells: [], rows: [],
      errors: ["Source scan failed: no-geometry"],
    };
    const wrapper = mount(StashValuationPanel);
    await flushPromises();
    expect(wrapper.text()).toContain("No item values were established because the source scan failed");
    expect(wrapper.text()).toContain("Item coverage unconfirmed: scan failed");
    expect(wrapper.text()).toContain("Source scan failed: no-geometry");
    expect(wrapper.text()).not.toContain("Item scan coverage: no unresolved cells were reported");
    wrapper.unmount();
  });

  it("automatically displays new rows during a running scan and expires the provider's evidence deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T12:00:00Z"));
    state.running = true;
    state.report = {
      schemaVersion: 1, id: "live-report", startedAt: "2026-09-14T12:00:00Z", league: "Forbidden Rites", settings: state.settings,
      scoreVersion: "test-1", mode: "scan", status: "running", sourceTab: "Dump", scannedItems: 0, unreadCells: [], rows: [], errors: [],
    };
    const wrapper = mount(StashValuationPanel);
    await flushPromises();
    expect(wrapper.findAll('[data-test="valuation-row"]')).toHaveLength(0);
    state.report = { ...state.report, scannedItems: 1, rows: [{
      id: "arrived", rawText: "fresh copied item", name: "Arriving Ring", baseType: "Ruby Ring", itemClass: "Rings", sourceTab: "Dump",
      scoreVersion: "test-1", gearScore: 15, craftScore: 0, mods: [], decision: "valuable", destination: "Rings", status: "planned", reasons: [],
      quote: { state: "priced", league: "Forbidden Rites", provider: "trade2", fetchedAt: "2026-09-14T12:00:00Z", validUntil: "2026-09-14T12:00:03Z", currency: "chaos",
        low: 2, fair: 3, high: 4, sampleSize: 5, candidateCount: 8, confidence: 80, reasons: [] },
    }] };
    await vi.advanceTimersByTimeAsync(2_000);
    await flushPromises();
    expect(wrapper.findAll('[data-test="valuation-row"]')).toHaveLength(1);
    expect(wrapper.text()).toContain("Arriving Ring");
    expect(wrapper.text()).not.toContain("Expired market or currency evidence");
    await vi.advanceTimersByTimeAsync(2_000);
    await flushPromises();
    expect(wrapper.text()).toContain("Expired market or currency evidence");
    expect(wrapper.text()).toContain("1 quotes with limited or stale evidence");
    const calls = state.overview.mock.calls.length;
    wrapper.unmount();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(state.overview).toHaveBeenCalledTimes(calls);
  });
});
