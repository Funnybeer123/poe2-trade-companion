import type { InputAction } from "../input/types.js";
import { followDirection } from "../navigation/direction.js";
import type { PixelPoint } from "../world-state/types.js";

/** Named QA fixture coordinates — not live client calibration. */
export const DEFAULT_TRADE_UI = {
  inviteButton: { x: 220, y: 80 } satisfies PixelPoint,
  tradeNpc: { x: 400, y: 200 } satisfies PixelPoint,
  openTrade: { x: 960, y: 520 } satisfies PixelPoint,
  ourItemSlot: { x: 720, y: 540 } satisfies PixelPoint,
  acceptButton: { x: 840, y: 720 } satisfies PixelPoint,
  rejectButton: { x: 1080, y: 720 } satisfies PixelPoint,
  leaveParty: { x: 220, y: 120 } satisfies PixelPoint,
};

export function tradeInviteActions(point: PixelPoint = DEFAULT_TRADE_UI.inviteButton): InputAction[] {
  return [{ type: "mouse-click", x: point.x, y: point.y, button: "left" }];
}

export function tradePrepareItemActions(point: PixelPoint): InputAction[] {
  return [{ type: "mouse-click", x: point.x, y: point.y, button: "left" }];
}

export function tradeNavigateActions(point: PixelPoint = DEFAULT_TRADE_UI.tradeNpc): InputAction[] {
  return followDirection({ target: point }).actions;
}

export function tradeOpenActions(point: PixelPoint = DEFAULT_TRADE_UI.openTrade): InputAction[] {
  return [{ type: "mouse-click", x: point.x, y: point.y, button: "left" }];
}

export function tradePlaceItemActions(
  itemPoint: PixelPoint,
  slot: PixelPoint = DEFAULT_TRADE_UI.ourItemSlot,
): InputAction[] {
  return [
    { type: "mouse-click", x: itemPoint.x, y: itemPoint.y, button: "left" },
    { type: "mouse-click", x: slot.x, y: slot.y, button: "left" },
  ];
}

export function tradeAcceptActions(point: PixelPoint = DEFAULT_TRADE_UI.acceptButton): InputAction[] {
  return [{ type: "mouse-click", x: point.x, y: point.y, button: "left" }];
}

export function tradeRejectActions(point: PixelPoint = DEFAULT_TRADE_UI.rejectButton): InputAction[] {
  return [{ type: "mouse-click", x: point.x, y: point.y, button: "left" }];
}

export function tradeCleanupActions(point: PixelPoint = DEFAULT_TRADE_UI.leaveParty): InputAction[] {
  return [{ type: "mouse-click", x: point.x, y: point.y, button: "left" }];
}
