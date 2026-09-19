import { LeaderTracker, type FollowerCalibration, type PixelRect, type WhiteFrame } from "./followerPerception.js";

/** Recorded gameplay frames and the replay that measures perception against human labels. Emits no input. */
export interface RecordingManifest {
  version: 1;
  recordedAt: string;
  view: { width: number; height: number };
  frames: Array<{ file: string; offsetMs: number }>;
}
/** `leader` is the nameplate rectangle a person marked, or null when the leader is not visible in the frame. */
export interface FixtureLabels { version: 1; targetName: string; frames: Record<string, { leader: PixelRect | null; note?: string }> }
export type FixtureOutcome = "correct" | "correct-absent" | "missed" | "wrong-location" | "false-acquisition" | "unlabelled";
export interface FixtureFrameResult {
  file: string; offsetMs: number; found: boolean; position?: { x: number; y: number };
  score: number; runnerUp: number; confidence: number; searched: "full" | "window";
  /** Confidence reached the gate, so a future controller would have acted on this frame. */
  accepted: boolean; outcome: FixtureOutcome; matchMs: number;
}
export interface FixtureMetrics {
  frames: number; labelled: number; leaderVisible: number; leaderAbsent: number;
  detected: number; accepted: number; missed: number;
  /** Accepted sightings that were wrong: the number that matters most before any input is connected. */
  acceptedWrong: number; rejectedWrong: number;
  recall?: number; acceptedRecall?: number; acceptedPrecision?: number; medianMatchMs?: number;
}

const FRAME_FILE = /^frame-\d{4}\.png$/, TOLERANCE = 8;
const integer = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);
function rect(r: PixelRect, view: { width: number; height: number }): boolean {
  return !!r && [r.x, r.y, r.width, r.height].every(integer) && r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0 && r.x + r.width <= view.width && r.y + r.height <= view.height;
}
export function parseRecordingManifest(raw: unknown): RecordingManifest {
  const m = raw as RecordingManifest | null, fail = new Error("Invalid follower recording manifest.");
  if (!m || m.version !== 1 || typeof m.recordedAt !== "string" || m.recordedAt.length > 40 || !m.view || !integer(m.view.width) || !integer(m.view.height) || m.view.width < 320 || m.view.height < 240 || m.view.width > 8192 || m.view.height > 8192) throw fail;
  if (!Array.isArray(m.frames) || m.frames.length > 2000) throw fail;
  let last = -1;
  for (const f of m.frames) { if (!f || typeof f.file !== "string" || !FRAME_FILE.test(f.file) || !Number.isFinite(f.offsetMs) || f.offsetMs <= last) throw fail; last = f.offsetMs; }
  if (new Set(m.frames.map(f => f.file)).size !== m.frames.length) throw fail;
  return { version: 1, recordedAt: m.recordedAt, view: { width: m.view.width, height: m.view.height }, frames: m.frames.map(f => ({ file: f.file, offsetMs: f.offsetMs })) };
}
export function parseFixtureLabels(raw: unknown, manifest: RecordingManifest): FixtureLabels {
  const l = raw as FixtureLabels | null, fail = (why: string) => new Error(`Invalid follower labels: ${why}`);
  if (!l || l.version !== 1 || typeof l.targetName !== "string" || !l.targetName || l.targetName.length > 80 || !l.frames || typeof l.frames !== "object") throw fail("expected version 1, a targetName and frames.");
  const files = new Set(manifest.frames.map(f => f.file)), frames: FixtureLabels["frames"] = {};
  for (const [file, label] of Object.entries(l.frames)) {
    if (!files.has(file)) throw fail(`${file} is not in the recording.`);
    if (!label || (label.leader !== null && !rect(label.leader, manifest.view)) || (label.note !== undefined && (typeof label.note !== "string" || label.note.length > 200))) throw fail(`${file} needs "leader": null or a rectangle inside the view.`);
    frames[file] = { leader: label.leader ? { ...label.leader } : null, note: label.note };
  }
  return { version: 1, targetName: l.targetName, frames };
}

/**
 * Replays frames through the same tracker the live preview uses, with recorded offsets as the
 * clock, so tracking windows and periodic full searches behave as they would live.
 */
export function evaluateFixture(calibration: FollowerCalibration, manifest: RecordingManifest, load: (file: string) => WhiteFrame, labels: FixtureLabels | undefined, confidenceGate: number, now: () => number = () => performance.now()): { results: FixtureFrameResult[]; metrics: FixtureMetrics } {
  if (manifest.view.width !== calibration.view.width || manifest.view.height !== calibration.view.height) throw new Error(`Recording is ${manifest.view.width} × ${manifest.view.height} but calibration is ${calibration.view.width} × ${calibration.view.height}.`);
  if (labels && labels.targetName !== calibration.targetName) throw new Error(`Labels are for ${labels.targetName} but calibration is for ${calibration.targetName}.`);
  const tracker = new LeaderTracker(calibration), results: FixtureFrameResult[] = [];
  for (const entry of manifest.frames) {
    const full = load(entry.file);
    if (full.width !== manifest.view.width || full.height !== manifest.view.height) throw new Error(`${entry.file} does not match the recorded view size.`);
    const { region, searched } = tracker.nextRegion(entry.offsetMs), cropped = new Uint8Array(region.width * region.height);
    for (let y = 0; y < region.height; y++) cropped.set(full.pixels.subarray((region.y + y) * full.width + region.x, (region.y + y) * full.width + region.x + region.width), y * region.width);
    const started = now(), seen = tracker.observe({ width: region.width, height: region.height, pixels: cropped }, region, searched, entry.offsetMs, { captureMs: 0, matchMs: 0 }), matchMs = now() - started;
    const label = labels?.frames[entry.file], p = seen.position;
    const inside = !!label?.leader && !!p && p.x >= label.leader.x - TOLERANCE && p.y >= label.leader.y - TOLERANCE && p.x < label.leader.x + label.leader.width + TOLERANCE && p.y < label.leader.y + label.leader.height + TOLERANCE;
    const outcome: FixtureOutcome = !label ? "unlabelled" : label.leader ? (!seen.found ? "missed" : inside ? "correct" : "wrong-location") : seen.found ? "false-acquisition" : "correct-absent";
    results.push({ file: entry.file, offsetMs: entry.offsetMs, found: seen.found, position: p, score: seen.evidence.score, runnerUp: seen.evidence.runnerUp, confidence: seen.confidence, searched, accepted: seen.found && seen.confidence >= confidenceGate, outcome, matchMs: Math.round(matchMs * 10) / 10 });
  }
  const labelled = results.filter(r => r.outcome !== "unlabelled"), count = (test: (r: FixtureFrameResult) => boolean) => labelled.filter(test).length;
  const wrong = (r: FixtureFrameResult) => r.outcome === "wrong-location" || r.outcome === "false-acquisition";
  const visible = count(r => ["correct", "missed", "wrong-location"].includes(r.outcome)), accepted = count(r => r.accepted), acceptedWrong = count(r => r.accepted && wrong(r));
  const times = results.map(r => r.matchMs).sort((a, b) => a - b), ratio = (a: number, b: number) => b ? Math.round(a / b * 1000) / 1000 : undefined;
  return { results, metrics: {
    frames: results.length, labelled: labelled.length, leaderVisible: visible, leaderAbsent: labelled.length - visible,
    detected: count(r => r.outcome === "correct"), accepted, missed: count(r => r.outcome === "missed"), acceptedWrong, rejectedWrong: count(r => !r.accepted && wrong(r)),
    recall: ratio(count(r => r.outcome === "correct"), visible), acceptedRecall: ratio(count(r => r.accepted && r.outcome === "correct"), visible), acceptedPrecision: ratio(accepted - acceptedWrong, accepted),
    medianMatchMs: times.length ? times[Math.floor(times.length / 2)] : undefined,
  } };
}
