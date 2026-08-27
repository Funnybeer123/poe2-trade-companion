import { expect, test } from "@playwright/test";
import {
  navigatePrimary,
  withPackagedElectron,
} from "./electron-smoke.js";

const RARE_RING = [
  "Item Class: Rings",
  "Rarity: Rare",
  "Doom Turn",
  "Ruby Ring",
  "--------",
  "Requirements:",
  "Level: 50",
  "--------",
  "Item Level: 75",
  "--------",
  "+30% to Fire Resistance (implicit)",
  "--------",
  "+100 to maximum Life",
  "+35% to Cold Resistance",
].join("\n");

test("public build keeps primary navigation companion-only", async ({}, testInfo) => {
  await withPackagedElectron("public-companion", testInfo, async ({ page }) => {
    await expect(page.locator(".qa-banner")).toHaveCount(0);
    await expect(
      page.getByText("Public mode · input locked", { exact: true }),
    ).toBeVisible();

    const routes = [
      ["Items", "Item intelligence", "/items"],
      ["Finder", "Stash query finder", "/finder"],
      ["Builds", "Build profiles", "/builds"],
      ["Rules", "Rule studio", "/rules"],
      ["Scans", "Scan sessions", "/scans"],
    ] as const;
    for (const [label, heading, route] of routes) {
      await navigatePrimary(page, label, heading, route);
    }
    const scannerControls = page.locator(".scanner-controls");
    await expect(scannerControls).toHaveCount(1);
    await scannerControls.locator("summary").click();
    await expect(
      page.getByText("Public companion mode · scanner input locked.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Run audited dry scan",
        exact: true,
      }),
    ).toBeDisabled();

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
      page.getByText(
        "Automation cannot be armed in this build. Public companion intelligence remains available.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Stage selected modules",
        exact: true,
      }),
    ).toBeDisabled();
    await expect(
      page.getByRole("checkbox", { name: /Dry-run default/i }),
    ).toBeChecked();
    await expect(page.getByText("Not staged", { exact: true })).toBeVisible();
    await expect(page.locator(".qa-banner")).toHaveCount(0);
    await expect(
      page.getByText("Public mode · input locked", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("checkbox", {
        name: /Authorized QA acknowledgement/i,
      }),
    ).not.toBeChecked();
    await expect(
      page.getByRole("button", { name: "Disarm", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByText("public-companion", { exact: true }).first(),
    ).toBeVisible();
  });
});

test("public item intelligence evaluates, imports, and persists locally", async (
  {},
  testInfo,
) => {
  await withPackagedElectron("public-companion", testInfo, async ({ page }) => {
    await page.getByLabel("Path of Exile item text").fill(RARE_RING);
    await page.getByRole("button", { name: "Evaluate text", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Doom Turn", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Estimated value", { exact: true })).toBeVisible();
    await expect(
      page.getByText(
        "This is an estimate, not a guaranteed sale price. Confirm current listings before acting.",
        { exact: true },
      ),
    ).toBeVisible();

    await navigatePrimary(page, "Finder", "Stash query finder", "/finder");
    await page
      .getByRole("button", { name: "Generate validated queries", exact: true })
      .click();
    await expect(page.locator(".query-card code").first()).toContainText("Ruby Ring");

    await navigatePrimary(page, "Rules", "Rule studio", "/rules");
    await page.getByLabel("Rule-set name").fill("E2E life rules");
    await page.getByRole("button", { name: "Save rule set", exact: true }).click();
    await expect(page.getByText(/^Saved /)).toBeVisible();

    await navigatePrimary(page, "Builds", "Build profiles", "/builds");
    await page.getByLabel("New profile name").fill("E2E ring build");
    await page
      .getByLabel("Links or query JSON")
      .fill(
        JSON.stringify({
          query: {
            type: "Ruby Ring",
            stats: [],
            filters: {
              type_filters: {
                filters: {
                  category: { option: "accessory.ring" },
                },
              },
            },
          },
          sort: { price: "asc" },
        }),
      );
    await page
      .getByRole("button", { name: "Import as new profile", exact: true })
      .click();
    await expect(page.getByText("1 added · 0 updated", { exact: true })).toBeVisible();
    await expect(page.getByText("E2E ring build", { exact: true }).first()).toBeVisible();

    await navigatePrimary(page, "Scans", "Scan sessions", "/scans");
    await page.getByText("Import offline JSONL", { exact: true }).click();
    await page
      .getByLabel("Scan JSONL")
      .fill(
        JSON.stringify({
          SessionId: "e2e-session",
          SlotKey: "inventory:0,0",
          Status: "copied",
          ItemFingerprint: "e2e-fingerprint",
          ScannedAt: "2026-08-27T12:00:00.000Z",
        }),
      );
    await page
      .getByRole("button", { name: "Import for review", exact: true })
      .click();
    await expect(page.getByText("1 records parsed", { exact: true })).toBeVisible();
    await expect(page.getByText("inventory:0,0", { exact: true })).toBeVisible();
  });

  await withPackagedElectron("public-companion", testInfo, async ({ page }) => {
    await expect(page.getByText("Doom Turn", { exact: true }).first()).toBeVisible();
    await navigatePrimary(page, "Rules", "Rule studio", "/rules");
    await expect(page.getByText("E2E life rules", { exact: true }).first()).toBeVisible();
    await navigatePrimary(page, "Builds", "Build profiles", "/builds");
    await expect(page.getByText("E2E ring build", { exact: true }).first()).toBeVisible();
    await navigatePrimary(page, "Scans", "Scan sessions", "/scans");
    await expect(page.getByText("legacy-jsonl", { exact: true }).first()).toBeVisible();
  });
});
