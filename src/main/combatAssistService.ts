import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CombatInputSink } from "../adapters/combatInputSink.js";
import { startWinHost } from "../adapters/winHost.js";
import {
  CombatPlanner, defaultCombatConfig, parseCombatConfig, readCombatFrame, requireCombatCalibration,
  type CombatConfig, type CombatFrame, type CombatPreview, type CombatStatus,
} from "../core/combatAssist.js";
import { GameInputController } from "../core/gameInputController.js";
import type { KillSwitch } from "../core/killSwitch.js";
import { scenario } from "../core/scenarios.js";
import type { QaActionTrace, RuntimeMode } from "../core/types.js";

type Host = ReturnType<typeof startWinHost>;
interface CombatServiceOptions {
  killSwitch: KillSwitch;
  mode: RuntimeMode;
  config?: CombatConfig;
  createHost?: () => Host;
  blocked?: () => string | undefined;
  save?: (config: CombatConfig) => void;
  audit: (traces: QaActionTrace[]) => void;
  now?: () => number;
}

export class CombatAssistService {
  private config: CombatConfig;
  private running = false;
  private reason = "Stopped";
  private host?: Host;
  private timer?: ReturnType<typeof setTimeout>;
  private cancelPreviewWait?: () => void;
  private generation = 0;
  private frame?: CombatFrame;
  private reading?: CombatStatus["reading"];
  private cycleMs?: number;
  private actions = 0;
  private readonly now: () => number;
  constructor(private options: CombatServiceOptions) {
    this.config = parseCombatConfig(options.config ?? defaultCombatConfig());
    this.now = options.now ?? (() => performance.now());
  }
  get status(): CombatStatus {
    return structuredClone({ running: this.running, reason: this.reason, config: this.config, reading: this.reading, cycleMs: this.cycleMs, actions: this.actions });
  }
  configure(value: unknown): CombatStatus {
    const config = parseCombatConfig(value);
    this.stop("Settings changed — press Start to resume");
    this.options.save?.(config);
    this.config = config;
    return this.status;
  }
  stop(reason = "Stopped"): CombatStatus {
    this.generation++;
    this.running = false;
    this.reason = reason;
    this.frame = undefined;
    this.reading = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.cancelPreviewWait?.();
    const host = this.host;
    this.host = undefined;
    if (host) void host.close().catch(() => {});
    return this.status;
  }
  private blocked(): string | undefined {
    if (this.options.killSwitch.isLatched()) return "Emergency stop latched — rearm in the app";
    return this.options.blocked?.();
  }
  private createHost(): Host {
    return this.options.createHost?.() ?? startWinHost({ scriptName: "win-combat-host.ps1", requestTimeoutMs: 5000 });
  }
  async preview(): Promise<CombatPreview> {
    this.stop("Paused for HUD calibration");
    const generation = this.generation;
    const host = this.createHost();
    this.host = host;
    const focusDeadline = this.now() + 15_000;
    let waitingForFocus = false;
    try {
      while (true) {
        if (generation !== this.generation) throw new Error("Calibration cancelled");
        if (waitingForFocus && this.now() >= focusDeadline) throw new Error("Capture timed out waiting for game focus");
        const capture = host.send({ op: "preview" });
        let captureTimeout: ReturnType<typeof setTimeout> | undefined;
        const result = waitingForFocus ? await Promise.race([
          capture,
          new Promise<never>((_, reject) => {
            captureTimeout = setTimeout(() => reject(new Error("Capture timed out waiting for game focus")), Math.max(0, focusDeadline - this.now()));
          }),
        ]).finally(() => clearTimeout(captureTimeout)) : await capture;
        if (generation !== this.generation) throw new Error("Calibration cancelled");
        if (result.ok && typeof result.image === "string") {
          this.reason = "Paused for HUD calibration";
          return { image: result.image, width: Number(result.width), height: Number(result.height) };
        }
        const needsGameFocus = result.error === "Focus Path of Exile 2 to continue"
          || result.error === 'Exception calling "Foreground" with "0" argument(s): "Focus Path of Exile 2 to continue"';
        if (result.ok || !needsGameFocus) throw new Error(String(result.error ?? "Capture failed"));
        const remaining = focusDeadline - this.now();
        if (remaining <= 0) throw new Error("Capture timed out waiting for game focus");
        waitingForFocus = true;
        this.reason = "Waiting for game focus — switch to Path of Exile 2";
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            if (this.cancelPreviewWait === finish) this.cancelPreviewWait = undefined;
            resolve();
          };
          const timer = setTimeout(finish, Math.min(250, remaining));
          this.cancelPreviewWait = finish;
        });
      }
    } catch (error) {
      if (generation === this.generation) this.reason = error instanceof Error ? error.message : "Capture failed";
      throw error;
    } finally {
      if (this.host === host) {
        this.host = undefined;
        await host.close();
      }
    }
  }
  async start(): Promise<CombatStatus> {
    if (this.running) return this.status;
    requireCombatCalibration(this.config);
    const blocked = this.blocked();
    if (blocked) throw new Error(blocked);
    this.stop();
    const generation = this.generation;
    const host = this.createHost();
    this.host = host;
    this.running = true;
    this.reason = "Starting capture worker";
    const planner = new CombatPlanner();
    const sink = new CombatInputSink(host, () => {
      const frame = this.frame;
      return this.running && generation === this.generation && !this.blocked() && frame && this.now() - frame.capturedAt <= 120 ? frame.hwnd : undefined;
    });
    const controller = new GameInputController(sink, this.options.killSwitch, this.options.mode);
    const policy = scenario({ id: "combat-assist", name: "Flasks and Unleash", enabledModules: ["combat"], dryRun: this.config.dryRun, actionsPerMinute: 240, confidenceThreshold: 0.94, timingProfile: "tight" });
    const regions = Object.fromEntries(Object.entries(this.config.regions).map(([name, r]) => [name, { x: r.x, y: r.y, width: r.width, height: r.height }]));
    const tick = async () => {
      if (!this.running || generation !== this.generation) return;
      const started = this.now();
      let delay = this.config.pollMs;
      try {
        const blocked = this.blocked();
        if (blocked) { this.stop(blocked); return; }
        const reply = await host.send({ op: "sample", regions });
        if (!this.running || generation !== this.generation) return;
        this.frame = undefined;
        if (!reply.ok) {
          this.reason = String(reply.error ?? "Game capture unavailable");
          this.reading = undefined;
          delay = 100;
        } else {
          const samples = Object.fromEntries(Object.entries(reply.samples as Record<string, string | number[]>).map(([name, pixels]) => [name, typeof pixels === "string" ? [...Buffer.from(pixels, "base64")] : pixels]));
          const frame = { ...reply, samples, capturedAt: started } as unknown as CombatFrame;
          this.frame = frame;
          const reading = readCombatFrame(this.config, frame, this.now());
          this.reading = reading;
          this.reason = reading.reason;
          for (const planned of planner.decisions(this.config, reading, this.now())) {
            if (!this.running || generation !== this.generation || this.blocked()) break;
            if (this.now() - started > 120) break;
            const evidence = JSON.stringify({ capturedAt: frame.capturedAt, hwnd: frame.hwnd, reading });
            const traces = await controller.execute(planned.decision, policy, frame.process, evidence, true);
            this.options.audit(traces);
            // Long-running combat sessions must not retain every trace in RAM.
            controller.actionTraces.splice(0);
            if (traces.some((t) => t.result === "emitted" || t.reason.includes("safety=dry-run"))) {
              planner.committed(planned.name, this.now());
              this.actions++;
            }
            const failed = traces.find((t) => t.result === "failed");
            if (failed) { this.stop(failed.reason); return; }
            if (traces.some((t) => t.reason.includes("safety=rate-limited"))) { this.stop("Action limit reached (240/minute)"); return; }
          }
        }
      } catch (error) {
        if (generation === this.generation) this.stop(error instanceof Error ? error.message : "Combat worker failed");
      } finally {
        if (this.running && generation === this.generation) {
          this.cycleMs = Math.round((this.now() - started) * 10) / 10;
          // No overlapping captures, queued intervals, or catch-up bursts.
          this.timer = setTimeout(() => void tick(), Math.max(1, delay - (this.now() - started)));
        }
      }
    };
    try {
      const result = await host.send({ op: "ping" });
      if (!result.ok) throw new Error(String(result.error ?? "Capture worker failed to start"));
      if (this.running && generation === this.generation) void tick();
    } catch (error) {
      if (generation === this.generation) this.stop(error instanceof Error ? error.message : "Capture worker failed");
    }
    return this.status;
  }
}

export function combatStorage(root: string) {
  const settings = path.join(root, "combat-assist.json");
  return {
    load: (): CombatConfig => existsSync(settings) ? parseCombatConfig(JSON.parse(readFileSync(settings, "utf8"))) : defaultCombatConfig(),
    save: (config: CombatConfig) => { mkdirSync(root, { recursive: true }); writeFileSync(settings, JSON.stringify(config, null, 2)); },
    audit: (traces: QaActionTrace[]) => {
      if (!traces.length) return;
      mkdirSync(root, { recursive: true });
      appendFileSync(path.join(root, `combat-actions-${new Date().toISOString().slice(0, 10)}.jsonl`), traces.map((t) => JSON.stringify(t)).join("\n") + "\n");
    },
  };
}
