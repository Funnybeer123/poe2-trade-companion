/** Clipboard / sort timings from Codex Poe2StashScanner. Used when Ctrl+C or pick/place is needed. */

export const STASH_SCAN = {
  normal: { hoverMs: 60, copyMs: 15, afterMs: 20 },
  quad: { hoverMs: 25, copyMs: 8, afterMs: 10 },
  inventory: { hoverMs: 35, copyMs: 8, afterMs: 10 },
  /**
   * Merchant shop identify: as fast as live inventory/quad sweeps allow.
   * Footprint skip means each Ctrl+C is one item origin, not every cell.
   */
  shop: { hoverMs: 25, copyMs: 8, afterMs: 8 },
} as const;

/** Merchant delist: one overlay, then ctrl-burst the whole grid — no per-item verify. */
export const SHOP_DELIST = {
  /** Overlay flash before the burst (ms). */
  burstDwellMs: 0,
  /** Points per host ctrlburst IPC (stop still lands between chunks). */
  burstChunk: 24,
} as const;

/** Personal bag grid: 12×5. */
export const BAG_GRID_CELLS = 12 * 5;

/** True when the bag has room for the next withdraw footprint. */
export function shopBagCanAccept(freeCells: number, needCells: number): boolean {
  return freeCells >= Math.max(1, needCells);
}

/**
 * Stackable currency merges into an existing bag stack, so occupied bag cell
 * count often does not grow after a successful withdraw.
 */
export function shopItemStacksInBag(item: {
  itemClass?: string | undefined;
  text: string;
}): boolean {
  return (
    /^(Stackable )?Currency$/i.test(item.itemClass ?? "") || /^Stack Size:/im.test(item.text)
  );
}

export const CLIPBOARD_POLL_MS = 120;
export const CLIPBOARD_POLL_STEP_MS = 5;
export const CURSOR_OFF_GRID_PAD_PX = 48;
export const CURSOR_OFF_GRID_SETTLE_MS = 70;

export const PHYSICAL_CTRL_C = {
  ctrlSettleMs: 28,
  keyHoldMs: 34,
  releaseSettleMs: 20,
} as const;

export const SORT_MOVE = {
  sourceSettleMs: 22,
  afterPickMs: 42,
  targetSettleMs: 22,
  postPlaceMs: 110,
  verifyRetryMs: 85,
} as const;

export const INVENTORY_IDENTIFY = {
  wisdomHoverMs: 60,
  afterRightClickMs: 80,
  shiftHoverMs: 12,
  betweenClicksMs: 18,
} as const;

export const STASH_ALL = {
  hoverMs: 10,
  clickDownUpMs: 12,
  postClickMs: 20,
} as const;
