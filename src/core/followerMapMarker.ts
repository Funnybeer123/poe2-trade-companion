import {
  buildNameplateTemplate, findNameplate, MIN_NAMEPLATE_SCORE, templatePixelCount,
  type NameplateMatch, type NameplateSearch, type NameplateTemplate, type PixelRect, type TemplateLimits, type WhiteFrame,
} from "./followerPerception.js";

/**
 * Following by the overlay map. With the map overlay open, Path of Exile 2 draws the player's own
 * marker (orange) at the map centre and each party member's marker with a name label (saturated
 * green). The vector between the two gives direction and distance to the leader, on screen or off.
 * Pure functions over captured pixels; nothing here emits OS input.
 */
export interface KeyPoint { x: number; y: number }
export interface MapCalibration {
  version: 1;
  targetName: string;
  view: { width: number; height: number };
  /** Green-channel template of the leader's name label on the overlay map. */
  label: NameplateTemplate;
  /** From the label template's top-left to the centre of the leader's marker beneath it. */
  markerOffset: { dx: number; dy: number };
  /** Orange-channel template of the player's own marker and where its top-left sits: the map centre. */
  originTemplate: NameplateTemplate;
  originAnchor: { x: number; y: number };
  /**
   * The leader's marker sprite on its own (green channel) and where its centre sits in that template. Used only
   * when the name label cannot be seen: far away the marker reaches the screen edge before the label does.
   */
  marker?: { template: NameplateTemplate; centre: { dx: number; dy: number } };
  calibratedAt: string;
}
export interface MapObservation {
  capturedAt: number;
  view: { width: number; height: number };
  identity: { name: string; method: "map-label-template" };
  leaderFound: boolean;
  /** Player marker centre and leader marker centre in game-client pixels; offset = leader − origin in map pixels. */
  origin: KeyPoint;
  leader?: KeyPoint;
  offset?: { dx: number; dy: number; distance: number };
  confidence: number;
  /** The player's own marker was seen where calibration put it recently enough to trust the map centre. */
  originVerified: boolean;
  evidence: { score: number; runnerUp: number; candidates: number; keyPixels: number; originScore: number; originSeenAgoMs: number | null; searched: "full" | "window"; overflow: boolean; /** The sighting rests on the bare marker: the name label was off-screen. */ markerOnly?: boolean };
  timing: { captureMs: number; matchMs: number };
}
export interface SteeringConfig {
  /** Map pixels: stop clicking inside stopPx, start again beyond resumePx. */
  stopPx: number; resumePx: number;
  clickIntervalMs: number;
  /** Approximate screen pixels of world movement per overlay-map pixel. */
  mapScale: number;
  confidence: number;
}
export type SteeringDecision =
  | { kind: "move"; x: number; y: number; distance: number; reason: string }
  | { kind: "hold" | "near" | "pause"; reason: string; distance?: number };

export const LABEL_LIMITS: TemplateLimits = { minThreshold: 60, maxThreshold: 200, minPixels: 24, minWidth: 12, minHeight: 6 };
export const ORIGIN_LIMITS: TemplateLimits = { minThreshold: 30, maxThreshold: 200, minPixels: 10, minWidth: 5, minHeight: 5 };
const TRACK_MARGIN = 96, FULL_SEARCH_EVERY_MS = 1000, ORIGIN_MARGIN = 20, ORIGIN_TOLERANCE = 14, ORIGIN_MIN_SCORE = .5, ORIGIN_STICKY_MS = 1500, ORIGIN_COVERED_MAX_MS = 10_000, MAX_MISSES = 3;
const LABEL_FLANK = 6, LABEL_JUMP_PX = 30, LABEL_JUMP_WINDOW_MS = 250;
const MARKER_MIN_SCORE = .75, MARKER_TRUST = .95, MARKER_CONTINUITY_MS = 700, MARKER_CONTINUITY_PX = 40;
/** Blocked: we moved less than this many map pixels over STUCK_MS despite STUCK_CLICKS committed clicks. */
const STUCK_TOLERANCE_PX = 2.5, STUCK_MS = 1500, STUCK_CLICKS = 6, STUCK_REST_MS = 5000;
const RAD = Math.PI / 180, WALL_FIRST_TURN = 60 * RAD, WALL_TURN = 35 * RAD, WALL_EASE = 25 * RAD, WALL_MAX_TURN = 200 * RAD, WALL_STUCK_MS = 900, WALL_EASE_MS = 800, WALL_SIDE_MS = 25_000, WALL_SIDE_GAIN_PX = 20, WALL_SWING = 45 * RAD, EPISODE_CLEAR_MS = 6000, EPISODE_GAP_MS = 1000;
/** The input worker refuses clicks beyond 0.30 h of the view centre; steering stays just inside that. */
const SAFE_DISC = .29;
const integer = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);

export function decodeKeyPoints(base64: unknown): KeyPoint[] {
  if (typeof base64 !== "string") throw new Error("Capture worker returned no marker pixels.");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length % 4) throw new Error("Capture worker returned malformed marker pixels.");
  const points: KeyPoint[] = [];
  for (let i = 0; i < bytes.length; i += 4) points.push({ x: bytes.readUInt16LE(i), y: bytes.readUInt16LE(i + 2) });
  return points;
}
export function keyPointsOf(frame: WhiteFrame, threshold: number, area: PixelRect = { x: 0, y: 0, width: frame.width, height: frame.height }): KeyPoint[] {
  const points: KeyPoint[] = [];
  for (let y = area.y; y < area.y + area.height; y++) for (let x = area.x; x < area.x + area.width; x++) if (frame.pixels[y * frame.width + x] >= threshold) points.push({ x, y });
  return points;
}

/**
 * The same Dice-scored template search as findNameplate, over a sparse list of above-threshold
 * pixels instead of a dense plane. A few probe offsets vote for anchors; only anchors with enough
 * votes are scored exactly. Cost scales with marker pixels on screen, not with screen size.
 *
 * Without options, anchors may overhang the searched region: a clipped label still matches where it
 * really is, but pixels outside the region can never count against it. `bounds` keeps every anchor
 * inside the region that was actually captured. `flank` rejects a candidate with
 * ink directly left or right of it on the same rows: the name continues, so it is a longer name that
 * merely contains this one ("Ranger" inside "RangerTwo"), which Dice alone would score near 1.
 */
export interface SparseSearchOptions { flank?: number; bounds?: PixelRect }
export function findTemplateSparse(points: KeyPoint[], template: NameplateTemplate, minScore = MIN_NAMEPLATE_SCORE, options: SparseSearchOptions = {}): NameplateSearch {
  const flank = options.flank ?? 0, bounds = options.bounds;
  const offsets: KeyPoint[] = [];
  template.mask.forEach((row, y) => { for (let x = 0; x < row.length; x++) if (row[x] === "#") offsets.push({ x, y }); });
  const total = offsets.length;
  if (!total || !points.length) return { runnerUp: 0, candidates: 0 };
  // Where the points are, as a flat bitmap over their bounding box padded by one template: every lookup below is an
  // array read. It was a Set of numeric keys, which is fine for a 300-pixel label and ruinous for a big one: at a high
  // Map Zoom the label template is 206 x 30 with 1,890 pixels, 7,567 positions out-voted the 4-of-33 probe filter, each
  // paid 1,890 hash lookups, and one match took ~200 ms - against a 120 ms freshness limit, so EVERY click was refused.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const q of points) { if (q.x < minX) minX = q.x; if (q.x > maxX) maxX = q.x; if (q.y < minY) minY = q.y; if (q.y > maxY) maxY = q.y; }
  const gx = minX - template.width - flank, gy = minY - template.height, gw = maxX - minX + 1 + 2 * (template.width + flank), gh = maxY - minY + 1 + 2 * template.height;
  const grid = new Uint8Array(gw * gh);
  for (const q of points) grid[(q.y - gy) * gw + q.x - gx] = 1;
  // Every top-left a point can vote for keeps the whole template, and its flank, inside this padded bitmap, so the
  // inner loops below index it directly: a template pixel is one precomputed offset from the position's base index.
  const deltas = new Int32Array(total); for (let i = 0; i < total; i++) deltas[i] = offsets[i].y * gw + offsets[i].x;
  // Points left of x on each row, so "how many in this window / this flank" is two reads, not a scan.
  const pw = gw + 1, prefix = new Int32Array(pw * gh);
  for (let y = 0; y < gh; y++) { let n = 0; const g = y * gw, r = y * pw; for (let x = 0; x < gw; x++) { n += grid[g + x]; prefix[r + x + 1] = n; } }
  /** Points on bitmap row `row` with x0 <= x < x1, in bitmap columns. */
  const span = (row: number, x0: number, x1: number) => prefix[row * pw + x1] - prefix[row * pw + x0];
  // A big template votes with four times the probes. With 32, a 1,890-pixel label let 7,567 positions through a 4-vote
  // bar, and verifying those was the whole cost; with 128 the bar is 19 votes and a handful get through. Small templates
  // keep 32 probes and the same bar, so their candidates - and results - are exactly what they were.
  const floor = minScore * .75, step = Math.max(1, Math.floor(total / (total > 320 ? 128 : 32))), probes = offsets.filter((_, i) => i % step === 0);
  // Dice >= floor needs matched >= total * floor / (2 - floor); probes sample that fraction, halved for slack.
  const need = Math.max(1, Math.floor(probes.length * floor / (2 - floor) * .5)), minMatched = total * floor / (2 - floor);
  // One counter per possible top-left, flat: a Map keyed by position was most of what remained after the bitmap.
  const vx = minX - template.width + 1, vy = minY - template.height + 1, vw = maxX - vx + 1, vh = maxY - vy + 1, votes = new Uint16Array(vw * vh);
  for (const q of points) for (const o of probes) votes[(q.y - o.y - vy) * vw + q.x - o.x - vx]++;
  const found: NameplateMatch[] = [];
  for (let i = 0; i < votes.length; i++) {
    if (votes[i] < need) continue;
    const x = vx + i % vw, y = vy + Math.floor(i / vw);
    if (bounds && (x < bounds.x || y < bounds.y || x + template.width > bounds.x + bounds.width || y + template.height > bounds.y + bounds.height)) continue;
    const base = (y - gy) * gw + x - gx; let matched = 0;
    // Stop as soon as the floor is out of reach: what is left to check cannot bring this position back.
    for (let k = 0; k < total; k++) { if (grid[base + deltas[k]]) matched++; else if (matched + total - k - 1 < minMatched) break; }
    if (2 * matched / (total + matched) < floor) continue;
    let beside = 0, windowOn = 0; const bx = x - gx;
    for (let row = y - gy; row < y - gy + template.height; row++) { windowOn += span(row, bx, bx + template.width); if (flank) beside += span(row, bx - flank, bx) + span(row, bx + template.width, bx + template.width + flank); }
    if (beside >= 3) continue;
    const score = 2 * matched / (total + windowOn);
    if (score >= floor) found.push({ x, y, score, matchedPixels: matched });
  }
  const distinct: NameplateMatch[] = [];
  for (const m of found.sort((a, b) => b.score - a.score || a.y - b.y || a.x - b.x)) {
    if (distinct.length < 8 && distinct.every(d => Math.abs(m.x - d.x) >= template.width || Math.abs(m.y - d.y) >= template.height)) distinct.push(m);
  }
  if (!distinct.length || distinct[0].score < minScore) return { runnerUp: distinct[0]?.score ?? 0, candidates: 0 };
  return { best: distinct[0], runnerUp: distinct[1]?.score ?? 0, candidates: distinct.filter(m => m.score >= minScore).length };
}

interface Cluster { left: number; top: number; right: number; bottom: number; count: number; sumX: number; sumY: number }
/** Groups marker pixels that sit within one glyph gap of each other: a label is one cluster, its marker another. */
function clusters(points: KeyPoint[], gapX = 5, gapY = 2): Cluster[] {
  if (points.length > 3500) throw new Error("Too much saturated green on screen to find the map label. Calibrate away from green effects, or pass the rectangle around the label.");
  const parent = points.map((_, i) => i), find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
    if (Math.abs(points[i].x - points[j].x) <= gapX && Math.abs(points[i].y - points[j].y) <= gapY) parent[find(i)] = find(j);
  }
  const byRoot = new Map<number, Cluster>();
  points.forEach((p, i) => {
    const root = find(i), c = byRoot.get(root);
    if (!c) byRoot.set(root, { left: p.x, top: p.y, right: p.x, bottom: p.y, count: 1, sumX: p.x, sumY: p.y });
    else { c.left = Math.min(c.left, p.x); c.top = Math.min(c.top, p.y); c.right = Math.max(c.right, p.x); c.bottom = Math.max(c.bottom, p.y); c.count++; c.sumX += p.x; c.sumY += p.y; }
  });
  return [...byRoot.values()];
}
/** Every party label on the overlay map that has its marker directly beneath it. */
export function findMapLabels(green: WhiteFrame, threshold = 80, near?: PixelRect): Array<{ label: PixelRect; marker: KeyPoint; markerRect: PixelRect }> {
  // A selection only has to touch the label, so look a whole label's width around it, and no further:
  // green scenery elsewhere must not defeat a manual selection.
  const x = near ? Math.max(0, near.x - 400) : 0, y = near ? Math.max(0, near.y - 24) : 0;
  const area = near ? { x, y, width: Math.min(green.width, near.x + near.width + 400) - x, height: Math.min(green.height, near.y + near.height + 40) - y } : undefined;
  const points = keyPointsOf(green, threshold, area), pairs: Array<{ label: PixelRect; marker: KeyPoint; markerRect: PixelRect }> = [];
  // The gap between letters grows with the game's Map Zoom, and at the default join distance a zoomed name falls apart
  // into pieces: live, "HarrisonBot" calibrated as "arrison", which the tracker then refused every time because the
  // rest of the name sat in the flank it checks for stray ink. So the tallest text-sized piece sets the scale, and the
  // points are joined again at that scale. At the default zoom the scale is 1 and nothing changes.
  const first = clusters(points), tallest = Math.max(0, ...first.filter(c => c.right - c.left + 1 >= 12 && c.bottom - c.top + 1 <= 44 && c.count >= 20).map(c => c.bottom - c.top + 1));
  const scale = Math.max(1, tallest / 12), all = scale > 1.25 ? clusters(points, Math.round(5 * scale), 2) : first;
  for (const label of all) {
    const width = label.right - label.left + 1, height = label.bottom - label.top + 1;
    // Sizes grow with the game's Map Zoom setting. Measured at 2560 x 1440: the label 204 x 28 with a 23 px marker 11 px
    // beneath it at a high zoom, against roughly 14 and 10 px at the default - and the old limits (24 / 16) refused to
    // calibrate at all on the higher zoom, which is the zoom that makes the map's walls easiest to read.
    if (width < 24 || width > 560 || height < 6 || height > 44 || label.count < 40) continue;
    const centre = (label.left + label.right) / 2;
    // The marker's size and its gap beneath the label grow with the label, so the limits are the default zoom's (18 x 16,
    // 12 px beneath, 12 px off-centre) scaled by how much taller than a default 10-12 px label this one is - as strict as
    // ever at the default zoom, and wide enough for the measured 23 px marker 11 px under a 28 px label.
    const zoom = Math.max(1, height / 12);
    const marker = all.find(m => m !== label && m.right - m.left + 1 >= 5 && m.right - m.left + 1 <= 18 * zoom && m.bottom - m.top + 1 >= 5 && m.bottom - m.top + 1 <= 16 * zoom && m.count >= 10
      && Math.abs((m.left + m.right) / 2 - centre) <= 12 * zoom && m.top - label.bottom >= 1 && m.top - label.bottom <= 12 * zoom);
    if (marker) pairs.push({ label: { x: label.left, y: label.top, width, height }, marker: { x: Math.round(marker.sumX / marker.count), y: Math.round(marker.sumY / marker.count) },
      markerRect: { x: marker.left, y: marker.top, width: marker.right - marker.left + 1, height: marker.bottom - marker.top + 1 } });
  }
  return pairs;
}

/**
 * Calibrates from one full-view capture with the overlay map open and the leader on it.
 * With `labelRect` omitted, exactly one party label must be visible; otherwise pass the
 * rectangle the operator drew around the leader's label.
 */
export function buildMapCalibration(green: WhiteFrame, orange: WhiteFrame, targetName: string, calibratedAt: string, labelRect?: PixelRect): MapCalibration {
  if (!targetName) throw new Error("Enter and save the character to follow before calibrating.");
  if (green.width !== orange.width || green.height !== orange.height) throw new Error("Calibration planes differ in size.");
  const pairs = findMapLabels(green, 80, labelRect);
  const chosen = labelRect
    ? pairs.find(p => p.label.x < labelRect.x + labelRect.width && labelRect.x < p.label.x + p.label.width && p.label.y < labelRect.y + labelRect.height && labelRect.y < p.label.y + p.label.height)
    : pairs.length === 1 ? pairs[0] : undefined;
  if (!chosen) throw new Error(labelRect ? "No party label with a map marker beneath it was found in the selection. Open the overlay map (Tab) with the leader on it."
    : pairs.length ? `Found ${pairs.length} party labels on the overlay map. Calibrate while ${targetName} is the only other party member on it, or pass the rectangle around ${targetName}'s label.` : "No party label found on the overlay map. Open the overlay map (Tab) with the leader in the same area, then capture again.");
  const pad = (r: PixelRect, by: number): PixelRect => { const x = Math.max(0, r.x - by), y = Math.max(0, r.y - by); return { x, y, width: Math.min(green.width, r.x + r.width + by) - x, height: Math.min(green.height, r.y + r.height + by) - y }; };
  const { template: label, nameplate } = buildNameplateTemplate(green, pad(chosen.label, 2), LABEL_LIMITS);
  // The player's marker is the same sprite in orange: look for the leader marker's shape near the view centre.
  // The marker's own bounds, not a fixed 11 x 9: the sprite grows with the game's Map Zoom (23 px at a high zoom),
  // and a fixed crop then lands inside solid green and is refused as "mostly bright background".
  const markerBox = pad(chosen.markerRect, 2);
  const { template: shape, nameplate: shapeRect } = buildNameplateTemplate(green, markerBox, { ...ORIGIN_LIMITS, minThreshold: 60 });
  // The overlay map is centred on the player: horizontally mid-view, a little above mid-height
  // (measured at 0.4998 w, 0.4858 h). Anything orange elsewhere is scenery or the corner minimap.
  const centre: PixelRect = { x: Math.round(green.width * .485), y: Math.round(green.height * .46), width: Math.round(green.width * .03), height: Math.round(green.height * .05) };
  const crop = new Uint8Array(centre.width * centre.height);
  for (let y = 0; y < centre.height; y++) crop.set(orange.pixels.subarray((centre.y + y) * orange.width + centre.x, (centre.y + y) * orange.width + centre.x + centre.width), y * centre.width);
  const own = findNameplate({ width: centre.width, height: centre.height, pixels: crop }, { ...shape, threshold: 36 }, .55).best;
  if (!own) throw new Error("Could not find your own marker at the centre of the overlay map. Open the overlay map (Tab) instead of the corner minimap, close side panels, and capture again.");
  const ownBox = pad({ x: centre.x + own.x, y: centre.y + own.y, width: shape.width, height: shape.height }, 1);
  const { template: originTemplate, nameplate: originRect } = buildNameplateTemplate(orange, ownBox, ORIGIN_LIMITS);
  return parseMapCalibration({ version: 1, targetName, view: { width: green.width, height: green.height }, label,
    markerOffset: { dx: chosen.marker.x - nameplate.x, dy: chosen.marker.y - nameplate.y }, originTemplate, originAnchor: { x: originRect.x, y: originRect.y },
    marker: { template: shape, centre: { dx: chosen.marker.x - shapeRect.x, dy: chosen.marker.y - shapeRect.y } }, calibratedAt });
}

function validTemplate(t: NameplateTemplate, limits: TemplateLimits, maxWidth: number, maxHeight: number): boolean {
  return !!t && integer(t.width) && integer(t.height) && t.width >= 3 && t.height >= 3 && t.width <= maxWidth && t.height <= maxHeight && integer(t.threshold) && t.threshold >= limits.minThreshold && t.threshold <= limits.maxThreshold
    && Array.isArray(t.mask) && t.mask.length === t.height && t.mask.every(row => typeof row === "string" && row.length === t.width && /^[.#]+$/.test(row)) && templatePixelCount(t) >= limits.minPixels;
}
export function parseMapCalibration(raw: unknown): MapCalibration {
  const c = raw as MapCalibration | null, fail = () => new Error("Saved map calibration is invalid. Calibrate again.");
  if (!c || c.version !== 1 || typeof c.targetName !== "string" || !c.targetName || c.targetName.length > 80 || typeof c.calibratedAt !== "string" || c.calibratedAt.length > 40) throw fail();
  if (!c.view || !integer(c.view.width) || !integer(c.view.height) || c.view.width < 320 || c.view.height < 240 || c.view.width > 8192 || c.view.height > 8192) throw fail();
  if (!validTemplate(c.label, LABEL_LIMITS, 404, 84) || !validTemplate(c.originTemplate, ORIGIN_LIMITS, 40, 40)) throw fail();
  if (!c.markerOffset || !integer(c.markerOffset.dx) || !integer(c.markerOffset.dy) || Math.abs(c.markerOffset.dx) > 404 || c.markerOffset.dy < 0 || c.markerOffset.dy > 120) throw fail();
  const a = c.originAnchor;
  if (!a || !integer(a.x) || !integer(a.y) || a.x < ORIGIN_MARGIN || a.y < ORIGIN_MARGIN || a.x + c.originTemplate.width + ORIGIN_MARGIN > c.view.width || a.y + c.originTemplate.height + ORIGIN_MARGIN > c.view.height) throw fail();
  const m = c.marker;
  if (m !== undefined && (!m || !validTemplate(m.template, { ...ORIGIN_LIMITS, minThreshold: 60 }, 40, 40) || !m.centre || !integer(m.centre.dx) || !integer(m.centre.dy) || m.centre.dx < 0 || m.centre.dy < 0 || m.centre.dx >= m.template.width || m.centre.dy >= m.template.height)) throw fail();
  return { version: 1, targetName: c.targetName, view: { width: c.view.width, height: c.view.height }, label: { ...c.label, mask: [...c.label.mask] }, markerOffset: { dx: c.markerOffset.dx, dy: c.markerOffset.dy },
    originTemplate: { ...c.originTemplate, mask: [...c.originTemplate.mask] }, originAnchor: { x: a.x, y: a.y },
    ...(m ? { marker: { template: { ...m.template, mask: [...m.template.mask] }, centre: { dx: m.centre.dx, dy: m.centre.dy } } } : {}), calibratedAt: c.calibratedAt };
}
export function mapCalibrationIssue(c: MapCalibration, targetName: string, view?: { width: number; height: number }): string | undefined {
  if (c.targetName !== targetName) return `Map calibrated for ${c.targetName}; calibrate again for ${targetName || "the selected character"}.`;
  if (view && (view.width !== c.view.width || view.height !== c.view.height)) return `Game view changed from ${c.view.width} × ${c.view.height} to ${view.width} × ${view.height}. Calibrate again.`;
  return undefined;
}

export interface MapCaptureRequest { region: PixelRect; full: boolean; searched: "full" | "window"; channel: "green"; threshold: number; second: PixelRect & { channel: "orange"; threshold: number } }
/** Chooses what to capture next and turns sparse marker pixels into observations. Holds no pixels. */
export class MapMarkerTracker {
  private last?: KeyPoint;
  private misses = 0;
  private lastFullAt = -Infinity;
  private originSeenAt?: number;
  private region?: PixelRect;
  private fullRunnerUp = 0;
  private lastLeader?: { at: number; x: number; y: number };
  constructor(private readonly calibration: MapCalibration) {}
  get origin(): KeyPoint { const c = this.calibration; return { x: c.originAnchor.x + Math.floor(c.originTemplate.width / 2), y: c.originAnchor.y + Math.floor(c.originTemplate.height / 2) }; }
  nextRequest(now: number): MapCaptureRequest {
    const c = this.calibration, view = c.view, a = c.originAnchor;
    const second = { x: a.x - ORIGIN_MARGIN, y: a.y - ORIGIN_MARGIN, width: c.originTemplate.width + ORIGIN_MARGIN * 2, height: c.originTemplate.height + ORIGIN_MARGIN * 2, channel: "orange" as const, threshold: c.originTemplate.threshold };
    const base = { channel: "green" as const, threshold: c.label.threshold, second };
    if (!this.last || now - this.lastFullAt >= FULL_SEARCH_EVERY_MS) { this.lastFullAt = now; this.region = { x: 0, y: 0, width: view.width, height: view.height }; return { ...base, region: this.region, full: true, searched: "full" }; }
    const x = Math.max(0, this.last.x - TRACK_MARGIN), y = Math.max(0, this.last.y - TRACK_MARGIN);
    const right = Math.min(view.width, this.last.x + c.label.width + TRACK_MARGIN), bottom = Math.min(view.height, this.last.y + c.label.height + TRACK_MARGIN);
    this.region = { x, y, width: right - x, height: bottom - y };
    return { ...base, region: this.region, full: false, searched: "window" };
  }
  observe(points: KeyPoint[] | undefined, originPoints: KeyPoint[] | undefined, searched: "full" | "window", capturedAt: number, timing: { captureMs: number; matchMs: number }): MapObservation {
    const c = this.calibration;
    let search = points ? findTemplateSparse(points, c.label, MIN_NAMEPLATE_SCORE, { flank: LABEL_FLANK, bounds: this.region }) : { runnerUp: 0, candidates: 0 } as NameplateSearch, best = search.best, markerOnly = false;
    if (!best && points && c.marker) {
      // Far away the label leaves the screen before the marker does. The bare marker says nothing about whose it is,
      // so it is believed only when it is the single marker in view and either its label would be off-screen there or
      // it is where the labelled leader just was.
      const found = findTemplateSparse(points, c.marker.template, MARKER_MIN_SCORE, { bounds: this.region }), lone = found.best;
      if (lone && found.candidates === 1) {
        const centre = { x: lone.x + c.marker.centre.dx, y: lone.y + c.marker.centre.dy }, anchor = { x: centre.x - c.markerOffset.dx, y: centre.y - c.markerOffset.dy };
        const labelOffScreen = anchor.y < 0 || anchor.x < 0 || anchor.x + c.label.width > c.view.width || anchor.y + c.label.height > c.view.height;
        const continues = !!this.lastLeader && capturedAt - this.lastLeader.at <= MARKER_CONTINUITY_MS && Math.hypot(centre.x - this.lastLeader.x, centre.y - this.lastLeader.y) <= MARKER_CONTINUITY_PX;
        if (labelOffScreen || continues) { markerOnly = true; search = { best: { x: anchor.x, y: anchor.y, score: lone.score * MARKER_TRUST, matchedPixels: lone.matchedPixels }, runnerUp: found.runnerUp, candidates: 1 }; best = search.best; }
      }
    }
    if (best) { this.last = { x: best.x, y: best.y }; this.misses = 0; }
    // An overflowed capture never ran a search: it says nothing about the label, so the track is kept.
    else if (points && (++this.misses >= MAX_MISSES || searched === "full")) this.last = undefined;
    // A window cannot see a rival label elsewhere on the map; the last full search could. Identity stays
    // as ambiguous as that search found it until another full search clears it.
    if (searched === "full" && points) this.fullRunnerUp = search.runnerUp;
    const runnerUp = Math.max(search.runnerUp, this.fullRunnerUp);
    const own = originPoints ? findTemplateSparse(originPoints, c.originTemplate, ORIGIN_MIN_SCORE).best : undefined;
    // Where the map draws our own marker drifts by about ten pixels between sessions and areas: a live run sat
    // blocked with it 11 px from the calibrated anchor, matching at .93, and called that "displaced". What this
    // check is for is a marker that is GONE (a panel over it, the map closed) or one that turns up somewhere
    // else entirely, and the search window is only ORIGIN_MARGIN wide, so a tolerance near the template's own
    // size keeps both of those while surviving the drift.
    const ownInPlace = !!own && Math.abs(own.x - c.originAnchor.x) <= ORIGIN_TOLERANCE && Math.abs(own.y - c.originAnchor.y) <= ORIGIN_TOLERANCE;
    const origin = this.origin, leader = best ? { x: best.x + c.markerOffset.dx, y: best.y + c.markerOffset.dy } : undefined;
    // Markers crawl a pixel or two per capture. A label that jumps means the whole map moved (a panel
    // opened, the map was panned), and so does our own marker turning up somewhere else.
    const jumped = !!leader && !!this.lastLeader && capturedAt - this.lastLeader.at <= LABEL_JUMP_WINDOW_MS && Math.hypot(leader.x - this.lastLeader.x, leader.y - this.lastLeader.y) > LABEL_JUMP_PX;
    if (leader) this.lastLeader = { at: capturedAt, ...leader };
    const dx = leader ? leader.x - origin.x : 0, dy = leader ? leader.y - origin.y : 0, distance = Math.hypot(dx, dy);
    // With the leader's marker drawn over ours, what is left of ours matches a few pixels off: that is cover, not a moved map.
    const overlapped = !!leader && distance <= Math.max(c.originTemplate.width, c.originTemplate.height) + ORIGIN_TOLERANCE;
    if (ownInPlace) this.originSeenAt = capturedAt;
    else if ((own && !overlapped) || jumped) this.originSeenAt = undefined;
    const margin = best ? best.score - runnerUp : 0, seenAgo = this.originSeenAt === undefined ? null : capturedAt - this.originSeenAt;
    // The leader's marker covers ours when they stand on us; the map centre cannot have moved then, but only for a while.
    const covered = overlapped && seenAgo !== null && seenAgo <= ORIGIN_COVERED_MAX_MS;
    const originVerified = (seenAgo !== null && seenAgo <= ORIGIN_STICKY_MS) || covered;
    return {
      capturedAt, view: { ...c.view }, identity: { name: c.targetName, method: "map-label-template" }, leaderFound: !!best, origin, leader,
      offset: leader ? { dx, dy, distance: Math.round(distance * 10) / 10 } : undefined,
      confidence: best ? Math.round(best.score * Math.min(1, margin / .1) * 1000) / 1000 : 0, originVerified,
      evidence: { score: Math.round((best?.score ?? 0) * 1000) / 1000, runnerUp: Math.round(runnerUp * 1000) / 1000, candidates: search.candidates, keyPixels: points?.length ?? 0,
        originScore: Math.round((own?.score ?? 0) * 1000) / 1000, originSeenAgoMs: seenAgo === null ? null : Math.round(seenAgo), searched, overflow: !points, ...(markerOnly ? { markerOnly: true } : {}) },
      timing,
    };
  }
}

/**
 * Turns observations into movement clicks. It clicks only while it can see the leader's label with
 * enough confidence and trusts the map centre: when either is missing it sends nothing, so the
 * character finishes its last move and stands still. There is no blind pursuit.
 */
export class FollowSteering {
  private moving = false;
  private lastClickAt = -Infinity;
  /** Recent own movement (or, without odometry, change in the leader's offset): the "did that click move us" sensor. */
  private steps: Array<{ at: number; dx: number; dy: number }> = [];
  private lastOffset?: { dx: number; dy: number };
  private clicksSinceMoved = 0;
  private checkedAt = -Infinity;
  /** Wall-following: an absolute heading (radians, screen axes) held while something blocks the straight line. */
  private wall?: { side: 1 | -1; heading: number; /** The goal this heading was turned away from. */ goal: number; turned: number; easedAt: number; since: number; from: number };
  private preferredSide: 1 | -1 = 1;
  /** From the first time we were blocked until we get clearly nearer: slipping back to the straight line and sticking again is the same episode. */
  private episode?: { at: number; from: number; fails: number; blockedAt: number };
  private flips = 0;
  private restUntil = -Infinity;
  private headedAt = -Infinity;
  constructor(private readonly config: SteeringConfig) {}
  private travelled(now: number, withinMs: number): number {
    let dx = 0, dy = 0;
    for (const s of this.steps) if (now - s.at <= withinMs) { dx += s.dx; dy += s.dy; }
    return Math.hypot(dx, dy);
  }
  private reset(): void { this.wall = undefined; this.episode = undefined; this.flips = 0; this.steps = []; this.clicksSinceMoved = 0; this.checkedAt = -Infinity; this.restUntil = -Infinity; }
  /**
   * Clicking straight at the goal walks into whatever is in between. When committed clicks stop moving
   * us we are against something, so hold a heading turned away from the goal to one side: each time that
   * heading is blocked too, turn further away; each time it is moving, ease back toward the goal. That
   * hugs a wall round its corners. Having turned most of the way round without getting free, try the
   * other side; after both sides, rest and start again. It is reactive, not pathfinding: it cannot plan
   * through a maze. The goal is whatever aim the caller supplies (trail or plan): once that swings well
   * away from the goal the wall heading was built against, the wall is dropped and the new aim walked at once.
   */
  private heading(goal: number, distance: number, now: number): { angle: number; note?: string } | "rest" {
    if (now < this.restUntil) return "rest";
    const stuck = this.clicksSinceMoved >= STUCK_CLICKS && now - this.checkedAt >= (this.wall ? WALL_STUCK_MS : STUCK_MS) && this.travelled(now, this.wall ? WALL_STUCK_MS : STUCK_MS) < STUCK_TOLERANCE_PX;
    const between = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
    const gap = now - this.headedAt; this.headedAt = now;
    if (this.episode) {
      // Time not spent steering (label lost, panel open) is not time spent failing to get round.
      if (gap > EPISODE_GAP_MS) this.episode.at += gap;
      if (this.wall || stuck) this.episode.blockedAt = now;
      // Walking free this long: the obstacle is behind us, and its side timer must not fire later.
      else if (now - this.episode.blockedAt >= EPISODE_CLEAR_MS) this.episode = undefined;
    }
    if (this.episode && distance <= this.episode.from - WALL_SIDE_GAIN_PX) this.episode = { at: now, from: distance, fails: 0, blockedAt: this.episode.blockedAt };
    if (this.episode && now - this.episode.at >= WALL_SIDE_MS) {
      // A long time on this side, in and out of the wall, without getting nearer: it is not the way round.
      if (++this.episode.fails >= 2) { this.reset(); this.restUntil = now + STUCK_REST_MS; return "rest"; }
      this.preferredSide = (this.preferredSide === 1 ? -1 : 1) as 1 | -1; this.episode.at = now;
      this.wall = { side: this.preferredSide, heading: goal + this.preferredSide * WALL_FIRST_TURN, goal, turned: WALL_FIRST_TURN, easedAt: now, since: now, from: distance };
      this.checkedAt = now; this.clicksSinceMoved = 0;
    }
    if (this.wall) {
      // The aim now points round the other way, or back out: this heading was turned from a goal that no longer holds.
      const swing = Math.atan2(Math.sin(goal - this.wall.goal), Math.cos(goal - this.wall.goal));
      if (-this.wall.side * swing > WALL_SWING || Math.abs(swing) > 2 * WALL_SWING) { this.wall = undefined; this.clicksSinceMoved = 0; this.checkedAt = now; return { angle: goal }; }
    }
    if (!this.wall) {
      if (!stuck) return { angle: goal };
      this.episode ??= { at: now, from: distance, fails: 0, blockedAt: now };
      this.wall = { side: this.preferredSide, heading: goal + this.preferredSide * WALL_FIRST_TURN, goal, turned: WALL_FIRST_TURN, easedAt: now, since: now, from: distance };
      this.checkedAt = now; this.clicksSinceMoved = 0;
    } else if (stuck) {
      this.wall.heading += this.wall.side * WALL_TURN; this.wall.turned += WALL_TURN; this.checkedAt = now; this.clicksSinceMoved = 0; this.wall.easedAt = now;
      if (this.wall.turned > WALL_MAX_TURN) {
        if (++this.flips >= 2) { this.reset(); this.restUntil = now + STUCK_REST_MS; return "rest"; }
        const side = (this.wall.side === 1 ? -1 : 1) as 1 | -1;
        this.wall = { side, heading: goal + side * WALL_FIRST_TURN, goal, turned: WALL_FIRST_TURN, easedAt: now, since: now, from: distance };
      }
    } else {
      // Moving freely along this heading: lean back toward the goal, which is also toward the wall we are rounding.
      if (now - this.wall.easedAt >= WALL_EASE_MS && this.travelled(now, WALL_EASE_MS) >= STUCK_TOLERANCE_PX) { this.wall.heading -= this.wall.side * WALL_EASE; this.wall.turned = Math.max(0, this.wall.turned - WALL_EASE); this.wall.easedAt = now; }
      // Tested on every call, not only after easing: an aim that swings onto this heading takes over at once.
      if (between(this.wall.heading, goal) <= WALL_EASE) { this.preferredSide = this.wall.side; this.wall = undefined; this.flips = 0; return { angle: goal }; }
    }
    const degrees = Math.round(between(this.wall.heading, goal) * 180 / Math.PI);
    return { angle: this.wall.heading, note: `Blocked: going round to the ${this.wall.side === 1 ? "right" : "left"}, ${degrees}° off the line` };
  }
  /**
   * `aim` is where to walk (map pixels from us) when that is not straight at the leader: a point on the leader's trail.
   * `motion` is our own movement since the previous observation, from map odometry, when that is tracking.
   */
  decide(o: MapObservation | undefined, now: number, aim?: { dx: number; dy: number }, motion?: { dx: number; dy: number; tracked: boolean }): SteeringDecision {
    if (!o) return { kind: "hold", reason: "No observation." };
    if (!o.leaderFound || !o.leader || !o.offset) return { kind: "hold", reason: `${o.identity.name}'s map label is not visible.` };
    if (o.confidence < this.config.confidence) return { kind: "hold", reason: `Label confidence ${o.confidence} is below ${this.config.confidence}.`, distance: o.offset.distance };
    if (!o.originVerified) return { kind: "pause", reason: "Your own map marker is not at the calibrated map centre: a panel is open or the overlay map is hidden.", distance: o.offset.distance };
    const d = o.offset.distance;
    // Without odometry, a changing leader offset is the only sign that somebody moved.
    const step = motion?.tracked ? { dx: motion.dx, dy: motion.dy } : this.lastOffset ? { dx: this.lastOffset.dx - o.offset.dx, dy: this.lastOffset.dy - o.offset.dy } : { dx: 0, dy: 0 };
    this.lastOffset = { dx: o.offset.dx, dy: o.offset.dy };
    if (step.dx || step.dy) this.steps.push({ at: now, ...step });
    while (this.steps.length && now - this.steps[0].at > STUCK_MS * 2) this.steps.shift();
    if (this.travelled(now, STUCK_MS) >= STUCK_TOLERANCE_PX && !this.wall) { this.clicksSinceMoved = 0; this.checkedAt = now; }
    if (d <= (this.moving ? this.config.stopPx : this.config.resumePx)) { this.moving = false; this.reset(); return { kind: "near", reason: "Within following distance.", distance: d }; }
    if (!this.moving) { this.moving = true; this.checkedAt = now; this.clicksSinceMoved = 0; }
    const toward = aim && Math.hypot(aim.dx, aim.dy) > 1 ? aim : o.offset, reach = Math.hypot(toward.dx, toward.dy);
    const course = this.heading(Math.atan2(toward.dy, toward.dx), d, now);
    if (course === "rest") return { kind: "pause", reason: `Blocked: no way round found toward ${o.identity.name}. Resting before trying again.`, distance: d };
    if (now - this.lastClickAt < this.config.clickIntervalMs) return { kind: "hold", reason: "Pacing movement clicks.", distance: d };
    // Aim where the leader is on screen if the map scale is right; the clamp keeps clicks off our own feet and off the HUD.
    const radius = course.note ? o.view.height * .2 : Math.max(o.view.height * .06, Math.min(o.view.height * .26, reach * this.config.mapScale));
    let x = o.origin.x + Math.cos(course.angle) * radius, y = o.origin.y + Math.sin(course.angle) * radius;
    // The map centre is only near the view centre; pull the target in so the input worker never has to refuse it.
    const cx = o.view.width / 2, cy = o.view.height / 2, out = Math.hypot(x - cx, y - cy), limit = o.view.height * SAFE_DISC;
    if (out > limit) { x = cx + (x - cx) / out * limit; y = cy + (y - cy) / out * limit; }
    x = Math.max(0, Math.min(o.view.width - 1, Math.round(x))); y = Math.max(0, Math.min(o.view.height - 1, Math.round(y)));
    return { kind: "move", x, y, distance: d, reason: course.note ? `${course.note} to ${o.identity.name}, ${Math.round(d)} map px away.` : `${toward === o.offset ? "Move toward" : "Follow the path of"} ${o.identity.name}: ${Math.round(d)} map px away.` };
  }
  /** Call only when a click was really emitted (or previewed in dry-run): refused input must retry at once. */
  committed(now: number): void { this.lastClickAt = now; this.clicksSinceMoved++; }
}