import {
  activeStashGrid,
  profileReadyForDeposit,
  type CalibrationProfile,
} from "./calibrationProfile.js";
import type { DryRunOverlayPlan, OverlayCellRef, OverlayDetectionLabel } from "./dryRunOverlay.js";
import type { OccupancyLabel } from "./occupancyLabels.js";

/** Official Cursor prompt deeplink. User must confirm; it never auto-runs. Max URL length 8000. */
export const CURSOR_PROMPT_DEEPLINK_BASE = "cursor://anysphere.cursor-deeplink/prompt";
export const CURSOR_DEEPLINK_MAX_CHARS = 8000;

const SENSITIVE_KEY =
  /(cookie|token|password|secret|authorization|oauth|poesessid|cf_clearance|accountName|accountId|account_id)/i;

export interface AssistiveHandoffResult {
  ok: boolean;
  reason: string;
  kind: string;
  dryRun: boolean;
  cycles?: number;
  elapsedMs?: number;
  bagCells: number;
  stashCells: number;
  traces?: Array<{
    timestamp?: string;
    reason?: string;
    result?: string;
    decisionRule?: string;
    module?: string;
    processName?: string;
    input?: {
      kind?: string;
      x?: number;
      y?: number;
      x2?: number;
      y2?: number;
      button?: string;
    } | null;
  }>;
}

export interface CalibrationHandoffSummary {
  client: { width: number; height: number };
  activeStashTab: "normal" | "quad";
  stash: { x: number; y: number; w: number; h: number; cols: number; rows: number } | null;
  bag: { x: number; y: number; w: number; h: number; cols: number; rows: number } | null;
  searchPresent: boolean;
  gridsReady: boolean;
}

export interface OverlayHandoffSnapshot {
  kind?: string;
  client?: { width: number; height: number };
  grids: Array<{
    region: string;
    label?: string;
    cols?: number;
    rows?: number;
    x: number;
    y: number;
    w: number;
    h: number;
  }>;
  occupied: string[];
  detected: string[];
  items: Array<{
    area: string;
    row: number;
    col: number;
    w: number;
    h: number;
    itemClass?: string;
    cellCount: number;
  }>;
  clicks: Array<{ n: number; kind: string; region: string }>;
  selected: OverlayCellRef[];
  evidenceHash?: string;
  screenshotId?: string;
}

export interface CursorHandoffEvidence {
  createdAt: string;
  occupancyLabels: OccupancyLabel[];
  sessionLabels: OverlayDetectionLabel[];
  selected: OverlayCellRef[];
  lastResult: AssistiveHandoffResult | null;
  overlay: OverlayHandoffSnapshot | null;
  calibration: CalibrationHandoffSummary | null;
  traceTail: string;
  occupancyLabelFile?: string;
  traceFile?: string;
  screenshotId?: string;
  workspace?: string;
}

export function redactHandoffText(text: string): string {
  return text
    .replace(/POESESSID=[^\s;]+/gi, "POESESSID=[redacted]")
    .replace(/cf_clearance=[^\s;]+/gi, "cf_clearance=[redacted]")
    .replace(/__cf_bm=[^\s;]+/gi, "__cf_bm=[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [redacted]");
}

export function redactHandoffJson(value: unknown, key = ""): unknown {
  if (SENSITIVE_KEY.test(key)) return "[redacted]";
  if (typeof value === "string") return redactHandoffText(value);
  if (Array.isArray(value)) return value.map((entry) => redactHandoffJson(entry));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [nextKey, nextValue] of Object.entries(value)) {
      out[nextKey] = redactHandoffJson(nextValue, nextKey);
    }
    return out;
  }
  return value;
}

export function summarizeCalibration(profile: CalibrationProfile): CalibrationHandoffSummary {
  const stash = activeStashGrid(profile);
  const bag = profile.bagGrid;
  const search = profile.stashSearch;
  return {
    client: { ...profile.client },
    activeStashTab: profile.activeStashTab === "quad" ? "quad" : "normal",
    stash: stash
      ? { x: stash.x, y: stash.y, w: stash.w, h: stash.h, cols: stash.cols, rows: stash.rows }
      : null,
    bag: bag ? { x: bag.x, y: bag.y, w: bag.w, h: bag.h, cols: bag.cols, rows: bag.rows } : null,
    searchPresent: Boolean(search && search.w >= 8 && search.h >= 8),
    gridsReady: profileReadyForDeposit(profile),
  };
}

function cellKey(cell: { area: string; row: number; col: number }): string {
  return `${cell.area}:${cell.row},${cell.col}`;
}

export function summarizeOverlayPlan(
  plan: DryRunOverlayPlan,
  selected: readonly OverlayCellRef[] = plan.selected ?? [],
): OverlayHandoffSnapshot {
  return {
    kind: plan.kind,
    client: { width: plan.client.width, height: plan.client.height },
    grids: plan.grids.map((grid) => ({
      region: grid.region,
      ...(grid.label ? { label: grid.label } : {}),
      ...(grid.cols ? { cols: grid.cols } : {}),
      ...(grid.rows ? { rows: grid.rows } : {}),
      x: grid.x,
      y: grid.y,
      w: grid.w,
      h: grid.h,
    })),
    occupied: plan.occupied.map(cellKey),
    detected: plan.detected.map(cellKey),
    items: (plan.items ?? []).map((item) => ({
      area: item.area,
      row: item.row,
      col: item.col,
      w: item.w,
      h: item.h,
      ...(item.itemClass ? { itemClass: item.itemClass } : {}),
      cellCount: item.cells.length,
    })),
    clicks: plan.clicks.map((click) => ({
      n: click.n,
      kind: click.kind,
      region: click.region,
    })),
    selected: [...selected],
    ...(plan.evidenceHash ? { evidenceHash: plan.evidenceHash } : {}),
    ...(plan.screenshotId ? { screenshotId: plan.screenshotId } : {}),
  };
}

export function summarizeAssistiveResult(result: AssistiveHandoffResult): AssistiveHandoffResult {
  const traces = (result.traces ?? []).slice(-40).map((trace) => ({
    ...(trace.timestamp ? { timestamp: trace.timestamp } : {}),
    ...(trace.reason ? { reason: redactHandoffText(trace.reason) } : {}),
    ...(trace.result ? { result: trace.result } : {}),
    ...(trace.decisionRule ? { decisionRule: trace.decisionRule } : {}),
    ...(trace.module ? { module: trace.module } : {}),
    input: trace.input
      ? {
          kind: trace.input.kind,
          ...(trace.input.x !== undefined ? { x: trace.input.x } : {}),
          ...(trace.input.y !== undefined ? { y: trace.input.y } : {}),
          ...(trace.input.x2 !== undefined ? { x2: trace.input.x2 } : {}),
          ...(trace.input.y2 !== undefined ? { y2: trace.input.y2 } : {}),
          ...(trace.input.button ? { button: trace.input.button } : {}),
        }
      : null,
  }));
  return {
    ok: result.ok,
    reason: redactHandoffText(result.reason),
    kind: result.kind,
    dryRun: result.dryRun,
    ...(result.cycles !== undefined ? { cycles: result.cycles } : {}),
    ...(result.elapsedMs !== undefined ? { elapsedMs: result.elapsedMs } : {}),
    bagCells: result.bagCells,
    stashCells: result.stashCells,
    traces,
  };
}

export function wrongOccupancyLabels(labels: readonly OccupancyLabel[]): OccupancyLabel[] {
  return labels.filter((label) => label.label === "wrong");
}

export function hasCursorHandoffFindings(evidence: CursorHandoffEvidence): boolean {
  if (wrongOccupancyLabels(evidence.occupancyLabels).length > 0) return true;
  if (evidence.sessionLabels.some((label) => label.label === "wrong")) return true;
  if (evidence.selected.length > 0) return true;
  if (evidence.overlay) return true;
  const last = evidence.lastResult;
  if (!last) return false;
  if (!last.ok || last.dryRun) return true;
  return last.reason !== "ok" && last.reason !== "max-items-reached";
}

function formatCell(cell: { area: string; row: number; col: number; occupied?: boolean; perceivedOccupied?: boolean }): string {
  const occupied = cell.occupied ?? cell.perceivedOccupied;
  const perceived =
    occupied === undefined ? "" : occupied ? " perceived occupied" : " perceived empty";
  return `${cell.area} r${cell.row} c${cell.col}${perceived}`;
}

function formatLabel(label: OccupancyLabel | OverlayDetectionLabel): string {
  const perceived = "perceivedOccupied" in label ? label.perceivedOccupied : false;
  const kind = label.label === "wrong" ? (perceived ? "false-occupied" : "missed-item") : "confirmed";
  return `${formatCell({ ...label, occupied: perceived })} → ${label.label} (${kind})`;
}

function uniqueLabels(
  fileLabels: readonly OccupancyLabel[],
  sessionLabels: readonly OverlayDetectionLabel[],
): OccupancyLabel[] {
  const out: OccupancyLabel[] = [];
  const seen = new Set<string>();
  const push = (label: OccupancyLabel) => {
    const key = `${label.timestamp}:${cellKey(label)}:${label.label}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(label);
  };
  for (const label of fileLabels) push(label);
  for (const label of sessionLabels) {
    push({
      timestamp: "",
      area: label.area,
      row: label.row,
      col: label.col,
      perceivedOccupied: label.perceivedOccupied,
      label: label.label,
    });
  }
  return out;
}

export function selectHandoffLabels(
  labels: readonly OccupancyLabel[],
  options: {
    evidenceHash?: string;
    limit?: number;
  } = {},
): OccupancyLabel[] {
  const limit = options.limit ?? 80;
  const hashed = options.evidenceHash
    ? labels.filter((label) => label.evidenceHash === options.evidenceHash)
    : [];
  const pool = hashed.length > 0 ? hashed : labels;
  const wrong = pool.filter((label) => label.label === "wrong");
  const rest = pool.filter((label) => label.label !== "wrong");
  return [...wrong, ...rest.slice(-Math.max(0, limit - wrong.length))].slice(-limit);
}

function taskBlurb(evidence: CursorHandoffEvidence): string {
  const wrongs = uniqueLabels(evidence.occupancyLabels, evidence.sessionLabels).filter(
    (label) => label.label === "wrong",
  );
  const last = evidence.lastResult;
  const parts = [
    "The operator is reporting Path of Exile 2 companion perception/transfer is wrong.",
  ];
  if (wrongs.length) {
    parts.push(
      `They labeled ${wrongs.length} occupancy cell(s) Wrong on the dry-run overlay (false occupied or missed item).`,
    );
  }
  if (evidence.selected.length) {
    parts.push(`Selected overlay cells: ${evidence.selected.map(formatCell).join("; ")}.`);
  }
  if (last) {
    parts.push(
      `Last assistive run: kind=${last.kind} dryRun=${last.dryRun} ok=${last.ok} reason=${last.reason} bagCells=${last.bagCells} stashCells=${last.stashCells}.`,
    );
  }
  parts.push(
    "Diagnose and fix occupancy detection and/or stash-bag transfer so the overlay matches the game UI and Empty/Fill succeed.",
    "Do not revert Empty-when-bag-empty, Fill finisher guard, combined stash/quad calibration, occupancy labels, or overlay Shift-click multi-select / item footprints.",
    "Logs are local-only. Do not send telemetry. Do not commit secrets or account/session identifiers.",
  );
  return parts.join(" ");
}

function calibrationLines(summary: CalibrationHandoffSummary | null): string[] {
  if (!summary) return ["Calibration: unknown"];
  const stash = summary.stash
    ? `stash ${summary.stash.cols}×${summary.stash.rows} at ${summary.stash.x},${summary.stash.y} ${summary.stash.w}×${summary.stash.h}`
    : "stash missing";
  const bag = summary.bag
    ? `bag ${summary.bag.cols}×${summary.bag.rows} at ${summary.bag.x},${summary.bag.y} ${summary.bag.w}×${summary.bag.h}`
    : "bag missing";
  return [
    `Calibration: ${summary.activeStashTab} tab · client ${summary.client.width}×${summary.client.height} · gridsReady=${summary.gridsReady}`,
    `${stash}; ${bag}; search present: ${summary.searchPresent ? "yes" : "no"}`,
  ];
}

export function compactCursorFixPrompt(
  evidence: CursorHandoffEvidence,
  extras: { promptPath?: string } = {},
): string {
  const labels = uniqueLabels(evidence.occupancyLabels, evidence.sessionLabels);
  const wrongs = labels.filter((label) => label.label === "wrong");
  const lines = [
    "Fix Path of Exile 2 companion perception/transfer.",
    "",
    taskBlurb(evidence),
    "",
    "## Wrong occupancy labels",
    wrongs.length ? wrongs.map((label) => `- ${formatLabel(label)}`).join("\n") : "- none this session",
    "",
    "## Selected cells",
    evidence.selected.length
      ? evidence.selected.map((cell) => `- ${formatCell(cell)}`).join("\n")
      : "- none",
    "",
    "## Calibration",
    ...calibrationLines(evidence.calibration),
  ];
  if (evidence.overlay) {
    lines.push(
      "",
      "## Overlay snapshot",
      `kind=${evidence.overlay.kind ?? "unknown"} occupied=${evidence.overlay.occupied.length} detected=${evidence.overlay.detected.length} items=${evidence.overlay.items.length} plannedClicks=${evidence.overlay.clicks.length}`,
    );
  }
  if (extras.promptPath) {
    lines.push(
      "",
      `Full redacted evidence is on the clipboard and saved at: ${extras.promptPath}`,
    );
  } else {
    lines.push("", "Full redacted evidence is on the clipboard.");
  }
  if (evidence.workspace) {
    lines.push(`Workspace: ${evidence.workspace}`);
  }
  lines.push(
    "",
    "Start in `src/core/uiPerception.ts`, `src/core/cellOccupancy.ts`, `src/core/occupancyLabels.ts`, and `src/main/assistiveRunService.ts`.",
  );
  return redactHandoffText(lines.join("\n"));
}

export function buildCursorFixPrompt(
  evidence: CursorHandoffEvidence,
  extras: { promptPath?: string } = {},
): string {
  const labels = uniqueLabels(evidence.occupancyLabels, evidence.sessionLabels);
  const last = evidence.lastResult
    ? summarizeAssistiveResult(evidence.lastResult)
    : null;
  const body = [
    compactCursorFixPrompt(evidence, extras),
    "",
    "## Occupancy labels (latest session)",
    labels.length
      ? JSON.stringify(redactHandoffJson(labels), null, 2)
      : "none",
    "",
    "## Last assistive result",
    last ? JSON.stringify(redactHandoffJson(last), null, 2) : "none",
    "",
    "## Overlay snapshot",
    evidence.overlay
      ? JSON.stringify(redactHandoffJson(evidence.overlay), null, 2)
      : "none",
    "",
    "## QA action trace tail",
    evidence.traceTail.trim() || "none",
    "",
    "## Local files (do not commit secrets)",
    evidence.occupancyLabelFile ? `- occupancy labels: ${evidence.occupancyLabelFile}` : "",
    evidence.traceFile ? `- qa-action-trace: ${evidence.traceFile}` : "",
    evidence.screenshotId ? `- screenshot id: ${evidence.screenshotId}` : "",
  ]
    .filter((line) => line !== "")
    .join("\n");
  return redactHandoffText(body);
}

export function cursorPromptDeeplink(promptText: string): string {
  const url = new URL(CURSOR_PROMPT_DEEPLINK_BASE);
  url.searchParams.set("text", promptText);
  return url.toString();
}

export function fitPromptForDeeplink(
  promptText: string,
  extras: { promptPath?: string } = {},
  maxChars = CURSOR_DEEPLINK_MAX_CHARS,
): { href: string; text: string; truncated: boolean } {
  const footer = extras.promptPath
    ? `\n\nFull evidence is on the clipboard and at: ${extras.promptPath}`
    : "\n\nFull evidence is on the clipboard.";
  let text = promptText;
  let href = cursorPromptDeeplink(text);
  let truncated = false;
  if (href.length <= maxChars) return { href, text, truncated: false };
  truncated = true;
  const budget = Math.max(240, Math.floor(maxChars * 0.45) - footer.length);
  text = `${promptText.slice(0, budget).trimEnd()}\n…${footer}`;
  href = cursorPromptDeeplink(text);
  while (href.length > maxChars && text.length > 180) {
    text = `${text.slice(0, Math.floor(text.length * 0.8)).trimEnd()}\n…${footer}`;
    href = cursorPromptDeeplink(text);
  }
  return { href, text, truncated };
}

export function cursorHandoffUserMessage(result: {
  opened: boolean;
  copied: boolean;
  truncated: boolean;
}): string {
  if (result.opened && result.copied) {
    return result.truncated
      ? "Opened Cursor with a Fix summary. Confirm the prompt in chat. Full evidence is on the clipboard."
      : "Opened Cursor with a Fix prompt. Confirm it in chat to start the agent. Full evidence is also on the clipboard.";
  }
  if (result.opened) {
    return "Opened Cursor with a Fix prompt. Confirm it in chat to start the agent.";
  }
  if (result.copied) {
    return "Copied the Fix prompt to the clipboard. Paste it into a new Cursor Agent chat.";
  }
  return "Could not open Cursor or copy the Fix prompt.";
}
