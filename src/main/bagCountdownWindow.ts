import type { BrowserWindow } from "electron";
import type { BagTriageStatus } from "../shared/bagTriage.js";

type BagWindow = Pick<BrowserWindow, "isDestroyed" | "isMinimized" | "setAlwaysOnTop" | "minimize">;

/** Remove the companion from screen capture before the bag countdown expires. */
export function prepareBagCountdownWindow(window: BagWindow | undefined, phase: BagTriageStatus["phase"]): void {
  if (phase !== "countdown" || !window || window.isDestroyed()) return;
  window.setAlwaysOnTop(false);
  if (!window.isMinimized()) window.minimize();
}
