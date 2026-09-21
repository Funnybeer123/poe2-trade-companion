import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CombatInputSink } from "../adapters/combatInputSink.js";
import { startWinHost } from "../adapters/winHost.js";
import { COMBAT_PROCESSES } from "../core/combatAssist.js";
import { FlaskPlanner, flaskReferenceIssue, lifeGlobeColumn, parseFlaskCalibration, readLife, type FlaskCalibration, type FlaskSettings } from "../core/followerFlask.js";
import { GameInputController } from "../core/gameInputController.js";
import type { KillSwitch } from "../core/killSwitch.js";
import { scenario } from "../core/scenarios.js";
import type { QaActionTrace, RuntimeMode } from "../core/types.js";

type Host = Pick<ReturnType<typeof startWinHost>, "send" | "close">;
interface FlaskOptions {
  directory: string;
  killSwitch: KillSwitch;
  mode: RuntimeMode;
  settings: FlaskSettings;
  dryRun: boolean;
  /** A reason not to press right now — the human holds the PC, the follower is stopped. Reading goes on regardless. */
  blocked?: () => string | undefined;
  createHost?: () => Host;
  audit?: (traces: QaActionTrace[]) => void;
  now?: () => number;
  pollMs?: number;
}
export interface FlaskStatus { running: boolean; reason: string; life?: number; presses: number; previewed: number; refused: number; unreadable: number; readings: number }

/** A sample older than this when the press goes out is not evidence of anything; the combat worker re-checks the window itself. */
const SAMPLE_MAX_AGE_MS = 250;

/**
 * Drinks the follower's life flask. Its own worker and its own loop: nothing here is awaited by the follower's
 * tick, so the 120 ms click budget is untouched. The press goes through GameInputController (kill switch,
 * dry-run, rate cap, trace) and out through the combat worker's `tap` — down and up in one SendInput batch,
 * allowlisted bindings only, refused while a modifier or the key itself is physically held, bound to the
 * window handle of the very sample that showed low life. No key reaches the follower's own input worker.
 */
export class FollowerFlaskService {
  private running = false;
  private generation = 0;
  private host?: Host;
  private timer?: ReturnType<typeof setTimeout>;
  private state: FlaskStatus = { running: false, reason: "Stopped", presses: 0, previewed: 0, refused: 0, unreadable: 0, readings: 0 };
  private readonly file: string;
  private readonly now: () => number;
  constructor(private readonly options: FlaskOptions) {
    this.file = path.join(options.directory, "flask-calibration.json");
    this.now = options.now ?? (() => performance.now());
  }
  get status(): FlaskStatus { return { ...this.state, running: this.running }; }
  private createHost(): Host { return this.options.createHost?.() ?? startWinHost({ scriptName: "win-combat-host.ps1", requestTimeoutMs: 5000 }); }
  private decode(pixels: unknown): number[] { return typeof pixels === "string" ? [...Buffer.from(pixels, "base64")] : Array.isArray(pixels) ? pixels as number[] : []; }

  loadCalibration(): FlaskCalibration | undefined {
    return existsSync(this.file) ? parseFlaskCalibration(JSON.parse(readFileSync(this.file, "utf8"))) : undefined;
  }
  /** One capture, no input. Refuses anything but a full, red globe: every later reading is measured against this. */
  async calibrate(): Promise<FlaskCalibration> {
    const host = this.createHost();
    try {
      const ping = await host.send({ op: "sample", regions: {} });
      if (!ping.ok) throw new Error(String(ping.error ?? "Game capture unavailable."));
      const view = { width: Number(ping.width), height: Number(ping.height) }, region = lifeGlobeColumn(view);
      const reply = await host.send({ op: "sample", regions: { health: region } });
      if (!reply.ok) throw new Error(String(reply.error ?? "Game capture unavailable."));
      const reference = this.decode((reply.samples as Record<string, unknown> | undefined)?.health), issue = flaskReferenceIssue(reference);
      if (issue) throw new Error(issue);
      const calibration: FlaskCalibration = { version: 1, view, region, reference, calibratedAt: new Date().toISOString() };
      mkdirSync(this.options.directory, { recursive: true });
      writeFileSync(this.file, JSON.stringify(calibration));
      return calibration;
    } finally { await host.close().catch(() => {}); }
  }

  start(): FlaskStatus {
    if (this.running) return this.status;
    const calibration = this.loadCalibration();
    if (!calibration) throw new Error("The life flask is not calibrated: run once with --flask-calibrate at full life.");
    const generation = ++this.generation, host = this.host = this.createHost(), planner = new FlaskPlanner(this.options.settings);
    let sample: { hwnd: string; at: number } | undefined;
    const sink = new CombatInputSink(host, () => sample && this.running && generation === this.generation && !this.options.killSwitch.isLatched() && this.now() - sample.at <= SAMPLE_MAX_AGE_MS ? sample.hwnd : undefined);
    const controller = new GameInputController(sink, this.options.killSwitch, this.options.mode);
    const policy = scenario({ id: "follower-life-flask", name: "Follower life flask", enabledModules: ["combat"], dryRun: this.options.dryRun, actionsPerMinute: 60, confidenceThreshold: 0.94, timingProfile: "tight" });
    this.running = true;
    this.state = { running: true, reason: "Watching the life globe.", presses: 0, previewed: 0, refused: 0, unreadable: 0, readings: 0 };
    const tick = async () => {
      if (!this.running || generation !== this.generation) return;
      let delay = this.options.pollMs ?? 150;
      try {
        const at = this.now(), reply = await host.send({ op: "sample", regions: { health: calibration.region } });
        if (!this.running || generation !== this.generation) return;
        sample = undefined;
        if (!reply.ok) { this.state.life = undefined; this.state.reason = String(reply.error ?? "Game capture unavailable."); delay = 300; }
        else if (Number(reply.width) !== calibration.view.width || Number(reply.height) !== calibration.view.height) { this.state.life = undefined; this.state.reason = "The game view changed size: recalibrate the life flask."; delay = 1000; }
        else {
          const process = String(reply.process ?? ""), life = readLife(this.decode((reply.samples as Record<string, unknown> | undefined)?.health), calibration);
          this.state.readings++; this.state.life = life;
          if (life === undefined) this.state.unreadable++;
          sample = { hwnd: String(reply.hwnd ?? ""), at };
          const decision = planner.decide(life, this.now()), blocked = this.options.blocked?.();
          if (!decision) this.state.reason = life === undefined ? "The life globe cannot be read right now." : `Life ${life}%.`;
          else if (blocked) this.state.reason = `Life ${life}% — not drinking: ${blocked}`;
          else {
            const allowed = COMBAT_PROCESSES.some(name => name.toLowerCase() === process.toLowerCase());
            const traces = await controller.execute(decision, policy, process, JSON.stringify({ life, below: this.options.settings.below, hwnd: sample.hwnd }), allowed);
            this.options.audit?.(traces); controller.actionTraces.splice(0);
            const trace = traces[0];
            if (trace?.result === "emitted") { planner.committed(this.now()); this.state.presses++; this.state.reason = decision.reason; }
            else if (trace?.reason.includes("safety=dry-run")) { planner.committed(this.now()); this.state.previewed++; this.state.reason = `Preview only: would drink at ${life}%.`; }
            else { this.state.refused++; this.state.reason = `Life ${life}% — the flask press was refused: ${trace?.reason.split("; ").pop() ?? "unknown"}`; }
          }
        }
      } catch (error) { this.state.reason = error instanceof Error ? error.message : "Flask worker failed."; delay = 500; }
      if (this.running && generation === this.generation) this.timer = setTimeout(() => void tick(), delay);
    };
    void tick();
    return this.status;
  }
  stop(reason = "Stopped"): FlaskStatus {
    this.generation++; this.running = false; clearTimeout(this.timer); this.state.reason = reason;
    const host = this.host; this.host = undefined;
    if (host) void host.close().catch(() => {});
    return this.status;
  }
}
