import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, type TestInfo } from "@playwright/test";
import { defaultStashValuationSettings, STASH_SCORING_VERSION, type StashValuationReport, type StashValuationSettings } from "../src/core/stashValuation.js";
import { withPackagedElectron, type SmokeBuildMode } from "./electron-smoke.js";

/** Real packaged IPC/persistence with synthetic reports, an isolated workspace, and no game operations. */
export async function stashValuationSmoke(mode: SmokeBuildMode, testInfo: TestInfo): Promise<void> {
  const workspace = testInfo.outputPath("stash-workspace");
  mkdirSync(workspace, { recursive: true });
  await withPackagedElectron(mode, testInfo, async ({ application, page }) => {
    const userData = await application.evaluate(({ app }) => app.getPath("userData"));
    const artifacts = path.join(userData, "artifacts", "tab-admin");
    mkdirSync(artifacts, { recursive: true });
    await application.evaluate(({ ipcMain }) => {
      const state = { scriptRequests: [] as string[] };
      (globalThis as unknown as { __stashSmoke: typeof state }).__stashSmoke = state;
      ipcMain.removeHandler("stash-tabs:run-script");
      ipcMain.handle("stash-tabs:run-script", (_event, kind: string) => {
        state.scriptRequests.push(kind);
        throw new Error("Worker operations are blocked in the stash valuation smoke test.");
      });
    });
    await page.locator("aside.side-rail").getByRole("link", { name: /^Sort\b/ }).click();
    await expect(page.getByRole("heading", { name: "Find value in your dump tab", exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Dump values/ })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator('[data-test="source-tab"]')).toHaveValue("Dump");
    await expect(page.locator('[data-test="destination-folder"]')).toHaveValue("G");
    await expect(page.locator('[data-test="routing-mode"]')).toHaveValue("class");
    const expected = defaultStashValuationSettings();
    for (const [key, label] of Object.entries(expected.classTabs)) {
      await expect(page.locator(`input[data-test="class-${key}"]`)).toHaveValue(label);
    }
    await expect(page.locator('[data-test="scan"]')).toBeDisabled();
    await expect(page.getByRole("button", { name: "Resume saved pricing", exact: true })).toBeDisabled();
    await page.locator('[data-test="league"]').fill("Forbidden Rites");
    await page.locator('[data-test="league"]').press("Tab");
    await page.getByRole("button", { name: "Save settings", exact: true }).click();
    await expect(page.getByText("Saved valuation settings for Forbidden Rites.", { exact: true })).toBeVisible();
    const saved = JSON.parse(readFileSync(path.join(artifacts, "stash-valuation.json"), "utf8")) as StashValuationSettings;
    expect(saved).toMatchObject({ league: "Forbidden Rites", sourceTab: "Dump", destinationFolder: "G", routingMode: "class",
      minChaos: 1, minCraftScore: 70, minMarketConfidence: 65, classTabs: { "Body Armor": "Body Armour", OffHands: "OffHands" } });

    // Exercise the shipped worker with an empty saved inventory. This proves
    // standalone packaging and persistence without any network or game input.
    const runtime = await application.evaluate(({ app }) => ({ executable: process.execPath, appPath: app.getAppPath() }));
    const worker = path.join(runtime.appPath.replace(/app\.asar$/, "app.asar.unpacked"), "dist-electron", "value-dump.cjs");
    expect(existsSync(worker), "the standalone valuation worker must be unpacked").toBe(true);
    const workerRoot = testInfo.outputPath("offline-worker");
    const workerArtifacts = path.join(workerRoot, "artifacts", "tab-admin");
    mkdirSync(workerArtifacts, { recursive: true });
    writeFileSync(path.join(workerArtifacts, "stash-valuation.json"), JSON.stringify(saved));
    const inputFile = path.join(workerRoot, "empty-scan.json");
    const workerAt = new Date().toISOString();
    const emptyReport: StashValuationReport = {
      schemaVersion: 1, id: "packaged-smoke-empty", startedAt: workerAt, finishedAt: workerAt,
      league: saved.league, settings: saved, scoreVersion: STASH_SCORING_VERSION,
      mode: "scan", status: "complete", sourceTab: saved.sourceTab,
      scannedItems: 0, rows: [], unreadCells: [], errors: [],
    };
    writeFileSync(inputFile, JSON.stringify(emptyReport));
    const output = execFileSync(runtime.executable, [worker, `--from-scan=${inputFile}`], {
      cwd: workspace, windowsHide: true, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", POE2_STASH_DATA_ROOT: workerRoot, POE2_MARKET_CONFIG_DIR: workerRoot },
    });
    expect(output).toContain("0 items, 0 unread cells, 0 verified transfers");
    const offlineReport = JSON.parse(readFileSync(path.join(workerArtifacts, "stash-valuation-report.json"), "utf8")) as StashValuationReport;
    expect(offlineReport).toMatchObject({ status: "complete", mode: "scan", scannedItems: 0, rows: [] });
    const resumedOutput = execFileSync(runtime.executable, [worker, `--from-scan=${inputFile}`, "--pending-only"], {
      cwd: workspace, windowsHide: true, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", POE2_STASH_DATA_ROOT: workerRoot, POE2_MARKET_CONFIG_DIR: workerRoot },
    });
    expect(resumedOutput).toContain("0 items, 0 unread cells, 0 verified transfers");
    const resumedReport = JSON.parse(readFileSync(path.join(workerArtifacts, "stash-valuation-report.json"), "utf8")) as StashValuationReport;
    expect(resumedReport).toMatchObject({ id: emptyReport.id, startedAt: workerAt, league: saved.league,
      status: "complete", scannedItems: 0, rows: [] });

    const at = new Date().toISOString();
    const priced = {
      id: "fixture-priced", rawText: "Item Class: Rings\nRarity: Rare\nFixture Ruby Ring\nRuby Ring\n--------\n+162 to maximum Life",
      name: "Fixture Ruby Ring", baseType: "Ruby Ring", itemClass: "Rings", sourceTab: "Dump", row: 0, col: 0,
      scoreVersion: STASH_SCORING_VERSION, gearScore: 82, craftScore: 0,
      mods: [{ text: "+162 to maximum Life", familyId: "life", tier: 1, points: 9, multiplier: 1 }],
      quote: { state: "priced" as const, league: "Forbidden Rites", provider: "smoke-fixture", fetchedAt: at,
        validUntil: new Date(Date.now() + 600_000).toISOString(), currency: "chaos" as const,
        low: 2, fair: 3, high: 4, sampleSize: 4, candidateCount: 6, confidence: 80, reasons: ["Synthetic comparable evidence for UI verification."] },
      decision: "valuable" as const, destination: "Rings", status: "planned" as const,
      reasons: ["Fixture conservative range exceeds one chaos."],
    };
    const report: StashValuationReport = {
      schemaVersion: 1, id: "packaged-smoke", startedAt: at, finishedAt: at, league: "Forbidden Rites", settings: saved,
      scoreVersion: STASH_SCORING_VERSION, mode: "scan", status: "incomplete", sourceTab: "Dump", scannedItems: 3, unreadCells: [], errors: [],
      rows: [priced, {
        ...priced, id: "fixture-craft", name: "Fixture Craft Ring", row: 1, craftScore: 80, decision: "craft",
        quote: { ...priced.quote, state: "no-comparables", low: undefined, fair: undefined, high: undefined, sampleSize: 0, candidateCount: 0, confidence: 0,
          reasons: ["No fixture comparable listings."] }, reasons: ["Fixture crafting candidate; no profit estimate."],
      }, {
        ...priced, id: "fixture-unpriced", name: "Fixture Unpriced Wand", baseType: "Wand", itemClass: "Wands", row: 2,
        gearScore: 32, decision: "review", destination: "Dump", status: "stay", mods: [],
        quote: { ...priced.quote, state: "unavailable", low: undefined, fair: undefined, high: undefined, sampleSize: 0, candidateCount: 0, confidence: 0,
          reasons: ["Fixture market service is unavailable."] }, reasons: ["Unpriced item remains in Dump for review."],
      }],
    };
    writeFileSync(path.join(artifacts, "stash-valuation-report.json"), JSON.stringify(report));
    await page.getByRole("button", { name: "Refresh report", exact: true }).click();
    const rows = page.locator('[data-test="valuation-row"]');
    await expect(rows).toHaveCount(3);
    await expect(page.getByRole("button", { name: "Resume saved pricing", exact: true })).toBeEnabled();
    await expect(rows.nth(0)).toContainText("3 chaos");
    await expect(rows.nth(0)).toContainText("Low 2 · high 4");
    await expect(rows.nth(0)).toContainText("80% confidence · 4 usable / 6 candidates");
    await expect(rows.nth(0)).toContainText("smoke-fixture · Forbidden Rites");
    await expect(rows.nth(0)).toContainText("valuable · planned");
    await expect(rows.nth(1)).toContainText("Craft 80/100");
    await expect(rows.nth(2)).toContainText("Unpriced · unavailable");
    await expect(rows.nth(2)).toContainText("Remains in Dump");
    await expect(page.getByText(/Item scan coverage: no unresolved cells were reported/)).toBeVisible();
    await expect(page.getByText(/Market coverage is incomplete: 2 unpriced items/)).toBeVisible();
    await rows.nth(0).locator("summary").click();
    await expect(rows.nth(0).locator(".item-text")).toContainText("+162 to maximum Life");
    await expect(rows.nth(0)).toContainText("heuristic score band 1");
    await page.getByText("Existing class tabs in G", { exact: true }).click();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath("stash-valuation.png"), fullPage: true });
    await page.reload();
    await expect(page.locator('[data-test="league"]')).toHaveValue("Forbidden Rites");
    await expect(page.locator('[data-test="destination-folder"]')).toHaveValue("G");
    await expect(page.locator('[data-test="valuation-row"]')).toHaveCount(3);
    await page.getByRole("button", { name: "Resume saved pricing", exact: true }).click();
    await expect.poll(() => application.evaluate(() =>
      (globalThis as unknown as { __stashSmoke: { scriptRequests: string[] } }).__stashSmoke.scriptRequests,
    )).toEqual(["value-dump-resume"]);
  }, { cwd: workspace });
}
