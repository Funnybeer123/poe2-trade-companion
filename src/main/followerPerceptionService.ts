import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startWinHost } from "../adapters/winHost.js";
import {
  buildNameplateTemplate, calibrationIssue, LeaderTracker, parseFollowerCalibration, templatePixelCount,
  type FollowerCalibration, type PixelRect, type WhiteFrame,
} from "../core/followerPerception.js";
import type { RecordingManifest } from "../core/followerFixture.js";
import type { FollowerCapture, FollowerPerceptionStatus } from "../shared/follower.js";

type Host = Pick<ReturnType<typeof startWinHost>, "send" | "close">;
interface PerceptionOptions {
  directory: string;
  targetName: () => string;
  blocked?: () => string | undefined;
  createHost?: () => Host;
  now?: () => number;
  pollMs?: number;
}
const FOCUS = /Focus Path of Exile 2/;

/** Capture, calibration and observation preview. There is no input sink or controller here. */
export class FollowerPerceptionService {
  private calibration?: FollowerCalibration;
  private calibrationError?: string;
  private captured?: WhiteFrame;
  private observing = false;
  private reason = "Capture the game view to calibrate.";
  private host?: Host;
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private observation?: FollowerPerceptionStatus["observation"];
  private cycles: number[] = [];
  private recording?: { directory: string; frames: number; endsAt: number };
  private lastRecording?: { directory: string; frames: number };
  private readonly file: string;
  private readonly now: () => number;
  constructor(private readonly options: PerceptionOptions) {
    this.file = path.join(options.directory, "calibration.json");
    this.now = options.now ?? (() => performance.now());
    try { if (existsSync(this.file)) { this.calibration = parseFollowerCalibration(JSON.parse(readFileSync(this.file, "utf8"))); this.reason = "Calibration loaded. Start the observation preview."; } }
    catch { this.calibrationError = "Saved follower calibration is invalid. Calibrate again."; }
  }
  status(): FollowerPerceptionStatus {
    const c = this.calibration, o = this.observation, mean = this.cycles.length ? this.cycles.reduce((a, b) => a + b, 0) / this.cycles.length : undefined;
    return structuredClone({
      observing: this.observing, reason: this.reason, inputCapability: "none" as const,
      recording: this.recording && { directory: this.recording.directory, frames: this.recording.frames, remainingMs: Math.max(0, Math.round(this.recording.endsAt - this.now())) },
      lastRecording: this.lastRecording,
      calibration: c && { targetName: c.targetName, view: c.view, searchArea: c.searchArea, nameplate: c.nameplate, calibratedAt: c.calibratedAt, templatePixels: templatePixelCount(c.template) },
      calibrationIssue: this.calibrationError ?? (c ? calibrationIssue(c, this.options.targetName()) : undefined),
      observation: o && { ...o, ageMs: Math.max(0, Math.round(this.now() - o.capturedAt)) },
      stats: mean === undefined ? undefined : { cycleMs: Math.round(mean * 10) / 10, observationsPerSecond: Math.round(10000 / Math.max(mean, this.options.pollMs ?? 33)) / 10 },
    });
  }
  stop(reason = "Observation stopped."): FollowerPerceptionStatus {
    this.generation++; this.observing = false; this.reason = reason; this.observation = undefined; this.cycles = []; this.recording = undefined;
    clearTimeout(this.timer); this.timer = undefined;
    const host = this.host; this.host = undefined;
    if (host) void host.close().catch(() => {});
    return this.status();
  }
  private createHost(): Host { return this.options.createHost?.() ?? startWinHost({ scriptName: "win-follower-host.ps1", requestTimeoutMs: 5000 }); }
  private frame(reply: Record<string, unknown>, width: number, height: number): WhiteFrame {
    const pixels = typeof reply.pixels === "string" ? new Uint8Array(Buffer.from(reply.pixels, "base64")) : new Uint8Array();
    if (pixels.length !== width * height) throw new Error("Capture worker returned an incomplete frame.");
    return { width, height, pixels };
  }
  /** One full-view screenshot for calibration. Waits up to 15 s for the game to be focused. */
  async capture(): Promise<FollowerCapture> {
    const blocked = this.options.blocked?.();
    if (blocked) throw new Error(blocked);
    this.stop("Paused for calibration.");
    const generation = this.generation, host = this.host = this.createHost(), deadline = this.now() + 15_000;
    try {
      while (true) {
        const reply = await host.send({ op: "preview" });
        if (generation !== this.generation) throw new Error("Calibration cancelled.");
        if (reply.ok && typeof reply.image === "string") {
          const width = Number(reply.width), height = Number(reply.height);
          this.captured = this.frame(reply, width, height);
          this.reason = "Select the leader's nameplate on the screenshot.";
          return { image: reply.image, width, height, capturedAt: new Date().toISOString() };
        }
        if (reply.ok || !FOCUS.test(String(reply.error))) throw new Error(String(reply.error ?? "Capture failed."));
        if (this.now() >= deadline) throw new Error("Capture timed out waiting for game focus.");
        this.reason = "Waiting for game focus — switch to Path of Exile 2.";
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    } catch (e) {
      if (generation === this.generation) this.reason = e instanceof Error ? e.message : "Capture failed.";
      throw e;
    } finally {
      if (this.host === host) { this.host = undefined; await host.close().catch(() => {}); }
    }
  }
  /** Builds the template from the main process's own captured pixels; the renderer supplies only rectangles. */
  calibrate(raw: unknown): FollowerPerceptionStatus {
    const input = raw as { nameplate?: PixelRect; searchArea?: PixelRect } | null, frame = this.captured, targetName = this.options.targetName();
    if (!targetName) throw new Error("Enter and save the character to follow before calibrating.");
    if (!frame) throw new Error("Capture the game view before calibrating.");
    if (!input?.nameplate) throw new Error("Select the leader's nameplate on the screenshot.");
    this.stop("Calibrating.");
    const { template, nameplate } = buildNameplateTemplate(frame, input.nameplate);
    const calibration = parseFollowerCalibration({ version: 1, targetName, view: { width: frame.width, height: frame.height }, searchArea: input.searchArea ?? { x: 0, y: 0, width: frame.width, height: frame.height }, nameplate, template, calibratedAt: new Date().toISOString() });
    mkdirSync(this.options.directory, { recursive: true });
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify(calibration)); renameSync(temporary, this.file);
    this.calibration = calibration; this.calibrationError = undefined; this.captured = undefined;
    this.reason = "Calibration saved. Start the observation preview.";
    return this.status();
  }
  /**
   * Records full-view PNG frames for labelled replay fixtures. Returns once recording has begun;
   * poll status for progress. Frames stay on this PC and contain whatever the game showed.
   */
  async record(raw: unknown): Promise<FollowerPerceptionStatus> {
    const seconds = (raw as { seconds?: unknown } | null)?.seconds;
    if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds < 5 || seconds > 30) throw new Error("Choose a recording length between 5 and 30 seconds.");
    const blocked = this.options.blocked?.();
    if (blocked) throw new Error(blocked);
    this.stop("Starting recording…");
    const generation = this.generation, host = this.host = this.createHost(), recordedAt = new Date();
    const directory = path.join(this.options.directory, "recordings", recordedAt.toISOString().replace(/[:.]/g, "-"));
    mkdirSync(directory, { recursive: true });
    const started = this.now(), recording = this.recording = { directory, frames: 0, endsAt: started + seconds * 1000 };
    const manifest: RecordingManifest = { version: 1, recordedAt: recordedAt.toISOString(), view: { width: 0, height: 0 }, frames: [] };
    const finish = (reason: string) => {
      if (manifest.frames.length) writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest, null, 2)); else rmSync(directory, { recursive: true, force: true });
      if (this.recording === recording) this.recording = undefined;
      if (manifest.frames.length) this.lastRecording = { directory, frames: manifest.frames.length };
      if (generation === this.generation) this.stop(manifest.frames.length ? `${reason} Saved ${manifest.frames.length} frames.` : `${reason} No frames were captured.`);
    };
    const loop = async () => {
      let reason = "Recording finished.";
      try {
        while (generation === this.generation && this.now() < recording.endsAt && !this.options.blocked?.()) {
          const at = this.now(), file = `frame-${String(manifest.frames.length + 1).padStart(4, "0")}.png`;
          const reply = await host.send({ op: "record", file: path.join(directory, file) });
          if (reply.ok) {
            const view = { width: Number(reply.width), height: Number(reply.height) };
            if (!manifest.frames.length) manifest.view = view;
            // One recording is one view: a resized game ends it rather than mixing frame sizes.
            else if (view.width !== manifest.view.width || view.height !== manifest.view.height) { rmSync(path.join(directory, file), { force: true }); reason = "Game view changed; recording ended early."; break; }
            manifest.frames.push({ file, offsetMs: Math.round(at - started) }); recording.frames = manifest.frames.length;
            if (generation === this.generation) this.reason = `Recording… ${manifest.frames.length} frames. No game input is sent.`;
          } else if (generation === this.generation) this.reason = String(reply.error ?? "Game capture unavailable.");
          await new Promise(resolve => setTimeout(resolve, Math.max(1, 250 - (this.now() - at))));
        }
        if (generation !== this.generation) reason = "Recording stopped.";
      } catch (e) { reason = e instanceof Error ? e.message : "Recording failed."; }
      finish(reason);
    };
    this.reason = "Recording… switch to Path of Exile 2. No game input is sent.";
    void loop();
    return this.status();
  }
  clearCalibration(): FollowerPerceptionStatus {
    this.stop("Calibration cleared. Capture the game view to calibrate.");
    this.calibration = undefined; this.calibrationError = undefined; this.captured = undefined;
    rmSync(this.file, { force: true });
    return this.status();
  }
  async start(): Promise<FollowerPerceptionStatus> {
    if (this.observing) return this.status();
    const blocked = this.options.blocked?.();
    if (blocked) throw new Error(blocked);
    const calibration = this.calibration;
    if (!calibration) throw new Error(this.calibrationError ?? "Calibrate the game view first.");
    const issue = calibrationIssue(calibration, this.options.targetName());
    if (issue) throw new Error(issue);
    this.stop();
    const generation = this.generation, host = this.host = this.createHost(), tracker = new LeaderTracker(calibration);
    this.observing = true; this.reason = "Starting capture worker…";
    const tick = async () => {
      if (!this.observing || generation !== this.generation) return;
      const started = this.now();
      let delay = this.options.pollMs ?? 33;
      try {
        const stop = this.options.blocked?.() ?? calibrationIssue(calibration, this.options.targetName());
        if (stop) { this.stop(stop); return; }
        const { region, searched } = tracker.nextRegion(started);
        const reply = await host.send({ op: "sample", ...region });
        if (!this.observing || generation !== this.generation) return;
        if (!reply.ok) {
          // An unfocused game is not an observation: show nothing rather than a stale sighting.
          this.observation = undefined; this.reason = String(reply.error ?? "Game capture unavailable."); delay = 250;
        } else {
          const changed = calibrationIssue(calibration, calibration.targetName, { width: Number(reply.width), height: Number(reply.height) });
          if (changed) { this.stop(changed); return; }
          const frame = this.frame(reply, region.width, region.height), received = this.now();
          const observation = tracker.observe(frame, region, searched, started, { captureMs: Number(reply.captureMs) || 0, matchMs: 0 });
          observation.timing.matchMs = Math.round((this.now() - received) * 10) / 10;
          this.observation = { ...observation, ageMs: 0 };
          this.reason = observation.found ? `Tracking ${calibration.targetName}'s nameplate. No game input is sent.` : `Looking for ${calibration.targetName}'s nameplate. No game input is sent.`;
          this.cycles.push(this.now() - started); if (this.cycles.length > 30) this.cycles.shift();
        }
      } catch (e) {
        if (generation === this.generation) this.stop(e instanceof Error ? e.message : "Capture worker failed.");
      } finally {
        // No overlapping captures or catch-up bursts.
        if (this.observing && generation === this.generation) this.timer = setTimeout(() => void tick(), Math.max(1, delay - (this.now() - started)));
      }
    };
    try {
      const ready = await host.send({ op: "ping" });
      if (!ready.ok) throw new Error(String(ready.error ?? "Capture worker failed to start."));
      if (this.observing && generation === this.generation) void tick();
    } catch (e) {
      if (generation === this.generation) this.stop(e instanceof Error ? e.message : "Capture worker failed.");
    }
    return this.status();
  }
}
