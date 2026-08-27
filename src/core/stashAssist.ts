import type { DesirabilityResult, RecommendationCategory } from "./types.js";
import {
  contentRect,
  fractionRegion,
  HUD_FRACTIONS,
  type GridCell,
  type ScreenRect,
} from "./screenLayout.js";

export function inventoryGrid(client: ScreenRect, cols = 12, rows = 5): GridCell[] {
  const region = fractionRegion(contentRect(client), HUD_FRACTIONS.inventory);
  return buildGrid(region, cols, rows);
}

export function stashGrid(client: ScreenRect, cols = 12, rows = 12): GridCell[] {
  const region = fractionRegion(contentRect(client), HUD_FRACTIONS.stash);
  return buildGrid(region, cols, rows);
}

function buildGrid(
  region: { x: number; y: number; w: number; h: number },
  cols: number,
  rows: number,
): GridCell[] {
  const cells: GridCell[] = [];
  const cellW = region.w / cols;
  const cellH = region.h / rows;
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      cells.push({
        row,
        col,
        x: Math.round(region.x + cellW * (col + 0.5)),
        y: Math.round(region.y + cellH * (row + 0.5)),
      });
    }
  }
  return cells;
}

export function destinationFor(result: DesirabilityResult): RecommendationCategory {
  return result.category;
}

export function shouldKeepInInventory(category: RecommendationCategory): boolean {
  return category === "keep" || category === "craft";
}
