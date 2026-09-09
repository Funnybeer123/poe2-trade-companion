import { expect, type TestInfo } from "@playwright/test";
import { spawn } from "node:child_process";
import path from "node:path";
import { withPackagedElectron, type SmokeBuildMode } from "./electron-smoke.js";

/** Isolated windows/profile only: no game focus changes or generated input. */
export async function windowFocusSmoke(mode: SmokeBuildMode, testInfo: TestInfo) {
  await withPackagedElectron(mode, testInfo, async ({ application, page }) => {
    const mainId = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.id);
    const state = () => application.evaluate(({ BrowserWindow }, id) => {
      const main = BrowserWindow.fromId(id)!;
      return {
        focused: main.isFocused(),
        minimized: main.isMinimized(),
        visible: main.isVisible(),
        topmost: main.isAlwaysOnTop(),
      };
    }, mainId);

    // Reproduce a fullscreen game's competing topmost window without touching the game.
    const competitorId = await application.evaluate(async ({ BrowserWindow }, id) => {
      const main = BrowserWindow.fromId(id)!;
      const competitor = new BrowserWindow({
        ...main.getBounds(),
        show: false,
        alwaysOnTop: true,
        title: "Window activation test",
        backgroundColor: "#283447",
        webPreferences: { contextIsolation: true, nodeIntegration: false },
      });
      await competitor.loadURL("data:text/html,<title>Window activation test</title><p>Competing window</p>");
      competitor.show();
      competitor.focus();
      competitor.moveTop();
      return competitor.id;
    }, mainId);
    await expect.poll(state).toEqual({ focused: false, minimized: false, visible: true, topmost: false });

    await application.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.focus(), mainId);
    await expect.poll(state).toEqual({ focused: true, minimized: false, visible: true, topmost: true });
    await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();

    // Switching away releases the temporary topmost state; it must not steal focus back.
    await application.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.focus(), competitorId);
    await expect.poll(state).toEqual({ focused: false, minimized: false, visible: true, topmost: false });
    await application.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.destroy(), competitorId);

    await application.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.minimize(), mainId);
    await expect.poll(state).toMatchObject({ minimized: true, topmost: false });
    // Windows taskbar restoration emits the same native restore event.
    await application.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.restore(), mainId);
    await expect.poll(state).toEqual({ focused: true, minimized: false, visible: true, topmost: true });

    await application.evaluate(({ app, BrowserWindow }, id) => {
      BrowserWindow.fromId(id)!.hide();
      app.emit("activate");
    }, mainId);
    await expect.poll(state).toEqual({ focused: true, minimized: false, visible: true, topmost: true });

    const launch = await application.evaluate(({ app }) => ({ executable: app.getPath("exe"), userData: app.getPath("userData") }));
    expect(path.resolve(launch.userData)).toBe(path.resolve(testInfo.outputPath("user-data")));
    await application.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.minimize(), mainId);
    await expect.poll(state).toMatchObject({ minimized: true });
    const secondExit = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(launch.executable, [`--user-data-dir=${launch.userData}`, "--disable-gpu"], {
        windowsHide: true,
        env: { ...process.env, POE2_BUILD_MODE: mode, POE2_ENABLE_LIVE_INPUT: "0" },
        stdio: "ignore",
      });
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("Second launch did not exit after activating the existing companion"));
      }, 15_000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
    });
    expect(secondExit).toBe(0);
    await expect.poll(state).toEqual({ focused: true, minimized: false, visible: true, topmost: true });
    expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    expect((await page.evaluate(() => window.poe2!.combat!.status())).actions).toBe(0);
  });
}
