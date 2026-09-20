import type { KeyPoint } from "./followerMapMarker.js";
import type { PixelRect } from "./followerPerception.js";

/**
 * The teleport confirmation. Clicking the party frame's travel button opens a modal — "Are you sure you want to
 * teleport to this player's location?" with CANCEL and OK — and until OK is clicked nothing happens: the teleport
 * never completes, and the dialog covers the map centre, so the follower cannot even verify its own marker and
 * pauses on that forever.
 *
 * Recognising the modal is a darkness test, not a shape one: it dims a wide band across the middle of the view,
 * and a played scene in that same band is thirty to sixty times brighter. The answer is only meaningful in the
 * seconds after a travel click, when the modal is the one thing that can be covering the view. Pure functions over
 * captured pixels; nothing here emits OS input.
 */
export const CONFIRM_CHANNEL = "white" as const, CONFIRM_THRESHOLD = 110;

/** The band the modal dims, measured at x 563..1997, y 547..864 on a 2560 x 1440 view. */
export function confirmBand(view: { width: number; height: number }): PixelRect {
  const left = Math.round(view.width * .22), right = Math.round(view.width * .78), top = Math.round(view.height * .38), bottom = Math.round(view.height * .60);
  return { x: left, y: top, width: Math.max(1, Math.min(view.width, right) - left), height: Math.max(1, Math.min(view.height, bottom) - top) };
}
/** The name the follower service asks for the band by. */
export const CONFIRM_BAND = confirmBand;

/**
 * Counted with the capture worker's own white channel at threshold 110 inside that band on real 2560 x 1440
 * frames: 1253 points with the dialog up, 36767 and 75234 on two frames of ordinary play. The cap abandons the
 * scan the moment it is passed, so a bright scene answers "not the dialog" by overflowing and costs nothing:
 * 6000 sits near the geometric middle of 1253 and 36767 — 4.8x over the dialog, 6.1x under the dimmest played
 * frame — and is the worker's own default cap. The ceiling is re-checked here because the caller chooses the cap
 * it sends: 4000 is 3.2x the measured dialog and 9x under played pixels. The floor is what keeps a black loading
 * screen — exactly what an accepted teleport shows next — from reading as a modal, while staying far under the
 * modal's own text and button borders. These are counts, and the band is 454k px at 2560 x 1440, so the same
 * dialog counts ~310 at 1280 x 720 and ~2800 at 4K: still inside both bounds.
 */
export const CONFIRM_POINT_CAP = 6000, CONFIRM_MAX_POINTS = 4000, CONFIRM_MIN_POINTS = 120;

/**
 * The OK button's centre, measured at (1732, 764) — x 1595..1870, y 728..800 — on a 2560 x 1440 view. CANCEL is
 * the other button, left of centre near x 948, and is never a target: OK is always the right-hand one.
 */
export const CONFIRM_OK = { x: .6766, y: .5306 } as const;
export const confirmOk = (view: { width: number; height: number }): KeyPoint => ({ x: Math.round(view.width * CONFIRM_OK.x), y: Math.round(view.height * CONFIRM_OK.y) });

export interface ConfirmDialog { ok: KeyPoint }
/**
 * Where to click OK, or nothing when the band is not the modal's darkness. `points` left out is the caller saying
 * the scan failed, and `overflow` is the worker saying it gave up at the cap — a lit scene, so not the dialog.
 * Only how many points came back decides it; where they are carries no signal a dimmed rectangle can be told by.
 */
export function confirmDialog(points: KeyPoint[] | undefined, view: { width: number; height: number }, overflow = false): ConfirmDialog | undefined {
  if (!points || overflow || points.length > CONFIRM_MAX_POINTS || points.length < CONFIRM_MIN_POINTS) return undefined;
  return { ok: confirmOk(view) };
}
