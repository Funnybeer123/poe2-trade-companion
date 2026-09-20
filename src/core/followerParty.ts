import type { KeyPoint } from "./followerMapMarker.js";
import type { PixelRect } from "./followerPerception.js";

/**
 * Crossing areas. The leader's map marker exists only while we share an area, so stairs, a portal or
 * an area transition simply deletes it and the follower holds forever. Path of Exile 2's party frame
 * carries a "travel to party member" button — a blue swirl — per member, and clicking it teleports us
 * to them: finding that button is how following continues across areas.
 *
 * The button is drawn with identical pixels whether the leader is beside us or an act away, so its
 * presence is never a "they left" signal; that is the marker having been absent for a while.
 * Pure functions over captured pixels; nothing here emits OS input.
 */
export const PARTY_CHANNEL = "blue" as const, PARTY_THRESHOLD = 60;
/** More blue than this in so small a strip is a panel or a spell effect, not a party frame. */
export const PARTY_POINT_CAP = 3000;

/** The party frame's strip down the left edge, measured at x 0..90, y 250..670 on a 2560 x 1440 view. */
export function partyBand(view: { width: number; height: number }): PixelRect {
  // The party frame scales with view height, so every fraction below is of height, x included.
  const right = Math.round(view.height * .0625), top = Math.round(view.height * .1736), bottom = Math.round(view.height * .4653);
  return { x: 0, y: top, width: Math.min(view.width, right), height: Math.max(1, Math.min(view.height, bottom) - top) };
}
/** The name the follower service asks for the band by. */
export const PARTY_BAND = partyBand;

/**
 * Measured at 2560 x 1440: a 28 x 28 button (x 11..38, y 322..349) holding 423 points at threshold 60.
 * Sizes are fractions of view height so they hold at any resolution; the point floor is a fraction of
 * the button's own area, which is .54 full when measured, so .35 leaves margin for a dimmer swirl.
 */
const BUTTON_SIDE = 28 / 1440, SIDE_TOLERANCE = .006, MIN_FILL = .35, JOIN_GAP = .002, MAX_ASPECT = 1.4;

export interface TravelButton { centre: KeyPoint; pixels: number }
interface Blob { left: number; top: number; right: number; bottom: number; count: number }

/** Flood-fills sparse points into blobs, joining anything within `gap` px: anti-aliasing breaks the swirl up. */
function blobs(points: KeyPoint[], gap: number): Blob[] {
  const key = (x: number, y: number) => y * 8192 + x, index = new Map<number, number>();
  points.forEach((p, i) => index.set(key(p.x, p.y), i));
  const seen = new Uint8Array(points.length), found: Blob[] = [];
  for (let i = 0; i < points.length; i++) {
    if (seen[i]) continue;
    seen[i] = 1;
    const start = points[i], stack = [i], blob: Blob = { left: start.x, top: start.y, right: start.x, bottom: start.y, count: 0 };
    while (stack.length) {
      const p = points[stack.pop()!];
      blob.count++;
      blob.left = Math.min(blob.left, p.x); blob.top = Math.min(blob.top, p.y);
      blob.right = Math.max(blob.right, p.x); blob.bottom = Math.max(blob.bottom, p.y);
      for (let dy = -gap; dy <= gap; dy++) for (let dx = -gap; dx <= gap; dx++) {
        const j = index.get(key(p.x + dx, p.y + dy));
        if (j !== undefined && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    found.push(blob);
  }
  return found;
}

/**
 * The travel button in a sparse blue scan of the party band, or nothing when the band holds no blob of
 * the measured size, shape and density. With a whole party on screen the buttons stack downward, one per
 * member, so the topmost is the first member's: the leader we were told to follow.
 */
export function findTravelButton(points: KeyPoint[], view: { width: number; height: number }): TravelButton | undefined {
  if (!points.length || points.length > PARTY_POINT_CAP) return undefined;
  const side = view.height * BUTTON_SIDE, slack = view.height * SIDE_TOLERANCE;
  const min = side - slack, max = side + slack, floor = Math.max(24, Math.round(side * side * MIN_FILL)), gap = Math.max(1, Math.round(view.height * JOIN_GAP));
  let best: (TravelButton & { top: number }) | undefined;
  for (const blob of blobs(points, gap)) {
    const width = blob.right - blob.left + 1, height = blob.bottom - blob.top + 1;
    if (width < min || width > max || height < min || height > max) continue;
    if (Math.max(width, height) / Math.min(width, height) > MAX_ASPECT) continue;
    if (blob.count < floor) continue;
    if (best && blob.top >= best.top) continue;
    best = { centre: { x: Math.round((blob.left + blob.right) / 2), y: Math.round((blob.top + blob.bottom) / 2) }, pixels: blob.count, top: blob.top };
  }
  return best && { centre: best.centre, pixels: best.pixels };
}
