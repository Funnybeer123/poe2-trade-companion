import { expect, type Page, type TestInfo } from "@playwright/test";
import { spawn } from "node:child_process";
import path from "node:path";
import { withPackagedElectron, type SmokeBuildMode } from "./electron-smoke.js";

export async function combatSmoke(mode: SmokeBuildMode, testInfo: TestInfo) {
  await withPackagedElectron(mode, testInfo, async ({ page, application }) => {
    await page.getByRole("link", { name: /Tools & QA/ }).click();
    await page.getByRole("link", { name: /Flasks & Unleash/ }).click();
    await expect(page.getByRole("heading", { name: "Flasks & Unleash" })).toBeVisible();
    const panel = page.locator(".combat-tool");
    expect(await application.evaluate(({ globalShortcut }) => [globalShortcut.isRegistered("F8"), globalShortcut.isRegistered("CommandOrControl+Shift+F12")])).toEqual([true, true]);
    await expect(panel.getByLabel("health threshold")).toHaveValue("25");
    await expect(panel.getByLabel("mana threshold")).toHaveValue("25");
    await expect(panel.getByLabel("Unleash key", { exact: true })).toHaveValue("R");
    await panel.getByLabel("Auto health flask").check();
    await panel.getByLabel("Auto Unleash").check();
    await panel.getByRole("button", { name: "Save settings", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.poe2!.combat!.status().then((s) => s.config.health.enabled))).toBe(true);
    await panel.getByRole("button", { name: "Save & start", exact: true }).click();
    await expect(panel.getByRole("alert")).toContainText("Calibrate a fixed HUD ornament");
    expect((await page.evaluate(() => window.poe2!.combat!.status())).running).toBe(false);
    // Exercise the actual packaged helper, without capturing or emitting input.
    const appPath = await application.evaluate(({ app }) => app.getAppPath());
    const script = path.join(appPath.replace(/app\.asar$/, "app.asar.unpacked"), "scripts", "win-combat-host.ps1");
    const nativeReady = await new Promise<string>((resolve, reject) => {
        const child = spawn("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", script], { windowsHide: true });
        let output = "", errors = "";
        const timer = setTimeout(() => { child.kill(); reject(new Error("Native host timed out")); }, 10000);
        child.stdout.on("data", (data) => { output += String(data); });
        child.stderr.on("data", (data) => { errors += String(data); });
        child.on("error", (e) => { clearTimeout(timer); reject(e); });
        child.on("exit", (code) => { clearTimeout(timer); if (code === 0) resolve(output); else reject(new Error(errors)); });
        child.stdin.end('{"op":"ping"}\nquit\n');
    });
    expect(nativeReady.trim()).toBe('{"ok":true}');
    await saveCombatScreenshot(page, testInfo);
  });
}

async function saveCombatScreenshot(page: Page, testInfo: TestInfo) {
  await page.locator(".combat-tool").getByRole("button", { name: "Stop", exact: true }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("combat-controls.png"), fullPage: true });
}
