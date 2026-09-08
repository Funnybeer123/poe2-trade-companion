import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolveWinHostScript } from "./winHost.js";

/** Dedicated OS-key observer: never shares the capture or input worker queue. */
export function startEmergencyStopMonitor(onStop: () => void, onFailure: () => void) {
  const script = resolveWinHostScript("win-emergency-stop.ps1");
  const child = spawn("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", script], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let ready = false, closed = false;
  const fail = () => { ready = false; if (!closed) onFailure(); };
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (line.trim() === "ready") ready = true;
    if (line.trim() === "stop") onStop();
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
