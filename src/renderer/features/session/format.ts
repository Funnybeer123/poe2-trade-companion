/**
 * Display helpers shared by the Home view, its cards and the overlay recap
 * panel. Formatting only — no state, no bridge calls.
 */
import { formatDuration } from "@core/sessionTracker";
import type { MapRun, RunKind } from "@core/sessionTracker";
import { formatAmount, formatDate } from "../../utils/intelligence";

export { formatDuration };

export function kindLabel(kind: RunKind): string {
  if (kind === "map") return "Map";
  if (kind === "trial") return "Trial";
  return "League";
}

/** "T15", "T16+" for the irradiated/corrupted tiers, "" for non-maps. */
export function tierLabel(run: Pick<MapRun, "kind" | "tier" | "areaLevel">): string {
  if (run.kind !== "map" || run.tier === undefined) return "";
  return run.areaLevel > 80 ? "T16+" : `T${run.tier}`;
}

export function runEndLabel(run: Pick<MapRun, "endedBy" | "endedAt" | "completed">): string {
  if (!run.endedAt) return "In progress";
  switch (run.endedBy) {
    case "hideout":
      return "Left to hideout";
    case "town":
      return "Left to town";
    case "endgame-town":
      return "Left to the Ziggurat";
    case "new-run":
      return "Next area";
    case "campaign":
      return "Campaign area";
    case "timeout":
      return "Abandoned (timed out)";
    case "session-end":
      return "Session ended";
    default:
      return run.completed ? "Completed" : "Abandoned";
  }
}

/** "3.0/h" or an em dash while the rate window is still too short. */
export function rate(value: number | undefined): string {
  return value === undefined ? "—" : `${value.toFixed(1)}/h`;
}

export function ex(value: number | undefined): string {
  return value === undefined ? "—" : `${formatAmount(value)} ex`;
}

export function div(value: number | undefined): string {
  return value === undefined ? "—" : `${formatAmount(value)} div`;
}

export function when(value: string | undefined): string {
  return formatDate(value);
}

/** A signed exalted delta, for the gains chips. */
export function signedEx(value: number | undefined): string {
  if (value === undefined) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatAmount(value)} ex`;
}

export function deltaTone(value: number | undefined): "safe" | "danger" | "neutral" {
  if (value === undefined || value === 0) return "neutral";
  return value > 0 ? "safe" : "danger";
}

export function describeError(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}
