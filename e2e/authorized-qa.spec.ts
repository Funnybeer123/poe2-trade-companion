import { expect, test } from "@playwright/test";
import {
  navigatePrimary,
  withPackagedElectron,
} from "./electron-smoke.js";

test("QA build stays labeled, dry-run, and unarmed", async ({}, testInfo) => {
  await withPackagedElectron("authorized-qa", testInfo, async ({ page }) => {
    const banner = page.locator(".qa-banner");
    await expect(banner).toBeVisible();
    await expect(
      banner.getByText("Authorized QA mode", { exact: true }),
    ).toBeVisible();
    await expect(
      banner.getByText("Generated input is capability-gated and audited", {
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
      page.getByText("authorized-qa", { exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole("checkbox", {
        name: /Authorized QA acknowledgement/i,
      }),
    ).not.toBeChecked();
    await expect(
      page.getByRole("checkbox", { name: /Dry-run default/i }),
    ).toBeChecked();
    await expect(
      page.getByRole("button", {
        name: "Stage selected modules",
        exact: true,
      }),
    ).toBeDisabled();
    await expect(page.getByText("Not staged", { exact: true })).toBeVisible();

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
      page.getByText("Local QA opt-in was not enabled at startup.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Run audited dry scan",
        exact: true,
      }),
    ).toBeDisabled();
  });
});
