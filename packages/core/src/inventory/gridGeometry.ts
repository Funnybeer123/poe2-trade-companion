export interface GridGeometry {
  originX: number;
  originY: number;
  cellWidth: number;
  cellHeight: number;
  columns: number;
  rows: number;
  tabId?: string;
}

export interface GridHover {
  kind: "inventory" | "stash";
  x: number;
  y: number;
  clipboardText?: string;
}

export interface GridDetectionHints {
  inventoryGrid?: GridGeometry;
  stashGrid?: GridGeometry;
  hover?: GridHover;
  gridHover?: GridHover;
}
