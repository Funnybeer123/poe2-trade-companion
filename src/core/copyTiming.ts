/** Clipboard / sort timings from Codex Poe2StashScanner. Used when Ctrl+C or pick/place is needed. */

export const STASH_SCAN = {
  normal: { hoverMs: 60, copyMs: 15, afterMs: 20 },
  quad: { hoverMs: 25, copyMs: 8, afterMs: 10 },
  inventory: { hoverMs: 35, copyMs: 8, afterMs: 10 },
} as const;

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
