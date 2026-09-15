/**
 * Main-window geometry helpers for the "appSettings" package (pure).
 *
 * The bounds tracker persists the desktop window's position so a restart
 * puts it back where the user left it. A saved rectangle is only trusted
 * when it still lands on a display that exists — unplugging the monitor the
 * window lived on must fall back to Electron's own centring instead of
 * parking the window off-screen where it cannot be dragged back.
 *
 * Kept in core (not shared) because it is arithmetic with no contract of its
 * own; `src/shared/appSettings.ts` re-exports the two types the channels use.
 */

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A display's usable area (Electron `Display.workArea`). */
export interface DisplayArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Matches `createWindow()` in src/main/index.ts — "Reset window positions" restores it. */
export const DEFAULT_MAIN_WINDOW_SIZE = { width: 1120, height: 860 } as const;

/** Smallest window we are willing to restore; anything smaller is treated as junk. */
export const MIN_WINDOW_WIDTH = 200;
export const MIN_WINDOW_HEIGHT = 150;

/** Fraction of the window's area that must sit inside one work area. */
const MIN_VISIBLE_FRACTION = 0.5;

function intOrUndefined(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.round(parsed);
}

/**
 * Junk (or a suspiciously tiny rectangle) → undefined, so the caller simply
 * leaves the window where Electron put it.
 */
export function sanitizeWindowBounds(raw: unknown): WindowBounds | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const x = intOrUndefined(source.x);
  const y = intOrUndefined(source.y);
  const width = intOrUndefined(source.width);
  const height = intOrUndefined(source.height);
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined;
  }
  if (width < MIN_WINDOW_WIDTH || height < MIN_WINDOW_HEIGHT) return undefined;
  return { x, y, width, height };
}

function overlapArea(a: WindowBounds, b: DisplayArea): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (width <= 0 || height <= 0) return 0;
  return width * height;
}

/**
 * True when at least half of the window's area falls inside one display's
 * work area. Deliberately per-display (not the union): a window split across
 * two monitors is still reachable, and a window that only clips the corner of
 * each is not worth restoring.
 */
export function boundsOnSomeDisplay(bounds: WindowBounds, displays: readonly DisplayArea[]): boolean {
  const area = bounds.width * bounds.height;
  if (area <= 0) return false;
  return displays.some((display) => overlapArea(bounds, display) / area >= MIN_VISIBLE_FRACTION);
}

/** The rectangle "Reset window positions" puts the window back to. */
export function centredBounds(
  display: DisplayArea,
  size: { width: number; height: number } = DEFAULT_MAIN_WINDOW_SIZE,
): WindowBounds {
  const width = Math.min(Math.max(Math.round(size.width), MIN_WINDOW_WIDTH), Math.max(display.width, MIN_WINDOW_WIDTH));
  const height = Math.min(
    Math.max(Math.round(size.height), MIN_WINDOW_HEIGHT),
    Math.max(display.height, MIN_WINDOW_HEIGHT),
  );
  return {
    x: Math.round(display.x + (display.width - width) / 2),
    y: Math.round(display.y + (display.height - height) / 2),
    width,
    height,
  };
}
