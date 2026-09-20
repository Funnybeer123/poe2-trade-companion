import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FollowerInputSink, LOOT_CLICK, SPRINT_HOLD, type FollowerFrameGuard } from "../adapters/followerInputSink.js";
import { pngPlanes } from "../adapters/pngWhiteness.js";
import { startWinHost } from "../adapters/winHost.js";
import {
  buildMapCalibration, decodeKeyPoints, FollowSteering, mapCalibrationIssue, MapMarkerTracker, parseMapCalibration,
  type MapCalibration, type SteeringDecision,
} from "../core/followerMapMarker.js";
import { decodeFlatRuns, decodeHueRuns, findLootLabels, LOOT_MIN_BRIGHTNESS, LOOT_MIN_CONFIDENCE, LOOT_MIN_RUN, lootArea, LootPlanner } from "../core/followerLoot.js";
import { TERRAIN_CHANNEL, TERRAIN_POINT_CAP, TERRAIN_THRESHOLD, TerrainPlanner, terrainWindow, type TerrainPlan } from "../core/followerTerrain.js";
import { LeaderTrail, MapOdometry, ODOMETRY_CHANNEL, ODOMETRY_THRESHOLD, odometryWindow } from "../core/followerTrail.js";
import { templatePixelCount, type PixelRect } from "../core/followerPerception.js";
import { GameInputController } from "../core/gameInputController.js";
import type { KillSwitch } from "../core/killSwitch.js";
import { scenario } from "../core/scenarios.js";
import type { QaActionTrace, RuntimeMode } from "../core/types.js";
import type { FollowerCapture, FollowerDriveSettings, FollowerDriveStatus } from "../shared/follower.js";

type Host = Pick<ReturnType<typeof startWinHost>, "send" | "close">;
interface DriveOptions {
  directory: string;
  killSwitch: KillSwitch;
  mode: RuntimeMode;
  /** Live follower preferences: who to follow, how close, and the minimum confidence. */
  follow: () => { targetName: string; followDistance: number; confidence: number; lootEnabled?: boolean; lootLeash?: number };
  blocked?: () => string | undefined;
  globalDryRun?: () => boolean;
  createCaptureHost?: () => Host;
  createInputHost?: () => Host;
  createMapHost?: () => Host;
  audit?: (traces: QaActionTrace[]) => void;
  now?: () => number;
  pollMs?: number;
}
const GAME_PROCESSES = ["pathofexile", "pathofexile_x64", "pathofexilesteam", "pathofexile_x64steam", "pathofexileegs", "pathofexile_x64egs"];
const FRAME_MAX_AGE_MS = 120, MANUAL_PAUSE_MS = 1500, ACTIONS_PER_MINUTE = 600, MAP_PX_PER_FOLLOW_UNIT = 6, LOOT_SCAN_MS = 250, PLAN_MS = 250, PLAN_KEEP_MS = 900, PLAN_NOT_WITHIN_PX = 35;
/** Sprint (hold space) only while well behind the leader, with hysteresis so it does not flutter. */
const SPRINT_START_PX = 70, SPRINT_STOP_PX = 40;
// A loot click lands this long after the scan that found the label; a label seen sliding across two scans is led by that much.
const LOOT_LEAD_MS = 70, LOOT_SAME_LABEL_PX = 120, LOOT_STEADY_PX = 4;
const RELEASE_ATTEMPTS = 240, RELEASE_RETRY_MS = 250;
/** How far behind the leader looting still happens, in leashes: beyond that, catching up is all that matters. */
const LOOT_CHASE_LEASHES = 2;
/** The fastest pacing the action cap can sustain: a shorter interval would always end in a rate-limit stop. */
export const MIN_CLICK_INTERVAL_MS = Math.ceil(60_000 / ACTIONS_PER_MINUTE);
const FOCUS = /Focus Path of Exile 2/, COVERED = /covered at the click point/;
const MANUAL = /Manual mouse movement|Mouse button held|Modifier key held|Space held/, RETRY = /Stale capture|capture stale|Focus Path of Exile|focus or view changed/i;

export function defaultDriveSettings(): FollowerDriveSettings { return { version: 1, dryRun: true, mapScale: 7, clickIntervalMs: 110 }; }
export function parseDriveSettings(raw: unknown): FollowerDriveSettings {
  const s = raw as FollowerDriveSettings | null;
  if (!s || s.version !== 1 || typeof s.dryRun !== "boolean" || !Number.isFinite(s.mapScale) || s.mapScale < 2 || s.mapScale > 20 || !Number.isInteger(s.clickIntervalMs) || s.clickIntervalMs < MIN_CLICK_INTERVAL_MS || s.clickIntervalMs > 1000) throw new Error(`Invalid follow settings: map scale 2–20 and click interval ${MIN_CLICK_INTERVAL_MS}–1000 ms.`);
  if (s.sprint !== undefined && typeof s.sprint !== "boolean") throw new Error("Invalid follow settings: sprint must be on or off.");
  return { version: 1, dryRun: s.dryRun, mapScale: s.mapScale, clickIntervalMs: s.clickIntervalMs, ...(s.sprint ? { sprint: true } : {}) };
}
function percentile(values: number[], p: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] * 10) / 10;
}

/**
 * Follows the leader's overlay-map marker. Perception decides; every click goes through
 * GameInputController (kill switch, process allowlist, confidence gate, rate limit, dry-run, trace)
 * and is re-checked natively against the capture it was decided from.
 */
export class FollowerDriveService {
  private settings = defaultDriveSettings();
  private calibration?: MapCalibration;
  private calibrationError?: string;
  private running = false;
  private reason = "Calibrate on the overlay map, then start following.";
  private captureHost?: Host;
  private inputHost?: Host;
  private mapHost?: Host;
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private observation?: FollowerDriveStatus["observation"];
  private decision?: SteeringDecision;
  private frame?: FollowerFrameGuard & { at: number };
  private odometry?: FollowerDriveStatus["odometry"];
  private terrain?: FollowerDriveStatus["terrain"];
  private cycles: number[] = [];
  private latencies: number[] = [];
  /** Capture-to-click times of the first click after standing near the leader: the reaction to them moving off. */
  private resumes: number[] = [];
  private counts = { cycles: 0, clicks: 0, previewed: 0, refused: 0, manualTakeovers: 0, lootScans: 0, lootLabels: 0, lootClicks: 0, sprints: 0 };
  private sprinting = false;
  private startedAt = 0;
  private readonly calibrationFile: string;
  private readonly settingsFile: string;
  private readonly now: () => number;
  constructor(private readonly options: DriveOptions) {
    this.calibrationFile = path.join(options.directory, "map-calibration.json");
    this.settingsFile = path.join(options.directory, "drive.json");
    this.now = options.now ?? (() => performance.now());
    try { if (existsSync(this.settingsFile)) this.settings = parseDriveSettings(JSON.parse(readFileSync(this.settingsFile, "utf8"))); } catch { this.reason = "Saved follow settings were invalid and have been reset."; }
    try { if (existsSync(this.calibrationFile)) this.calibration = parseMapCalibration(JSON.parse(readFileSync(this.calibrationFile, "utf8"))); }
    catch { this.calibrationError = "Saved map calibration is invalid. Calibrate again."; }
  }
  get isRunning(): boolean { return this.running; }
  private dryRun(): boolean { return this.settings.dryRun || this.options.globalDryRun?.() === true; }
  status(): FollowerDriveStatus {
    const c = this.calibration, o = this.observation, elapsed = this.running ? (this.now() - this.startedAt) / 1000 : 0;
    const cycleP95 = percentile(this.cycles, .95), inputP95 = percentile(this.latencies, .95);
    return structuredClone({
      running: this.running, reason: this.reason, settings: this.settings, dryRun: this.dryRun(),
      calibration: c && { targetName: c.targetName, view: c.view, origin: new MapMarkerTracker(c).origin, markerOffset: c.markerOffset, labelPixels: templatePixelCount(c.label), labelMask: c.label.mask, calibratedAt: c.calibratedAt },
      calibrationIssue: this.calibrationError ?? (c ? mapCalibrationIssue(c, this.options.follow().targetName) : undefined),
      observation: o && { ...o, ageMs: Math.max(0, Math.round(this.now() - o.capturedAt)) },
      decision: this.decision, odometry: this.running ? this.odometry : undefined, terrain: this.running ? this.terrain : undefined, sprinting: this.running && this.sprinting,
      stats: this.counts.cycles ? {
        ...this.counts, observationsPerSecond: elapsed > 0 ? Math.round(this.counts.cycles / elapsed * 10) / 10 : 0,
        cycleMsP50: percentile(this.cycles, .5), cycleMsP95: cycleP95, captureToInputMsP50: percentile(this.latencies, .5), captureToInputMsP95: inputP95,
        resumes: this.resumes.length, resumeCaptureToInputMsP50: percentile(this.resumes, .5), resumeCaptureToInputMsP95: percentile(this.resumes, .95),
        // A change can land just after a capture starts, so the worst case adds one whole cycle.
        worstCaseReactionMsP95: cycleP95 !== undefined && inputP95 !== undefined ? Math.round((cycleP95 + inputP95) * 10) / 10 : undefined,
      } : undefined,
    });
  }
  configure(raw: unknown): FollowerDriveStatus {
    const settings = parseDriveSettings(raw);
    this.stop("Follow settings changed — press Start to resume.");
    mkdirSync(this.options.directory, { recursive: true });
    const temporary = `${this.settingsFile}.tmp`;
    writeFileSync(temporary, JSON.stringify(settings, null, 2)); renameSync(temporary, this.settingsFile);
    this.settings = settings;
    return this.status();
  }
  stop(reason = "Following stopped."): FollowerDriveStatus {
    this.generation++; this.running = false; this.sprinting = false; this.reason = reason; this.observation = undefined; this.decision = undefined; this.frame = undefined;
    clearTimeout(this.timer); this.timer = undefined;
    const capture = this.captureHost, input = this.inputHost; this.captureHost = undefined; this.inputHost = undefined;
    if (capture) void capture.close().catch(() => {});
    const map = this.mapHost; this.mapHost = undefined;
    if (map) void map.close().catch(() => {});
    // Ask for an explicit button release before the worker goes away; its own finally block is the backstop.
    // While it reports a key still held (a secure desktop rejects input), its watchdog is the only thing that can let go: keep it alive and keep asking.
    if (input) void (async () => {
      for (let attempt = 0; attempt < RELEASE_ATTEMPTS; attempt++) {
        const reply = await input.send({ op: "release" }).catch(() => undefined);
        if (!reply || reply.ok) break;
        await new Promise(resolve => setTimeout(resolve, RELEASE_RETRY_MS));
      }
      await input.close().catch(() => {});
    })();
    return this.status();
  }
  private createCaptureHost(): Host { return this.options.createCaptureHost?.() ?? startWinHost({ scriptName: "win-follower-host.ps1", requestTimeoutMs: 5000 }); }
  /** A second capture-only worker for the large map scans. With injected hosts (tests) there is none unless one is injected too, and planning is simply off. */
  private createMapHost(): Host | undefined {
    if (this.options.createMapHost) return this.options.createMapHost();
    return this.options.createCaptureHost ? undefined : startWinHost({ scriptName: "win-follower-host.ps1", requestTimeoutMs: 5000 });
  }
  private createInputHost(): Host { return this.options.createInputHost?.() ?? startWinHost({ scriptName: "win-follower-input-host.ps1", requestTimeoutMs: 5000 }); }
  /**
   * One full-view capture with the overlay map open. The label is found automatically when exactly
   * one party member is on the map; otherwise pass the rectangle the operator drew around it.
   */
  async calibrate(raw?: unknown): Promise<FollowerDriveStatus & { capture: FollowerCapture }> {
    const blocked = this.options.blocked?.();
    if (blocked) throw new Error(blocked);
    const label = (raw as { label?: PixelRect } | null | undefined)?.label, targetName = this.options.follow().targetName;
    if (!targetName) throw new Error("Enter and save the character to follow before calibrating.");
    this.stop("Calibrating on the overlay map…");
    const generation = this.generation, host = this.captureHost = this.createCaptureHost(), deadline = this.now() + 15_000;
    try {
      // The button or terminal that asked for this has focus; give the operator time to switch to the game.
      let reply = await host.send({ op: "preview" });
      while (generation === this.generation && !reply.ok && FOCUS.test(String(reply.error)) && this.now() < deadline) {
        this.reason = "Waiting for game focus — switch to Path of Exile 2.";
        await new Promise(resolve => setTimeout(resolve, 250));
        reply = await host.send({ op: "preview" });
      }
      if (generation !== this.generation) throw new Error("Calibration cancelled.");
      if (!reply.ok || typeof reply.image !== "string") throw new Error(String(reply.error ?? "Capture failed."));
      const [green, orange] = pngPlanes(Buffer.from(reply.image.slice(reply.image.indexOf(",") + 1), "base64"), ["green", "orange"]);
      const calibration = buildMapCalibration(green, orange, targetName, new Date().toISOString(), label);
      mkdirSync(this.options.directory, { recursive: true });
      const temporary = `${this.calibrationFile}.tmp`;
      writeFileSync(temporary, JSON.stringify(calibration)); renameSync(temporary, this.calibrationFile);
      this.calibration = calibration; this.calibrationError = undefined;
      this.reason = `Calibrated on ${targetName}'s map label. Start following.`;
      return { ...this.status(), capture: { image: reply.image, width: green.width, height: green.height, capturedAt: calibration.calibratedAt } };
    } catch (e) {
      if (generation === this.generation) this.reason = e instanceof Error ? e.message : "Calibration failed.";
      throw e;
    } finally {
      if (this.captureHost === host) { this.captureHost = undefined; await host.close().catch(() => {}); }
    }
  }
  clearCalibration(): FollowerDriveStatus {
    this.stop("Map calibration cleared.");
    this.calibration = undefined; this.calibrationError = undefined;
    rmSync(this.calibrationFile, { force: true });
    return this.status();
  }
  private refusal(): string | undefined {
    if (this.options.killSwitch.isLatched()) return "Emergency stop latched — rearm in the app.";
    return this.options.blocked?.();
  }
  async start(): Promise<FollowerDriveStatus> {
    if (this.running) return this.status();
    const refused = this.refusal();
    if (refused) throw new Error(refused);
    const calibration = this.calibration;
    if (!calibration) throw new Error(this.calibrationError ?? "Calibrate on the overlay map first.");
    const follow = this.options.follow(), issue = mapCalibrationIssue(calibration, follow.targetName);
    if (issue) throw new Error(issue);
    this.stop();
    const generation = this.generation, capture = this.captureHost = this.createCaptureHost(), input = this.inputHost = this.createInputHost();
    const tracker = new MapMarkerTracker(calibration), stopPx = follow.followDistance * MAP_PX_PER_FOLLOW_UNIT;
    const steering = new FollowSteering({ stopPx, resumePx: stopPx + MAP_PX_PER_FOLLOW_UNIT, clickIntervalMs: this.settings.clickIntervalMs, mapScale: this.settings.mapScale, confidence: follow.confidence });
    const live = () => this.running && generation === this.generation;
    // A run that started as a preview can never send input, whatever happens to the dry-run switches later.
    const previewOnly = this.dryRun();
    const sink = new FollowerInputSink(input, () => {
      const frame = this.frame;
      return live() && !this.refusal() && frame && this.now() - frame.at <= FRAME_MAX_AGE_MS ? frame : undefined;
    }, FRAME_MAX_AGE_MS);
    const controller = new GameInputController(sink, this.options.killSwitch, this.options.mode);
    this.running = true; this.reason = "Starting capture and input workers…";
    this.cycles = []; this.latencies = []; this.resumes = []; this.counts = { cycles: 0, clicks: 0, previewed: 0, refused: 0, manualTakeovers: 0, lootScans: 0, lootLabels: 0, lootClicks: 0, sprints: 0 }; this.sprinting = false; this.startedAt = this.now();
    let manualUntil = -Infinity, pauseReason = "", wasNear = false, lastLootScanAt = -Infinity, lootSeen: { x: number; y: number; at: number } | undefined;
    const odometry = new MapOdometry(), trail = new LeaderTrail(), watch = { ...odometryWindow(tracker.origin, calibration.view), channel: ODOMETRY_CHANNEL, threshold: ODOMETRY_THRESHOLD };
    const terrain = new TerrainPlanner(), terrainArea = terrainWindow(tracker.origin, calibration.view);
    let plan: (TerrainPlan & { at: number }) | undefined, lastPlanAt = -Infinity, sprinting = false, planning = false;
    let planWanted: { origin: { x: number; y: number }; offset: { dx: number; dy: number; distance: number }; view: { width: number; height: number } } | undefined;
    const mapScanner = this.mapHost = this.createMapHost();
    const letGo = async () => { if (sprinting) { sprinting = false; this.sprinting = false; await sink.releaseSprint(); } };
    const loot = new LootPlanner(), leashPx = (follow.lootLeash ?? 0) * MAP_PX_PER_FOLLOW_UNIT;
    /** Runs one executed decision through the controller and says what became of it. */
    const execute = async (module: "navigation" | "loot", rule: string, reason: string, x: number, y: number, confidence: number, process: string, allowed: boolean, evidence: string, lootEnabled: boolean, threshold: number, sprint = false): Promise<"emitted" | "previewed" | "paused" | "retry" | "stopped"> => {
      const policy = scenario({ id: "follow-map-marker", name: "Follow by overlay map", enabledModules: lootEnabled ? ["navigation", "loot"] : ["navigation"], dryRun: previewOnly || this.dryRun(), actionsPerMinute: ACTIONS_PER_MINUTE, confidenceThreshold: threshold, timingProfile: "tight" });
      const traces = await controller.execute({ module, rule, reason, intended: [sprint ? { kind: "key", key: "space", text: SPRINT_HOLD } : { kind: "click", x, y, button: "left", ...(module === "loot" ? { text: LOOT_CLICK } : {}) }], confidence }, policy, process, evidence, allowed);
      this.options.audit?.(traces);
      // Long sessions must not retain every trace in memory.
      controller.actionTraces.splice(0);
      if (!live()) return "stopped";
      const trace = traces[0];
      if (trace?.result === "emitted") return "emitted";
      if (trace?.reason.includes("safety=dry-run")) { this.reason = `Preview only: would ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`; return "previewed"; }
      if (trace?.reason.includes("safety=rate-limited")) { this.stop(`Action limit reached (${ACTIONS_PER_MINUTE}/minute).`); return "stopped"; }
      if (trace?.result === "failed" && COVERED.test(trace.reason)) { this.counts.refused++; manualUntil = this.now() + MANUAL_PAUSE_MS; this.reason = pauseReason = "Another window covers the game at the click point — pausing."; await letGo(); return "paused"; }
      if (trace?.result === "failed" && MANUAL.test(trace.reason)) { this.counts.manualTakeovers++; manualUntil = this.now() + MANUAL_PAUSE_MS; this.reason = pauseReason = "Manual control detected — following resumes shortly."; await letGo(); return "paused"; }
      if (trace?.result === "failed" && RETRY.test(trace.reason)) { this.counts.refused++; this.reason = "A click was refused as stale or unfocused; retrying on a fresh capture."; await letGo(); return "retry"; }
      this.stop(trace ? `Movement input stopped: ${trace.reason}` : "Movement input produced no trace."); return "stopped";
    };
    const tick = async () => {
      if (!live()) return;
      const started = this.now();
      let delay = this.options.pollMs ?? 8;
      try {
        const current = this.options.follow(), stop = this.refusal() ?? mapCalibrationIssue(calibration, current.targetName);
        if (stop) { this.stop(stop); return; }
        if (this.dryRun() !== previewOnly) { this.stop("Dry-run setting changed — press Start to resume."); return; }
        const request = tracker.nextRequest(started);
        const reply = await capture.send({ op: "key", ...request.region, full: request.full, channel: request.channel, threshold: request.threshold, second: request.second, third: watch });
        if (!live()) return;
        this.frame = undefined;
        if (!reply.ok) {
          // An unfocused or covered game is not an observation, and nothing is clicked.
          this.observation = undefined; this.decision = undefined; this.reason = String(reply.error ?? "Game capture unavailable."); delay = 100;
          await letGo();
        } else {
          const view = { width: Number(reply.width), height: Number(reply.height) }, changed = mapCalibrationIssue(calibration, calibration.targetName, view);
          if (changed) { this.stop(changed); return; }
          const received = this.now(), process = String(reply.process ?? ""), allowed = GAME_PROCESSES.includes(process.toLowerCase());
          const observation = tracker.observe(reply.overflow ? undefined : decodeKeyPoints(reply.points), reply.secondOverflow ? undefined : decodeKeyPoints(reply.secondPoints), request.searched, started, { captureMs: Number(reply.captureMs) || 0, matchMs: 0 });
          observation.timing.matchMs = Math.round((this.now() - received) * 10) / 10;
          this.observation = { ...observation, ageMs: 0 };
          this.frame = { hwnd: String(reply.hwnd ?? ""), viewWidth: view.width, viewHeight: view.height, capturedAtQpcMs: Number(reply.capturedAtQpcMs), at: started };
          const distance = observation.offset?.distance ?? Infinity;
          const manual = this.now() < manualUntil;
          // Our own movement from the slide of the map outlines, then the leader's path in that frame.
          const moved = odometry.update(reply.thirdOverflow || typeof reply.thirdPoints !== "string" ? undefined : decodeKeyPoints(reply.thirdPoints), started);
          const trusted = observation.leaderFound && !!observation.offset && observation.confidence >= current.confidence && observation.originVerified;
          if (trusted && moved.tracked) trail.record(odometry.position, observation.offset!, odometry.epoch);
          const trailAim = trusted ? trail.aim(odometry.position, observation.offset!, odometry.epoch) : undefined;
          // Read the landscape off the overlay map a few times a second and plan a way to the leader round what it shows.
          // Blind odometry is reported too: it is not evidence of standing still.
          terrain.noteMotion(moved, started);
          // The map scan is large, so it runs on its own capture worker and never holds up marker tracking.
          planWanted = trusted && !manual && observation.offset!.distance > stopPx ? { origin: observation.origin, offset: observation.offset!, view } : undefined;
          if (planWanted && !planning && mapScanner && started - lastPlanAt >= PLAN_MS) {
            lastPlanAt = started; planning = true;
            void mapScanner.send({ op: "terrain", ...terrainArea, full: false, channel: TERRAIN_CHANNEL, threshold: TERRAIN_THRESHOLD, cap: TERRAIN_POINT_CAP }).then(scanned => {
              const wanted = planWanted;
              if (!live() || !wanted) { plan = undefined; return; }
              // Plan from where things are now, not where they were when the scan was asked for.
              if (scanned.ok && !scanned.overflow && Number(scanned.width) === wanted.view.width && Number(scanned.height) === wanted.view.height) plan = { ...terrain.plan(decodeKeyPoints(scanned.points), terrainArea, wanted.origin, wanted.offset, odometry.position, odometry.epoch, this.now()), at: this.now() };
              else plan = undefined;
            }).catch(() => { plan = undefined; }).finally(() => { planning = false; });
          }
          if (plan && (started - plan.at > PLAN_KEEP_MS || !planWanted)) plan = undefined;
          // A path the leader actually walked beats a route read off pixels, until following it has bumped into something. Close in, go straight.
          const trailKnows = trailAim?.via === "trail" && !plan?.bumps;
          const planned = trusted && plan?.aim && !trailKnows && observation.offset!.distance > PLAN_NOT_WITHIN_PX ? plan.aim : undefined;
          const aim = planned ? { ...planned, via: "plan" as const } : trailAim;
          this.odometry = { tracked: moved.tracked, quality: moved.quality, trailPoints: trail.length, via: aim?.via ?? "direct" };
          this.terrain = plan && { planned: !!plan.aim, pathPx: plan.pathPx, walls: plan.walls, bumps: plan.bumps, blockedAhead: plan.blockedAhead, planMs: plan.planMs };
          let decision: SteeringDecision = manual ? { kind: "pause", reason: pauseReason } : steering.decide(observation, this.now(), aim && aim.via !== "direct" ? aim : undefined, moved);
          if (decision.kind === "near") wasNear = true;
          this.counts.cycles++; this.cycles.push(this.now() - started); if (this.cycles.length > 600) this.cycles.shift();
          // Loot while following, not only once caught up: items drop where the leader fights, so waiting to
          // be inside the leash misses most of them. A trusted sighting and a verified map centre (so no panel
          // is open) are still required, nobody may be at the mouse, and rejoining a leader who is getting
          // away always comes first.
          const lootOn = current.lootEnabled === true && leashPx > 0;
          const canLoot = lootOn && !manual && observation.leaderFound && observation.confidence >= current.confidence && observation.originVerified && distance <= leashPx * LOOT_CHASE_LEASHES;
          if (canLoot && started - lastLootScanAt >= LOOT_SCAN_MS) {
            lastLootScanAt = started;
            const scanAt = this.now(), scan = await capture.send({ op: "runs", ...lootArea(view), minLength: LOOT_MIN_RUN, minBrightness: LOOT_MIN_BRIGHTNESS });
            if (!live()) return;
            if (scan.ok && !scan.overflow && Number(scan.width) === view.width && Number(scan.height) === view.height) {
              // The leash bounds the detour, so it is measured from the character: a label across the screen is
              // not worth leaving the leader for, however near to them it lies.
              const scale = this.settings.mapScale;
              const labels = findLootLabels(decodeFlatRuns(scan.runs), view, observation.origin, scan.hueOverflow || typeof scan.hueRuns !== "string" ? [] : decodeHueRuns(scan.hueRuns))
                .filter(label => label.confidence >= LOOT_MIN_CONFIDENCE && Math.hypot(label.centre.x - observation.origin.x, label.centre.y - observation.origin.y) / scale <= leashPx);
              const choice = loot.decide(labels, this.now());
              this.counts.lootScans++; this.counts.lootLabels = labels.length;
              // The camera scrolls while we run, so a label slides between the scan and the click. Seen twice, it is led by its own drift; seen once, it waits a scan.
              const centre = choice.label?.centre, before = lootSeen, area = lootArea(view);
              lootSeen = centre && { ...centre, at: scanAt };
              const drift = centre && before && scanAt - before.at <= 2 * LOOT_SCAN_MS + 100 && Math.hypot(centre.x - before.x, centre.y - before.y) <= LOOT_SAME_LABEL_PX ? { x: (centre.x - before.x) / (scanAt - before.at), y: (centre.y - before.y) / (scanAt - before.at) } : undefined;
              if (choice.kind === "loot" && choice.label && drift) {
                const steady = Math.hypot(drift.x, drift.y) * (scanAt - before!.at) <= LOOT_STEADY_PX;
                const x = steady ? centre!.x : Math.min(area.x + area.width - 1, Math.max(area.x, Math.round(centre!.x + drift.x * LOOT_LEAD_MS))), y = steady ? centre!.y : Math.min(area.y + area.height - 1, Math.max(area.y, Math.round(centre!.y + drift.y * LOOT_LEAD_MS)));
                // Never click a label with the sprint key down.
                await letGo();
                // The click is bound to the scan that found the label, not to the earlier marker capture.
                this.frame = { hwnd: String(scan.hwnd ?? ""), viewWidth: view.width, viewHeight: view.height, capturedAtQpcMs: Number(scan.capturedAtQpcMs), at: scanAt };
                const outcome = await execute("loot", "pick-up-nearest-label", choice.reason, x, y, choice.label.confidence, process, allowed,
                  JSON.stringify({ capturedAtQpcMs: this.frame.capturedAtQpcMs, hwnd: this.frame.hwnd, label: choice.label, click: { x, y }, labelsInView: labels.length, leaderDistance: distance }), true, LOOT_MIN_CONFIDENCE);
                if (outcome === "stopped") return;
                if (outcome === "emitted" || outcome === "previewed") { loot.committed(labels.length, this.now()); this.counts.lootClicks++; if (outcome === "emitted") this.counts.clicks++; else this.counts.previewed++; }
              }
              // Hold only for a label being acted on: a backoff or an empty scan must not interrupt following (or drop the sprint) four times a second.
              if (choice.label) decision = { kind: "hold", reason: choice.reason, distance };
            }
          }
          // While the character walks to an item, do not pull it back toward the leader.
          else if (canLoot && loot.busy(this.now()) && decision.kind === "move") decision = { kind: "hold", reason: "Walking to a loot pickup.", distance };
          this.decision = decision; this.reason = decision.reason;
          // Sprint while far behind and actually heading somewhere; let go for loot, manual control, arrival, or anything unsure.
          const heading = decision.kind === "move" || (decision.kind === "hold" && decision.reason === "Pacing movement clicks.");
          const wantSprint = this.settings.sprint === true && heading && !manual && trusted && distance >= (sprinting ? SPRINT_STOP_PX : SPRINT_START_PX) && !loot.busy(this.now());
          if (!wantSprint) await letGo();
          else if (sprinting) { try { await sink.renewSprint(); } catch { sprinting = false; this.sprinting = false; } }
          if (decision.kind === "move") {
            const evidence = JSON.stringify({ capturedAtQpcMs: this.frame!.capturedAtQpcMs, hwnd: this.frame!.hwnd, leader: observation.leader, origin: observation.origin, offset: observation.offset, evidence: observation.evidence });
            const outcome = await execute("navigation", "follow-map-marker", decision.reason, decision.x, decision.y, observation.confidence, process, allowed, evidence, lootOn, current.confidence);
            if (outcome === "stopped") return;
            // A previewed click moves nothing, so it says nothing about walls.
            if (outcome === "emitted") terrain.noteClick({ dx: decision.x - observation.origin.x, dy: decision.y - observation.origin.y }, odometry.position, odometry.epoch, this.now());
            // Start sprinting only on the back of an accepted movement click, so the cursor is already where we are heading.
            if (outcome === "emitted" && wantSprint && !sprinting) {
              const started = await execute("navigation", "sprint-to-catch-up", `Sprint: ${Math.round(distance)} map px behind.`, decision.x, decision.y, observation.confidence, process, allowed, evidence, lootOn, current.confidence, true);
              if (started === "stopped") return;
              if (started === "emitted") { sprinting = true; this.sprinting = true; this.counts.sprints++; }
            }
            if (outcome === "emitted") {
              steering.committed(this.now()); this.counts.clicks++;
              if (sink.lastInput) {
                this.latencies.push(sink.lastInput.captureToInputMs); if (this.latencies.length > 600) this.latencies.shift();
                if (wasNear) { this.resumes.push(sink.lastInput.captureToInputMs); if (this.resumes.length > 600) this.resumes.shift(); }
              }
              wasNear = false;
            } else if (outcome === "previewed") { steering.committed(this.now()); this.counts.previewed++; }
          }        }
      } catch (e) {
        if (generation === this.generation) this.stop(e instanceof Error ? e.message : "Follow worker failed.");
      } finally {
        // No overlapping captures, queued clicks, or catch-up bursts.
        if (live()) this.timer = setTimeout(() => void tick(), Math.max(1, delay - (this.now() - started)));
      }
    };
    try {
      const [captureReady, inputReady] = await Promise.all([capture.send({ op: "ping" }), input.send({ op: "ping" })]);
      if (!captureReady.ok || !inputReady.ok) throw new Error(String(captureReady.error ?? inputReady.error ?? "Follow workers failed to start."));
      if (live()) void tick();
    } catch (e) {
      if (generation === this.generation) this.stop(e instanceof Error ? e.message : "Follow workers failed to start.");
    }
    return this.status();
  }
}

export function driveAudit(root: string): (traces: QaActionTrace[]) => void {
  return traces => {
    if (!traces.length) return;
    mkdirSync(root, { recursive: true });
    appendFileSync(path.join(root, `follow-actions-${new Date().toISOString().slice(0, 10)}.jsonl`), traces.map(t => JSON.stringify(t)).join("\n") + "\n");
  };
}
