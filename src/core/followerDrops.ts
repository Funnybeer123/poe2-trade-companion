import { lootArea, type LootLabel } from "./followerLoot.js";
import type { KeyPoint } from "./followerMapMarker.js";
import type { PixelRect } from "./followerPerception.js";

/**
 * Telling an item that dropped from the level's own furniture, which one frame of pixels cannot.
 *
 * A ground-item label the filter leaves unstyled is a near-black box with white text, and doors, area
 * transitions, waypoints, NPCs, chests and quest objects draw the identical box. Clicking an area
 * transition takes the character out of the zone and ends the follow, so the difference has to come from
 * somewhere other than the pixels: movement. Furniture is already standing there, so its label can only
 * come into view across an EDGE of the scanned area; an item that drops appears in the MIDDLE of ground
 * the previous scan could already see and reported nothing on. So a label first seen well inside what the
 * last scan showed was dropped, and one first seen at an edge — or with no usable scan to compare against
 * — is never trusted. Labels are carried between scans in the odometry frame, because the camera slides
 * under them; a verdict then stays with its label for as long as it is tracked.
 *
 * Feed it every label the scan found, before any leash or confidence filter: a label that drifts back
 * inside a filter would otherwise read as a fresh drop. The known hole: a furniture label that stops
 * being detected for longer than DROP_FORGET_MS (a spell effect over it, say) and comes back is a first
 * sighting again, and in mid-view that reads as a drop. Pure bookkeeping; nothing here emits OS input.
 */
export type DropVerdict = "dropped" | "furniture" | "unknown";
export interface DropCounts { labels: number; dropped: number; furniture: number; unknown: number; tracks: number }

/**
 * How far a first sighting must clear every edge of the scanned area, in screen px, both where it is now
 * and where the previous scan would have shown it. Two things make the edge untrustworthy: label runs
 * stop at the area, so a label crossing its side is reported as a narrow fragment that a rect test would
 * happily call "well inside"; and a label crossing the top or bottom is not reported at all until its flat
 * rows are in, so its first sighting is already a little way inside. Furniture is therefore first seen
 * within about half a label width of the edge it came in across (about 129 px for the 258 x 50 px
 * "Stitched Gloves" label measured on a 2560 x 1440 frame), and the camera cannot carry it further in one
 * 250 ms scan than the mapping-back step already accounts for. 120 px on top of the label's own width
 * covers that with room for prediction slop, and still leaves the middle ~1300 x 800 px of the scanned
 * area as ground a drop can be trusted on.
 */
export const DROP_EDGE_MARGIN = 120;
/** A label unseen this long is forgotten, and memory is capped, so a long session cannot grow without bound. */
export const DROP_FORGET_MS = 2000, DROP_MAX_TRACKS = 64;
// Matching slop, in screen px. Map pixels are whole numbers at about 7 screen px each and mapScale is a
// setting rather than a measurement, so a prediction is a few px out; labels stack about their own height
// apart, so the vertical gate stays well under that to stop a label claiming its neighbour's track. A
// label's text can change width between scans (a beam cutting its fill, a clipped edge), so widths are
// allowed to differ by a part of the wider one.
const MATCH_X = 48, MATCH_Y = 20, MATCH_HEIGHT = 8, MATCH_WIDTH = 48, MATCH_WIDTH_PART = .3, SHADOW_PX = 120;
// Two scans much further apart than the loop's 250 ms may have odometry ticks lost between them, which
// move the player without moving its position: too weak to judge a first sighting on.
const STALE_MS = 1500;

/** A box by its centre, which is what survives the label's text changing width; the reported rect's own x does not. */
interface Box { cx: number; cy: number; width: number; height: number }
interface Track extends Box { verdict: DropVerdict; seenAt: number }
const box = (r: PixelRect): Box => ({ cx: r.x + r.width / 2, cy: r.y + r.height / 2, width: r.width, height: r.height });
/** Any part of the box is still in the scanned area. */
const showing = (a: PixelRect, b: Box): boolean => b.cx + b.width / 2 > a.x && b.cx - b.width / 2 < a.x + a.width && b.cy + b.height / 2 > a.y && b.cy - b.height / 2 < a.y + a.height;
/** The whole box clears every edge of the scanned area by `margin`. */
const clear = (a: PixelRect, b: Box, margin: number): boolean => b.cx - b.width / 2 >= a.x + margin && b.cx + b.width / 2 <= a.x + a.width - margin && b.cy - b.height / 2 >= a.y + margin && b.cy + b.height / 2 <= a.y + a.height - margin;

export class DropWatch {
  private tracks: Track[] = [];
  private last?: { at: number; position: KeyPoint; epoch: number; tracked: boolean };
  private verdicts = new Map<LootLabel, DropVerdict>();
  private tally: DropCounts = { labels: 0, dropped: 0, furniture: 0, unknown: 0, tracks: 0 };
  /** One loot scan: every label it found (unfiltered), the view, where odometry says we are, and when. */
  observe(labels: LootLabel[], view: { width: number; height: number }, position: KeyPoint, epoch: number, tracked: boolean, mapScale: number, now: number): DropCounts {
    const area = lootArea(view), last = this.last;
    // Both scans must sit in one unbroken stretch of odometry, or the step between them is a guess.
    const usable = !!last && last.epoch === epoch && last.tracked && tracked && now - last.at <= STALE_MS;
    // The world slides opposite to the player, by mapScale screen px per map px of the step.
    const shift = usable ? { x: (position.x - last!.position.x) * mapScale, y: (position.y - last!.position.y) * mapScale } : undefined;
    this.last = { at: now, position: { x: position.x, y: position.y }, epoch, tracked };
    this.verdicts = new Map();
    if (!shift) this.tracks = [];
    else for (const t of this.tracks) { t.cx -= shift.x; t.cy -= shift.y; }
    // A label whose place has slid off the scanned area is gone for good: coming back is a first sighting again.
    this.tracks = this.tracks.filter(t => now - t.seenAt <= DROP_FORGET_MS && showing(area, t));
    const seen = labels.map(l => box(l.rect)), pairs: Array<{ s: number; t: number; cost: number }> = [];
    for (let s = 0; s < seen.length; s++) for (let t = 0; t < this.tracks.length; t++) {
      const a = seen[s], b = this.tracks[t], dx = a.cx - b.cx, dy = a.cy - b.cy, dw = Math.abs(a.width - b.width);
      if (Math.abs(dx) > MATCH_X || Math.abs(dy) > MATCH_Y || Math.abs(a.height - b.height) > MATCH_HEIGHT || dw > Math.max(MATCH_WIDTH, MATCH_WIDTH_PART * Math.max(a.width, b.width))) continue;
      pairs.push({ s, t, cost: Math.hypot(dx, dy) + dw * .25 });
    }
    // Best pair first, each label and each track used once, so two labels close together cannot swap.
    const matched = new Array<number>(seen.length).fill(-1), taken = new Set<number>();
    for (const p of pairs.sort((a, b) => a.cost - b.cost)) { if (matched[p.s] >= 0 || taken.has(p.t)) continue; matched[p.s] = p.t; taken.add(p.t); }
    const counts: DropCounts = { labels: seen.length, dropped: 0, furniture: 0, unknown: 0, tracks: 0 };
    for (let s = 0; s < seen.length; s++) {
      const a = seen[s], held = matched[s] >= 0 ? this.tracks[matched[s]] : undefined;
      let track: Track;
      if (held) { held.cx = a.cx; held.cy = a.cy; held.width = a.width; held.height = a.height; held.seenAt = now; track = held; }
      else {
        const verdict: DropVerdict = !shift ? "unknown"
          // Judged where the previous scan would have drawn it: it had a clear view of that ground and reported nothing.
          : !clear(area, a, DROP_EDGE_MARGIN) || !clear(area, { ...a, cx: a.cx + shift.x, cy: a.cy + shift.y }, DROP_EDGE_MARGIN) ? "furniture"
          // A first sighting where a label we just lost was expected could be that same label, mispredicted.
          : this.tracks.some((t, i) => !taken.has(i) && Math.hypot(a.cx - t.cx, a.cy - t.cy) <= SHADOW_PX) ? "unknown" : "dropped";
        track = { ...a, verdict, seenAt: now };
        this.tracks.push(track);
      }
      this.verdicts.set(labels[s], track.verdict);
      counts[track.verdict]++;
    }
    // Newest sighting kept: a screen full of labels cannot push memory past the cap.
    if (this.tracks.length > DROP_MAX_TRACKS) this.tracks = this.tracks.sort((x, y) => y.seenAt - x.seenAt).slice(0, DROP_MAX_TRACKS);
    counts.tracks = this.tracks.length;
    this.tally = counts;
    return counts;
  }
  /** The verdict for a label from the latest scan; anything else is unknown. */
  verdict(label: LootLabel): DropVerdict { return this.verdicts.get(label) ?? "unknown"; }
  /** The gate for a loot click: this label is an item that fell on ground we could already see. */
  dropped(label: LootLabel): boolean { return this.verdict(label) === "dropped"; }
  /** The latest scan's tally, for the status line. */
  get counts(): DropCounts { return this.tally; }
  /** Labels remembered, never more than DROP_MAX_TRACKS. */
  get size(): number { return this.tracks.length; }
}
