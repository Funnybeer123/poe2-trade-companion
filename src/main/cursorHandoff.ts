import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CalibrationProfile } from "../core/calibrationProfile.js";
import {
  buildCursorFixPrompt,
  compactCursorFixPrompt,
  cursorHandoffUserMessage,
  fitPromptForDeeplink,
  hasCursorHandoffFindings,
  redactHandoffText,
  selectHandoffLabels,
  summarizeAssistiveResult,
  summarizeCalibration,
  summarizeOverlayPlan,
  type AssistiveHandoffResult,
  type CursorHandoffEvidence,
} from "../core/cursorHandoff.js";
import type { DryRunOverlayPlan, OverlayCellRef, OverlayDetectionLabel } from "../core/dryRunOverlay.js";
import { loadOccupancyLabels, occupancyLabelsPath } from "../core/occupancyLabels.js";

export interface CursorHandoffSnapshot {
  last: AssistiveHandoffResult | null;
  overlayPlan: DryRunOverlayPlan | null;
  overlaySelection: OverlayCellRef[];
  overlaySessionLabels: OverlayDetectionLabel[];
}

export interface CursorHandoffResult {
  ok: boolean;
  opened: boolean;
  copied: boolean;
  truncated: boolean;
  findings: boolean;
  promptPath?: string;
  method: "deeplink" | "clipboard" | "none";
  message: string;
}

export interface CursorLaunchDeps {
  writeText: (text: string) => void;
  openExternal: (url: string) => Promise<void>;
  spawnCursor?: (args: string[]) => Promise<boolean>;
}

const TRACE_FILE = "qa-action-trace.jsonl";
const PROMPT_FILE = "cursor-handoff-latest.md";

export function findCompanionRepoRoot(startDirs: readonly string[]): string | undefined {
  for (const start of startDirs) {
    if (!start) continue;
    let dir = path.resolve(start);
    for (let i = 0; i < 8; i += 1) {
      const pkg = path.join(dir, "package.json");
      if (existsSync(pkg)) {
        try {
          const parsed = JSON.parse(readFileSync(pkg, "utf8")) as { name?: string };
          if (parsed.name === "poe2-trade-companion") return dir;
        } catch {
          // Keep walking; a nested package.json is not this repo.
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return undefined;
}

export function readTextTail(file: string, maxLines = 40, maxChars = 20_000): string {
  if (!existsSync(file)) return "";
  const raw = readFileSync(file, "utf8");
  const lines = raw.split(/\r?\n/).filter((line) => line.trim());
  const tail = lines.slice(-maxLines).join("\n");
  const clipped = tail.length > maxChars ? tail.slice(-maxChars) : tail;
  return redactHandoffText(clipped);
}

export function gatherCursorHandoffEvidence(input: {
  memoryRoot: string;
  artifactDir: string;
  profile: CalibrationProfile;
  snapshot: CursorHandoffSnapshot;
  workspace?: string;
  createdAt?: string;
}): CursorHandoffEvidence {
  const occupancyLabelFile = occupancyLabelsPath(input.memoryRoot);
  const traceFile = path.join(input.artifactDir, TRACE_FILE);
  const evidenceHash = input.snapshot.overlayPlan?.evidenceHash;
  const occupancyLabels = selectHandoffLabels(loadOccupancyLabels(input.memoryRoot), {
    ...(evidenceHash ? { evidenceHash } : {}),
  });
  const overlay = input.snapshot.overlayPlan
    ? summarizeOverlayPlan(input.snapshot.overlayPlan, input.snapshot.overlaySelection)
    : null;
  const last = input.snapshot.last ? summarizeAssistiveResult(input.snapshot.last) : null;
  return {
    createdAt: input.createdAt ?? new Date().toISOString(),
    occupancyLabels,
    sessionLabels: [...input.snapshot.overlaySessionLabels],
    selected: [...input.snapshot.overlaySelection],
    lastResult: last,
    overlay,
    calibration: summarizeCalibration(input.profile),
    traceTail: readTextTail(traceFile),
    occupancyLabelFile,
    traceFile,
    ...(overlay?.screenshotId ? { screenshotId: overlay.screenshotId } : {}),
    ...(input.workspace ? { workspace: input.workspace } : {}),
  };
}

export function spawnCursorCli(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(args[0] ?? "cursor", args.slice(1), {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      shell: process.platform === "win32",
    });
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}

export async function launchCursorWithPrompt(
  evidence: CursorHandoffEvidence,
  options: { artifactDir: string },
  deps: CursorLaunchDeps,
): Promise<CursorHandoffResult> {
  const findings = hasCursorHandoffFindings(evidence);
  if (!findings) {
    return {
      ok: false,
      opened: false,
      copied: false,
      truncated: false,
      findings: false,
      method: "none",
      message: "No Wrong labels, selected cells, or failed/dry-run Empty/Fill result to send.",
    };
  }

  mkdirSync(options.artifactDir, { recursive: true });
  const promptPath = path.join(options.artifactDir, PROMPT_FILE);
  const fullPrompt = buildCursorFixPrompt(evidence, { promptPath });
  writeFileSync(promptPath, fullPrompt, "utf8");

  let copied = false;
  try {
    deps.writeText(fullPrompt);
    copied = true;
  } catch {
    copied = false;
  }

  const compact = compactCursorFixPrompt(evidence, { promptPath });
  const fitted = fitPromptForDeeplink(compact, { promptPath });
  let opened = false;
  try {
    await deps.openExternal(fitted.href);
    opened = true;
  } catch {
    opened = false;
  }

  if (!opened && deps.spawnCursor && evidence.workspace) {
    await deps.spawnCursor(["cursor", evidence.workspace]);
  }

  return {
    ok: opened || copied,
    opened,
    copied,
    truncated: fitted.truncated,
    findings: true,
    promptPath,
    method: opened ? "deeplink" : copied ? "clipboard" : "none",
    message: cursorHandoffUserMessage({ opened, copied, truncated: fitted.truncated }),
  };
}
