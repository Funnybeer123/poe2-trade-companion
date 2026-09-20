import type { PixelRect } from "./followerPerception.js";

/**
 * Ground-item labels from horizontal runs the capture worker reports. Two kinds of run find two kinds
 * of label, both measured on real frames:
 * - Flat-colour runs. An opaque or nearly opaque fill is a few rows of one colour across the label's
 *   width (top padding), rows broken up by text, then flat rows again, all with the same left and right
 *   edges. Rendered scenery almost never produces that.
 * - Hue runs. A translucent label with a vivid border, fill and text is too noisy to be flat, and a drop
 *   beam behind it shifts its brightness, but it keeps one hue from edge to edge on nearly every row.
 *
 * Only coloured fills count. Doors, area transitions, waypoints, NPCs and unfiltered items all use the
 * same near-black box with white text, and nothing in the pixels tells them apart: use an item filter
 * that gives wanted items a coloured background. The rule enforced: a flat fill must reach
 * LOOT_MIN_BRIGHTNESS, and below LOOT_DIM it must also be coloured (chroma at least LOOT_DIM_CHROMA %
 * of its brightest channel), so a black box lifted by a bright neutral backdrop is dropped. One lifted
 * by a warm backdrop (sand) cannot be told from a dim coloured fill; the game's label opacity is unmeasured.
 * Pure functions; nothing here emits OS input.
 */
export interface FlatRun { y: number; x0: number; x1: number; r: number; g: number; b: number }
/** A run of one hue class: 1..12 for 30° hue buckets offset by 15°, never 0 (dark or unsaturated). */
export interface HueRun { y: number; x0: number; x1: number; hue: number }
/** Same integer arithmetic as HueClass() in scripts/win-follower-host.ps1. */
export function hueClass(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b), chroma = max - Math.min(r, g, b);
  if (max < 45 || chroma * 100 < 50 * max) return 0;
  // C# truncates the quotient before adding the offset; truncating the sum differs when the quotient is negative.
  const q = (n: number) => Math.trunc(60 * n / chroma), hue = max === r ? q(g - b) : max === g ? q(b - r) + 120 : q(r - g) + 240;
  return Math.trunc((hue + 375) % 360 / 30) + 1;
}
export interface LootLabel { rect: PixelRect; centre: { x: number; y: number }; colour: { r: number; g: number; b: number }; /** Set for labels found by hue rather than flat colour. */ hue?: number; confidence: number }
export interface LootDecision { kind: "loot" | "idle" | "backoff"; label?: LootLabel; reason: string }

/** The part of the client where world labels can be clicked: clear of the HUD, party frames, chat input and quest tracker. */
export function lootArea(view: { width: number; height: number }): PixelRect {
  const x = Math.round(view.width * .10), y = Math.round(view.height * .05);
  return { x, y, width: Math.round(view.width * .80) - x, height: Math.round(view.height * .80) - y };
}
export const LOOT_MIN_RUN = 48, LOOT_MIN_BRIGHTNESS = 45, LOOT_DIM = 110, LOOT_DIM_CHROMA = 35;
/** The gate for loot clicks, separate from the leader-label preference. Every label findLootLabels returns passes it. */
export const LOOT_MIN_CONFIDENCE = .85;

export function decodeFlatRuns(base64: unknown): FlatRun[] {
  if (typeof base64 !== "string") throw new Error("Capture worker returned no label runs.");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length % 9) throw new Error("Capture worker returned malformed label runs.");
  const runs: FlatRun[] = [];
  for (let i = 0; i < bytes.length; i += 9) runs.push({ y: bytes.readUInt16LE(i), x0: bytes.readUInt16LE(i + 2), x1: bytes.readUInt16LE(i + 4), r: bytes[i + 6], g: bytes[i + 7], b: bytes[i + 8] });
  return runs;
}

export function decodeHueRuns(base64: unknown): HueRun[] {
  if (typeof base64 !== "string") throw new Error("Capture worker returned no hue runs.");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length % 7) throw new Error("Capture worker returned malformed hue runs.");
  const runs: HueRun[] = [];
  for (let i = 0; i < bytes.length; i += 7) runs.push({ y: bytes.readUInt16LE(i), x0: bytes.readUInt16LE(i + 2), x1: bytes.readUInt16LE(i + 4), hue: bytes[i + 6] });
  return runs;
}

// A translucent fill lets scenery and map lines show through, which clips its flat rows a few pixels
// differently from row to row; the clipped band is still centred on the label, which is all a click needs.
const EDGE = 8, COLOUR = 16, PADDING_ROWS = 3, TEXT_ROWS = 8, BAND_GAP = 3, JOIN_GAP = 40, JOIN_COLOUR = 48, HUE_EDGE = 3, HUE_COVERAGE = .45, HUE_ROW_GAP = 4, HUE_MAX_CONFIDENCE = .95;
interface Piece { x0: number; x1: number }
/** Rows with shared edges. Joining can bridge the gap between two neighbouring labels, so the pieces the worker really reported decide where to click. */
interface Span { x0: number; x1: number; rows: number[]; mid: number; covered: number; px0: number; px1: number }
const span = (x0: number, x1: number, y: number): Span => ({ x0, x1, rows: [y], mid: Math.round((x0 + x1) / 2), covered: 0, px0: 0, px1: -1 });
function addPieces(g: Span, pieces: Piece[]): void {
  for (const p of pieces) { if (p.x0 <= g.mid && g.mid <= p.x1) g.covered++; else if (p.x1 - p.x0 > g.px1 - g.px0) { g.px0 = p.x0; g.px1 = p.x1; } }
}
/** The union midpoint when real runs cover it on most rows, else the middle of the longest real piece beside it. */
const clickX = (g: Span): number => g.covered * 2 >= g.rows.length || g.px1 < g.px0 ? g.mid : Math.round((g.px0 + g.px1) / 2);
/** Labels found in one scan, nearest to `from` first. */
export function findLootLabels(runs: FlatRun[], view: { width: number; height: number }, from: { x: number; y: number }, hueRuns: HueRun[] = []): LootLabel[] {
  const minHeight = view.height * .025, maxHeight = view.height * .065, maxWidth = view.width * .4;
  const groups: Array<Span & { r: number; g: number; b: number; bands: number }> = [];
  // Something bright behind a translucent label (a drop beam, a spell) cuts its flat rows in two: rejoin
  // same-coloured pieces of one row across a short gap before looking for the label's edges.
  const joined: Array<FlatRun & { pieces: Piece[] }> = [];
  for (const run of [...runs].sort((a, b) => a.y - b.y || a.x0 - b.x0)) {
    const left = joined[joined.length - 1];
    if (left && left.y === run.y && run.x0 - left.x1 <= JOIN_GAP && Math.abs(left.r - run.r) <= JOIN_COLOUR && Math.abs(left.g - run.g) <= JOIN_COLOUR && Math.abs(left.b - run.b) <= JOIN_COLOUR) { left.x1 = Math.max(left.x1, run.x1); left.pieces.push({ x0: run.x0, x1: run.x1 }); }
    else joined.push({ ...run, pieces: [{ x0: run.x0, x1: run.x1 }] });
  }
  for (const run of joined) {
    const max = Math.max(run.r, run.g, run.b), chroma = max - Math.min(run.r, run.g, run.b);
    if (max < LOOT_MIN_BRIGHTNESS || (max < LOOT_DIM && chroma * 100 < LOOT_DIM_CHROMA * max)) continue;
    const group = groups.find(g => Math.abs(g.x0 - run.x0) <= EDGE && Math.abs(g.x1 - run.x1) <= EDGE && Math.abs(g.r - run.r) <= COLOUR && Math.abs(g.g - run.g) <= COLOUR && Math.abs(g.b - run.b) <= COLOUR
      // A label is two flat bands around its text. A third band is the next label stacked underneath.
      && run.y - g.rows[0] < maxHeight && run.y !== g.rows[g.rows.length - 1] && (run.y - g.rows[g.rows.length - 1] <= BAND_GAP || g.bands < 2));
    if (group) { if (run.y - group.rows[group.rows.length - 1] > BAND_GAP) group.bands++; group.rows.push(run.y); addPieces(group, run.pieces); }
    else { const made = { ...span(run.x0, run.x1, run.y), r: run.r, g: run.g, b: run.b, bands: 1 }; addPieces(made, run.pieces); groups.push(made); }
  }
  const labels: LootLabel[] = [];
  for (const g of groups) {
    const top = g.rows[0], bottom = g.rows[g.rows.length - 1], height = bottom - top + 1, width = g.x1 - g.x0 + 1;
    if (height < minHeight || height > maxHeight || width < height * 1.2 || width > maxWidth) continue;
    // Flat rows at the top and bottom, and enough broken rows between them to hold text.
    let topRows = 1; while (topRows < g.rows.length && g.rows[topRows] === top + topRows) topRows++;
    let bottomRows = 1; while (bottomRows < g.rows.length && g.rows[g.rows.length - 1 - bottomRows] === bottom - bottomRows) bottomRows++;
    if (topRows < PADDING_ROWS || bottomRows < PADDING_ROWS || height - g.rows.length < TEXT_ROWS) continue;
    labels.push({ rect: { x: g.x0, y: top, width, height }, centre: { x: clickX(g), y: Math.round((top + bottom) / 2) }, colour: { r: g.r, g: g.g, b: g.b },
      confidence: Math.min(1, .8 + Math.min(topRows, bottomRows) * .04) });
  }
  // Hue labels: one hue from edge to edge, with the same edges, on at least HUE_COVERAGE of the rows.
  const hueJoined: Array<HueRun & { pieces: Piece[] }> = [];
  for (const run of [...hueRuns].sort((a, b) => a.y - b.y || a.x0 - b.x0)) {
    const left = hueJoined[hueJoined.length - 1];
    if (left && left.y === run.y && left.hue === run.hue && run.x0 - left.x1 <= JOIN_GAP) { left.x1 = Math.max(left.x1, run.x1); left.pieces.push({ x0: run.x0, x1: run.x1 }); }
    else if (run.hue > 0) hueJoined.push({ ...run, pieces: [{ x0: run.x0, x1: run.x1 }] });
  }
  // Grouped by row contiguity, so a tall block of one hue stays one group and fails the height limit
  // whole instead of leaving a label-sized remainder.
  const hueGroups: Array<Span & { hue: number }> = [];
  for (const run of hueJoined) {
    const group = hueGroups.find(g => g.hue === run.hue && Math.abs(g.x0 - run.x0) <= HUE_EDGE && Math.abs(g.x1 - run.x1) <= HUE_EDGE && run.y !== g.rows[g.rows.length - 1] && run.y - g.rows[g.rows.length - 1] <= HUE_ROW_GAP);
    if (group) { group.rows.push(run.y); addPieces(group, run.pieces); }
    else { const made = { ...span(run.x0, run.x1, run.y), hue: run.hue }; addPieces(made, run.pieces); hueGroups.push(made); }
  }
  const scan = lootArea(view), scanBottom = scan.y + scan.height - 1;
  for (const g of hueGroups) {
    const top = g.rows[0], bottom = g.rows[g.rows.length - 1], height = bottom - top + 1, width = g.x1 - g.x0 + 1, coverage = g.rows.length / height;
    if (height < minHeight || height > maxHeight || width < height * 1.5 || width > maxWidth || coverage < HUE_COVERAGE) continue;
    // A block on the first or last scanned row may continue outside the scan, where its height is unknown.
    if (top <= scan.y || bottom >= scanBottom) continue;
    // Nothing at run level tells a label from a solid block of its size, so a hue label never earns full confidence.
    labels.push({ rect: { x: g.x0, y: top, width, height }, centre: { x: clickX(g), y: Math.round((top + bottom) / 2) }, colour: { r: 0, g: 0, b: 0 }, hue: g.hue, confidence: Math.min(HUE_MAX_CONFIDENCE, Math.round((.78 + coverage * .22) * 100) / 100) });
  }
  // One label can yield several overlapping bands; keep the widest of each pile.
  const distinct: LootLabel[] = [];
  for (const label of labels.filter(l => l.confidence >= LOOT_MIN_CONFIDENCE).sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height)) {
    const r = label.rect;
    if (!distinct.some(d => r.x < d.rect.x + d.rect.width && d.rect.x < r.x + r.width && r.y < d.rect.y + d.rect.height && d.rect.y < r.y + r.height)) distinct.push(label);
  }
  return distinct.sort((a, b) => Math.hypot(a.centre.x - from.x, a.centre.y - from.y) - Math.hypot(b.centre.x - from.x, b.centre.y - from.y));
}

const CONFIRM_SCANS = 2, MAX_BACKOFF_DOUBLINGS = 4;
export interface LootConfig { clickIntervalMs: number; maxAttempts: number; backoffMs: number }
export const DEFAULT_LOOT_CONFIG: LootConfig = { clickIntervalMs: 450, maxAttempts: 5, backoffMs: 6000 };
/**
 * Picks the nearest label and paces clicks so the character can walk to the item and pick it up.
 * Labels move as the camera moves, so an item cannot be recognised from one scan to the next; a
 * full inventory or an unreachable item therefore shows up as clicks that never reduce the number
 * of labels. After maxAttempts such clicks looting backs off instead of clicking forever, twice as long
 * each time. Detection flickers, so a lower count or an empty view only counts once it is seen on
 * CONFIRM_SCANS scans in a row, and no click is made while a lower count is being confirmed.
 */
export class LootPlanner {
  private lastClickAt = -Infinity;
  private fruitless = 0;
  private labelsAtLastClick = Infinity;
  private backoffUntil = -Infinity;
  private lowerScans = 0;
  private emptyScans = 0;
  private backoffs = 0;
  constructor(private readonly config: LootConfig = DEFAULT_LOOT_CONFIG) {}
  decide(labels: LootLabel[], now: number): LootDecision {
    if (!labels.length) {
      if (++this.emptyScans >= CONFIRM_SCANS) { this.fruitless = 0; this.backoffs = 0; this.lowerScans = 0; this.labelsAtLastClick = Infinity; }
      return { kind: "idle", reason: "No loot labels in view." };
    }
    this.emptyScans = 0;
    if (this.labelsAtLastClick !== Infinity && labels.length < this.labelsAtLastClick) {
      // A pickup stays picked up; a flicker is back on the next scan. Clicking now would overwrite the count being compared.
      if (++this.lowerScans < CONFIRM_SCANS) return { kind: "idle", label: labels[0], reason: "Confirming a pickup." };
      this.fruitless = 0; this.backoffs = 0; this.labelsAtLastClick = labels.length;
    }
    this.lowerScans = 0;
    if (now < this.backoffUntil) return { kind: "backoff", reason: "Loot clicks are not picking anything up (inventory full or out of reach); waiting before trying again." };
    if (now - this.lastClickAt < this.config.clickIntervalMs) return { kind: "idle", label: labels[0], reason: "Walking to the last loot click." };
    if (this.fruitless >= this.config.maxAttempts) { this.fruitless = 0; this.backoffUntil = now + this.config.backoffMs * 2 ** Math.min(this.backoffs++, MAX_BACKOFF_DOUBLINGS); return { kind: "backoff", reason: "Loot clicks are not picking anything up (inventory full or out of reach); waiting before trying again." }; }
    return { kind: "loot", label: labels[0], reason: `Pick up the nearest of ${labels.length} loot label${labels.length === 1 ? "" : "s"}.` };
  }
  /** Call only when the click was really emitted (or previewed in dry-run). */
  committed(labelsInView: number, now: number): void { this.lastClickAt = now; this.fruitless++; this.labelsAtLastClick = labelsInView; }
  /** True while the character should be left alone to reach the item it was sent to. */
  busy(now: number): boolean { return now - this.lastClickAt < this.config.clickIntervalMs; }
}
