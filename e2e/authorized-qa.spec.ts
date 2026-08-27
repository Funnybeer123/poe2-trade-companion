import { expect, test } from "@playwright/test";
import {
  navigatePrimary,
  withPackagedElectron,
} from "./electron-smoke.js";

test("full build exposes live automation with e-stop ready", async ({}, testInfo) => {
  await withPackagedElectron("authorized-qa", testInfo, async ({ page }) => {
    const banner = page.locator(".qa-banner");
    await expect(banner).toBeVisible();
    await expect(banner.getByText("Automation on", { exact: true })).toBeVisible();
    await expect(
      banner.getByText("Stash transfers and scans can send input to Path of Exile", {
        exact: true,
      }),
    ).toBeVisible();

    await navigatePrimary(page, "Tools & QA", "Tools & QA", "/tools/overview");
    const tools = page.getByRole("navigation", {
      name: "Tools and QA sections",
    });
    await tools.getByRole("link", { name: /QA dashboard/ }).click();
    await expect(page).toHaveURL(/#\/tools\/qa$/);
    await expect(
      page.getByRole("heading", { name: "Automation dashboard", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("checkbox", { name: /Dry-run default/i }),
    ).not.toBeChecked();
    await expect(
      page.getByRole("button", {
        name: "Stage selected modules",
        exact: true,
      }),
    ).toBeEnabled();

    await navigatePrimary(page, "Items", "Item intelligence", "/items");
    await expect(banner).toBeVisible();
    await expect(
      page.getByText("E-stop ready · Ctrl+Shift+Esc", { exact: true }),
    ).toBeVisible();

    await navigatePrimary(page, "Scans", "Scan sessions", "/scans");
    const scannerControls = page.locator(".scanner-controls");
    await expect(scannerControls).toHaveCount(1);
    await scannerControls.locator("summary").click();
    await expect(
      page.getByRole("button", {
        name: "Run live scan",
        exact: true,
      }),
    ).toBeEnabled();
  });
});
