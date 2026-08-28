import { activeStashGrid, type CalibrationProfile, type ClientBox } from "./calibrationProfile.js";
import type { ScreenRect } from "./screenLayout.js";
import type { InputAction } from "./types.js";

export interface TransferInputValidation {
  ok: boolean;
  reason?: string;
}

function toScreenBox(box: ClientBox, client: ScreenRect): ClientBox {
  return { x: client.left + box.x, y: client.top + box.y, w: box.w, h: box.h };
}

function contains(box: ClientBox, x: number, y: number): boolean {
  return x >= box.x && y >= box.y && x < box.x + box.w && y < box.y + box.h;
}

function validPoint(boxes: ClientBox[], x: number | undefined, y: number | undefined): boolean {
  return (
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    boxes.some((box) => contains(box, Number(x), Number(y)))
  );
}

/**
 * Rejects coordinate input outside the explicitly calibrated transfer surfaces.
 * Keyboard, text, focus, and waits have no screen coordinate to validate.
 */
export function validateTransferInput(
  actions: InputAction[],
  profile: CalibrationProfile,
  client: ScreenRect,
  extraBoxes: ClientBox[] = [],
): TransferInputValidation {
  const marks = [activeStashGrid(profile), profile.bagGrid, profile.stashSearch, ...extraBoxes].filter(
    (box): box is ClientBox => Boolean(box),
  );
  const boxes = marks.map((box) => toScreenBox(box, client));

  for (const action of actions) {
    if (action.kind !== "click" && action.kind !== "move" && action.kind !== "drag") continue;
    if (!validPoint(boxes, action.x, action.y)) {
      return { ok: false, reason: `${action.kind}-outside-calibrated-transfer-regions` };
    }
    if (action.kind === "drag" && !validPoint(boxes, action.x2, action.y2)) {
      return { ok: false, reason: "drag-destination-outside-calibrated-transfer-regions" };
    }
  }
  return { ok: true };
}
