import { expect, type TestInfo } from "@playwright/test";
import { withPackagedElectron, type SmokeBuildMode } from "./electron-smoke.js";

/** Isolated profile: configuration and navigation only; never start game input. */
export async function dashboardSmoke(mode: SmokeBuildMode, testInfo: TestInfo) {
  await withPackagedElectron(mode, testInfo, async ({ page }) => {
    await expect(page).toHaveURL(/#\/dashboard$/);
    await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
    const dashboard = page.locator(".action-dashboard");
    await expect(dashboard.getByRole("switch")).toHaveCount(3);
    await expect(dashboard.locator(".combat-quick-card.mana kbd")).toHaveText("Mouse 5");
    await expect(dashboard.getByRole("button", { name: "Start combat", exact: true })).toBeDisabled();
    await expect(dashboard.locator(".stash-quick-action")).toHaveCount(4);
    await expect(dashboard.locator(".dashboard-workflow-card")).toHaveCount(4);

    await dashboard.getByRole("switch", { name: "Enable Health flask", exact: true }).click();
    await expect(dashboard.getByRole("switch", { name: "Enable Health flask", exact: true })).toBeChecked();
    await dashboard.getByRole("link", { name: "Calibrate & configure" }).click();
    await expect(page.getByLabel("Auto health flask")).toBeChecked();
    await page.getByLabel("health threshold").fill("24");
    await page.getByRole("link", { name: /Dashboard Quick actions/ }).click();
    await dashboard.getByRole("switch", { name: "Enable Mana flask", exact: true }).click();
    await expect(dashboard.getByRole("switch", { name: "Enable Mana flask", exact: true })).toBeChecked();
    await dashboard.getByRole("link", { name: "Calibrate & configure" }).click();
    await expect(page.getByLabel("Auto mana flask")).toBeChecked();
    await expect(page.getByLabel("health threshold")).toHaveValue("24");
    await page.getByRole("button", { name: "Save settings", exact: true }).click();
    await page.getByRole("link", { name: /Dashboard Quick actions/ }).click();
    await expect(dashboard.locator(".combat-quick-card.health p")).toHaveText("Use below 24% life");
    await expect(dashboard.getByRole("button", { name: "Start combat", exact: true })).toBeDisabled();
    await dashboard.getByRole("link", { name: /Scan stash items/ }).click();
    await expect(page.getByRole("tab", { name: /Scan sessions/ })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("link", { name: /Dashboard Quick actions/ }).click();
    await expect(page.locator(".game-action-rail")).toHaveCount(0);
    const state = await page.evaluate(() => window.poe2!.combat!.status());
    expect(state.running).toBe(false);
    expect(state.actions).toBe(0);
    await page.screenshot({ path: testInfo.outputPath("dashboard.png"), fullPage: true, animations: "disabled" });
  });
}
