import { expect, type TestInfo } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { withPackagedElectron, type SmokeBuildMode } from "./electron-smoke.js";
import { DECK_ACTIONS, type DeckActionId, type DeckStatus } from "../src/shared/deckActions.js";

/** Real packaged Electron and HTTP bridge; no game workflow is started. */
export async function deckSmoke(mode: SmokeBuildMode, info: TestInfo) {
  await withPackagedElectron(mode, info, async ({ page, application }) => {
    const root = await application.evaluate(({ app }) => app.getPath("userData"));
    const file = path.join(root, "stream-deck", "connection.json");
    let connection!: { port: number; token: string; session: string };
    await expect.poll(() => { try { connection = JSON.parse(readFileSync(file, "utf8")); return true; } catch { return false; } }).toBe(true);
    const url = `http://127.0.0.1:${connection.port}`;
    const headers = { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" };
    const status = async () => (await fetch(url + "/v1/status", { headers })).json() as Promise<DeckStatus>;
    const command = async (action: DeckActionId, id = randomUUID()) => (await fetch(url + "/v1/command", { method: "POST", headers, body: JSON.stringify({ version: 1, session: connection.session, id, action, parameters: {} }) })).json();
    expect(Object.keys((await status()).buttons)).toHaveLength(DECK_ACTIONS.length);
    expect((await fetch(url + "/v1/status")).status).toBe(403);
    const id = randomUUID(); expect((await command("open.settings", id)).ok).toBe(true);
    await expect(page).toHaveURL(/#\/tools\/settings/);
    expect((await command("open.settings", id)).reason).toContain("Duplicate");
    expect((await command("safety.dry-on")).ok).toBe(true);
    await expect.poll(async () => (await status()).dryRun).toBe(true);
    expect((await command("bag.workflow")).ok).toBe(false);
    expect((await command("safety.estop")).ok).toBe(true);
    expect((await status()).killLatched).toBe(true);
    expect((await command("rings.gamble")).ok).toBe(false);
    expect((await command("safety.rearm")).ok).toBe(true);
    expect((await status()).killLatched).toBe(false);
    expect((await status()).dryRun).toBe(true);
    // Use existing worker preview paths only; no native hosts are launched.
    expect((await command("rings.cleanup")).ok).toBe(true);
    await expect.poll(() => page.evaluate(() => window.poe2!.bagTriage!.status().then(s => s.phase)), { timeout: 15000 }).toBe("complete");
    const bag = await page.evaluate(() => window.poe2!.bagTriage!.status());
    expect(bag.purchased).toBeUndefined(); expect(bag.sold).toBeUndefined();
    await page.screenshot({ path: info.outputPath("deck-settings.png") });
  });
}
