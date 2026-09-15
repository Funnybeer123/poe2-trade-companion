/**
 * Administrator-rights heuristic and the elevated-relaunch command (pure).
 *
 * WHY this exists: Windows UIPI silently drops keyboard/mouse input and
 * global hotkeys sent from a lower-privilege process to an elevated window.
 * If the game runs "as administrator" and the companion does not, every
 * transfer, chat command and overlay hotkey fails with a focus error and
 * nothing says why. The probe turns that into one sentence.
 *
 * WHY `Process.Handle`: .NET opens the process with full access to hand out
 * `Handle`; from a non-elevated caller that throws "Access is denied" for an
 * elevated process and succeeds for a same-integrity one. It is a heuristic —
 * protected/anti-cheat processes also deny handles and a localized Windows
 * words the exception differently — so the vocabulary is
 * "likely"/"no"/"unknown" and the verdict never blocks anything.
 *
 * SAFETY: the two PowerShell strings in this file are the only PowerShell
 * this package runs. The probe is a constant with no interpolation at all;
 * the relaunch command's only variable parts are `process.execPath`,
 * `process.argv` and the build mode, each passed through `psQuote`. A
 * blocking test asserts neither string can carry a shell expansion.
 */
import type { ElevationProcessRow, ElevationReport, ElevationVerdict } from "../shared/appSettings.js";

/**
 * Fixed probe text — run as
 * `powershell.exe -NoProfile -NonInteractive -Command <script>`.
 * Assembled from plain string literals so no build step can inject anything.
 */
export const ELEVATION_PROBE_SCRIPT: string = [
  "$me = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
  "$rows = @(Get-Process | Where-Object { $_.ProcessName -match 'PathOfExile' } | ForEach-Object {",
  "  $access = 'ok'",
  "  try { $null = $_.Handle } catch { $access = if ($_.Exception.Message -match 'denied') { 'denied' } else { 'error' } }",
  "  [pscustomobject]@{ name = $_.ProcessName; pid = $_.Id; access = $access } })",
  "[pscustomobject]@{ appElevated = [bool]$me; processes = $rows } | ConvertTo-Json -Compress -Depth 3",
].join("\n");

export interface ElevationProbeResult {
  appElevated: boolean | "unknown";
  processes: ElevationProcessRow[];
}

export const ELEVATION_HINT =
  "Path of Exile 2 appears to run as administrator while the companion does not. " +
  "Windows (UIPI) drops keyboard/mouse input and global hotkeys sent from a lower-privilege app " +
  "to an elevated window, so transfers, chat commands and overlay hotkeys will fail with focus errors. " +
  "Start the game without 'Run as administrator', or relaunch the companion elevated.";

function asAccess(value: unknown): ElevationProcessRow["access"] {
  return value === "denied" ? "denied" : value === "error" ? "error" : "ok";
}

function asRow(value: unknown): ElevationProcessRow | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const name = typeof source.name === "string" ? source.name : "";
  const pid = Number(source.pid);
  if (!name || !Number.isFinite(pid)) return undefined;
  return { name, pid: Math.trunc(pid), access: asAccess(source.access) };
}

/**
 * Tolerant parse. `ConvertTo-Json` unwraps a single-element array, so
 * `processes` may arrive as one object; an empty stdout or any garbage
 * degrades to "unknown" rather than throwing.
 */
export function parseElevationProbe(stdout: string): ElevationProbeResult {
  const empty: ElevationProbeResult = { appElevated: "unknown", processes: [] };
  const text = (stdout ?? "").trim();
  if (!text) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return empty;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return empty;
  const source = parsed as Record<string, unknown>;
  const appElevated =
    source.appElevated === true ? true : source.appElevated === false ? false : ("unknown" as const);
  const raw = source.processes;
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  const processes = list.map(asRow).filter((row): row is ElevationProcessRow => row !== undefined);
  return { appElevated, processes };
}

/** Verdict + the one actionable hint; `checkedAt` comes from the caller's clock. */
export function judgeElevation(probe: ElevationProbeResult, checkedAt: string): ElevationReport {
  const processes = probe.processes;
  const poeRunning = processes.length > 0;
  let poeElevated: ElevationVerdict;
  if (!poeRunning) {
    // Nothing to compare against — not evidence either way.
    poeElevated = "unknown";
  } else if (probe.appElevated === true) {
    // An elevated caller can open everything, so a successful handle proves nothing.
    poeElevated = "unknown";
  } else if (processes.some((row) => row.access === "denied")) {
    poeElevated = "likely";
  } else if (processes.every((row) => row.access === "ok")) {
    poeElevated = "no";
  } else {
    poeElevated = "unknown";
  }
  const actionable = probe.appElevated === false && poeElevated === "likely";
  return {
    appElevated: probe.appElevated,
    poeRunning,
    poeElevated,
    processes,
    ...(actionable ? { hint: ELEVATION_HINT } : {}),
    checkedAt,
  };
}

/**
 * Single-quotes one PowerShell argument. Inside single quotes PowerShell
 * expands nothing at all, so doubling embedded quotes is the complete rule —
 * no `$`, no backtick and no backslash escaping is needed or wanted.
 */
export function psQuote(value: string): string {
  return "'" + String(value ?? "").replace(/'/g, "''") + "'";
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface RelaunchCommandOptions {
  /**
   * `-WorkingDirectory` for the elevated child. UAC elevation goes through
   * ShellExecuteEx/AppInfo, which does NOT carry the caller's current
   * directory, so a relative argument (`electron .`) would otherwise resolve
   * against whatever the broker picks. Must be a real directory — never an
   * `app.asar` path, which `Start-Process` rejects.
   */
  workingDirectory?: string;
}

/**
 * `$env:POE2_BUILD_MODE = '…'; Start-Process -FilePath '…' -ArgumentList @('…') -WorkingDirectory '…' -Verb RunAs`
 *
 * `-Verb RunAs` raises the UAC prompt — the user's consent is the gate; the
 * companion never elevates itself silently.
 *
 * The `$env:` prefix is belt-and-braces only. AppInfo builds a FRESH
 * environment block for the elevated child, so a variable set in this
 * (non-elevated) PowerShell does not reach it. The build mode actually
 * survives because Vite bakes `__POE2_BUILD_MODE__` into the main bundle for
 * both the dev and packaged builds; the prefix just means a future build that
 * drops the define, and a shell that does inherit, still land in the same mode.
 */
export function relaunchElevatedCommand(
  exe: string,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
  options: RelaunchCommandOptions = {},
): string {
  const prefix = Object.entries(env)
    .filter(([name, value]) => ENV_NAME.test(name) && typeof value === "string" && value.length > 0)
    .map(([name, value]) => "$env:" + name + " = " + psQuote(value) + "; ")
    .join("");
  const list = args.filter((arg) => typeof arg === "string" && arg.length > 0).map(psQuote);
  const argumentList = list.length > 0 ? " -ArgumentList @(" + list.join(",") + ")" : "";
  const cwd = options.workingDirectory;
  const workingDirectory =
    typeof cwd === "string" && cwd.length > 0 ? " -WorkingDirectory " + psQuote(cwd) : "";
  return (
    prefix + "Start-Process -FilePath " + psQuote(exe) + argumentList + workingDirectory + " -Verb RunAs"
  );
}
