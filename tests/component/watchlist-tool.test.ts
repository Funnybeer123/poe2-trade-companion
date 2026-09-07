// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DealAlert, Watch } from "../../src/core/watchlist.js";
import type { WatchlistOverviewView } from "../../src/shared/ipc.js";

const bridge = vi.hoisted(() => ({
  overview: undefined as unknown,
  save: vi.fn(),
  scanNow: vi.fn(),
  copyWhisper: vi.fn(),
  dismiss: vi.fn(),
}));

vi.mock("../../src/renderer/services/rendererApi", () => ({
  getWatchlistApi: () => ({
    overview: vi.fn(async () => bridge.overview),
    save: bridge.save,
    scanNow: bridge.scanNow,
    copyWhisper: bridge.copyWhisper,
    dismiss: bridge.dismiss,
  }),
}));

import WatchlistTool from "../../src/renderer/components/tools/WatchlistTool.vue";

const WATCH: Watch = {
  id: "temporalis",
  label: "Temporalis (Silk Robe)",
  enabled: true,
  kind: "unique",
  query: { name: "Temporalis", baseType: "Silk Robe" },
  thresholdPercent: 60,
  minSample: 4,
  intervalMinutes: 10,
  lastScanAt: "2026-09-07T10:00:00.000Z",
  lastReferenceExalted: 200,
};

const WITH_WHISPER: DealAlert = {
  id: "temporalis:a:100",
  at: "2026-09-07T10:00:00.000Z",
  watchId: "temporalis",
  listingId: "a",
  name: "Temporalis",
  baseType: "Silk Robe",
  askExalted: 100,
  ask: { amount: 100, currency: "exalted" },
  referenceExalted: 200,
  discountPercent: 50,
  accountName: "seller-a",
  whisper: "@seller-a Hi, I would like to buy your Temporalis",
};

const WITHOUT_WHISPER: DealAlert = {
  ...WITH_WHISPER,
  id: "temporalis:b:110",
  listingId: "b",
  askExalted: 110,
  ask: { amount: 110, currency: "exalted" },
  discountPercent: 45,
  accountName: "seller-b",
  whisper: undefined,
};

function overview(partial: Partial<WatchlistOverviewView> = {}): WatchlistOverviewView {
  return {
    enabled: true,
    notifications: true,
    watches: [WATCH],
    alerts: [WITH_WHISPER, WITHOUT_WHISPER],
    budget: { lookups: 5 },
    nextScanEtaMs: 90_000,
    scansThisHour: 2,
    maxScansPerHour: 20,
    scanning: false,
    files: { watchlist: "watchlist.json", alerts: "deal-alerts.jsonl" },
    ...partial,
  };
}

async function mountTool() {
  const wrapper = mount(WatchlistTool);
  await flushPromises();
  return wrapper;
}

function buttonByText(wrapper: ReturnType<typeof mount>, text: string) {
  const button = wrapper.findAll("button").find((candidate) => candidate.text() === text);
  if (!button) throw new Error(`no button "${text}"`);
  return button;
}

describe("WatchlistTool", () => {
  beforeEach(() => {
    bridge.overview = overview();
    bridge.save.mockReset().mockImplementation(async (request: { enabled?: boolean; watches?: Watch[] }) =>
      overview({
        ...(request.enabled !== undefined ? { enabled: request.enabled } : {}),
        ...(request.watches ? { watches: request.watches } : {}),
      }),
    );
    bridge.scanNow.mockReset().mockResolvedValue({
      ok: true,
      watchId: "temporalis",
      label: "Temporalis (Silk Robe)",
      sample: 4,
      total: 9,
      referenceExalted: 200,
      referenceBasis: "feed",
      newAlerts: 1,
    });
    bridge.copyWhisper.mockReset().mockResolvedValue({ ok: true });
    bridge.dismiss.mockReset().mockImplementation(async () => overview({ alerts: [WITHOUT_WHISPER] }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders watches, alerts and the budget line, and never offers to send a whisper", async () => {
    const wrapper = await mountTool();
    const text = wrapper.text();
    expect(text).toContain("Temporalis (Silk Robe)");
    expect(text).toContain("unique");
    expect(text).toContain("≤ 60% of reference · every 10 min");
    expect(text).toContain("reference 200 ex");
    expect(text).toContain("−50%");
    expect(text).toContain("−45%");
    expect(text).toContain("seller-a");
    expect(text).toContain("5 lookups spare");
    expect(text).toContain("next scan in 1m 30s");
    expect(text).toContain("2/20 scans this hour");
    expect(text).toContain("The app never sends a whisper, buys, or lists");
    // One Copy whisper per alert; only the listing with a whisper is enabled.
    const copies = wrapper.findAll("button").filter((button) => button.text() === "Copy whisper");
    expect(copies).toHaveLength(2);
    expect(copies[0]!.attributes("disabled")).toBeUndefined();
    expect(copies[1]!.attributes("disabled")).toBeDefined();
    wrapper.unmount();
  });

  it("copies a whisper, dismisses an alert, and scans on demand through the bridge", async () => {
    const wrapper = await mountTool();
    const copies = wrapper.findAll("button").filter((button) => button.text() === "Copy whisper");
    await copies[0]!.trigger("click");
    await flushPromises();
    expect(bridge.copyWhisper).toHaveBeenCalledWith("temporalis:a:100");
    expect(wrapper.text()).toContain("Whisper copied");

    const dismisses = wrapper.findAll("button").filter((button) => button.text() === "Dismiss");
    await dismisses[0]!.trigger("click");
    await flushPromises();
    expect(bridge.dismiss).toHaveBeenCalledWith("temporalis:a:100");
    expect(wrapper.findAll("button").filter((button) => button.text() === "Dismiss")).toHaveLength(1);

    await buttonByText(wrapper, "Scan now").trigger("click");
    await flushPromises();
    expect(bridge.scanNow).toHaveBeenCalledWith(undefined);
    expect(wrapper.text()).toContain('Scanned "Temporalis (Silk Robe)": 4 priced of 9 matches · reference 200 ex (feed) · 1 new alert.');

    await buttonByText(wrapper, "Scan").trigger("click");
    await flushPromises();
    expect(bridge.scanNow).toHaveBeenLastCalledWith("temporalis");
    wrapper.unmount();
  });

  it("saves the master switch and adds a unique watch from the form", async () => {
    const wrapper = await mountTool();
    const master = wrapper.find('input[type="checkbox"]');
    await master.setValue(false);
    await flushPromises();
    expect(bridge.save).toHaveBeenCalledWith({ enabled: false });
    expect(wrapper.text()).toContain("automatic scans off");

    const add = buttonByText(wrapper, "Add watch");
    expect(add.attributes("disabled")).toBeDefined();
    expect(wrapper.text()).toContain("A unique watch needs the item name.");
    await wrapper.find('input[placeholder="Temporalis"]').setValue("Headhunter");
    await wrapper.find('input[placeholder="Silk Robe"]').setValue("Heavy Belt");
    expect(add.attributes("disabled")).toBeUndefined();
    await add.trigger("click");
    await flushPromises();
    const request = bridge.save.mock.calls.at(-1)?.[0] as { watches: Watch[] };
    expect(request.watches).toHaveLength(2);
    expect(request.watches[0]).toEqual(WATCH);
    expect(request.watches[1]).toMatchObject({
      kind: "unique",
      label: "Headhunter (Heavy Belt)",
      enabled: true,
      query: { name: "Headhunter", baseType: "Heavy Belt" },
      thresholdPercent: 60,
      minSample: 4,
      intervalMinutes: 10,
    });
    expect(wrapper.text()).toContain('Watching "Headhunter (Heavy Belt)".');
    wrapper.unmount();
  });

  it("builds a stat-filtered watch with family rows and a class-only base watch", async () => {
    const wrapper = await mountTool();
    await wrapper.find('input[type="radio"][value="stat-filtered"]').setValue(true);
    await wrapper.find('input[placeholder="Ruby Ring"]').setValue("Ruby Ring");
    expect(wrapper.text()).toContain("Pick at least one mod family.");
    const familySelects = wrapper.findAll(".stat-rows select");
    expect(familySelects).toHaveLength(3);
    await familySelects[0]!.setValue("life");
    const minInputs = wrapper.findAll('.stat-rows input[type="number"]');
    await minInputs[0]!.setValue(100);
    await buttonByText(wrapper, "Add watch").trigger("click");
    await flushPromises();
    let request = bridge.save.mock.calls.at(-1)?.[0] as { watches: Watch[] };
    expect(request.watches.at(-1)).toMatchObject({
      kind: "stat-filtered",
      query: { baseType: "Ruby Ring", rarity: "nonunique", stats: [{ familyId: "life", min: 100 }] },
    });

    await wrapper.find('input[type="radio"][value="base-type"]').setValue(true);
    await wrapper.find('input[placeholder="Ruby Ring"]').setValue("");
    expect(wrapper.text()).toContain("Enter a base type or pick an item class.");
    const classSelect = wrapper.findAll("select").find((select) => select.text().includes("Any (from the base type)"));
    await classSelect!.setValue("Rings");
    await wrapper.find('input[type="number"][max="100"]').setValue(80);
    await buttonByText(wrapper, "Add watch").trigger("click");
    await flushPromises();
    request = bridge.save.mock.calls.at(-1)?.[0] as { watches: Watch[] };
    expect(request.watches.at(-1)).toMatchObject({
      kind: "base-type",
      label: "Rings · ilvl 80+",
      query: { itemClass: "Rings", rarity: "nonunique", minItemLevel: 80 },
    });
    wrapper.unmount();
  });

  it("shows the desktop-only panel without a bridge", async () => {
    // A second module graph where getWatchlistApi returns nothing.
    vi.doMock("../../src/renderer/services/rendererApi", () => ({ getWatchlistApi: () => undefined }));
    vi.resetModules();
    const { default: Tool } = await import("../../src/renderer/components/tools/WatchlistTool.vue");
    const wrapper = mount(Tool);
    await flushPromises();
    expect(wrapper.text()).toContain("The watchlist needs the desktop app");
    expect(wrapper.findAll("button")).toHaveLength(0);
    wrapper.unmount();
    vi.doUnmock("../../src/renderer/services/rendererApi");
  });
});
