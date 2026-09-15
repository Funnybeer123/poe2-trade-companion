/**
 * Stash tracker — the worth timeline (package "stash-tracker").
 *
 * The last 24 h is shown snapshot by snapshot; older history collapses to
 * one point per local calendar day (that day's LAST snapshot), because a
 * week of auto snapshots is noise at chart width. Pure maths — the SVG is
 * drawn by the renderer from `timelineChart`.
 *
 * Numbers in the chart body are never abbreviated; only axis labels use
 * `compactNumber`, so a reader never has to guess what "1.2k" hides.
 */
import {
  effectiveTotal,
  type SnapshotKind,
  type WealthSnapshot,
} from "./stashTrackerSnapshot.js";

export interface TimelinePoint {
  id: string;
  at: string;
  /** Epoch ms of `at`. */
  t: number;
  totalExalted: number;
  kind: SnapshotKind;
  label?: string;
  /** True when the point stands for a whole day rather than one snapshot. */
  grouped: boolean;
}

export const TIMELINE_DETAIL_WINDOW_MS = 24 * 60 * 60_000;

function timeOf(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Local calendar day key for an instant, given the viewer's UTC offset. */
function dayKey(t: number, timeZoneOffsetMin: number): string {
  const local = new Date(t - timeZoneOffsetMin * 60_000);
  return local.toISOString().slice(0, 10);
}

export function timelinePoints(
  snapshots: readonly WealthSnapshot[],
  excluded: ReadonlySet<string>,
  now: number,
  options: { detailWindowMs?: number; timeZoneOffsetMin?: number } = {},
): TimelinePoint[] {
  const detailWindow = options.detailWindowMs ?? TIMELINE_DETAIL_WINDOW_MS;
  const offset = options.timeZoneOffsetMin ?? new Date().getTimezoneOffset();
  const all = snapshots
    .map((snapshot) => ({
      snapshot,
      t: timeOf(snapshot.at),
    }))
    .filter((entry) => entry.t > 0)
    .sort((a, b) => a.t - b.t);
  const detailed: TimelinePoint[] = [];
  const byDay = new Map<string, { snapshot: WealthSnapshot; t: number }>();
  for (const entry of all) {
    if (now - entry.t < detailWindow) {
      detailed.push({
        id: entry.snapshot.id,
        at: entry.snapshot.at,
        t: entry.t,
        totalExalted: effectiveTotal(entry.snapshot, excluded),
        kind: entry.snapshot.kind,
        ...(entry.snapshot.label ? { label: entry.snapshot.label } : {}),
        grouped: false,
      });
      continue;
    }
    // Later entries win: the day's point is that day's last snapshot.
    byDay.set(dayKey(entry.t, offset), entry);
  }
  const grouped: TimelinePoint[] = [...byDay.values()].map((entry) => ({
    id: entry.snapshot.id,
    at: entry.snapshot.at,
    t: entry.t,
    totalExalted: effectiveTotal(entry.snapshot, excluded),
    kind: entry.snapshot.kind,
    ...(entry.snapshot.label ? { label: entry.snapshot.label } : {}),
    grouped: true,
  }));
  return [...grouped, ...detailed].sort((a, b) => a.t - b.t);
}

export interface TimelineChartPoint extends TimelinePoint {
  x: number;
  y: number;
}

export interface TimelineChart {
  width: number;
  height: number;
  /** SVG path data ("M x y L x y …"); empty when there is nothing to draw. */
  path: string;
  points: TimelineChartPoint[];
  yTicks: Array<{ y: number; value: number; label: string }>;
  xTicks: Array<{ x: number; label: string }>;
  min: number;
  max: number;
}

/** 1234 → "1.2k"; axis labels only. */
export function compactNumber(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${round(value / 1_000_000, 2)}M`;
  if (abs >= 1_000) return `${round(value / 1_000, 1)}k`;
  if (abs >= 100) return String(Math.round(value));
  return String(round(value, 2));
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** "—" | "12" | "1.5" | "0.25" — at most two decimals, no trailing zeros. */
export function formatExalted(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return String(round(value, 2));
}

/**
 * `t` is a day key already shifted into the viewer's local day (see
 * `dayKey`), so it is read back in UTC: reading it with local getters would
 * shift it a second time and name the wrong day either side of midnight.
 */
function dayLabel(t: number): string {
  const date = new Date(t);
  const month = date.toLocaleString("en-GB", { month: "short", timeZone: "UTC" });
  return `${date.getUTCDate()} ${month}`;
}

export function timelineChart(
  points: readonly TimelinePoint[],
  size: { width: number; height: number; padding?: number; timeZoneOffsetMin?: number },
): TimelineChart {
  const width = Math.max(40, size.width);
  const height = Math.max(40, size.height);
  const pad = size.padding ?? 28;
  if (!points.length) {
    return { width, height, path: "", points: [], yTicks: [], xTicks: [], min: 0, max: 0 };
  }
  const values = points.map((point) => point.totalExalted);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  // A flat, high line wastes the panel: zoom the baseline when the whole
  // series sits in the top fifth of the range.
  const zoom = points.length > 1 && rawMin > 0 && rawMax > 0 && rawMin / rawMax > 0.8;
  const min = zoom ? Math.floor(rawMin * 0.95) : 0;
  const max = rawMax > min ? rawMax : min + 1;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const tMin = points[0]!.t;
  const tMax = points[points.length - 1]!.t;
  const span = tMax - tMin;
  const chartPoints: TimelineChartPoint[] = points.map((point) => ({
    ...point,
    x: span > 0 ? pad + ((point.t - tMin) / span) * innerW : pad + innerW / 2,
    y: height - pad - ((point.totalExalted - min) / (max - min)) * innerH,
  }));
  const path = chartPoints
    .map((point, index) => `${index === 0 ? "M" : "L"} ${round(point.x, 2)} ${round(point.y, 2)}`)
    .join(" ");
  const yTicks = [0, 1, 2, 3].map((step) => {
    const value = min + ((max - min) * step) / 3;
    return {
      y: round(height - pad - (innerH * step) / 3, 2),
      value: round(value, 2),
      label: compactNumber(value),
    };
  });
  // The SAME day definition `timelinePoints` grouped by: keying the ticks in
  // UTC while the points were grouped locally puts a tick under the wrong day
  // for every snapshot either side of local midnight.
  const offset = size.timeZoneOffsetMin ?? new Date().getTimezoneOffset();
  const days = new Map<string, number>();
  for (const point of chartPoints) {
    const key = dayKey(point.t, offset);
    if (!days.has(key)) days.set(key, point.x);
  }
  const dayEntries = [...days.entries()];
  const stride = Math.max(1, Math.ceil(dayEntries.length / 8));
  const xTicks = dayEntries
    .filter((_entry, index) => index % stride === 0)
    .map(([key, x]) => ({ x: round(x, 2), label: dayLabel(Date.parse(`${key}T00:00:00Z`)) }));
  return { width, height, path, points: chartPoints, yTicks, xTicks, min, max };
}
