/** Default screen-capture budget. Live capture must stay at or below this. */
export const DEFAULT_CAPTURE_FPS = 15;

/** Orchestrator tick interval range (ms). */
export const DEFAULT_LOOP_TICK_MIN_MS = 100;
export const DEFAULT_LOOP_TICK_MAX_MS = 200;
export const DEFAULT_LOOP_TICK_MS = 150;

export function clampLoopTickMs(tickMs: number): number {
  if (!Number.isFinite(tickMs)) {
    return DEFAULT_LOOP_TICK_MS;
  }
  return Math.min(DEFAULT_LOOP_TICK_MAX_MS, Math.max(DEFAULT_LOOP_TICK_MIN_MS, Math.round(tickMs)));
}

export function captureIntervalMs(fps: number = DEFAULT_CAPTURE_FPS): number {
  const bounded = Math.min(DEFAULT_CAPTURE_FPS, Math.max(1, fps));
  return Math.round(1000 / bounded);
}
