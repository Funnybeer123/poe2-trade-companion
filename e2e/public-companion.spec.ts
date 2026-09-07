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

/** Every primary workspace, in rail order, with its page heading and route. */
const WORKSPACES = [
  ["Sort", "Sort & triage", "/sort"],
  ["Shop", "Shop", "/shop"],
  ["Wealth", "Wealth", "/wealth"],
  ["Item log", "Item log", "/items"],
  ["Search", "Search & rules", "/search"],
  ["Builds", "Build profiles", "/builds"],
] as const;

/** Tools & QA sections added by the 2026-09 roadmap, with their headings. */
const TOOLS = [
  ["Market", "Trends, stacks & farming", "/tools/market"],
  ["Deals", "Deals watchlist", "/tools/deals"],
  ["Loot filter", "Loot filter generator", "/tools/filter"],
] as const;

test("companion shell exposes every workspace with the e-stop armed", async ({}, testInfo) => {
  await withPackagedElectron("public-companion", testInfo, async ({ page }) => {
    await expect(
      page.getByText("E-stop ready · Ctrl+Shift+Esc", { exact: true }),
    ).toBeVisible();

    for (const [label, heading, route] of WORKSPACES) {
      await navigatePrimary(page, label, heading, route);
      if (label === "Wealth") {
        // A fresh user-data dir has no inventory ledger: the empty state must render.
        await expect(page.getByText(/Nothing in the ledger yet/)).toBeVisible();
      }
    }

    await navigatePrimary(page, "Tools & QA", "Tools & QA", "/tools");
    const tools = page.getByRole("navigation", { name: "Tools and QA sections" });
    for (const [link, heading, route] of TOOLS) {
      await tools.getByRole("link", { name: new RegExp(`^${link}`) }).click();
      await expect(page).toHaveURL(new RegExp(`#${route}$`));
      await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    }
    // The loot filter previews from the local price table without any network.
    await expect(page.locator(".filter-output")).toContainText(
      "# PoE2 Trade Companion loot filter",
    );
  });
});

test("item intelligence evaluates, searches, imports, and persists locally", async (
  {},
  testInfo,
) => {
  await withPackagedElectron("public-companion", testInfo, async ({ page }) => {
    await navigatePrimary(page, "Item log", "Item log", "/items");
    await page.getByLabel("Path of Exile item text").fill(RARE_RING);
    await page.getByRole("button", { name: "Evaluate text", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Doom Turn", exact: true })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Estimated value", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "This is an estimate, not a guaranteed sale price. Confirm current listings before acting.",
        { exact: true },
      ),
    ).toBeVisible();

    await navigatePrimary(page, "Search", "Search & rules", "/search");
    await page
      .getByRole("button", { name: "Generate validated queries", exact: true })
      .click();
    await expect(page.locator(".query-card code").first()).toContainText("Ruby Ring");

    await page.getByText("Rule studio", { exact: true }).first().click();
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

    await navigatePrimary(page, "Item log", "Item log", "/items");
    await page.getByText("Scan sessions", { exact: true }).first().click();
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

  // A second launch on the same user-data dir must show everything persisted.
  await withPackagedElectron("public-companion", testInfo, async ({ page }) => {
    await navigatePrimary(page, "Item log", "Item log", "/items");
    await expect(page.getByText("Doom Turn", { exact: true }).first()).toBeVisible();
    await navigatePrimary(page, "Search", "Search & rules", "/search");
    await page.getByText("Rule studio", { exact: true }).first().click();
    await expect(page.getByText("E2E life rules", { exact: true }).first()).toBeVisible();
    await navigatePrimary(page, "Builds", "Build profiles", "/builds");
    await expect(page.getByText("E2E ring build", { exact: true }).first()).toBeVisible();
    await navigatePrimary(page, "Item log", "Item log", "/items");
    await page.getByText("Scan sessions", { exact: true }).first().click();
    await expect(page.getByText("legacy-jsonl", { exact: true }).first()).toBeVisible();
  });
});
