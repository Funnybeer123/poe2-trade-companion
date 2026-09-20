import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolveWinHostScript } from "./winHost.js";

/**
 * Watches Ctrl+Shift+H (hold the follower's PC) and Ctrl+Shift+M / Ctrl+Shift+F (resume following).
 *
 * Two idempotent chords rather than one toggle: the operator usually cannot see the status line, so a
 * toggle makes every press a guess, and pressing to resume stops a follower that was already following.
 *
 * Dedicated OS-key observer: never shares the capture or input worker queue, so a busy or wedged
 * worker cannot delay a takeover. Each fires once per fresh press, never repeatedly while held.
 *
 * On failure the caller decides: giving control back is never automatic, because resuming the
 * follower under a hand that is still on the mouse is the one outcome worth ruling out.
 */
export function startManualControlMonitor(onTake: () => void, onGive: () => void, onFailure: () => void) {
  const script = resolveWinHostScript("win-manual-control.ps1");
  const child = spawn("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", script], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let ready = false, closed = false;
  const fail = () => { ready = false; if (!closed) onFailure(); };
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (line.trim() === "ready") ready = true;
    if (line.trim() === "take") onTake();
    if (line.trim() === "give") onGive();
  });
  child.stderr.resume();
  child.on("error", fail);
  child.on("exit", fail);
  lines.on("close", fail);
  return {
    get ready() { return ready; },
    close() { closed = true; ready = false; lines.close(); child.kill(); },
  };
}
