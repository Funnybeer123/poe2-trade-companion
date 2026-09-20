import { describe, expect, it } from "vitest";
import { CONFIRM_BAND, CONFIRM_BUTTON_POINTS, CONFIRM_CANCEL, CONFIRM_CHANNEL, CONFIRM_MAX_POINTS, CONFIRM_OK, CONFIRM_POINT_CAP, CONFIRM_THRESHOLD, confirmBand, confirmButtons, confirmDialog, confirmOk } from "../src/core/followerConfirm.js";
import type { KeyPoint } from "../src/core/followerMapMarker.js";

// The counts are the real ones, measured on 2560 x 1440 captures in the band below at threshold 110: the teleport
// modal, then two frames of ordinary play. The points are synthetic, but their PLACES now decide the answer, so
// they are laid out the way the real ones are: the dimmed scene spread over the band, the buttons where measured.
const VIEW = { width: 2560, height: 1440 }, SMALL = { width: 1920, height: 1080 }, LOW = { width: 1280, height: 720 }, TINY = { width: 640, height: 360 };
const DIALOG = 1253, PLAYED = [36767, 75234], OLD_FLOOR = 120;
/** The OK button as measured: x 1595..1870, y 728..800 at 2560 x 1440. */
const OK_BOX = { left: 1595, right: 1870, top: 728, bottom: 800 };
const OK_AT = { x: 1732, y: 764 };

/** `count` points spread evenly over the whole band: the scene the modal dimmed, showing through it. */
const spread = (count: number, view = VIEW): KeyPoint[] => {
  const b = confirmBand(view), step = b.width * b.height / count;
  return Array.from({ length: count }, (_, i) => { const at = Math.floor(i * step); return { x: b.x + at % b.width, y: b.y + Math.floor(at / b.width) }; });
};
/** `count` points on one button, filling its measured .107w x .05h box from the top-left corner outward. */
const onButton = (count: number, centre: { x: number; y: number }, view = VIEW): KeyPoint[] => {
  const w = Math.round(view.width * .107), h = Math.round(view.height * .05);
  const left = Math.round(view.width * centre.x) - (w >> 1), top = Math.round(view.height * centre.y) - (h >> 1);
  return Array.from({ length: count }, (_, i) => ({ x: left + i % w, y: top + Math.floor(i / w) % h }));
};
/** `count` points crowded into the band's top-left corner: bright, and nowhere near either button. */
const corner = (count: number, view = VIEW): KeyPoint[] => {
  const b = confirmBand(view);
  return Array.from({ length: count }, (_, i) => ({ x: b.x + i % 40, y: b.y + Math.floor(i / 40) }));
};
/** A dialog over a scene dark enough that the band holds almost nothing but the two buttons. */
const darkModal = (per = 20, view = VIEW): KeyPoint[] => [...onButton(per, CONFIRM_OK, view), ...onButton(per, CONFIRM_CANCEL, view), ...corner(15, view)];

describe("teleport confirmation (two measured buttons inside the measured band)", () => {
  it("scans the measured band with the capture worker's existing white channel", () => {
    expect([CONFIRM_CHANNEL, CONFIRM_THRESHOLD]).toEqual(["white", 110]);
    expect(CONFIRM_BAND).toBe(confirmBand);
    expect(confirmBand(VIEW)).toEqual({ x: 563, y: 547, width: 1434, height: 317 });
    expect(confirmBand(SMALL)).toEqual({ x: 422, y: 410, width: 1076, height: 238 });
    // What we scan covers what we weigh and what we click: both buttons sit inside the one band, at every size,
    // so the evidence costs no second scan and no second threshold.
    for (const view of [VIEW, SMALL, TINY]) {
      const b = confirmBand(view), where = `${view.width}x${view.height}`;
      const inside = (p: KeyPoint) => p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
      expect(inside(confirmOk(view)), where).toBe(true);
      for (const centre of [CONFIRM_OK, CONFIRM_CANCEL]) for (const dx of [-.075, .075]) for (const dy of [-.04, .04])
        expect(inside({ x: Math.round(view.width * (centre.x + dx)), y: Math.round(view.height * (centre.y + dy)) }), `${where} ${centre.x}`).toBe(true);
    }
  });

  it("weighs the measured buttons, and counts nothing between or beside them", () => {
    // Every corner of the OK button as measured, and its centre, is OK evidence; CANCEL's measured centre is CANCEL's.
    const corners = [{ x: OK_BOX.left, y: OK_BOX.top }, { x: OK_BOX.right, y: OK_BOX.bottom }, { x: OK_BOX.left, y: OK_BOX.bottom }, { x: OK_BOX.right, y: OK_BOX.top }, OK_AT];
    expect(confirmButtons(corners, VIEW)).toEqual({ ok: 5, cancel: 0 });
    expect(confirmButtons([{ x: 948, y: 764 }], VIEW)).toEqual({ ok: 0, cancel: 1 });
    // The gap between the buttons is wider than either box, so the modal's own text between them is not evidence
    // and no point can ever be counted twice.
    expect(confirmButtons([{ x: 1340, y: 764 }, { x: 563, y: 547 }, { x: 1732, y: 547 }], VIEW)).toEqual({ ok: 0, cancel: 0 });
    const lit = confirmButtons(spread(DIALOG), VIEW);
    expect(lit.ok + lit.cancel).toBeLessThan(DIALOG);
  });

  it("accepts the measured dialog count and refuses both measured frames of play", () => {
    expect(confirmDialog(spread(DIALOG), VIEW)).toEqual({ ok: OK_AT });
    for (const lit of PLAYED) expect(confirmDialog(spread(lit), VIEW), String(lit)).toBeUndefined();
    // Play is refused for being lit, not for being shapeless: a played band has points all over both buttons too,
    // which is exactly why the ceiling stays and why button evidence alone may never accept a frame.
    expect(confirmButtons(spread(PLAYED[0]), VIEW).ok).toBeGreaterThan(CONFIRM_BUTTON_POINTS);
  });

  it("finds the dialog over a dark scene, where counting alone missed one live", () => {
    const dark = darkModal();
    // The whole band holds less than the floor of 120 this detector used to demand — the live miss.
    expect(dark.length).toBeLessThan(OLD_FLOOR);
    expect(confirmDialog(dark, VIEW)).toEqual({ ok: OK_AT });
    expect(confirmDialog(darkModal(20, SMALL), SMALL)).toEqual({ ok: { x: 1299, y: 573 } });
    // Both buttons are required, and the floor is what a loading screen cannot fake rather than what a dark scene cannot reach.
    expect(confirmDialog(darkModal(CONFIRM_BUTTON_POINTS), VIEW)).toEqual({ ok: OK_AT });
    expect(confirmDialog(darkModal(CONFIRM_BUTTON_POINTS - 1), VIEW)).toBeUndefined();
  });

  it("refuses a loading screen, black or not: an accepted teleport shows one next", () => {
    expect(confirmDialog([], VIEW)).toBeUndefined();
    // Brighter than the old floor ever asked for, and all of it in one place that is not a button.
    const clump = corner(900);
    expect(clump.length).toBeGreaterThan(OLD_FLOOR);
    expect(confirmDialog(clump, VIEW)).toBeUndefined();
    // One bright cluster is not two buttons, whichever one it lands on.
    expect(confirmDialog([...onButton(200, CONFIRM_OK), ...corner(15)], VIEW)).toBeUndefined();
    expect(confirmDialog([...onButton(200, CONFIRM_CANCEL), ...corner(15)], VIEW)).toBeUndefined();
  });

  it("loses nothing the count used to accept: an evenly dimmed band still passes at the old floor", () => {
    for (const count of [OLD_FLOOR, 400, DIALOG, CONFIRM_MAX_POINTS]) expect(confirmDialog(spread(count), VIEW), String(count)).toEqual({ ok: OK_AT });
    expect(confirmDialog(spread(CONFIRM_MAX_POINTS + 1), VIEW)).toBeUndefined();
  });

  it("keeps a cap a played scene overflows long before the dialog reaches it", () => {
    expect(CONFIRM_POINT_CAP).toBeGreaterThan(CONFIRM_MAX_POINTS);
    expect(CONFIRM_POINT_CAP / DIALOG).toBeGreaterThan(3);              // the dialog never hits the cap
    expect(Math.min(...PLAYED) / CONFIRM_POINT_CAP).toBeGreaterThan(3); // played pixels always do
    expect(CONFIRM_MAX_POINTS / DIALOG).toBeGreaterThan(3);
    expect(Math.min(...PLAYED) / CONFIRM_MAX_POINTS).toBeGreaterThan(3);
    expect(CONFIRM_POINT_CAP).toBeLessThanOrEqual(60_000);              // the worker's own bounds on a cap
    expect(CONFIRM_POINT_CAP).toBeGreaterThanOrEqual(100);
    // Room under the measured dialog for a scene that lends the buttons nothing: 1253 points spread over the band
    // put ~120 on each button before the button's own pixels are counted at all.
    expect(confirmButtons(spread(DIALOG), VIEW).ok / CONFIRM_BUTTON_POINTS).toBeGreaterThan(10);
  });

  it("refuses an overflowed scan and a failed scan whatever the points say", () => {
    expect(confirmDialog(spread(DIALOG), VIEW, true)).toBeUndefined();  // bright enough to give up: not a modal
    expect(confirmDialog(darkModal(), VIEW, true)).toBeUndefined();
    expect(confirmDialog(undefined, VIEW)).toBeUndefined();
    expect(confirmDialog(undefined, VIEW, true)).toBeUndefined();
  });

  it("aims at the measured OK button, and scales it to another resolution", () => {
    expect(confirmOk(VIEW)).toEqual(OK_AT);
    expect(confirmOk(SMALL)).toEqual({ x: 1299, y: 573 });
    expect(confirmOk(VIEW).x / VIEW.width).toBeCloseTo(CONFIRM_OK.x, 3);
    // Where we click is the middle of the button we weigh, to the pixel the live measurement rounded to.
    expect(Math.abs(confirmOk(VIEW).x - (OK_BOX.left + OK_BOX.right) / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(confirmOk(VIEW).y - (OK_BOX.top + OK_BOX.bottom) / 2)).toBeLessThanOrEqual(1);
    // OK is the right-hand button; CANCEL is left of centre at x 948 (0.370 w), is weighed but never returned.
    expect(CONFIRM_OK.x).toBeGreaterThan(.5);
    expect(CONFIRM_CANCEL.x).toBeLessThan(.5);
    expect(confirmOk(VIEW).x - Math.round(VIEW.width * CONFIRM_CANCEL.x)).toBeGreaterThan(VIEW.width * .25);
    expect(Object.keys(confirmDialog(spread(DIALOG), VIEW)!)).toEqual(["ok"]);
    // The same dialog at 1920 x 1080 dims a band 56% the area, so it carries about 707 points, and at 1280 x 720
    // — the smallest view the game runs at — about 313: four times the evidence either button needs.
    expect(confirmDialog(spread(707, SMALL), SMALL)).toEqual({ ok: { x: 1299, y: 573 } });
    expect(confirmButtons(spread(313, LOW), LOW).ok).toBeGreaterThan(CONFIRM_BUTTON_POINTS * 3);
    expect(confirmDialog(spread(313, LOW), LOW)).toEqual({ ok: confirmOk(LOW) });
    // And the 282-point dimmed band the follower service's own tests drive at their 640 x 360 view.
    expect(confirmDialog(spread(282, TINY), TINY)).toEqual({ ok: { x: 433, y: 191 } });
  });
});
