// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import path from "node:path";
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { itemSummary } from "../../src/core/evaluateItem.js";
import { initialQueryState } from "../../src/core/evaluateQuery.js";
import { parseItemText } from "../../src/core/parseItem.js";
import { DEFAULT_EVALUATE_SETTINGS, type EvaluateSession } from "../../src/shared/evaluate.js";
import { ITEM_INTELLIGENCE_IPC_VERSION, type ParsedItemEvaluation } from "../../src/shared/ipc.js";

const bridge = vi.hoisted(() => ({
  available: true,
  invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(),
  listeners: new Map<string, (payload: unknown) => void>(),
  appAvailable: true,
  appInvoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(),
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
  getAppFeatureApi: () =>
    bridge.appAvailable
      ? {
          invoke: (channel: string, ...args: unknown[]) => bridge.appInvoke(channel, ...args),
          on: () => () => undefined,
        }
      : null,
}));

import EvaluateItemLogSection from "../../src/renderer/features/evaluate/EvaluateItemLogSection.vue";
import EvaluateSettingsSection from "../../src/renderer/features/evaluate/EvaluateSettingsSection.vue";
import EvaluateOverlayPanel from "../../src/renderer/features/evaluate/EvaluateOverlayPanel.vue";
import { disposeEvaluateSession } from "../../src/renderer/features/evaluate/useEvaluateSession";

function fixture(name: string): string {
  return readFileSync(path.join(process.cwd(), "fixtures", "evaluate", name), "utf8");
}

const RAW = fixture("rare-ring-resists.txt");

function session(raw = RAW, id = "ev_test"): EvaluateSession {
  const parsed = parseItemText(raw);
  const item = itemSummary(parsed);
  return {
    id,
    source: "item-log",
    openedAt: "2026-09-07T12:00:00Z",
    item,
    query: initialQueryState({ parsed, summary: item, settings: DEFAULT_EVALUATE_SETTINGS }),
    busy: "idle",
    catalogueReady: false,
    prefs: { groupBySeller: false },
    budget: {
      lookups: 4,
      searchesSpare: 4,
      fetchesSpare: 4,
      hasSession: false,
      league: "Runes of Aldur",
      leagueAmbiguous: false,
    },
  };
}

function evaluation(raw = RAW): ParsedItemEvaluation {
  const parsed = parseItemText(raw);
  return {
    schemaVersion: ITEM_INTELLIGENCE_IPC_VERSION,
    parsed: true,
    raw,
    item: parsed,
    valuation: {
      itemIdentifier: parsed.fingerprint,
      itemType: parsed.itemClass,
      normalizedKeyStats: {},
      providerName: "appraisal",
      marketTimestamp: "2026-09-07T12:00:00Z",
      candidateCount: 0,
      comparablesUsed: 0,
      low: 1,
      fair: 2,
      high: 3,
      recommendedListing: 2,
      currency: "exalted",
      confidence: "low",
    },
    desirability: { score: 40, category: "sell", reasons: [] },
  };
}

beforeEach(() => {
  bridge.available = true;
  bridge.listeners.clear();
  bridge.invoke.mockReset();
  bridge.invoke.mockImplementation(async (channel: string) => {
    if (channel === "evaluate:budget") return session().budget;
    if (channel === "evaluate:current") return session();
    if (channel === "evaluate:open") return session();
    return undefined;
  });
  bridge.appAvailable = true;
  bridge.appInvoke.mockReset();
  bridge.appInvoke.mockImplementation(async (channel: string) => {
    if (channel === "settings:get") return { evaluate: { pageSize: 10 } };
    return undefined;
  });
  disposeEvaluateSession();
});

afterEach(() => {
  disposeEvaluateSession();
});

describe("EvaluateItemLogSection", () => {
  it("opens the session without searching when the button is pressed", async () => {
    const wrapper = mount(EvaluateItemLogSection, { props: { evaluation: evaluation() } });
    await flushPromises();
    expect(bridge.invoke).not.toHaveBeenCalled();
    await wrapper.find("button").trigger("click");
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith("evaluate:open", {
      text: RAW,
      source: "item-log",
      autoSearch: false,
      showOverlay: false,
    });
    expect(wrapper.text()).toContain("Woe Loop");
    wrapper.unmount();
  });

  it("re-opens for a new item in the log, still without a lookup", async () => {
    const wrapper = mount(EvaluateItemLogSection, { props: { evaluation: evaluation() } });
    await flushPromises();
    await wrapper.find("button").trigger("click");
    await flushPromises();

    const nextRaw = RAW.replace("Woe Loop", "Grim Loop");
    bridge.invoke.mockImplementation(async (channel: string) => {
      if (channel === "evaluate:budget") return session().budget;
      if (channel === "evaluate:open") return session(nextRaw, "ev_next");
      return session(nextRaw, "ev_next");
    });
    await wrapper.setProps({ evaluation: evaluation(nextRaw) } as never);
    await flushPromises();
    const opens = bridge.invoke.mock.calls.filter(([channel]) => channel === "evaluate:open");
    // Once for the button, once for the new item — and never a search.
    expect(opens).toHaveLength(2);
    expect(opens[1]![1]).toMatchObject({ text: nextRaw, autoSearch: false, source: "item-log" });
    expect(bridge.invoke.mock.calls.some(([channel]) => channel === "evaluate:search")).toBe(false);
    expect(wrapper.text()).toContain("Grim Loop");
    wrapper.unmount();
  });

  it("stays a button until the user asks: a new item alone opens nothing", async () => {
    const wrapper = mount(EvaluateItemLogSection, { props: { evaluation: evaluation() } });
    await flushPromises();
    const nextRaw = RAW.replace("Woe Loop", "Grim Loop");
    await wrapper.setProps({ evaluation: evaluation(nextRaw) } as never);
    await flushPromises();
    expect(bridge.invoke.mock.calls.some(([channel]) => channel === "evaluate:open")).toBe(false);
    wrapper.unmount();
  });

  it("renders the desktop-only state in the browser preview", async () => {
    bridge.available = false;
    disposeEvaluateSession();
    const wrapper = mount(EvaluateItemLogSection, { props: { evaluation: evaluation() } });
    await flushPromises();
    expect(wrapper.text()).toContain("Evaluate needs the desktop app");
    wrapper.unmount();
  });
});

describe("EvaluateOverlayPanel", () => {
  it("reads the session named by its payload and renders the workbench", async () => {
    const wrapper = mount(EvaluateOverlayPanel, {
      props: { panelId: "evaluate", payload: { sessionId: "ev_test" }, visible: true },
    });
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith("evaluate:current");
    expect(wrapper.text()).toContain("Woe Loop");
    expect(bridge.listeners.has("evaluate:session")).toBe(true);
    wrapper.unmount();
  });

  it("closes through main and tells the panel host", async () => {
    const wrapper = mount(EvaluateOverlayPanel, {
      props: { panelId: "evaluate", payload: { sessionId: "ev_test" }, visible: true },
    });
    await flushPromises();
    const close = wrapper.findAll("button").find((node) => node.text() === "Close");
    await close!.trigger("click");
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith("evaluate:close", "ev_test");
    expect(wrapper.emitted("close")).toHaveLength(1);
    wrapper.unmount();
  });

  it("says what to do when nothing has been evaluated yet", async () => {
    bridge.invoke.mockImplementation(async (channel: string) => {
      if (channel === "evaluate:budget") return session().budget;
      return null;
    });
    const wrapper = mount(EvaluateOverlayPanel, {
      props: { panelId: "evaluate", payload: {}, visible: true },
    });
    await flushPromises();
    expect(wrapper.text()).toContain("hover an item and press the Evaluate hotkey");
    wrapper.unmount();
  });

  it("takes a pushed session update from main", async () => {
    const wrapper = mount(EvaluateOverlayPanel, {
      props: { panelId: "evaluate", payload: { sessionId: "ev_test" }, visible: true },
    });
    await flushPromises();
    const pushed = session();
    pushed.error = "trade2 is rate limited until 12:10";
    bridge.listeners.get("evaluate:session")!(pushed);
    await flushPromises();
    expect(wrapper.find('[role="alert"]').text()).toContain("rate limited");
    wrapper.unmount();
  });
});

describe("EvaluateSettingsSection", () => {
  it("saves one switch at a time through the settings channel", async () => {
    const wrapper = mount(EvaluateSettingsSection);
    await flushPromises();
    expect(bridge.appInvoke).toHaveBeenCalledWith("settings:get");
    const waystone = wrapper
      .findAll("label")
      .find((node) => node.text().includes("Waystones"))!
      .find("input");
    await waystone.setValue(true);
    await flushPromises();
    const call = bridge.appInvoke.mock.calls.find(([channel]) => channel === "settings:set");
    expect(call?.[1]).toBe("evaluate");
    expect((call?.[2] as { autoSearch: Record<string, boolean> }).autoSearch.waystone).toBe(true);
    wrapper.unmount();
  });

  it("renders the desktop-only state without a settings bridge", async () => {
    bridge.appAvailable = false;
    const wrapper = mount(EvaluateSettingsSection);
    await flushPromises();
    expect(wrapper.text()).toContain("Evaluate settings need the desktop app");
    wrapper.unmount();
  });
});
