// Replays a follower recording through the live tracker and reports measured perception results.
// Reads files only: no capture, no game input.
//   npm run follower:replay -- <recording-directory> [--calibration <calibration.json>] [--gate 0.85] [--frames]
// Labels are optional: put labels.json beside manifest.json (see docs/FOLLOWER.md).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pngWhiteness } from "../src/adapters/pngWhiteness.js";
import { evaluateFixture, parseFixtureLabels, parseRecordingManifest } from "../src/core/followerFixture.js";
import { parseFollowerCalibration } from "../src/core/followerPerception.js";

const args = process.argv.slice(2), option = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const directory = args.find((a, i) => !a.startsWith("--") && !["--calibration", "--gate"].includes(args[i - 1] ?? ""));
if (!directory) { console.error("Usage: npm run follower:replay -- <recording-directory> [--calibration <file>] [--gate 0.85] [--frames]"); process.exit(2); }
const gate = Number(option("--gate") ?? .85);
if (!Number.isFinite(gate) || gate < .5 || gate > 1) { console.error("--gate must be between 0.5 and 1."); process.exit(2); }
const calibrationFile = option("--calibration") ?? path.join(directory, "..", "..", "calibration.json");
const calibration = parseFollowerCalibration(JSON.parse(readFileSync(calibrationFile, "utf8")));
const manifest = parseRecordingManifest(JSON.parse(readFileSync(path.join(directory, "manifest.json"), "utf8")));
const labelsFile = path.join(directory, "labels.json");
const labels = existsSync(labelsFile) ? parseFixtureLabels(JSON.parse(readFileSync(labelsFile, "utf8")), manifest) : undefined;
const { results, metrics } = evaluateFixture(calibration, manifest, file => pngWhiteness(readFileSync(path.join(directory, file))), labels, gate);

if (args.includes("--frames") || !labels) for (const r of results) {
  console.log(`${r.file} +${String(r.offsetMs).padStart(5)} ms  ${r.found ? `found at ${r.position!.x},${r.position!.y}` : "not found".padEnd(18)}  score ${r.score.toFixed(3)}  next ${r.runnerUp.toFixed(3)}  confidence ${r.confidence.toFixed(3)}${r.accepted ? " ACCEPTED" : ""}  ${r.searched}  ${r.matchMs} ms  ${r.outcome}`);
}
console.log(`\nRecording ${manifest.recordedAt} · ${manifest.view.width} × ${manifest.view.height} · ${metrics.frames} frames · target ${calibration.targetName} · gate ${gate}`);
console.log(`Median match time ${metrics.medianMatchMs} ms per frame (decode excluded; this machine).`);
if (!labels) console.log("No labels.json: nothing above is an accuracy measurement. Label frames to measure recall and false acquisitions.");
else {
  console.log(`Labelled ${metrics.labelled}: leader visible in ${metrics.leaderVisible}, absent in ${metrics.leaderAbsent}.`);
  console.log(`Detected correctly ${metrics.detected} (recall ${metrics.recall ?? "n/a"}); accepted at the gate and correct: recall ${metrics.acceptedRecall ?? "n/a"}; missed ${metrics.missed}.`);
  console.log(`Accepted but WRONG ${metrics.acceptedWrong} (precision at gate ${metrics.acceptedPrecision ?? "n/a"}); wrong but rejected by the gate ${metrics.rejectedWrong}.`);
  console.log("These figures describe this recording only.");
}
