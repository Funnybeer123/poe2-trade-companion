import { expect, test } from "@playwright/test";
import {
  navigatePrimary,
  withPackagedElectron,
} from "./electron-smoke.js";

/**
 * The QA artifact is the same companion built with POE2_BUILD_MODE=authorized-qa
 * (there is no separate QA banner or opt-in any more — see AGENTS.md). The smoke
 * proves the build boots, reports its mode in the rail, arms the e-stop, and
 * reaches every workspace without renderer errors.
 */
test("QA build boots in authorized-qa mode with the e-stop armed", async ({}, testInfo) => {
  await withPackagedElectron("authorized-qa", testInfo, async ({ page }) => {
    const rail = page.locator("aside.side-rail");
    await expect(rail).toBeVisible();
    await expect(rail.locator(".rail-status")).toContainText("authorized-qa");
    await expect(
      page.getByText("E-stop ready · Ctrl+Shift+Esc", { exact: true }),
    ).toBeVisible();

    const routes = [
      ["Home", "Home", "/home"],
      ["Sort", "Sort & triage", "/sort"],
      ["Shop", "Shop", "/shop"],
      ["Market", "Market", "/market"],
      ["Trade", "Trade", "/trade"],
      ["Wealth", "Wealth", "/wealth"],
      ["Item log", "Item log", "/items"],
      ["Search", "Search & rules", "/search"],
      ["Builds", "Build profiles", "/builds"],
      ["Tools & QA", "Tools & QA", "/tools"],
    ] as const;
    for (const [label, heading, route] of routes) {
      await navigatePrimary(page, label, heading, route);
    }

    // Sorting readiness on the home screen names the desktop bridge.
    await navigatePrimary(page, "Sort", "Sort & triage", "/sort");
    await expect(page.getByText("Game bridge available", { exact: true })).toBeVisible();
  });
});
