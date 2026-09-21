// Runs the follow loop from a terminal, so the game keeps focus (the Electron window would take it).
// Dry-run unless --live is given. Ctrl+Shift+Esc is the emergency stop; moving the mouse or holding
// a mouse button takes manual control briefly. Ctrl+Shift+H hands the PC over, Ctrl+Shift+M gives it back.
// Always ends after --seconds.
//   npm run follower:live -- --target <LeaderName> [--seconds 20] [--calibrate] [--live] [--loot] [--leash 7] [--sprint] [--wait 0] [--distance 2] [--confidence 0.85] [--scale 7] [--interval 110] [--dir <folder>] [--flask 1] [--flask-below 55] [--flask-calibrate]
import os from "node:os";
import { PerformanceObserver } from "node:perf_hooks";
import path from "node:path";
import { startWinHost } from "../src/adapters/winHost.js";
import { startEmergencyStopMonitor } from "../src/adapters/emergencyStopMonitor.js";
import { startManualControlMonitor } from "../src/adapters/manualControlMonitor.js";
import { KillSwitch } from "../src/core/killSwitch.js";
import { driveAudit, FollowerDriveService, MIN_CLICK_INTERVAL_MS } from "../src/main/followerDriveService.js";
import { FollowerFlaskService } from "../src/main/followerFlaskService.js";
import { parseFlaskSettings } from "../src/core/followerFlask.js";

const args = process.argv.slice(2), option = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const number = (name: string, fallback: number, min: number, max: number) => { const n = Number(option(name) ?? fallback); if (!Number.isFinite(n) || n < min || n > max) { console.error(`${name} must be between ${min} and ${max}.`); process.exit(2); } return n; };
const targetName = option("--target");
if (!targetName) { console.error("Usage: npm run follower:live -- --target <LeaderName> [--seconds 20] [--calibrate] [--live]"); process.exit(2); }
// Up to 4 hours: long enough for a levelling session without restarting. This is a backstop against an
// unattended run, not an input guard - the kill switch, the takeover hotkey, the cursor guard and every
// per-click check are unchanged and stop a run at any point inside it.
const seconds = number("--seconds", 20, 3, 14_400), live = args.includes("--live");
const directory = option("--dir") ?? path.join(os.homedir(), "AppData", "Roaming", "poe2-trade-companion", "follower-cli");
const killSwitch = new KillSwitch();
const service = new FollowerDriveService({
  directory, killSwitch, mode: "authorized-qa", audit: driveAudit(directory),
  follow: () => ({ targetName, followDistance: number("--distance", 2, 1, 10), confidence: number("--confidence", .85, .5, 1), lootEnabled: args.includes("--loot"), lootLeash: number("--leash", 7, 2, 25) }),
});
// --flask <key> drinks the life flask below --flask-below percent. Its own worker and loop: the follower's tick never
// waits on it. It keeps drinking through the brief pause a touched mouse causes (the character still needs to live),
// but never while Ctrl+Shift+H holds the PC for the human, and never with the kill switch latched.
const flaskKey = option("--flask");
let flaskSettings; try { flaskSettings = flaskKey === undefined ? undefined : parseFlaskSettings({ key: flaskKey, below: option("--flask-below") }); } catch (e) { console.error(String(e instanceof Error ? e.message : e)); process.exit(2); }
const flask = flaskSettings ? new FollowerFlaskService({
  directory, killSwitch, mode: "authorized-qa", settings: flaskSettings, dryRun: !live, audit: driveAudit(directory),
  blocked: () => service.manualControlHeld ? "you have manual control" : !service.isRunning ? "the follower is not running" : undefined,
}) : undefined;
const finish = (reason: string, code = 0) => {
  const final = service.status();
  if (flask) console.log(`Life flask: ${JSON.stringify(flask.status)}`);
  flask?.stop(reason);
  service.stop(reason); monitor?.close(); takeover?.close();
  console.log(`\n${reason}`);
  console.log(JSON.stringify({ stats: final.stats, lastDecision: final.decision, lastObservation: final.observation && { leader: final.observation.leader, offset: final.observation.offset, confidence: final.observation.confidence, evidence: final.observation.evidence } }, null, 1));
  console.log(`Action traces: ${directory}`);
  setTimeout(() => process.exit(code), 400);
};
let monitor: ReturnType<typeof startEmergencyStopMonitor> | undefined;
try { monitor = startEmergencyStopMonitor(() => { killSwitch.trip(); finish("EMERGENCY STOP (Ctrl+Shift+Esc)."); }, () => { if (live && service.isRunning) { killSwitch.trip(); finish("Emergency-stop monitor failed; stopping live input.", 1); } }); }
catch (e) { if (live) { console.error(`No emergency stop available, refusing live input: ${String(e)}`); process.exit(1); } }

// Ctrl+Shift+H hands this PC over, Ctrl+Shift+M or +F gives it back. Idempotent chords, not a toggle:
// the operator cannot see this status line, so a toggle makes every press a guess, and pressing to
// resume stops a follower that was already following. Unlike the emergency stop neither is fatal:
// the loop keeps watching while you play, so following picks up from a live marker instead of re-acquiring.
let takeover: ReturnType<typeof startManualControlMonitor> | undefined;
try {
  takeover = startManualControlMonitor(
    () => { service.setManualControl(true); console.log("\n>>> MANUAL CONTROL: the follower is yours. Ctrl+Shift+M gives it back.\n"); },
    () => { service.setManualControl(false); console.log("\n<<< Following resumes.\n"); },
    // Failing open would resume the follower under a hand that is still on the mouse, so a hold stands.
    () => { if (service.manualControlHeld) console.error("Manual-control hotkey stopped; control stays yours. Ctrl+Shift+Esc still stops everything."); },
  );
} catch (e) { console.error(`Manual-control hotkey unavailable (Ctrl+Shift+Esc still stops): ${String(e)}`); }

// Nothing can be captured unless the game is in front, and the operator is usually in another window: wait rather than fail.
async function waitForGame(waitSeconds: number): Promise<void> {
  if (waitSeconds <= 0) return;
  const host = startWinHost({ scriptName: "win-follower-host.ps1", requestTimeoutMs: 10_000 }), deadline = Date.now() + waitSeconds * 1000;
  try {
    let said = false;
    for (;;) {
      const reply = await host.send({ op: "sample", x: 0, y: 0, width: 8, height: 8, full: false });
      if (reply.ok) { if (said) console.log("Game is in front; starting."); return; }
      if (Date.now() >= deadline) { console.error(`Gave up waiting for the game: ${String(reply.error)}`); process.exit(1); }
      if (!said) { console.log(`Waiting up to ${waitSeconds} s for Path of Exile 2 to come to the front (${String(reply.error)})…`); said = true; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } finally { await host.close().catch(() => {}); }
}

(async () => {
  await waitForGame(number("--wait", 0, 0, 3600));
  service.configure({ version: 1, dryRun: !live, mapScale: number("--scale", 7, 2, 20), clickIntervalMs: number("--interval", 110, MIN_CLICK_INTERVAL_MS, 1000), sprint: args.includes("--sprint") });
  if (args.includes("--calibrate") || !service.status().calibration || service.status().calibrationIssue) {
    // --label x,y,width,height selects one label when several party members are on the map.
    const box = option("--label")?.split(",").map(Number);
    if (box && (box.length !== 4 || box.some(n => !Number.isInteger(n) || n < 0))) { console.error("--label needs x,y,width,height in game-client pixels."); process.exit(2); }
    const calibrated = await service.calibrate(box ? { label: { x: box[0], y: box[1], width: box[2], height: box[3] } } : undefined);
    console.log(calibrated.calibration?.labelMask.map(row => row.replace(/\./g, " ")).join("\n"));
    console.log(`Calibrated: ${JSON.stringify(calibrated.calibration)}`);
  }
  if (live) { for (let i = 0; i < 20 && !monitor?.ready; i++) await new Promise(resolve => setTimeout(resolve, 100)); if (!monitor?.ready) { console.error("Emergency stop did not become ready; refusing live input."); process.exit(1); } }
  console.log(`${live ? "LIVE INPUT" : "Dry-run (no input)"}: following ${targetName} for ${seconds} s. Ctrl+Shift+Esc stops; Ctrl+Shift+M resumes following, Ctrl+Shift+H holds it for you; moving the mouse takes over briefly.`);
  // A flask that cannot be calibrated (life not full, globe covered) must not cost the run: following goes on without it.
  let flaskReady = false;
  if (flask) {
    try {
      if (args.includes("--flask-calibrate") || !flask.loadCalibration()) { const c = await flask.calibrate(); console.log(`Life flask calibrated at full life: column ${JSON.stringify(c.region)}.`); }
      flaskReady = true;
      console.log(`Life flask: key ${flaskSettings!.key} below ${flaskSettings!.below}%${live ? "" : " (preview only)"}.`);
    } catch (e) { console.error(`LIFE FLASK OFF for this run: ${e instanceof Error ? e.message : String(e)}`); }
  }
  await service.start();
  if (flaskReady) flask?.start();
  const began = Date.now();
  // Two live runs stalled for tens of seconds with no status line and no action trace, so the whole process
  // was held up rather than the loop merely running slow. A 100 ms heartbeat measures how late it is actually
  // called: that is the event loop being blocked or starved, and it is the number to look at when it happens
  // again. Reported as the worst lag since the previous status line.
  // A stall is either this process being blocked or the machine descheduling it; a long garbage collection is
  // the first thing to rule out, and it is the one the loop could plausibly cause by itself (every terrain plan
  // allocates two typed arrays over ~121,000 cells, four times a second, and decodes tens of thousands of points).
  let worstGc = 0, gcMs = 0;
  try {
    const gc = new PerformanceObserver(list => { for (const entry of list.getEntries()) { gcMs += entry.duration; if (entry.duration > worstGc) worstGc = entry.duration; if (entry.duration > 1000) console.log(`!! garbage collection took ${(entry.duration / 1000).toFixed(1)} s`); } });
    gc.observe({ entryTypes: ["gc"] });
  } catch { /* Measurement only: a runtime without GC entries still follows. */ }
  let lastBeat = Date.now(), worstLag = 0, stalls = 0;
  const beat = setInterval(() => {
    const now = Date.now(), lag = now - lastBeat - 100;
    lastBeat = now;
    if (lag > worstLag) worstLag = lag;
    if (lag > 1000) { stalls++; console.log(`!! event loop blocked for ${(lag / 1000).toFixed(1)} s at ${((now - began) / 1000).toFixed(1)} s`); }
  }, 100);
  beat.unref?.();
  const report = setInterval(() => {
    const s = service.status();
    if (!s.running) { clearInterval(report); clearInterval(beat); finish(`Stopped: ${s.reason}`, 1); return; }
    console.log(`${((Date.now() - began) / 1000).toFixed(1).padStart(5)} s  ${(s.decision?.kind ?? "-").padEnd(5)} d=${String(s.observation?.offset?.distance ?? "-").padStart(5)} conf=${s.observation?.confidence ?? "-"} odo=${s.odometry ? `${s.odometry.tracked ? "ok" : "no"}:${s.odometry.quality}:${s.odometry.via}:${s.odometry.trailPoints}` : "-"} moved=${s.odometry?.movedPxPerSec ?? "-"}px/s/${s.odometry?.movedTracked ?? "-"}trk life=${flask ? `${flask.status.life ?? "?"}%/${flask.status.presses}` : "-"} sprint=${s.sprinting ? "ON" : "off"}/${s.stats?.sprints ?? 0} plan=${s.terrain ? `${s.terrain.planned ? s.terrain.pathPx : "none"}/${s.terrain.walls}w/${s.terrain.bumps}b${s.terrain.blockedAhead ? "!" : ""}` : "-"} origin=${s.observation?.originVerified ? "ok" : "NO"}(${s.observation?.evidence.originScore ?? "-"}) ${s.observation?.evidence.searched ?? ""} obs/s=${s.stats?.observationsPerSecond ?? "-"} cycle p50/p95=${s.stats?.cycleMsP50 ?? "-"}/${s.stats?.cycleMsP95 ?? "-"} clicks=${s.stats?.clicks ?? 0} previewed=${s.stats?.previewed ?? 0} loot=${s.stats?.lootClicks ?? 0}/${s.stats?.lootLabels ?? 0}labels/${s.stats?.lootScans ?? 0}scans refused=${s.stats?.refused ?? 0} manual=${s.stats?.manualTakeovers ?? 0} input p50/p95=${s.stats?.captureToInputMsP50 ?? "-"}/${s.stats?.captureToInputMsP95 ?? "-"} lag=${worstLag}ms/${stalls}stalls gc=${Math.round(worstGc)}ms/${Math.round(gcMs)}total mem=${(() => { const m = process.memoryUsage(); const mb = (n: number) => Math.round(n / 1048576); return `rss${mb(m.rss)}/heap${mb(m.heapUsed)}/ext${mb(m.external)}/ab${mb(m.arrayBuffers)}`; })()}MB  ${s.reason}`);
    worstLag = 0; worstGc = 0;
    if (Date.now() - began >= seconds * 1000) { clearInterval(report); clearInterval(beat); finish("Time limit reached."); }
  }, 500);
})().catch(e => { console.error(String(e)); service.stop("Failed."); monitor?.close(); process.exit(1); });
