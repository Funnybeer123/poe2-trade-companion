import { app, ipcMain, type BrowserWindow } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { KillSwitch } from "../core/killSwitch.js";
import type { RuntimeMode } from "../core/types.js";
import { driveAudit, FollowerDriveService } from "./followerDriveService.js";
import { FollowerService } from "./followerService.js";
import { FollowerPerceptionService } from "./followerPerceptionService.js";

interface FollowerDriveWiring {
  killSwitch: KillSwitch;
  mode: RuntimeMode;
  globalDryRun: () => boolean;
  /** Why movement input may not start or continue right now: another game action, missing emergency stop, smoke run. */
  blocked: () => string | undefined;
}

export function installFollower(getMain: () => BrowserWindow | undefined, blocked: () => string | undefined, wiring: FollowerDriveWiring) {
  const directory = path.join(app.getPath("userData"), "follower");
  const service = new FollowerService(directory, blocked);
  const perception = new FollowerPerceptionService({ directory, blocked, targetName: () => service.followTarget.targetName });
  const drive = new FollowerDriveService({
    directory, killSwitch: wiring.killSwitch, mode: wiring.mode, globalDryRun: wiring.globalDryRun, audit: driveAudit(directory),
    blocked: () => blocked() ?? wiring.blocked(),
    follow: () => service.followTarget,
  });
  // Capture workers must not compete: one of preview/recording or following at a time.
  const exclusive = <T>(run: () => T, other: () => void): T => { other(); return run(); };
  const handlers: Record<string, (value?: unknown) => unknown> = {
    status: () => service.status(),
    // Steering captures distance and confidence at Start; saving new ones must not leave it running on the old.
    configure: value => { const saved = service.configure(value); if (drive.isRunning) drive.stop("Follower preferences changed — press Start to resume."); return saved; }, "generate-key": () => service.generateKey(),
    start: key => service.start(key), stop: () => service.stop(), demo: () => service.demo(),
    perception: () => perception.status(), capture: () => exclusive(() => perception.capture(), () => drive.isRunning && drive.stop("Stopped for the observation preview.")), calibrate: value => perception.calibrate(value),
    "clear-calibration": () => perception.clearCalibration(), observe: () => exclusive(() => perception.start(), () => drive.isRunning && drive.stop("Stopped for the observation preview.")), "stop-observing": () => perception.stop(),
    record: value => exclusive(() => perception.record(value), () => drive.isRunning && drive.stop("Stopped for recording.")),
    "drive-status": () => drive.status(), "drive-configure": value => drive.configure(value), "drive-calibrate": value => exclusive(() => drive.calibrate(value), () => perception.stop("Stopped for map calibration.")),
    "drive-clear-calibration": () => drive.clearCalibration(), "drive-start": () => exclusive(() => drive.start(), () => perception.stop("Stopped to follow.")), "drive-stop": () => drive.stop(),
  };
  for (const [action, handler] of Object.entries(handlers)) ipcMain.handle(`follower:${action}`, (event, value: unknown) => {
    const main = getMain();
    if (!main || event.sender !== main.webContents || event.senderFrame !== main.webContents.mainFrame) throw new Error("Follower request denied.");
    const url = event.senderFrame.url.split("#")[0];
    const expected = process.env.VITE_DEV_SERVER_URL ?? pathToFileURL(path.join(app.getAppPath(), "dist", "index.html")).href;
    if (url !== expected && url !== `${expected}/`) throw new Error("Follower origin denied.");
    return handler(value);
  });
  return {
    /** Emergency stop and shutdown end the peer connection, game capture, and movement input. */
    stop: (reason?: string) => { drive.stop(reason); service.stop(reason); perception.stop(reason); },
    /** True while the follow loop may be sending movement clicks: other game actions must not start. */
    driving: () => drive.isRunning,
    stopDriving: (reason: string) => { if (drive.isRunning) drive.stop(reason); },
  };
}
