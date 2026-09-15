/**
 * Auto-flask guard + auto-cast runner: owns a dedicated win-input host and
 * keeps the host-side `flaskguard` loop (scripts/win-input-host.ps1)
 * running in back-to-back cycles, carrying per-probe continuity across them
 * so the cooldown / armed state never resets at a cycle boundary. Probes
 * are the life/mana globes (press the flask when low) and the auto-cast
 * skill icons (press the skill key whenever the icon reads ready). Also the
 * click-calibration and "sample now" helpers the CLI and the app share.
 *
 * Why its own host: the action daemon's host blocks on `waitkey` and on
 * whole stash/map flows, so the guard would go blind for their duration.
 * A second PowerShell process samples and presses independently — the only
 * interaction is that a flask press can land while a flow holds Ctrl
 * (Ctrl+1 is unbound in the game, so it is harmless).
 */

import path from "node:path";
import { startWinHost, type WinReply } from "./winHost.js";
import { loadFlaskGuardConfig, saveFlaskGuardConfig } from "../core/flaskGuardConfig.js";
import {
  buildHostProbes,
  classifyPatch,
  describeFlaskKey,
  describeRgb,
  FLASK_GLOBES,
  freshContinuity,
  isSkillProbeId,
  looksLikeFilledGlobe,
  looksLikeReadySkill,
  probeConfigFor,
  probeThresholds,
  skillProbeId,
  skillThresholds,
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
  /** Where the host drops a 960x540 PNG of what it saw on each press (rate-limited); default artifacts/flask-guard. */
  snapshotDir?: string | null;
}

export interface FlaskGuardProbeStatus {
  /** "life" | "mana" | "skill:<id>" */
  id: string;
  /** @deprecated alias of id, kept for the globe rows. */
  globe: string;
  state: string;
  rgb: Rgb;
  armed: boolean;
  fires: number;
}

export interface FlaskGuardStatus {
  running: boolean;
  paused: boolean;
  /** Auto-cast held while a daemon action drives the game; flasks keep running. */
  skillsSuspended: boolean;
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
  private skillsSuspended = false;
  private loopPromise: Promise<void> | undefined;
  private continuity: Partial<Record<string, ProbeContinuity>> = {};
  private lastProbeKey = "";
  private lastStateMessage = "";
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
  private readonly snapshotDir: string | undefined;

  constructor(private readonly options: FlaskGuardRunnerOptions) {
    this.sleep = options.sleep ?? defaultSleep;
    this.cycleMs = Math.max(500, options.cycleMs ?? 5_000);
    this.dryRun = Boolean(options.dryRun);
    this.snapshotDir =
      options.snapshotDir === null
        ? undefined
        : (options.snapshotDir ?? path.join(options.root, "artifacts", "flask-guard"));
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

  /**
   * Hold auto-cast (not the flasks) while a daemon action drives the game:
   * those flows type into price dialogs, chat and rename boxes, where a
   * skill key would land as a stray letter. Takes effect within one tick.
   */
  suspendSkills(): void {
    if (this.skillsSuspended) return;
    this.skillsSuspended = true;
    this.interrupt();
  }

  resumeSkills(): void {
    if (!this.skillsSuspended) return;
    this.skillsSuspended = false;
    this.interrupt();
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
      skillsSuspended: this.skillsSuspended,
      enabled: this.lastEnabled,
      active: this.lastStateMessage.startsWith("guarding"),
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
      const allProbes = buildHostProbes(config, this.continuity);
      const held = this.skillsSuspended ? allProbes.filter((probe) => probe.fireOn === "filled") : [];
      const probes = this.skillsSuspended ? allProbes.filter((probe) => probe.fireOn !== "filled") : allProbes;
      const active = config.enabled && !this.paused && probes.length > 0;
      this.lastEnabled = config.enabled;
      const message = active
        ? `guarding ${probes.map((probe) => `${probeLabel(config, probe.id)}→${describeFlaskKey(probeConfigFor(config, probe.id)?.probe.key ?? "")} (${probe.fireOn === "filled" ? "auto-cast, retry gap" : "cooldown"} ${probe.cooldownMs}ms)`).join(", ")}${held.length ? ` — auto-cast held while a numpad action runs (${held.map((probe) => probeLabel(config, probe.id)).join(", ")})` : ""}${this.dryRun ? " [DRY-RUN: no key presses]" : ""}`
        : this.paused
          ? "paused (Numpad − resumes)"
          : !config.enabled
            ? "disabled in Tools → Hotkeys → Auto-flask & auto-cast"
            : held.length
              ? "auto-cast held while a numpad action runs"
              : "no calibrated globe or skill — run the calibration first";
      if (message !== this.lastStateMessage) {
        this.lastStateMessage = message;
        this.options.log({ phase: "state", message });
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
          ...(this.snapshotDir ? { snapshotDir: this.snapshotDir } : {}),
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
    for (const [id, state] of Object.entries(states)) {
      if (!state || (id !== "life" && id !== "mana" && !isSkillProbeId(id))) continue;
      const rgb = { r: Number(state.r) || 0, g: Number(state.g) || 0, b: Number(state.b) || 0 };
      this.continuity[id] = {
        armed: Boolean(state.armed),
        lastFireMsAgo: Number.isFinite(Number(state.lastFireMsAgo)) ? Number(state.lastFireMsAgo) : -1,
        lastFilledMsAgo: Number.isFinite(Number(state.lastFilledMsAgo)) ? Number(state.lastFilledMsAgo) : 0,
      };
      status.push({
        id,
        globe: id,
        state: String(state.state ?? "unknown"),
        rgb,
        armed: Boolean(state.armed),
        fires: Number(state.fires) || 0,
      });
    }
    this.probeStatus = status;
    const fires = Array.isArray(reply.fires) ? (reply.fires as Array<Record<string, unknown>>) : [];
    const config = this.loadConfig().config;
    // Skills fire every cooldown, so their presses are summarised per cycle
    // (one line) while every flask press is still logged individually.
    const skillCasts = new Map<string, { count: number; dry: boolean; last: Rgb }>();
    for (const fire of fires) {
      this.totalFires += 1;
      const id = String(fire.id);
      const rgb = { r: Number(fire.r) || 0, g: Number(fire.g) || 0, b: Number(fire.b) || 0 };
      if (isSkillProbeId(id)) {
        const entry = skillCasts.get(id) ?? { count: 0, dry: Boolean(fire.dry), last: rgb };
        entry.count += 1;
        entry.last = rgb;
        skillCasts.set(id, entry);
        continue;
      }
      const snapshot = typeof fire.snapshot === "string" && fire.snapshot ? ` — saw ${path.basename(fire.snapshot)}` : "";
      this.options.log({
        phase: "fire",
        message: `${id} flask ${fire.dry ? "WOULD fire" : "pressed"}${fire.stale ? " (stale: no fill seen recently)" : ""} — patch read ${describeRgb(rgb)} at +${String(fire.t)}ms${snapshot}`,
      });
    }
    for (const [id, cast] of skillCasts) {
      this.options.log({
        phase: "fire",
        message: `${probeLabel(config, id)} ${cast.dry ? "WOULD cast" : "cast"} ${cast.count}x this cycle (icon ready, read ${describeRgb(cast.last)})`,
      });
    }
  }
}

function probeLabel(config: FlaskGuardConfig, id: string): string {
  return probeConfigFor(config, id)?.label ?? id;
}

export interface FlaskCalibrationResult {
  ok: boolean;
  /** What was calibrated: "life" | "mana" | "skill:<id>". */
  target: string;
  /** @deprecated alias of target. */
  globe: string;
  point?: { x: number; y: number };
  rgb?: Rgb;
  /** Globe: the click looks like fluid. Skill: the click looks like a lit (ready) icon. */
  looksFilled?: boolean;
  error?: string;
  config?: FlaskGuardConfig;
  file?: string;
}

/**
 * Click-to-calibrate one probe: label the screen, wait for the user's click
 * inside the game window, sample the patch there, and (unless save=false)
 * store it as that probe's trigger point + "filled" reference colour. For a
 * globe click at the height where the flask should fire; for a skill
 * ("skill:<id>") click the TOP EDGE of the skill-bar icon while the skill
 * is READY (the cooldown sweep relights the top last).
 */
export async function calibrateFlaskProbe(
  host: WinHostLike,
  target: FlaskGlobe | string,
  options: { root: string; timeoutMs?: number; save?: boolean },
): Promise<FlaskCalibrationResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const loaded = loadFlaskGuardConfig(options.root);
  const entry = probeConfigFor(loaded.config, target);
  if (!entry) {
    return { ok: false, target, globe: target, error: `unknown probe "${target}" — life, mana, or skill:<id>` };
  }
  const window = await host.send({ op: "rect" });
  if (!window.ok) {
    return { ok: false, target, globe: target, error: String(window.error ?? "Path of Exile 2 window not found") };
  }
  const left = Number(window.left) || 0;
  const top = Number(window.top) || 0;
  const width = Number(window.width) || 1920;
  const seconds = Math.round(timeoutMs / 1000);
  const label =
    entry.kind === "globe"
      ? `AUTO-FLASK: click the ${target.toUpperCase()} globe at the height where the flask should fire (${seconds}s)`
      : `AUTO-CAST: click the TOP EDGE of the ${entry.label.toUpperCase()} icon on the skill bar while the skill is READY (${seconds}s)`;
  await host.send({
    op: "marks",
    rects: [{ x: Math.round(left + width / 2 - 520), y: top + 60, w: 1040, h: 44, kind: "find", label }],
  });
  try {
    const click = await host.send({ op: "waitclick", timeoutMs });
    if (!click.ok) {
      return { ok: false, target, globe: target, error: String(click.error ?? "no click inside the game window") };
    }
    const point = { x: Math.round(Number(click.x)), y: Math.round(Number(click.y)) };
    const patchSize = entry.probe.patchSize;
    const sample = await host.send({ op: "sample", points: [{ ...point, size: patchSize }] });
    const first = Array.isArray(sample.samples) ? (sample.samples[0] as Record<string, unknown>) : undefined;
    if (!sample.ok || !first) {
      return { ok: false, target, globe: target, point, error: String(sample.error ?? "sample failed") };
    }
    const rgb = { r: Number(first.r) || 0, g: Number(first.g) || 0, b: Number(first.b) || 0 };
    const looksFilled = entry.kind === "globe" ? looksLikeFilledGlobe(rgb) : looksLikeReadySkill(rgb);
    if (options.save === false) return { ok: true, target, globe: target, point, rgb, looksFilled };
    const patch = { point, reference: rgb, calibratedAt: new Date().toISOString() };
    // Re-read: the file may have been saved (panel edits) during the up-to-30 s wait.
    const current = loadFlaskGuardConfig(options.root).config;
    const next: FlaskGuardConfig =
      entry.kind === "globe"
        ? { ...current, [target]: { ...current[target as FlaskGlobe], ...patch } }
        : {
            ...current,
            skills: current.skills.map((skill) =>
              skillProbeId(skill) === target ? { ...skill, ...patch } : skill,
            ),
          };
    const saved = saveFlaskGuardConfig(options.root, next);
    return { ok: true, target, globe: target, point, rgb, looksFilled, config: saved.config };
  } finally {
    await host.send({ op: "hidemark" }).catch(() => undefined);
  }
}

export interface FlaskProbeSample {
  /** "life" | "mana" | "skill:<id>" */
  id: string;
  /** @deprecated alias of id. */
  globe: string;
  label: string;
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

/** Sample every calibrated globe and skill once and classify it — the app's "Test now". */
export async function sampleFlaskProbes(
  host: WinHostLike,
  config: FlaskGuardConfig,
): Promise<FlaskProbeSampleResult> {
  const calibrated = [
    ...FLASK_GLOBES.map((globe) => globe as string),
    ...config.skills.map((skill) => skillProbeId(skill)),
  ]
    .map((id) => ({ id, entry: probeConfigFor(config, id) }))
    .filter((row) => row.entry?.probe.point && row.entry.probe.reference);
  if (calibrated.length === 0) {
    return { ok: false, foregroundIsPoe: false, probes: [], error: "no calibrated globe or skill" };
  }
  const reply = await host.send({
    op: "sample",
    points: calibrated.map((row) => ({ ...row.entry!.probe.point, size: row.entry!.probe.patchSize })),
  });
  if (!reply.ok) {
    return { ok: false, foregroundIsPoe: false, probes: [], error: String(reply.error ?? "sample failed") };
  }
  const samples = Array.isArray(reply.samples) ? (reply.samples as Array<Record<string, unknown>>) : [];
  const probes: FlaskProbeSample[] = calibrated.map((row, index) => {
    const raw = samples[index] ?? {};
    const rgb = { r: Number(raw.r) || 0, g: Number(raw.g) || 0, b: Number(raw.b) || 0 };
    const entry = row.entry!;
    const reference = entry.probe.reference as Rgb;
    const thresholds = entry.kind === "globe" ? probeThresholds(config, reference) : skillThresholds(config, reference);
    return { id: row.id, globe: row.id, label: entry.label, rgb, state: classifyPatch(rgb, thresholds), thresholds, reference };
  });
  return { ok: true, foregroundIsPoe: Boolean(reply.foregroundIsPoe), probes };
}

export { freshContinuity };
