// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeathCapture, HomeOverview, SessionSummary } from "../../src/shared/session.js";

const bridge = vi.hoisted(() => ({
  available: true,
  checklistAvailable: true,
  home: null as HomeOverview | null,
  homeError: "" as string,
  deaths: [] as DeathCapture[],
  history: [] as SessionSummary[],
  calls: [] as Array<[string, unknown[]]>,
  listeners: new Map<string, (payload: unknown) => void>(),
  checklist: {
    steps: [
      { id: "client-log", label: "Client.txt", state: "ok", detail: "Reading C:/poe/Client.txt", optional: false, action: "browse-log" },
      { id: "league", label: "Pricing league", state: "todo", detail: "Pin a league", optional: false, action: "check-leagues" },
    ],
    done: 1,
    required: 2,
    complete: false,
  },
}));

vi.mock("vue-router", () => ({
  useRoute: () => ({ hash: "" }),
  RouterLink: { props: ["to"], template: "<a :href=\"to\"><slot /></a>" },
}));

vi.mock("../../src/renderer/features/session/api", () => ({
  getSessionApi: () =>
    bridge.available
      ? {
          invoke: (channel: string, ...args: unknown[]) => {
            bridge.calls.push([channel, args]);
            switch (channel) {
              case "session:home":
                return bridge.homeError
                  ? Promise.reject(new Error(bridge.homeError))
                  : Promise.resolve(bridge.home);
              case "session:deaths":
              case "session:death-delete":
                return Promise.resolve(bridge.deaths);
              case "session:death-thumbnail":
                return Promise.resolve("data:image/jpeg;base64,AAAA");
              case "session:death-open":
                return Promise.resolve(true);
              case "session:history":
              case "session:history-delete":
                return Promise.resolve(bridge.history);
              case "session:end":
                return Promise.resolve(bridge.home?.session);
              case "session:recap-show":
                return Promise.resolve(true);
              default:
                return Promise.reject(new Error(`unexpected ${channel}`));
            }
          },
          on: (channel: string, callback: (payload: unknown) => void) => {
            bridge.listeners.set(channel, callback);
            return () => bridge.listeners.delete(channel);
          },
        }
      : null,
  getHomeChecklistApi: () =>
    bridge.checklistAvailable
      ? {
          invoke: (channel: string) => {
            bridge.calls.push([channel, []]);
            return channel === "app:setup-checklist"
              ? Promise.resolve(bridge.checklist)
              : Promise.reject(new Error(`unexpected ${channel}`));
          },
          on: () => () => undefined,
        }
      : null,
}));

import HomeView from "../../src/renderer/features/session/views/HomeView.vue";

const ACCOUNT_STAT = { available: false, reason: "needs account link (not available)" } as const;

function home(overrides: Partial<HomeOverview> = {}): HomeOverview {
  return {
    generatedAt: "2026-09-11T22:00:00.000Z",
    clientLog: { watching: true, source: "steam", file: "C:/poe/Client.txt" },
    character: {
      name: "Himbo",
      className: "Disciple of Varashta",
      level: 88,
      seenAt: "2026-09-11T21:30:00.000Z",
      source: "level-up",
    },
    area: {
      areaId: "MapSunTemple",
      name: "Sun Temple",
      category: "map",
      level: 79,
      enteredAt: "2026-09-11T21:50:00.000Z",
    },
    session: {
      active: true,
      poeDetected: true,
      overlayAvailable: true,
      files: { current: "C:/user/session-current.json", history: "C:/user/session-history.jsonl", deathsDir: "C:/user/deaths" },
      session: {
        id: "ses-1",
        startedAt: "2026-09-11T21:00:00.000Z",
        characters: [],
        areas: [],
        areasDropped: 0,
        runs: [],
        runsDropped: 0,
        deaths: [],
        deathsDropped: 0,
        levelUps: [],
        afk: [],
        trades: { accepted: 1, cancelled: 0 },
        whispers: { in: 2, out: 1 },
        eventCount: 12,
      },
      metrics: {
        wallMs: 3_600_000,
        afkMs: 1_200_000,
        activeMs: 2_400_000,
        runsStarted: 2,
        mapsStarted: 2,
        mapsCompleted: 2,
        mapsAbandoned: 0,
        trialsCompleted: 0,
        leagueCompleted: 0,
        mapsPerHour: 3,
        avgMapMs: 669_500,
        medianMapMs: 669_500,
        deathsInMaps: 1,
        deathsPerMap: 0.5,
        deaths: 1,
        levelsGained: 1,
        levelUps: 1,
      },
    },
    recentMaps: [
      {
        id: "run-1",
        kind: "map",
        areaId: "MapSunTemple",
        name: "Sun Temple",
        areaLevel: 79,
        seed: 2600198359,
        tier: 15,
        startedAt: "2026-09-11T21:00:41.000Z",
        endedAt: "2026-09-11T21:14:00.000Z",
        wallMs: 799_000,
        activeMs: 769_000,
        portals: 1,
        deaths: 1,
        subAreas: ["BreachDomain_01"],
        completed: true,
        endedBy: "hideout",
      },
    ],
    xpPerHour: ACCOUNT_STAT,
    xpPerMap: ACCOUNT_STAT,
    goldPerMap: ACCOUNT_STAT,
    timeToLevel: ACCOUNT_STAT,
    stash: { available: true, snapshots: 3, baselineExalted: 12400.5, latestExalted: 13210.5, deltaExalted: 810, deltaDivine: 2, source: "session-file" },
    trade: {
      available: true,
      sales: 2,
      purchases: 1,
      earnedExalted: 410,
      spentExalted: 20,
      netExalted: 390,
      partial: false,
      window: "session",
      sinceIso: "2026-09-11T21:00:00.000Z",
    },
    market: {
      available: true,
      stale: false,
      league: "Rise of the Abyssal",
      fetchedAt: "2026-09-11T18:00:00.000Z",
      rising: [{ key: "divine", name: "Divine Orb", current: 405, change3d: 4.2, volume7d: 900, sampleSize: 7, direction: "rising" }],
      falling: [{ key: "chaos", name: "Chaos Orb", current: 1.2, change3d: -3.1, volume7d: 800, sampleSize: 7, direction: "falling" }],
    },
    recommendations: [
      { id: "feed", title: "Refresh market prices", detail: "The price feed is old.", route: "/sort", tone: "info" },
    ],
    deathsRecent: 1,
    ...overrides,
  };
}

const capture: DeathCapture = {
  id: "cap-1",
  at: "2026-09-11T21:03:10.000Z",
  kind: "death",
  character: "Himbo",
  areaId: "MapSunTemple",
  areaName: "Sun Temple",
  file: "cap-1.jpg",
  thumbFile: "cap-1.thumb.jpg",
  width: 1920,
  height: 1080,
  bytes: 1000,
  sourceName: "Path of Exile 2",
};

beforeEach(() => {
  bridge.available = true;
  bridge.checklistAvailable = true;
  bridge.home = home();
  bridge.homeError = "";
  bridge.deaths = [capture];
  bridge.history = [];
  bridge.calls = [];
  bridge.listeners.clear();
});

describe("HomeView", () => {
  it("renders the character, the session metrics and the account-link chips", async () => {
    const wrapper = mount(HomeView);
    await flushPromises();
    const text = wrapper.text();
    expect(text).toContain("Himbo");
    expect(text).toContain("Disciple of Varashta");
    expect(text).toContain("lvl 88");
    expect(text).toContain("Sun Temple");
    expect(text).toContain("3.0/h");
    expect(text).toContain("Needs account link (not available)");
    expect(wrapper.find(".spinner").exists()).toBe(false);
    wrapper.unmount();
  });

  it("says which period the trade totals cover", async () => {
    const wrapper = mount(HomeView);
    await flushPromises();
    expect(wrapper.text()).toContain("Since ");
    wrapper.unmount();

    // With no session running the same card covers the whole file, and says so.
    bridge.home = home({
      trade: {
        available: true,
        sales: 46,
        purchases: 3,
        earnedExalted: 3100,
        spentExalted: 300,
        netExalted: 2800,
        partial: false,
        window: "all",
      },
    });
    const all = mount(HomeView);
    await flushPromises();
    expect(all.text()).toContain("All recorded trades");
    all.unmount();
  });

  it("marks a divine figure that used an assumed rate", async () => {
    bridge.home = home({
      stash: {
        available: true,
        snapshots: 2,
        source: "snapshots",
        baselineExalted: 100,
        latestExalted: 505,
        deltaExalted: 405,
        deltaDivine: 1,
        divineRate: 405,
        rateAssumed: true,
      },
    });
    const wrapper = mount(HomeView);
    await flushPromises();
    expect(wrapper.text()).toContain("at an assumed 405 ex/div");
    wrapper.unmount();
  });

  it("renders the setup checklist the app-settings package supplies", async () => {
    const wrapper = mount(HomeView);
    await flushPromises();
    const list = wrapper.find('ul[aria-label="Setup checklist"]');
    expect(list.exists()).toBe(true);
    expect(list.text()).toContain("Client.txt");
    expect(list.text()).toContain("Pricing league");
    expect(bridge.calls.some(([channel]) => channel === "app:setup-checklist")).toBe(true);
    wrapper.unmount();
  });

  it("falls back to its own Client.txt row when the checklist channel is absent", async () => {
    bridge.checklistAvailable = false;
    const wrapper = mount(HomeView);
    await flushPromises();
    const list = wrapper.find('ul[aria-label="Setup checklist"]');
    expect(list.exists()).toBe(true);
    expect(list.text()).toContain("Client.txt");
    wrapper.unmount();
  });

  it("shows the desktop-only state and calls nothing without the bridge", async () => {
    bridge.available = false;
    bridge.checklistAvailable = false;
    const wrapper = mount(HomeView);
    await flushPromises();
    expect(wrapper.text()).toContain("Home needs the desktop app");
    expect(bridge.calls).toEqual([]);
    wrapper.unmount();
  });

  it("shows an error with a retry and no spinner", async () => {
    bridge.homeError = "the log is missing";
    const wrapper = mount(HomeView);
    await flushPromises();
    expect(wrapper.find('[role="alert"]').text()).toContain("the log is missing");
    expect(wrapper.find(".spinner").exists()).toBe(false);
    expect(wrapper.text()).toContain("Retry");
    wrapper.unmount();
  });

  it("ends the session only on the second click", async () => {
    const wrapper = mount(HomeView);
    await flushPromises();
    const button = wrapper
      .findAll("button")
      .find((entry) => entry.text().includes("End session & start fresh"));
    expect(button).toBeDefined();
    await button!.trigger("click");
    expect(bridge.calls.some(([channel]) => channel === "session:end")).toBe(false);
    expect(wrapper.text()).toContain("Confirm: end session");
    const confirm = wrapper
      .findAll("button")
      .find((entry) => entry.text().includes("Confirm: end session"));
    await confirm!.trigger("click");
    await flushPromises();
    expect(bridge.calls.some(([channel]) => channel === "session:end")).toBe(true);
    wrapper.unmount();
  });

  it("asks the overlay for the recap", async () => {
    const wrapper = mount(HomeView);
    await flushPromises();
    const button = wrapper.findAll("button").find((entry) => entry.text().includes("Show recap"));
    await button!.trigger("click");
    await flushPromises();
    expect(bridge.calls.some(([channel, args]) => channel === "session:recap-show" && args[0] === "full")).toBe(true);
    wrapper.unmount();
  });

  it("loads the screenshots and their thumbnails on the Deaths tab", async () => {
    const wrapper = mount(HomeView);
    await flushPromises();
    const tab = wrapper.findAll('[role="tab"]').find((entry) => entry.text().includes("Deaths"));
    await tab!.trigger("click");
    await flushPromises();
    expect(bridge.calls.some(([channel]) => channel === "session:deaths")).toBe(true);
    expect(bridge.calls.some(([channel]) => channel === "session:death-thumbnail")).toBe(true);
    expect(wrapper.find("img").attributes("src")).toContain("data:image/jpeg;base64");
    expect(wrapper.text()).toContain("Screenshots stay on this PC");
    wrapper.unmount();
  });

  it("deletes a screenshot only on the second click", async () => {
    const wrapper = mount(HomeView);
    await flushPromises();
    const tab = wrapper.findAll('[role="tab"]').find((entry) => entry.text().includes("Deaths"));
    await tab!.trigger("click");
    await flushPromises();
    const remove = wrapper.findAll("button").find((entry) => entry.text() === "Delete");
    await remove!.trigger("click");
    expect(bridge.calls.some(([channel]) => channel === "session:death-delete")).toBe(false);
    const confirm = wrapper.findAll("button").find((entry) => entry.text() === "Confirm");
    bridge.deaths = [];
    await confirm!.trigger("click");
    await flushPromises();
    expect(bridge.calls.some(([channel]) => channel === "session:death-delete")).toBe(true);
    wrapper.unmount();
  });

  it("shows the mapping metrics and the vendor-only rows on the Maps tab", async () => {
    const wrapper = mount(HomeView);
    await flushPromises();
    const tab = wrapper.findAll('[role="tab"]').find((entry) => entry.text().includes("Maps"));
    await tab!.trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("Maps this session");
    expect(wrapper.text()).toContain("Experience per map");
    expect(wrapper.text()).toContain("Needs account link (not available)");
    expect(wrapper.text()).toContain("T15");
    wrapper.unmount();
  });

  it("stops polling and unsubscribes when it is unmounted", async () => {
    vi.useFakeTimers();
    try {
      const wrapper = mount(HomeView);
      await flushPromises();
      expect(bridge.listeners.has("session:changed")).toBe(true);
      const before = bridge.calls.length;
      wrapper.unmount();
      vi.advanceTimersByTime(120_000);
      expect(bridge.calls.length).toBe(before);
      expect(bridge.listeners.has("session:changed")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
