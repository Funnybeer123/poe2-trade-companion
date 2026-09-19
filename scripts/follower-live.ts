// Runs the follow loop from a terminal, so the game keeps focus (the Electron window would take it).
// Dry-run unless --live is given. Ctrl+Shift+Esc is the emergency stop; moving the mouse or holding
// a mouse button takes manual control. Always ends after --seconds.
//   npm run follower:live -- --target <LeaderName> [--seconds 20] [--calibrate] [--live] [--loot] [--leash 7] [--sprint] [--dark] [--distance 2] [--confidence 0.85] [--scale 7] [--interval 110] [--dir <folder>]
import os from "node:os";
import path from "node:path";
import { startEmergencyStopMonitor } from "../src/adapters/emergencyStopMonitor.js";
import { KillSwitch } from "../src/core/killSwitch.js";
import { driveAudit, FollowerDriveService, MIN_CLICK_INTERVAL_MS } from "../src/main/followerDriveService.js";

const args = process.argv.slice(2), option = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const number = (name: string, fallback: number, min: number, max: number) => { const n = Number(option(name) ?? fallback); if (!Number.isFinite(n) || n < min || n > max) { console.error(`${name} must be between ${min} and ${max}.`); process.exit(2); } return n; };
const targetName = option("--target");
if (!targetName) { console.error("Usage: npm run follower:live -- --target <LeaderName> [--seconds 20] [--calibrate] [--live]"); process.exit(2); }
const seconds = number("--seconds", 20, 3, 600), live = args.includes("--live");
const directory = option("--dir") ?? path.join(os.homedir(), "AppData", "Roaming", "poe2-trade-companion", "follower-cli");
const killSwitch = new KillSwitch();
const service = new FollowerDriveService({
  directory, killSwitch, mode: "authorized-qa", audit: driveAudit(directory),
  follow: () => ({ targetName, followDistance: number("--distance", 2, 1, 10), confidence: number("--confidence", .85, .5, 1), lootEnabled: args.includes("--loot"), lootLeash: number("--leash", 7, 2, 25) }),
});
const finish = (reason: string, code = 0) => {
  const final = service.status();
  service.stop(reason); monitor?.close();
  console.log(`\n${reason}`);
  console.log(JSON.stringify({ stats: final.stats, lastDecision: final.decision, lastObservation: final.observation && { leader: final.observation.leader, offset: final.observation.offset, confidence: final.observation.confidence, evidence: final.observation.evidence } }, null, 1));
  console.log(`Action traces: ${directory}`);
  setTimeout(() => process.exit(code), 400);
};
let monitor: ReturnType<typeof startEmergencyStopMonitor> | undefined;
try { monitor = startEmergencyStopMonitor(() => { killSwitch.trip(); finish("EMERGENCY STOP (Ctrl+Shift+Esc)."); }, () => { if (live && service.isRunning) { killSwitch.trip(); finish("Emergency-stop monitor failed; stopping live input.", 1); } }); }
catch (e) { if (live) { console.error(`No emergency stop available, refusing live input: ${String(e)}`); process.exit(1); } }

(async () => {
  service.configure({ version: 1, dryRun: !live, mapScale: number("--scale", 7, 2, 20), clickIntervalMs: number("--interval", 110, MIN_CLICK_INTERVAL_MS, 1000), sprint: args.includes("--sprint"), darkLoot: args.includes("--dark") });
  if (args.includes("--calibrate") || !service.status().calibration || service.status().calibrationIssue) {
    // --label x,y,width,height selects one label when several party members are on the map.
    const box = option("--label")?.split(",").map(Number);
    if (box && (box.length !== 4 || box.some(n => !Number.isInteger(n) || n < 0))) { console.error("--label needs x,y,width,height in game-client pixels."); process.exit(2); }
    const calibrated = await service.calibrate(box ? { label: { x: box[0], y: box[1], width: box[2], height: box[3] } } : undefined);
    console.log(calibrated.calibration?.labelMask.map(row => row.replace(/\./g, " ")).join("\n"));
    console.log(`Calibrated: ${JSON.stringify(calibrated.calibration)}`);
  }
  if (live) { for (let i = 0; i < 20 && !monitor?.ready; i++) await new Promise(resolve => setTimeout(resolve, 100)); if (!monitor?.ready) { console.error("Emergency stop did not become ready; refusing live input."); process.exit(1); } }
  console.log(`${live ? "LIVE INPUT" : "Dry-run (no input)"}: following ${targetName} for ${seconds} s. Ctrl+Shift+Esc stops; moving the mouse takes over.`);
  await service.start();
  const began = Date.now();
  const report = setInterval(() => {
    const s = service.status();
    if (!s.running) { clearInterval(report); finish(`Stopped: ${s.reason}`, 1); return; }
    console.log(`${((Date.now() - began) / 1000).toFixed(1).padStart(5)} s  ${(s.decision?.kind ?? "-").padEnd(5)} d=${String(s.observation?.offset?.distance ?? "-").padStart(5)} conf=${s.observation?.confidence ?? "-"} odo=${s.odometry ? `${s.odometry.tracked ? "ok" : "no"}:${s.odometry.quality}:${s.odometry.via}:${s.odometry.trailPoints}` : "-"} sprint=${s.sprinting ? "ON" : "off"}/${s.stats?.sprints ?? 0} plan=${s.terrain ? `${s.terrain.planned ? s.terrain.pathPx : "none"}/${s.terrain.walls}w/${s.terrain.bumps}b${s.terrain.blockedAhead ? "!" : ""}` : "-"} origin=${s.observation?.originVerified ? "ok" : "NO"}(${s.observation?.evidence.originScore ?? "-"}) ${s.observation?.evidence.searched ?? ""} obs/s=${s.stats?.observationsPerSecond ?? "-"} cycle p50/p95=${s.stats?.cycleMsP50 ?? "-"}/${s.stats?.cycleMsP95 ?? "-"} clicks=${s.stats?.clicks ?? 0} previewed=${s.stats?.previewed ?? 0} loot=${s.stats?.lootClicks ?? 0}/${s.stats?.lootLabels ?? 0}labels/${s.stats?.lootScans ?? 0}scans refused=${s.stats?.refused ?? 0} manual=${s.stats?.manualTakeovers ?? 0} input p50/p95=${s.stats?.captureToInputMsP50 ?? "-"}/${s.stats?.captureToInputMsP95 ?? "-"}  ${s.reason}`);
    if (Date.now() - began >= seconds * 1000) { clearInterval(report); finish("Time limit reached."); }
  }, 500);
})().catch(e => { console.error(String(e)); service.stop("Failed."); monitor?.close(); process.exit(1); });
