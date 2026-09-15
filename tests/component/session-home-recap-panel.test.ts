// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import SessionRecapPanel from "../../src/renderer/features/session/panels/SessionRecapPanel.vue";
import type { SessionRecapPayload } from "../../src/shared/session.js";

function payload(overrides: Partial<SessionRecapPayload> = {}): SessionRecapPayload {
  return {
    mode: "afk",
    at: "2026-09-11T22:00:00.000Z",
    summary: {
      id: "ses-1",
      startedAt: "2026-09-11T21:00:00.000Z",
      character: { name: "Himbo", className: "Disciple of Varashta", level: 88 },
      wallMs: 3_600_000,
      activeMs: 2_400_000,
      mapsCompleted: 2,
      mapsPerHour: 3,
      avgMapMs: 669_500,
      deaths: 1,
      levelsGained: 1,
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
    stash: {
      available: true,
      snapshots: 3,
      baselineExalted: 12_400.5,
      latestExalted: 13_210.5,
      deltaExalted: 810,
      perHourExalted: 810,
      source: "session-file",
    },
    recentRuns: [
      {
        id: "run-1",
        kind: "map",
        areaId: "MapSunTemple",
        name: "Sun Temple",
        areaLevel: 79,
        seed: 1,
        tier: 15,
        startedAt: "2026-09-11T21:00:41.000Z",
        endedAt: "2026-09-11T21:14:00.000Z",
        wallMs: 799_000,
        activeMs: 769_000,
        portals: 1,
        deaths: 1,
        subAreas: [],
        completed: true,
        endedBy: "hideout",
      },
    ],
    trades: { accepted: 2, cancelled: 1 },
    whispers: { in: 4, out: 3 },
    ...overrides,
  };
}

function render(value: unknown) {
  return mount(SessionRecapPanel, {
    props: { panelId: "session-recap", payload: value, visible: true },
  });
}

describe("SessionRecapPanel", () => {
  it("opens on the session page in AFK mode", () => {
    const wrapper = render(payload());
    expect(wrapper.text()).toContain("AFK recap");
    expect(wrapper.text()).toContain("Himbo");
    expect(wrapper.text()).toContain("3.0/h");
    expect(wrapper.text()).toContain("2 / 1 cancelled");
    expect(wrapper.text()).toContain("4 in / 3 out");
  });

  it("opens on the maps page for the post-game recap", () => {
    const wrapper = render(payload({ mode: "full" }));
    expect(wrapper.text()).toContain("Session recap");
    expect(wrapper.text()).toContain("Sun Temple");
    expect(wrapper.text()).toContain("T15");
  });

  it("switches pages by click", async () => {
    const wrapper = render(payload());
    const stash = wrapper.findAll("button").find((entry) => entry.text() === "Stash");
    await stash!.trigger("click");
    expect(wrapper.text()).toContain("Baseline");
    expect(wrapper.text()).toContain("12400.5 ex");
    const maps = wrapper.findAll("button").find((entry) => entry.text() === "Maps");
    await maps!.trigger("click");
    expect(wrapper.text()).toContain("Sun Temple");
  });

  it("shows only the session page in mini mode", () => {
    const wrapper = render(payload({ mode: "mini" }));
    expect(wrapper.find(".recap-pages").exists()).toBe(false);
    expect(wrapper.text()).toContain("Active");
  });

  it("says so when there is no stash session", async () => {
    const wrapper = render(payload({ stash: { available: false, snapshots: 0, reason: "No stash session yet." } }));
    const stash = wrapper.findAll("button").find((entry) => entry.text() === "Stash");
    await stash!.trigger("click");
    expect(wrapper.text()).toContain("No stash session yet.");
  });

  it("renders safe defaults for a junk payload", () => {
    for (const junk of [undefined, null, 42, "nope", { mode: "weird", metrics: "no" }]) {
      const wrapper = render(junk);
      expect(wrapper.text()).toContain("Unknown character");
      expect(wrapper.text()).toContain("Estimates from Client.txt");
    }
  });

  it("emits close from Dismiss", async () => {
    const wrapper = render(payload());
    const dismiss = wrapper.findAll("button").find((entry) => entry.text() === "Dismiss");
    await dismiss!.trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("never claims an experience number", () => {
    expect(render(payload({ mode: "full" })).text()).toContain("need an account link (not available)");
  });
});
