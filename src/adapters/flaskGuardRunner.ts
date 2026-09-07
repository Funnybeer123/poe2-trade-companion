/**
 * Auto-flask guard runner: owns a dedicated win-input host and keeps the
 * host-side `flaskguard` loop (scripts/win-input-host.ps1) running in
 * back-to-back cycles, carrying per-probe continuity across them so the
 * cooldown / armed state never resets at a cycle boundary. Also the
 * click-calibration and "sample now" helpers the CLI and the app share.
 *
 * Why its own host: the action daemon's host blocks on `waitkey` and on
 * whole stash/map flows, so the guard would go blind for their duration.
 * A second PowerShell process samples and presses independently — the only
 * interaction is that a flask press can land while a flow holds Ctrl
 * (Ctrl+1 is unbound in the game, so it is harmless).
 */

import { startWinHost, type WinReply } from "./winHost.js";
import { loadFlaskGuardConfig, saveFlaskGuardConfig } from "../core/flaskGuardConfig.js";
import {
  buildHostProbes,
  classifyPatch,
  describeRgb,
  FLASK_GLOBES,
  freshContinuity,
  looksLikeFilledGlobe,
  probeThresholds,
  type FlaskGlobe,
  type FlaskGuardConfig,
  type PatchState,
  type ProbeContinuity,
  type ProbeThresholds,
  type Rgb,
} from "../shared/flaskGuard.js";

export interface WinHostLike {
  send: (payload: Record<string, unknown>) => Promise<WinReply>;
  close: () => Promise<void>;
}

export interface FlaskGuardLogEntry {
  phase: "state" | "fire" | "error" | "cycle";
  message: string;
}

export interface FlaskGuardRunnerOptions {
  root: string;
  log: (entry: FlaskGuardLogEntry) => void;
  /** Sample and decide, but never press a key. */
  dryRun?: boolean;
  /** Length of one host-side loop before it returns and is re-issued. */
  cycleMs?: number;
  /** Injected for tests; defaults to a fresh win-input host per (re)start. */
  hostFactory?: () => WinHostLike;
  /** Injected for tests; defaults to reading artifacts/flask-guard.json. */
  configLoader?: () => { config: FlaskGuardConfig; issues: string[]; mtimeMs: number };
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface FlaskGuardProbeStatus {
  globe: FlaskGlobe;
  state: string;
  rgb: Rgb;
  armed: boolean;
  fires: number;
}

export interface FlaskGuardStatus {
  running: boolean;
  paused: boolean;
  enabled: boolean;
  active: boolean;
  dryRun: boolean;
  probes: FlaskGuardProbeStatus[];
  cycles: number;
  totalFires: number;
  lastError?: string;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function probeKey(config: FlaskGuardConfig): string {
  return JSON.stringify(buildHostProbes(config).map((probe) => ({ ...probe, armed: undefined, lastFireMsAgo: undefined, lastFilledMsAgo: undefined })));
}

export class FlaskGuardRunner {
  private host: WinHostLike | undefined;
  private hostBusy = false;
  private stopping = false;
  private paused = false;
  private loopPromise: Promise<void> | undefined;
  private continuity: Partial<Record<FlaskGlobe, ProbeContinuity>> = {};
  private lastProbeKey = "";
  private lastActive: boolean | undefined;
  private lastEnabled = false;
  private lastError = "";
  private cycles = 0;
  private totalFires = 0;
  private probeStatus: FlaskGuardProbeStatus[] = [];
  private wakeResolve: (() => void) | undefined;
  private watchTimer: NodeJS.Timeout | undefined;
  private lastMtimeMs = -1;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly cycleMs: number;
  private readonly dryRun: boolean;
  private readonly loadConfig: () => { config: FlaskGuardConfig; issues: string[]; mtimeMs: number };
  private readonly makeHost: () => WinHostLike;

  constructor(private readonly options: FlaskGuardRunnerOptions) {
    this.sleep = options.sleep ?? defaultSleep;
    this.cycleMs = Math.max(500, options.cycleMs ?? 5_000);
    this.dryRun = Boolean(options.dryRun);
    this.loadConfig = options.configLoader ?? (() => loadFlaskGuardConfig(options.root));
    this.makeHost =
      options.hostFactory ?? (() => startWinHost({ requestTimeoutMs: this.cycleMs + 20_000 }));
  }

  start(): void {
    if (this.loopPromise) return;
    this.stopping = false;
    this.loopPromise = this.loop().catch((error) => {
      this.options.log({ phase: "error", message: `guard loop crashed: ${String(error)}` });
    });
    // A save from Tools → Hotkeys should apply within a second, not at the
    // next cycle boundary: poll the file's mtime and break the cycle early.
    this.watchTimer = setInterval(() => {
      const mtimeMs = this.loadConfig().mtimeMs;
      if (mtimeMs !== this.lastMtimeMs) {
        this.lastMtimeMs = mtimeMs;
        this.interrupt();
      }
    }, 1_000);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = undefined;
    }
    this.interrupt();
    await this.loopPromise;
    this.loopPromise = undefined;
    await this.closeHost();
  }

  /** Returns the new paused state. Takes effect within one tick, not one cycle. */
  togglePause(): boolean {
    this.paused = !this.paused;
    this.interrupt();
    return this.paused;
  }

  isPaused(): boolean {
    return this.paused;
  }

  /** Break a running host cycle (and any idle sleep) so config/pause changes apply now. */
  interrupt(): void {
    if (this.hostBusy && this.host) {
      // A stray stdin line makes the host loop park it, return, then answer it.
      this.host.send({ op: "ping" }).catch(() => undefined);
    }
    if (this.wakeResolve) {
      const wake = this.wakeResolve;
      this.wakeResolve = undefined;
      wake();
    }
  }

  status(): FlaskGuardStatus {
    return {
      running: Boolean(this.loopPromise) && !this.stopping,
      paused: this.paused,
      enabled: this.lastEnabled,
      active: Boolean(this.lastActive),
      dryRun: this.dryRun,
      probes: [...this.probeStatus],
      cycles: this.cycles,
      totalFires: this.totalFires,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  private async idle(ms: number): Promise<void> {
    await Promise.race([
      this.sleep(ms),
      new Promise<void>((resolve) => {
        this.wakeResolve = resolve;
      }),
    ]);
    this.wakeResolve = undefined;
  }

  private async closeHost(): Promise<void> {
    const host = this.host;
    this.host = undefined;
    this.hostBusy = false;
    if (host) await host.close().catch(() => undefined);
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      const loaded = this.loadConfig();
      const config = loaded.config;
      const key = probeKey(config);
      if (key !== this.lastProbeKey) {
        // Calibration or keys changed: forget armed/cooldown state for the old points.
        this.continuity = {};
        this.lastProbeKey = key;
      }
      const probes = buildHostProbes(config, this.continuity);
      const active = config.enabled && !this.paused && probes.length > 0;
      this.lastEnabled = config.enabled;
      if (active !== this.lastActive) {
        this.lastActive = active;
        this.options.log({
          phase: "state",
          message: active
            ? `guarding ${probes.map((probe) => `${probe.id}→key ${String.fromCharCode(probe.vk).toLowerCase()} (cooldown ${probe.cooldownMs}ms)`).join(", ")}${this.dryRun ? " [DRY-RUN: no key presses]" : ""}`
            : this.paused
              ? "paused (Numpad − resumes)"
              : !config.enabled
                ? "disabled in Tools → Hotkeys → Auto-flask"
                : "no calibrated globe — run the calibration first",
        });
      }
      if (!active) {
        await this.idle(500);
        continue;
      }
      if (!this.host) this.host = this.makeHost();
      let reply: WinReply;
      try {
        this.hostBusy = true;
        reply = await this.host.send({
          op: "flaskguard",
          intervalMs: config.intervalMs,
          durationMs: this.cycleMs,
          dryRun: this.dryRun,
          probes,
        });
      } catch (error) {
        this.hostBusy = false;
        const message = error instanceof Error ? error.message : String(error);
        this.noteError(`host failed: ${message} — restarting`);
        await this.closeHost();
        await this.idle(1_500);
        continue;
      }
      this.hostBusy = false;
      if (!reply.ok) {
        this.noteError(`guard cycle refused: ${String(reply.error ?? "unknown")}`);
        await this.idle(1_500);
        continue;
      }
      this.lastError = "";
      this.cycles += 1;
      this.absorb(reply);
    }
  }

  private noteError(message: string): void {
    if (message === this.lastError) return;
    this.lastError = message;
    this.options.log({ phase: "error", message });
  }

  private absorb(reply: WinReply): void {
    const states =
      typeof reply.states === "object" && reply.states !== null
        ? (reply.states as Record<string, Record<string, unknown>>)
        : {};
    const status: FlaskGuardProbeStatus[] = [];
    for (const globe of FLASK_GLOBES) {
      const state = states[globe];
      if (!state) continue;
      const rgb = { r: Number(state.r) || 0, g: Number(state.g) || 0, b: Number(state.b) || 0 };
      this.continuity[globe] = {
        armed: Boolean(state.armed),
        lastFireMsAgo: Number.isFinite(Number(state.lastFireMsAgo)) ? Number(state.lastFireMsAgo) : -1,
        lastFilledMsAgo: Number.isFinite(Number(state.lastFilledMsAgo)) ? Number(state.lastFilledMsAgo) : 0,
      };
      status.push({
        globe,
        state: String(state.state ?? "unknown"),
        rgb,
        armed: Boolean(state.armed),
        fires: Number(state.fires) || 0,
      });
    }
    this.probeStatus = status;
    const fires = Array.isArray(reply.fires) ? (reply.fires as Array<Record<string, unknown>>) : [];
    for (const fire of fires) {
      this.totalFires += 1;
      const rgb = { r: Number(fire.r) || 0, g: Number(fire.g) || 0, b: Number(fire.b) || 0 };
      this.options.log({
        phase: "fire",
        message: `${String(fire.id)} flask ${fire.dry ? "WOULD fire" : "pressed"}${fire.stale ? " (stale: no fill seen recently)" : ""} — patch read ${describeRgb(rgb)} at +${String(fire.t)}ms`,
      });
    }
  }
}

export interface FlaskCalibrationResult {
  ok: boolean;
  globe: FlaskGlobe;
  point?: { x: number; y: number };
  rgb?: Rgb;
  looksFilled?: boolean;
  error?: string;
  config?: FlaskGuardConfig;
  file?: string;
}

/**
 * Click-to-calibrate one globe: label the screen, wait for the user's click
 * inside the game window, sample the patch there, and (unless save=false)
 * store it as that globe's trigger point + "filled" reference colour.
 */
export async function calibrateFlaskProbe(
  host: WinHostLike,
  globe: FlaskGlobe,
  options: { root: string; timeoutMs?: number; save?: boolean },
): Promise<FlaskCalibrationResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const target = await host.send({ op: "rect" });
  if (!target.ok) {
    return { ok: false, globe, error: String(target.error ?? "Path of Exile 2 window not found") };
  }
  const left = Number(target.left) || 0;
  const top = Number(target.top) || 0;
  const width = Number(target.width) || 1920;
  const label = `AUTO-FLASK: click the ${globe.toUpperCase()} globe at the height where the flask should fire (${Math.round(timeoutMs / 1000)}s)`;
  await host.send({
    op: "marks",
    rects: [{ x: Math.round(left + width / 2 - 520), y: top + 60, w: 1040, h: 44, kind: "find", label }],
  });
  try {
    const click = await host.send({ op: "waitclick", timeoutMs });
    if (!click.ok) {
      return { ok: false, globe, error: String(click.error ?? "no click inside the game window") };
    }
    const point = { x: Math.round(Number(click.x)), y: Math.round(Number(click.y)) };
    const loaded = loadFlaskGuardConfig(options.root);
    const patchSize = loaded.config[globe].patchSize;
    const sample = await host.send({ op: "sample", points: [{ ...point, size: patchSize }] });
    const first = Array.isArray(sample.samples) ? (sample.samples[0] as Record<string, unknown>) : undefined;
    if (!sample.ok || !first) {
      return { ok: false, globe, point, error: String(sample.error ?? "sample failed") };
    }
    const rgb = { r: Number(first.r) || 0, g: Number(first.g) || 0, b: Number(first.b) || 0 };
    const looksFilled = looksLikeFilledGlobe(rgb);
    if (options.save === false) return { ok: true, globe, point, rgb, looksFilled };
    const next: FlaskGuardConfig = {
      ...loaded.config,
      [globe]: {
        ...loaded.config[globe],
        point,
        reference: rgb,
        calibratedAt: new Date().toISOString(),
      },
    };
    const saved = saveFlaskGuardConfig(options.root, next);
    return { ok: true, globe, point, rgb, looksFilled, config: saved.config };
  } finally {
    await host.send({ op: "hidemark" }).catch(() => undefined);
  }
}

export interface FlaskProbeSample {
  globe: FlaskGlobe;
  rgb: Rgb;
  state: PatchState;
  thresholds: ProbeThresholds;
  reference: Rgb;
}

export interface FlaskProbeSampleResult {
  ok: boolean;
  foregroundIsPoe: boolean;
  probes: FlaskProbeSample[];
  error?: string;
}

/** Sample every calibrated globe once and classify it — the app's "Test now". */
export async function sampleFlaskProbes(
  host: WinHostLike,
  config: FlaskGuardConfig,
): Promise<FlaskProbeSampleResult> {
  const calibrated = FLASK_GLOBES.filter((globe) => config[globe].point && config[globe].reference);
  if (calibrated.length === 0) {
    return { ok: false, foregroundIsPoe: false, probes: [], error: "no calibrated globe" };
  }
  const reply = await host.send({
    op: "sample",
    points: calibrated.map((globe) => ({ ...config[globe].point, size: config[globe].patchSize })),
  });
  if (!reply.ok) {
    return { ok: false, foregroundIsPoe: false, probes: [], error: String(reply.error ?? "sample failed") };
  }
  const samples = Array.isArray(reply.samples) ? (reply.samples as Array<Record<string, unknown>>) : [];
  const probes: FlaskProbeSample[] = calibrated.map((globe, index) => {
    const raw = samples[index] ?? {};
    const rgb = { r: Number(raw.r) || 0, g: Number(raw.g) || 0, b: Number(raw.b) || 0 };
    const reference = config[globe].reference as Rgb;
    const thresholds = probeThresholds(config, reference);
    return { globe, rgb, state: classifyPatch(rgb, thresholds), thresholds, reference };
  });
  return { ok: true, foregroundIsPoe: Boolean(reply.foregroundIsPoe), probes };
}

export { freshContinuity };
