import type { ClientBox } from "./calibrationProfile.js";
import type { BBox } from "./uiPerception.js";

export function stashSearchClick(searchBox: ClientBox): { x: number; y: number } {
  return {
    x: searchBox.x + Math.round(searchBox.w / 2),
    y: searchBox.y + Math.round(searchBox.h / 2),
  };
}

export function isStashSearchClick(
  point: { x: number; y: number },
  searchBox: ClientBox,
  stashRegion?: BBox,
): boolean {
  const inset = 2;
  if (point.x < searchBox.x + inset || point.x > searchBox.x + searchBox.w - inset) return false;
  if (point.y < searchBox.y + inset || point.y > searchBox.y + searchBox.h - inset) return false;
  if (!stashRegion) return true;
  if (point.x < stashRegion.x || point.x > stashRegion.x + stashRegion.w) return false;
  if (point.y < stashRegion.y + stashRegion.h) return false;
  const footerHeight = Math.max(120, Math.round(stashRegion.h * 0.25));
  if (point.y > stashRegion.y + stashRegion.h + footerHeight) return false;
  return true;
}

export function searchLooksFailed(occupiedBefore: number, litOccupied: number): boolean {
  if (litOccupied >= 120) return true;
  if (occupiedBefore <= 0) return litOccupied >= 80;
  const limit = Math.min(96, Math.max(40, Math.ceil(occupiedBefore * 0.32)));
  return litOccupied >= limit;
}

export function searchBoxFromClick(point: { x: number; y: number }, stashRegion: BBox): ClientBox {
  const w = 160;
  const h = 28;
  const x = Math.max(stashRegion.x + 16, Math.min(point.x - Math.round(w / 2), stashRegion.x + stashRegion.w - 16 - w));
  const y = Math.max(stashRegion.y + stashRegion.h + 8, point.y - Math.round(h / 2));
  return { x, y, w, h };
}
