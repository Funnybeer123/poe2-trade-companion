import type { KeyPoint } from "./followerMapMarker.js";
import type { PixelRect } from "./followerPerception.js";

/**
 * The teleport confirmation. Clicking the party frame's travel button opens a modal — "Are you sure you want to
 * teleport to this player's location?" with CANCEL and OK — and until OK is clicked nothing happens: the teleport
 * never completes, and the dialog covers the map centre, so the follower cannot even verify its own marker and
 * pauses on that forever.
 *
 * Recognising it is a shape test, with darkness only as a veto. The modal dims a wide band across the middle of
 * the view, so a played scene there is thirty to sixty times brighter and is refused on the count alone — but how
 * much light is left in the dimmed band is the scene's business, and over a cave or a night zone the same modal
 * counts almost nothing. What the modal draws whatever is behind it is its two buttons, at measured fractions of
 * the view; their pixels are the evidence. Pure functions over captured pixels; nothing here emits OS input.
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
 * it sends: 4000 is 3.2x the measured dialog and 9x under played pixels. There is no floor on the count any more.
 * A floor of 120 was what kept the black loading screen of an accepted teleport from reading as a modal, but the
 * modal dims the scene behind it and cannot light it, so over a dark zone the whole band holds a handful of
 * points and falls under any such floor — measured live as a travel click with no confirmation after it and a
 * teleport that never happened. Telling those two apart is a question of where the points are, not how many.
 */
export const CONFIRM_POINT_CAP = 6000, CONFIRM_MAX_POINTS = 4000;

/**
 * The OK button's centre, measured at (1732, 764) — x 1595..1870, y 728..800 — and CANCEL's at (948, 764) on a
 * 2560 x 1440 view. The pair is not centred on the view (their midpoint is x 1340), so CANCEL is its own
 * measurement and not OK mirrored. OK is always the right-hand one and is the only one ever clicked.
 */
export const CONFIRM_OK = { x: .6766, y: .5306 } as const;
export const CONFIRM_CANCEL = { x: .3703, y: .5306 } as const;
export const confirmOk = (view: { width: number; height: number }): KeyPoint => ({ x: Math.round(view.width * CONFIRM_OK.x), y: Math.round(view.height * CONFIRM_OK.y) });

/**
 * A box round each button centre. The measured button is 275 x 72 px, or .107w x .05h, so ±.075w x ±.04h holds it
 * with ~55 px of horizontal and ~21 px of vertical slack at 2560 x 1440 for a modal that sits a little differently
 * at another aspect ratio. Both boxes stay inside the scanned band at any view, and the gap between them is wider
 * than either, so no point is ever counted for both buttons.
 */
const BUTTON = { halfWidth: .075, halfHeight: .04 };
/**
 * What a lit button is worth. Each box is 9.7% of the band's area, so the one measured dialog frame — 1253 points
 * — puts ~120 in each box from the dimmed scene alone, before any of the button's own pixels. Eight is fifteen
 * times under the measurement it has to keep accepting, and a count rather than a fraction of the box because it
 * has to survive a dark scene lending it nothing: it is a floor on evidence a loading screen cannot produce, since
 * black gives none anywhere and a spinner or a hint line gives them in one place, not in two that match both
 * measured buttons to within a few percent of the view. Being a count, it shrinks with the view — the same dialog
 * carries ~66 per box at 1920 x 1080 and ~32 at 1280 x 720, the smallest the game runs at, so four times over.
 */
export const CONFIRM_BUTTON_POINTS = 8;

const inBox = (p: KeyPoint, centre: { x: number; y: number }, view: { width: number; height: number }): boolean =>
  Math.abs(p.x - view.width * centre.x) <= view.width * BUTTON.halfWidth && Math.abs(p.y - view.height * centre.y) <= view.height * BUTTON.halfHeight;
/** How many of `points` land on each button. Absolute view coordinates: the worker returns client pixels, not band-relative ones. */
export function confirmButtons(points: KeyPoint[], view: { width: number; height: number }): { ok: number; cancel: number } {
  let ok = 0, cancel = 0;
  for (const p of points) { if (inBox(p, CONFIRM_OK, view)) ok++; else if (inBox(p, CONFIRM_CANCEL, view)) cancel++; }
  return { ok, cancel };
}

export interface ConfirmDialog { ok: KeyPoint }
/**
 * Where to click OK, or nothing when the band is not the modal. `points` left out is the caller saying the scan
 * failed, and `overflow` is the worker saying it gave up at the cap — a lit scene, so not the dialog. Both buttons
 * being lit is what decides it; the count only rules out a scene too bright to have a dimming modal over it. The
 * evidence is therefore gathered where the click is about to go: we never click OK on a frame that shows nothing
 * there.
 */
export function confirmDialog(points: KeyPoint[] | undefined, view: { width: number; height: number }, overflow = false): ConfirmDialog | undefined {
  if (!points || overflow || points.length > CONFIRM_MAX_POINTS) return undefined;
  const lit = confirmButtons(points, view);
  if (lit.ok < CONFIRM_BUTTON_POINTS || lit.cancel < CONFIRM_BUTTON_POINTS) return undefined;
  return { ok: confirmOk(view) };
}
