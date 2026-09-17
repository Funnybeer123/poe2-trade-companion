import { expect, it } from "vitest";
import { startEmergencyStopMonitor } from "../src/adapters/emergencyStopMonitor.js";

it.runIf(process.platform === "win32")("starts an independent native emergency-stop observer without input", async () => {
  let failed = false;
  const monitor = startEmergencyStopMonitor(() => {}, () => { failed = true; });
  try {
    await expect.poll(() => monitor.ready || failed, { timeout: 10000, interval: 25 }).toBe(true);
    expect(failed).toBe(false);
    expect(monitor.ready).toBe(true);
  } finally { monitor.close(); }
  expect(monitor.ready).toBe(false);
}, 15000);
