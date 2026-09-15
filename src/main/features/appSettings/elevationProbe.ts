/**
 * Runs the administrator-rights heuristic at most once every `ttlMs`.
 *
 * Launching PowerShell is expensive and the answer changes only when the
 * user restarts the game or the app, so concurrent callers share one
 * in-flight run (`memoizeAsync`) and the Settings card can poll freely. A
 * failed probe still produces a report (verdict "unknown" + `error`) — this
 * is a hint, never a gate.
 */
import { memoizeAsync, type MemoizedAsync } from "../../../core/memoizeAsync.js";
import {
  ELEVATION_PROBE_SCRIPT,
  judgeElevation,
  parseElevationProbe,
} from "../../../core/appSettingsElevation.js";
import type { ElevationReport } from "../../../shared/appSettings.js";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  /** The child was killed by the timeout rather than exiting on its own. */
  killed?: boolean;
}

export type ElevationExec = (
  file: string,
  args: string[],
  opts?: { timeoutMs?: number },
) => Promise<ExecResult>;

export interface ElevationProbeOptions {
  exec: ElevationExec;
  now: () => Date;
  ttlMs: number;
  timeoutMs?: number;
  log?: (level: "info" | "warn" | "error", message: string, detail?: unknown) => void;
}

export const ELEVATION_TIMEOUT_MS = 8_000;

export class ElevationProbe {
  private memo: MemoizedAsync<ElevationReport>;
  private latest: ElevationReport | undefined;

  constructor(private readonly options: ElevationProbeOptions) {
    this.memo = this.freshMemo();
  }

  private freshMemo(): MemoizedAsync<ElevationReport> {
    return memoizeAsync(() => this.run(), {
      ttlMs: this.options.ttlMs,
      now: () => this.options.now().getTime(),
    });
  }

  /**
   * `force` really re-probes (the "Check administrator rights" button).
   * `memoizeAsync.reset()` drops only the settled value, so a forced call
   * issued while a probe is in flight would join THAT run and return the very
   * answer the user is trying to replace — a fresh memo cannot.
   */
  async report(force = false): Promise<ElevationReport> {
    if (force) this.memo = this.freshMemo();
    return this.memo();
  }

  /** The last report, without launching anything (the checklist uses this). */
  last(): ElevationReport | undefined {
    return this.latest;
  }

  private async run(): Promise<ElevationReport> {
    const checkedAt = this.options.now().toISOString();
    try {
      const result = await this.options.exec(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", ELEVATION_PROBE_SCRIPT],
        { timeoutMs: this.options.timeoutMs ?? ELEVATION_TIMEOUT_MS },
      );
      const parsed = parseElevationProbe(result.stdout);
      const stderr = (result.stderr ?? "").trim();
      // A verdict we could actually read survives a chatty stderr (a
      // PowerShell warning is not a failed probe). Only a non-zero exit, or
      // stderr with nothing usable on stdout, degrades to "unknown" + error —
      // which is what the checklist and the hint both document.
      const usable = parsed.appElevated !== "unknown" || parsed.processes.length > 0;
      if (result.code !== 0 || (stderr !== "" && !usable)) {
        const failure = this.unknown(
          checkedAt,
          stderr || (result.killed === true ? "the probe timed out" : `powershell exited with ${result.code}`),
        );
        this.latest = failure;
        return failure;
      }
      const report = judgeElevation(parsed, checkedAt);
      this.latest = report;
      return report;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.log?.("warn", "elevation probe failed", message);
      const report = this.unknown(checkedAt, message);
      this.latest = report;
      return report;
    }
  }

  private unknown(checkedAt: string, error: string): ElevationReport {
    return {
      appElevated: "unknown",
      poeRunning: false,
      poeElevated: "unknown",
      processes: [],
      checkedAt,
      error,
    };
  }
}
