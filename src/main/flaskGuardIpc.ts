import { ipcMain } from "electron";
import { startWinHost } from "../adapters/winHost.js";
import { calibrateFlaskProbe, sampleFlaskProbes } from "../adapters/flaskGuardRunner.js";
import {
  flaskGuardConfigPath,
  loadFlaskGuardConfig,
  saveFlaskGuardConfig,
} from "../core/flaskGuardConfig.js";
import { isSkillProbeId } from "../shared/flaskGuard.js";

/**
 * Auto-flask guard + auto-cast IPC: the config the daemon polls
 * (artifacts/flask-guard.json under the repo root, same as the hotkey
 * bindings), click-calibration of a globe's trigger point or a skill icon
 * ("skill:<id>"), and a one-shot "sample now" probe. The guard loop itself
 * runs in scripts/action-daemon.ts (or scripts/flask-guard.ts), not in the
 * app.
 */
export function registerFlaskGuardIpc(root: string): void {
  ipcMain.handle("flask:get", () => {
    const loaded = loadFlaskGuardConfig(root);
    return {
      config: loaded.config,
      issues: loaded.issues,
      source: loaded.source,
      file: flaskGuardConfigPath(root),
    };
  });
  ipcMain.handle("flask:save", (_event, raw: unknown) => saveFlaskGuardConfig(root, raw));
  ipcMain.handle("flask:calibrate", async (_event, rawTarget: unknown) => {
    const target = String(rawTarget ?? "");
    if (target !== "life" && target !== "mana" && !isSkillProbeId(target)) {
      return { ok: false, target, globe: target, error: "target must be life, mana, or skill:<id>" };
    }
    const host = startWinHost({ requestTimeoutMs: 45_000 });
    try {
      return await calibrateFlaskProbe(host, target, { root, timeoutMs: 30_000 });
    } catch (error) {
      return { ok: false, target, globe: target, error: error instanceof Error ? error.message : String(error) };
    } finally {
      await host.close();
    }
  });
  ipcMain.handle("flask:probe", async () => {
    const host = startWinHost();
    try {
      return await sampleFlaskProbes(host, loadFlaskGuardConfig(root).config);
    } catch (error) {
      return {
        ok: false,
        foregroundIsPoe: false,
        probes: [],
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      await host.close();
    }
  });
}
