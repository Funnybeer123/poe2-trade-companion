import { expect, type TestInfo } from "@playwright/test";
import { withPackagedElectron, type SmokeBuildMode } from "./electron-smoke.js";

/** Fixture-only market data; this smoke never starts native capture or game input. */
export async function priceHelperSmoke(mode: SmokeBuildMode, testInfo: TestInfo): Promise<void> {
  await withPackagedElectron(mode, testInfo, async ({ application, page }) => {
    await application.evaluate(() => {
      globalThis.fetch = async input => {
        const url = new URL(String(input));
        if (url.hostname !== "poe.ninja") throw new Error("Unexpected network request in smoke test");
        const category = url.searchParams.get("type");
        const name = category === "Currency" ? "Divine Orb" : `Example ${category}`;
        return new Response(JSON.stringify({ core: { primary: "divine", rates: { exalted: 300 } }, items: [{ id: "fixture", name }], lines: [{ id: "fixture", primaryValue: 1 }] }), { status: 200 });
      };
    });
    await page.evaluate(() => { location.hash = "/tools/price-helper"; });
    await expect(page.getByRole("heading", { name: "Price helper", exact: true })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Refresh prices every 30 minutes" })).not.toBeChecked();
    await page.getByRole("button", { name: "Start scanning", exact: true }).click();
    await expect(page.getByText("Calibrate this list region before scanning.")).toBeVisible();
    const league = page.getByLabel("League", { exact: true });
    await league.fill("HC Forbidden Rites"); await league.press("Tab");
    await expect(page.getByText("Settings saved. Start scanning when ready.")).toBeVisible();
    await page.getByRole("button", { name: "Refresh prices", exact: true }).click();
    await expect(page.getByText("All five price categories refreshed.")).toBeVisible();
    await page.getByLabel("Check an item list").fill("2x Divine Orb\nUncut Skill Gem (Level 19)");
    await page.getByRole("button", { name: "Look up list", exact: true }).click();
    await expect(page.getByRole("cell", { name: "2 div (1 each)", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: /could not be matched exactly/ })).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("League", { exact: true })).toHaveValue("HC Forbidden Rites");
    await expect(page.getByText("Scanning off", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("price-helper.png"), fullPage: true });
  });
}
