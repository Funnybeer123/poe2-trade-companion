import { ipcMain } from "electron";
import { startWinHost } from "../adapters/winHost.js";
import { calibrateFlaskProbe, sampleFlaskProbes } from "../adapters/flaskGuardRunner.js";
import {
  flaskGuardConfigPath,
  loadFlaskGuardConfig,
  saveFlaskGuardConfig,
} from "../core/flaskGuardConfig.js";
import type { FlaskGlobe } from "../shared/flaskGuard.js";

/**
 * Auto-flask guard IPC: the config the daemon polls (artifacts/flask-guard.json
 * under the repo root, same as the hotkey bindings), click-calibration of a
 * globe's trigger point, and a one-shot "sample now" probe. The guard loop
 * itself runs in scripts/action-daemon.ts (or scripts/flask-guard.ts), not
 * in the app.
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
  ipcMain.handle("flask:calibrate", async (_event, globe: FlaskGlobe) => {
    if (globe !== "life" && globe !== "mana") {
      return { ok: false, globe, error: "globe must be life or mana" };
    }
    const host = startWinHost({ requestTimeoutMs: 45_000 });
    try {
      return await calibrateFlaskProbe(host, globe, { root, timeoutMs: 30_000 });
    } catch (error) {
      return { ok: false, globe, error: error instanceof Error ? error.message : String(error) };
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
