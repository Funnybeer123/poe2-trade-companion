import type { BrowserWindow } from "electron";

type ActivationWindow = Pick<BrowserWindow,
  "isDestroyed" | "isMinimized" | "restore" | "show" | "focus" |
  "setAlwaysOnTop" | "moveTop" | "on" | "once" | "removeListener"
>;

/** Raise on user activation, then relinquish the topmost layer when they leave. */
export function installWindowActivation(window: ActivationWindow): () => void {
  let activating = false;
  let raising = false;
  let disposed = false;
  const unavailable = () => disposed || window.isDestroyed();

  function raise() {
    if (unavailable() || raising) return;
    raising = true;
    try {
      // A borderless game or overlay can occupy the topmost window layer.
      // Reassert our position when selected, without a recurring focus timer.
      window.setAlwaysOnTop(true, "screen-saver");
      window.moveTop();
    } finally { raising = false; }
  }

  function release() {
    if (!unavailable()) window.setAlwaysOnTop(false);
  }

  function activate() {
    if (unavailable() || activating) return;
    activating = true;
    try {
      if (window.isMinimized()) window.restore();
      window.show();
      raise();
      window.focus();
    } finally { activating = false; }
  }

  function dispose() {
    disposed = true;
    window.removeListener("ready-to-show", activate);
    window.removeListener("restore", activate);
    window.removeListener("focus", raise);
    window.removeListener("blur", release);
    window.removeListener("minimize", release);
  }

  window.once("ready-to-show", activate);
  window.on("restore", activate);
  window.on("focus", raise);
  window.on("blur", release);
  window.on("minimize", release);
  window.once("closed", dispose);
  return activate;
}
