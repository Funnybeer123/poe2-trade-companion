import { expect, type TestInfo } from "@playwright/test";
import { withPackagedElectron, type SmokeBuildMode } from "./electron-smoke.js";

export async function followerSmoke(mode: SmokeBuildMode, info: TestInfo) {
  await withPackagedElectron(mode, info, async ({ page }) => {
    await page.getByRole("link", { name: "Open follower setup" }).click();
    await expect(page.getByRole("heading", { name: "Follow & Loot", exact: true })).toBeVisible();
    await expect(page.getByText("Connecting the PCs does not move a character", { exact: false })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Live observation preview" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Start observation" })).toBeDisabled();
    expect(await page.evaluate(() => window.poe2!.follower!.perception())).toMatchObject({ observing: false, inputCapability: "none" });
    await expect(page.evaluate(() => window.poe2!.follower!.capture())).rejects.toThrow(/disabled during background UI smoke/);
    await page.getByLabel("Character to follow").fill("SmokeMain");
    await page.getByRole("button", { name: "Save preferences", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.poe2!.follower!.status().then(s => s.config.targetName))).toBe("SmokeMain");
    await page.getByRole("button", { name: "Run route demo" }).click();
    await expect(page.getByRole("heading", { name: "Acquire and follow" })).toBeVisible();
    await page.getByRole("button", { name: "Next step" }).click();
    await expect(page.getByText("Collect Exalted Orb", { exact: false })).toBeVisible();
    for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "Next step" }).click();
    await expect(page.getByRole("img", { name: /route around the wall/ })).toBeVisible();
    expect((await page.evaluate(() => window.poe2!.follower!.status())).connection).toBe("stopped");
    expect(await page.evaluate(() => window.poe2!.follower!.demo().then(steps => steps.length))).toBe(8);
    await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo(0, 0); });
    await page.screenshot({ path: info.outputPath("follow-loot-preview.png"), fullPage: true });
    await page.getByRole("navigation", { name: "Tools and QA sections" }).getByRole("link", { name: /Settings Automation defaults/ }).click();
    await page.getByRole("navigation", { name: "Tools and QA sections" }).getByRole("link", { name: /Follow & Loot/ }).click();
    await expect(page.getByLabel("Character to follow")).toHaveValue("SmokeMain");
    await expect(page.getByLabel("Pairing key", { exact: true })).toHaveValue("");
  }, { background: true });
}
