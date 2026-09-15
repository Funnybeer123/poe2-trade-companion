import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseSnapshotJournal,
  type SnapshotKind,
  type WealthSnapshot,
} from "../src/core/stashTrackerSnapshot.js";
import {
  compactNumber,
  formatExalted,
  timelineChart,
  timelinePoints,
  TIMELINE_DETAIL_WINDOW_MS,
} from "../src/core/stashTrackerTimeline.js";

const NOW = Date.parse("2026-09-14T12:00:00.000Z");

function snapshot(
  at: string,
  totalExalted: number,
  kind: SnapshotKind = "auto",
  label?: string,
): WealthSnapshot {
  return {
    version: 1,
    id: `snap-${at}`,
    at,
    kind,
    ...(label ? { label } : {}),
    sessionId: "s-1",
    ledgerAt: at,
    recordCount: 10,
    divineRate: 98,
    totalExalted,
    totalDivine: Math.round((totalExalted / 98) * 100) / 100,
    items: [],
    locations: [],
    itemsTrimmed: true,
  };
}

describe("timelinePoints", () => {
  it("keeps the last 24 h snapshot by snapshot and collapses older days to their last one", () => {
    const points = timelinePoints(
      [
        snapshot("2026-09-11T08:00:00.000Z", 100),
        snapshot("2026-09-11T20:00:00.000Z", 140, "manual", "day one end"),
        snapshot("2026-09-12T09:00:00.000Z", 150),
        snapshot("2026-09-12T22:00:00.000Z", 180),
        snapshot("2026-09-14T02:00:00.000Z", 200),
        snapshot("2026-09-14T11:00:00.000Z", 220, "session-start"),
      ],
      new Set(),
      NOW,
      { timeZoneOffsetMin: 0 },
    );
    expect(points.map((point) => [point.totalExalted, point.grouped])).toEqual([
      [140, true],
      [180, true],
      [200, false],
      [220, false],
    ]);
    expect(points[0]!.label).toBe("day one end");
    expect(points.every((point, index) => index === 0 || point.t >= points[index - 1]!.t)).toBe(true);
  });

  it("uses the configured detail window", () => {
    const points = timelinePoints(
      [snapshot("2026-09-14T11:30:00.000Z", 10), snapshot("2026-09-14T11:40:00.000Z", 20)],
      new Set(),
      NOW,
      { detailWindowMs: 60_000, timeZoneOffsetMin: 0 },
    );
    expect(TIMELINE_DETAIL_WINDOW_MS).toBe(24 * 60 * 60_000);
    expect(points).toHaveLength(1);
    expect(points[0]!.grouped).toBe(true);
    expect(points[0]!.totalExalted).toBe(20);
  });

  it("skips snapshots whose timestamp does not parse", () => {
    expect(timelinePoints([snapshot("not-a-date", 10)], new Set(), NOW)).toEqual([]);
  });
});

describe("timelineChart", () => {
  it("returns an empty chart for no points", () => {
    const chart = timelineChart([], { width: 720, height: 220 });
    expect(chart).toMatchObject({ path: "", points: [], yTicks: [], xTicks: [] });
  });

  it("centres a single point and baselines at zero", () => {
    const points = timelinePoints([snapshot("2026-09-14T11:00:00.000Z", 50)], new Set(), NOW);
    const chart = timelineChart(points, { width: 720, height: 220, padding: 20 });
    expect(chart.points).toHaveLength(1);
    expect(chart.points[0]!.x).toBe(20 + (720 - 40) / 2);
    expect(chart.min).toBe(0);
    expect(chart.max).toBe(50);
    expect(chart.path.startsWith("M ")).toBe(true);
  });

  it("zooms the baseline when every point sits near the top of the range", () => {
    const points = timelinePoints(
      [snapshot("2026-09-14T09:00:00.000Z", 990), snapshot("2026-09-14T11:00:00.000Z", 1000)],
      new Set(),
      NOW,
    );
    const chart = timelineChart(points, { width: 720, height: 220 });
    expect(chart.min).toBe(940);
    expect(chart.max).toBe(1000);
    expect(chart.yTicks).toHaveLength(4);
  });

  it("never draws more than eight day ticks", () => {
    const points = Array.from({ length: 30 }, (_entry, index) =>
      snapshot(`2026-08-${String(index + 1).padStart(2, "0")}T10:00:00.000Z`, 100 + index),
    );
    const chart = timelineChart(
      timelinePoints(points, new Set(), NOW, { timeZoneOffsetMin: 0 }),
      { width: 720, height: 220, timeZoneOffsetMin: 0 },
    );
    expect(chart.xTicks.length).toBeLessThanOrEqual(8);
    expect(chart.xTicks.length).toBeGreaterThan(0);
  });

  it("labels a day tick with the LOCAL day timelinePoints grouped it under", () => {
    // 22:30 on the 11th in UTC-5: keyed in UTC this would read as the 12th.
    const offsetWest = 300;
    const west = timelinePoints([snapshot("2026-09-12T03:30:00.000Z", 100)], new Set(), NOW, {
      timeZoneOffsetMin: offsetWest,
    });
    const westChart = timelineChart(west, {
      width: 720,
      height: 220,
      timeZoneOffsetMin: offsetWest,
    });
    expect(westChart.xTicks).toHaveLength(1);
    expect(westChart.xTicks[0]!.label).toMatch(/^11 Sep/);

    // 01:00 on the 12th in UTC+2: keyed in UTC this would read as the 11th.
    const offsetEast = -120;
    const east = timelinePoints([snapshot("2026-09-11T23:00:00.000Z", 100)], new Set(), NOW, {
      timeZoneOffsetMin: offsetEast,
    });
    const eastChart = timelineChart(east, {
      width: 720,
      height: 220,
      timeZoneOffsetMin: offsetEast,
    });
    expect(eastChart.xTicks[0]!.label).toMatch(/^12 Sep/);
  });
});

describe("number formatting", () => {
  it("abbreviates only where an axis needs it", () => {
    expect(compactNumber(999)).toBe("999");
    expect(compactNumber(1234)).toBe("1.2k");
    expect(compactNumber(1_250_000)).toBe("1.25M");
    expect(compactNumber(0.5)).toBe("0.5");
    expect(compactNumber(Number.NaN)).toBe("—");
  });

  it("formats exalted values with at most two decimals", () => {
    expect(formatExalted(undefined)).toBe("—");
    expect(formatExalted(12)).toBe("12");
    expect(formatExalted(1.5)).toBe("1.5");
    expect(formatExalted(0.2549)).toBe("0.25");
    expect(formatExalted(1234.567)).toBe("1234.57");
  });
});

describe("fixtures/stashTracker", () => {
  it("collapses the shipped journal to one point per local day", () => {
    const journal = parseSnapshotJournal(
      readFileSync(
        new URL("../fixtures/stashTracker/stash-snapshots-sample.jsonl", import.meta.url),
        "utf8",
      ),
    );
    const points = timelinePoints(journal, new Set(), NOW, { timeZoneOffsetMin: 0 });
    expect(
      points.map((point) => [point.at.slice(0, 10), point.totalExalted, point.grouped]),
    ).toEqual([
      ["2026-09-10", 1330, true],
      ["2026-09-11", 1400, true],
      ["2026-09-12", 1470, true],
    ]);
  });
});
