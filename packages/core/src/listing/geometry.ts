import type { InputAction } from "../input/types.js";
import type { PixelPoint } from "../world-state/types.js";
import { formatListingPrice } from "./pricePolicy.js";

/** Named QA fixture coordinates — not live client calibration. */
export const DEFAULT_LISTING_UI = {
  openButton: { x: 960, y: 820 } satisfies PixelPoint,
  priceField: { x: 960, y: 540 } satisfies PixelPoint,
  confirmButton: { x: 1100, y: 820 } satisfies PixelPoint,
};

export function listingSelectActions(point: PixelPoint): InputAction[] {
  return [{ type: "mouse-click", x: point.x, y: point.y, button: "left" }];
}

export function listingOpenUiActions(point: PixelPoint = DEFAULT_LISTING_UI.openButton): InputAction[] {
  return [{ type: "mouse-click", x: point.x, y: point.y, button: "left" }];
}

export function listingApplyActions(
  price: number,
  ui = DEFAULT_LISTING_UI,
): InputAction[] {
  const taps: InputAction[] = [...formatListingPrice(price)].map((key) => ({
    type: "key-tap",
    key,
  }));
  return [
    { type: "mouse-click", x: ui.priceField.x, y: ui.priceField.y, button: "left" },
    ...taps,
    { type: "mouse-click", x: ui.confirmButton.x, y: ui.confirmButton.y, button: "left" },
  ];
}
