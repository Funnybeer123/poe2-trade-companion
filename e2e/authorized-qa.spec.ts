import { expect, test } from "@playwright/test";
import { deckSmoke } from "./deck-smoke.js";
test("Stream Deck native bridge routes controls and dry-run without game input", async ({}, info) => { await deckSmoke("authorized-qa", info); });
import { combatSmoke } from "./combat-smoke.js";
import { dashboardSmoke } from "./dashboard-smoke.js";
import { windowFocusSmoke } from "./window-focus-smoke.js";
import { priceHelperSmoke } from "./price-helper-smoke.js";
import { stashValuationSmoke } from "./stash-valuation-smoke.js";
import { bagTriageSmoke } from "./bag-triage-smoke.js";

test("bag triage worker runs offline with isolated journals and no game input", async ({}, testInfo) => {
  await bagTriageSmoke("authorized-qa", testInfo);
});

test("dump values persist league routing and display every item without game input", async ({}, testInfo) => {
  await stashValuationSmoke("authorized-qa", testInfo);
});

test("price helper safely prices lists and preserves league settings", async ({}, testInfo) => {
  await priceHelperSmoke("authorized-qa", testInfo);
});

test("window activation restores and raises the existing companion", async ({}, testInfo) => {
  await windowFocusSmoke("authorized-qa", testInfo);
});

test("dashboard quick controls preserve settings across navigation", async ({}, testInfo) => {
  await dashboardSmoke("authorized-qa", testInfo);
});

test("combat controls persist and require HUD calibration", async ({}, testInfo) => {
  await combatSmoke("authorized-qa", testInfo);
});
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
