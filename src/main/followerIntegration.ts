import { app, ipcMain, type BrowserWindow } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { FollowerService } from "./followerService.js";

export function installFollower(getMain: () => BrowserWindow | undefined, blocked: () => string | undefined): FollowerService {
  const service = new FollowerService(path.join(app.getPath("userData"), "follower"), blocked);
  const handlers: Record<string, (value?: unknown) => unknown> = {
    status: () => service.status(), configure: value => service.configure(value), "generate-key": () => service.generateKey(),
    start: key => service.start(key), stop: () => service.stop(), demo: () => service.demo(),
  };
  for (const [action, handler] of Object.entries(handlers)) ipcMain.handle(`follower:${action}`, (event, value: unknown) => {
    const main = getMain();
    if (!main || event.sender !== main.webContents || event.senderFrame !== main.webContents.mainFrame) throw new Error("Follower request denied.");
    const url = event.senderFrame.url.split("#")[0];
    const expected = process.env.VITE_DEV_SERVER_URL ?? pathToFileURL(path.join(app.getAppPath(), "dist", "index.html")).href;
    if (url !== expected && url !== `${expected}/`) throw new Error("Follower origin denied.");
    return handler(value);
  });
  return service;
}
