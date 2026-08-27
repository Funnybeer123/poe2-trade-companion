import { expect, test } from "@playwright/test";

test("overlay opens with title and disclaimer", async ({ page }) => {
  await page.goto("/?runtime=public-companion");
  await expect(page.getByTestId("overlay-root")).toBeVisible();
  await expect(page.getByTestId("app-title")).toContainText("PoE2 QA Trade Companion");
  await expect(page.getByTestId("disclaimer")).toContainText(
    "This product isn't affiliated with or endorsed by Grinding Gear Games in any way.",
  );
});

test("QA banner is visible and cannot be dismissed in authorized-qa", async ({ page }) => {
  await page.goto("/?runtime=authorized-qa#/automation");
  await expect(page.getByTestId("qa-banner")).toBeVisible();
  await expect(page.getByTestId("qa-stop")).toBeVisible();
  await expect(page.locator("[data-testid='qa-banner-dismiss']")).toHaveCount(0);
  await page.getByTestId("qa-stop").click();
  await expect(page.getByTestId("stop-status")).toContainText("latched");
});

test("arm control is disabled in public companion", async ({ page }) => {
  await page.goto("/?runtime=public-companion#/automation");
  await expect(page.getByTestId("arm-qa")).toBeDisabled();
  await expect(page.getByTestId("arm-disabled-reason")).toContainText("cannot arm");
  await expect(page.getByTestId("qa-banner")).toHaveCount(0);
});

test("settings persist across reload", async ({ page }) => {
  await page.goto("/?runtime=public-companion#/settings");
  const league = page.getByTestId("setting-league");
  await league.fill("SmokeLeague");
  await page.getByTestId("save-settings").click();
  await expect(page.getByTestId("settings-saved")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("setting-league")).toHaveValue("SmokeLeague");
});

test("replay view loads expected states for a fixture id", async ({ page }) => {
  await page.goto("/?runtime=authorized-qa#/replay");
  await page.getByTestId("replay-id").fill("full-loop");
  await page.getByTestId("run-replay").click();
  await expect(page.getByTestId("replay-states")).toContainText("Follow");
  await expect(page.getByTestId("replay-states")).toContainText("LootPickup");
  await expect(page.getByTestId("replay-states")).toContainText("TradeSession");
});

test("first-run wizard requires AUTHORIZED QA plus acknowledgement", async ({ page }) => {
  await page.goto("/?runtime=authorized-qa&firstRun=1&compileTime=authorized-qa");
  await expect(page.getByTestId("first-run-wizard")).toBeVisible();
  await expect(page.getByTestId("first-run-disclaimer")).toContainText(
    "This product isn't affiliated with or endorsed by Grinding Gear Games in any way.",
  );
  await page.getByTestId("first-run-mode-qa").check();
  await page.getByTestId("first-run-continue").click();
  await expect(page.getByTestId("first-run-error")).toBeVisible();
  await page.getByTestId("first-run-qa-phrase").fill("AUTHORIZED QA");
  await page.getByTestId("first-run-qa-ack").check();
  await page.getByTestId("first-run-continue").click();
  await expect(page.getByTestId("first-run-wizard")).toHaveCount(0);
});

test("price check shows estimate not guarantee", async ({ page }) => {
  await page.goto("/?runtime=public-companion#/price-check");
  await page.getByTestId("price-check-input").fill("Rarity: Rare\nStorm Grip\nIron Ring");
  await page.getByTestId("price-check-parse").click();
  await expect(page.getByTestId("price-estimate-label")).toContainText("not a guaranteed sale price");
  await expect(page.getByTestId("price-not-guaranteed")).toContainText("estimate only");
});
