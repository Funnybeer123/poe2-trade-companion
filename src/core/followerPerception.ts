/** Screen-space leader perception. Pure functions over captured pixels; nothing here emits OS input. */
export interface PixelRect { x: number; y: number; width: number; height: number }
/**
 * Single-channel planes the capture host can produce. Each is high only for one kind of UI ink:
 * white = min(R,G,B) for bright unsaturated text; green = G − max(R,B) for party map markers and
 * labels; orange = min(R − G, G − B) for the player's own map marker.
 * scripts/win-follower-host.ps1 implements the same formulas natively.
 */
export type PlaneChannel = "white" | "green" | "orange";
export const PLANE_CHANNELS: readonly PlaneChannel[] = ["white", "green", "orange"];
export function channelValue(r: number, g: number, b: number, channel: PlaneChannel): number {
  if (channel === "white") return Math.min(r, g, b);
  if (channel === "green") return Math.max(0, g - Math.max(r, b));
  return Math.max(0, Math.min(r - g, g - b));
}
/** One byte per pixel of one PlaneChannel. */
export interface WhiteFrame { width: number; height: number; pixels: Uint8Array }
export interface NameplateTemplate { width: number; height: number; threshold: number; mask: string[] }
export interface FollowerCalibration {
  version: 1;
  targetName: string;
  view: { width: number; height: number };
  searchArea: PixelRect;
  nameplate: PixelRect;
  template: NameplateTemplate;
  calibratedAt: string;
}
export interface NameplateMatch { x: number; y: number; score: number; matchedPixels: number }
export interface NameplateSearch { best?: NameplateMatch; runnerUp: number; candidates: number }
export interface LeaderObservation {
  capturedAt: number;
  view: { width: number; height: number };
  identity: { name: string; method: "nameplate-template" };
  found: boolean;
  /** Centre of the matched nameplate in game-client pixels. Not a map position. */
  position?: { x: number; y: number };
  confidence: number;
  evidence: { score: number; runnerUp: number; matchedPixels: number; templatePixels: number; candidates: number; searched: "full" | "window" };
  timing: { captureMs: number; matchMs: number };
}

export const MIN_NAMEPLATE_SCORE = 0.6;
const TRACK_MARGIN = 160, FULL_SEARCH_EVERY_MS = 2000, MAX_MISSES = 3;

const integer = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);
function validRect(r: PixelRect, width: number, height: number): boolean {
  return !!r && [r.x, r.y, r.width, r.height].every(integer) && r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0 && r.x + r.width <= width && r.y + r.height <= height;
}
export function validWhiteFrame(f: WhiteFrame): boolean {
  return !!f && integer(f.width) && integer(f.height) && f.width > 0 && f.height > 0 && f.width <= 8192 && f.height <= 8192 && f.pixels instanceof Uint8Array && f.pixels.length === f.width * f.height;
}
function templatePixels(t: NameplateTemplate): number[] {
  const on: number[] = [];
  t.mask.forEach((row, y) => { for (let x = 0; x < row.length; x++) if (row[x] === "#") on.push(y * t.width + x); });
  return on;
}
export function templatePixelCount(t: NameplateTemplate): number { return templatePixels(t).length; }

/** Otsu's threshold over the selection, clamped so dim scenery can never count as text. */
function textThreshold(values: Uint8Array, min: number, max: number): number {
  const histogram = new Array<number>(256).fill(0);
  for (const v of values) histogram[v]++;
  let total = 0; for (let i = 0; i < 256; i++) total += i * histogram[i];
  let below = 0, belowSum = 0, best = 0, threshold = 128;
  for (let i = 0; i < 256; i++) {
    below += histogram[i]; belowSum += i * histogram[i];
    const above = values.length - below;
    if (!below || !above) continue;
    const gap = belowSum / below - (total - belowSum) / above, variance = below * above * gap * gap;
    if (variance > best) { best = variance; threshold = i + 1; }
  }
  return Math.max(min, Math.min(max, threshold));
}

/** Threshold clamp and minimum ink for a template. Defaults suit white nameplate text. */
export interface TemplateLimits { minThreshold: number; maxThreshold: number; minPixels: number; minWidth: number; minHeight: number }
export const NAMEPLATE_LIMITS: TemplateLimits = { minThreshold: 110, maxThreshold: 235, minPixels: 24, minWidth: 12, minHeight: 6 };

/** Builds a binary text template from the operator's selection, trimmed to the text itself. */
export function buildNameplateTemplate(frame: WhiteFrame, selection: PixelRect, limits: TemplateLimits = NAMEPLATE_LIMITS): { template: NameplateTemplate; nameplate: PixelRect } {
  if (!validWhiteFrame(frame) || !validRect(selection, frame.width, frame.height)) throw new Error("Select the nameplate inside the captured game view.");
  if (selection.width < limits.minWidth || selection.height < limits.minHeight || selection.width > 400 || selection.height > 80) throw new Error(`Select only the leader's name text: ${limits.minWidth}–400 pixels wide and ${limits.minHeight}–80 pixels tall.`);
  const values = new Uint8Array(selection.width * selection.height);
  for (let y = 0; y < selection.height; y++) values.set(frame.pixels.subarray((selection.y + y) * frame.width + selection.x, (selection.y + y) * frame.width + selection.x + selection.width), y * selection.width);
  const threshold = textThreshold(values, limits.minThreshold, limits.maxThreshold);
  let left = selection.width, right = -1, top = selection.height, bottom = -1, count = 0;
  for (let y = 0; y < selection.height; y++) for (let x = 0; x < selection.width; x++) if (values[y * selection.width + x] >= threshold) {
    count++; left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  if (count < limits.minPixels) throw new Error("No bright name text found in the selection. Capture again with the leader's nameplate visible.");
  // A one-pixel dark border lets extra bright pixels around a candidate lower its score.
  left = Math.max(0, left - 1); top = Math.max(0, top - 1); right = Math.min(selection.width - 1, right + 1); bottom = Math.min(selection.height - 1, bottom + 1);
  const width = right - left + 1, height = bottom - top + 1;
  if (count > width * height * .6) throw new Error("The selection is mostly bright background. Select the name text over darker scenery.");
  const mask: string[] = [];
  for (let y = top; y <= bottom; y++) { let row = ""; for (let x = left; x <= right; x++) row += values[y * selection.width + x] >= threshold ? "#" : "."; mask.push(row); }
  return { template: { width, height, threshold, mask }, nameplate: { x: selection.x + left, y: selection.y + top, width, height } };
}

/**
 * Exhaustive binary template search scored by the Dice coefficient, so both missing text
 * pixels and surplus bright pixels lower the score. An integral image rejects most
 * positions in constant time; a sparse probe rejects most of the remainder.
 */
export function findNameplate(frame: WhiteFrame, template: NameplateTemplate, minScore = MIN_NAMEPLATE_SCORE): NameplateSearch {
  if (!validWhiteFrame(frame)) throw new Error("Invalid capture frame.");
  const on = templatePixels(template), total = on.length;
  const { width, height, pixels } = frame, tw = template.width, th = template.height;
  if (!total || tw > width || th > height) return { runnerUp: 0, candidates: 0 };
  const stride = width + 1, integral = new Uint32Array(stride * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) { if (pixels[y * width + x] >= template.threshold) row++; integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + row; }
  }
  // Dice >= floor bounds the bright-pixel count of any acceptable window.
  const floor = minScore * .75, low = Math.ceil(total * floor / (2 - floor)), high = Math.floor(total * (2 / floor - 1));
  const offsets = on.map(i => Math.floor(i / tw) * width + i % tw);
  const probeStep = Math.max(1, Math.floor(total / 24)), probes = offsets.filter((_, i) => i % probeStep === 0);
  const probeNeed = Math.floor(probes.length * floor / (2 - floor) * .5);
  const found: NameplateMatch[] = [];
  for (let y = 0; y + th <= height; y++) for (let x = 0; x + tw <= width; x++) {
    const windowOn = integral[(y + th) * stride + x + tw] - integral[y * stride + x + tw] - integral[(y + th) * stride + x] + integral[y * stride + x];
    if (windowOn < low || windowOn > high) continue;
    const base = y * width + x;
    let hits = 0;
    for (const p of probes) if (pixels[base + p] >= template.threshold) hits++;
    if (hits < probeNeed) continue;
    let matched = 0;
    for (const o of offsets) if (pixels[base + o] >= template.threshold) matched++;
    const score = 2 * matched / (total + windowOn);
    if (score >= floor) found.push({ x, y, score, matchedPixels: matched });
  }
  // Overlapping matches are shifted copies of one nameplate (text resembles itself), not a rival character.
  const distinct: NameplateMatch[] = [];
  for (const m of found.sort((a, b) => b.score - a.score || a.y - b.y || a.x - b.x)) {
    if (distinct.length < 8 && distinct.every(d => Math.abs(m.x - d.x) >= tw || Math.abs(m.y - d.y) >= th)) distinct.push(m);
  }
  if (!distinct.length || distinct[0].score < minScore) return { runnerUp: distinct[0]?.score ?? 0, candidates: 0 };
  return { best: distinct[0], runnerUp: distinct[1]?.score ?? 0, candidates: distinct.filter(m => m.score >= minScore).length };
}

export function parseFollowerCalibration(raw: unknown): FollowerCalibration {
  const c = raw as FollowerCalibration | null, fail = () => new Error("Saved follower calibration is invalid. Calibrate again.");
  if (!c || c.version !== 1 || typeof c.targetName !== "string" || !c.targetName || c.targetName.length > 80 || typeof c.calibratedAt !== "string" || c.calibratedAt.length > 40) throw fail();
  if (!c.view || !integer(c.view.width) || !integer(c.view.height) || c.view.width < 320 || c.view.height < 240 || c.view.width > 8192 || c.view.height > 8192) throw fail();
  if (!validRect(c.searchArea, c.view.width, c.view.height) || !validRect(c.nameplate, c.view.width, c.view.height)) throw fail();
  const t = c.template;
  if (!t || !integer(t.width) || !integer(t.height) || t.width < 3 || t.height < 3 || t.width > 402 || t.height > 82 || !integer(t.threshold) || t.threshold < 110 || t.threshold > 235) throw fail();
  if (!Array.isArray(t.mask) || t.mask.length !== t.height || t.mask.some(row => typeof row !== "string" || row.length !== t.width || !/^[.#]+$/.test(row)) || templatePixelCount(t) < 24) throw fail();
  if (c.searchArea.width < t.width || c.searchArea.height < t.height) throw fail();
  return { version: 1, targetName: c.targetName, view: { width: c.view.width, height: c.view.height }, searchArea: { ...c.searchArea }, nameplate: { ...c.nameplate }, template: { width: t.width, height: t.height, threshold: t.threshold, mask: [...t.mask] }, calibratedAt: c.calibratedAt };
}

/** Why a calibration cannot be used for this character and game view, if it cannot. */
export function calibrationIssue(c: FollowerCalibration, targetName: string, view?: { width: number; height: number }): string | undefined {
  if (c.targetName !== targetName) return `Calibrated for ${c.targetName}; calibrate again for ${targetName || "the selected character"}.`;
  if (view && (view.width !== c.view.width || view.height !== c.view.height)) return `Game view changed from ${c.view.width} × ${c.view.height} to ${view.width} × ${view.height}. Calibrate again.`;
  return undefined;
}

/** Chooses where to look next and turns raw matches into observations. Holds no pixels. */
export class LeaderTracker {
  private last?: { x: number; y: number };
  private misses = 0;
  private lastFullAt = -Infinity;
  private readonly total: number;
  constructor(private readonly calibration: FollowerCalibration) { this.total = templatePixelCount(calibration.template); }
  /** Region to capture next: a window around the last sighting, or periodically the whole search area. */
  nextRegion(now: number): { region: PixelRect; searched: "full" | "window" } {
    const area = this.calibration.searchArea, t = this.calibration.template;
    if (!this.last || now - this.lastFullAt >= FULL_SEARCH_EVERY_MS) { this.lastFullAt = now; return { region: { ...area }, searched: "full" }; }
    const x = Math.max(area.x, this.last.x - TRACK_MARGIN), y = Math.max(area.y, this.last.y - TRACK_MARGIN);
    const right = Math.min(area.x + area.width, this.last.x + t.width + TRACK_MARGIN), bottom = Math.min(area.y + area.height, this.last.y + t.height + TRACK_MARGIN);
    return { region: { x, y, width: right - x, height: bottom - y }, searched: "window" };
  }
  observe(frame: WhiteFrame, region: PixelRect, searched: "full" | "window", capturedAt: number, timing: { captureMs: number; matchMs: number }, search = findNameplate(frame, this.calibration.template)): LeaderObservation {
    const t = this.calibration.template, best = search.best;
    if (best) { this.last = { x: region.x + best.x, y: region.y + best.y }; this.misses = 0; }
    else if (++this.misses >= MAX_MISSES || searched === "full") this.last = undefined;
    // A rival with a similar score means identity is ambiguous, however good the best match is.
    const margin = best ? best.score - search.runnerUp : 0;
    const confidence = best ? Math.round(best.score * Math.min(1, margin / .1) * 1000) / 1000 : 0;
    return {
      capturedAt, view: { ...this.calibration.view }, identity: { name: this.calibration.targetName, method: "nameplate-template" }, found: !!best,
      position: best ? { x: region.x + best.x + Math.floor(t.width / 2), y: region.y + best.y + Math.floor(t.height / 2) } : undefined, confidence,
      evidence: { score: Math.round((best?.score ?? 0) * 1000) / 1000, runnerUp: Math.round(search.runnerUp * 1000) / 1000, matchedPixels: best?.matchedPixels ?? 0, templatePixels: this.total, candidates: search.candidates, searched },
      timing,
    };
  }
}
