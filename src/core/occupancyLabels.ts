import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { CalibrationProfile } from "./calibrationProfile.js";
import type { ScreenRect } from "./screenLayout.js";
import {
  applyDiagnosticCorrections,
  type DiagnosticCorrection,
} from "./transferDiagnostics.js";
import type { UiFacts } from "./uiPerception.js";

export type OccupancyArea = "stash" | "bag";
export type OccupancyLabelVerdict = "right" | "wrong";

/**
 * Operator label for one stash/bag cell's occupancy detection.
 * Right confirms the perceived state; Wrong means it was inverted.
 */
export interface OccupancyLabel {
  timestamp: string;
  area: OccupancyArea;
  row: number;
  col: number;
  perceivedOccupied: boolean;
  label: OccupancyLabelVerdict;
  evidenceHash?: string;
  screenshotId?: string;
}

/**
 * Append-only occupancy labels. Never sent as telemetry.
 *
 * Electron: `%APPDATA%/poe2-trade-companion/fixtures/benchmarks/occupancy-labels.jsonl`
 * Tests / cwd memory root: `fixtures/benchmarks/occupancy-labels.jsonl`
 */
export function occupancyLabelsPath(root = process.cwd()): string {
  return path.join(root, "fixtures", "benchmarks", "occupancy-labels.jsonl");
}

export function loadOccupancyLabels(root = process.cwd()): OccupancyLabel[] {
  const file = occupancyLabelsPath(root);
  if (!existsSync(file)) return [];
  const out: OccupancyLabel[] = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Partial<OccupancyLabel>;
      if (parsed.area !== "stash" && parsed.area !== "bag") continue;
      if (parsed.label !== "right" && parsed.label !== "wrong") continue;
      const row = parsed.row;
      const col = parsed.col;
      if (typeof row !== "number" || typeof col !== "number" || !Number.isInteger(row) || !Number.isInteger(col)) {
        continue;
      }
      out.push({
        timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : new Date(0).toISOString(),
        area: parsed.area,
        row,
        col,
        perceivedOccupied: Boolean(parsed.perceivedOccupied),
        label: parsed.label,
        ...(typeof parsed.evidenceHash === "string" ? { evidenceHash: parsed.evidenceHash } : {}),
        ...(typeof parsed.screenshotId === "string" ? { screenshotId: parsed.screenshotId } : {}),
      });
    } catch {
      // Skip corrupt lines so a single bad label cannot disable occupancy learning.
    }
  }
  return out;
}

export function recordOccupancyLabel(
  root: string,
  input: Omit<OccupancyLabel, "timestamp"> & { timestamp?: string },
): OccupancyLabel {
  const label: OccupancyLabel = {
    timestamp: input.timestamp ?? new Date().toISOString(),
    area: input.area,
    row: input.row,
    col: input.col,
    perceivedOccupied: Boolean(input.perceivedOccupied),
    label: input.label,
    ...(input.evidenceHash ? { evidenceHash: input.evidenceHash } : {}),
    ...(input.screenshotId ? { screenshotId: input.screenshotId } : {}),
  };
  const file = occupancyLabelsPath(root);
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(label)}\n`);
  return label;
}

export function occupancyLabelKey(label: Pick<OccupancyLabel, "area" | "row" | "col">): string {
  return `${label.area}:${label.row},${label.col}`;
}

/** Latest label per cell wins. Right clears an override; Wrong flips perceived occupancy. */
export function occupancyCorrectionsFromLabels(
  labels: readonly OccupancyLabel[],
): DiagnosticCorrection[] {
  const latest = new Map<string, OccupancyLabel>();
  for (const label of labels) latest.set(occupancyLabelKey(label), label);
  const corrections: DiagnosticCorrection[] = [];
  for (const label of latest.values()) {
    if (label.label === "right") continue;
    corrections.push({
      kind: label.perceivedOccupied ? "false-occupied" : "missed-item",
      grid: label.area,
      row: label.row,
      col: label.col,
      w: 1,
      h: 1,
      note: "overlay-occupancy-label",
      createdAt: label.timestamp,
    });
  }
  return corrections;
}

/** Apply persisted overlay labels as cell-level occupancy overrides for later dry-run/live captures. */
export function applyOccupancyLabels(
  facts: UiFacts,
  root: string,
  profile: CalibrationProfile,
  client: ScreenRect,
): UiFacts {
  return applyDiagnosticCorrections(
    facts,
    occupancyCorrectionsFromLabels(loadOccupancyLabels(root)),
    profile,
    client,
  );
}
