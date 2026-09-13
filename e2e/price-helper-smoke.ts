import { expect, type TestInfo } from "@playwright/test";
import { withPackagedElectron, type SmokeBuildMode } from "./electron-smoke.js";

const SKILL_REWARDS = ["Rain of Blades", "Wardbound Minions", "Voltaic Barrier", "Hollow Shell", "Explosive Transmutation", "Animus Splinters"];
interface HelperFixtureRequest { kind: "exchange" | "catalog" | "search" | "fetch" | "unexpected"; category?: string; type?: string; min?: number; max?: number; ids?: string[] }

/** Fixture-only market data; this smoke never starts native capture or game input. */
export async function priceHelperSmoke(mode: SmokeBuildMode, testInfo: TestInfo): Promise<void> {
  await withPackagedElectron(mode, testInfo, async ({ application, page }) => {
    await application.evaluate((_, rewards) => {
      const state: { requests: HelperFixtureRequest[] } = { requests: [] };
      (globalThis as unknown as { __helperSmoke: typeof state }).__helperSmoke = state;
      const listingIds = (reward: number) => Array.from({ length: 4 }, (_, i) => String(reward * 10 + i + 1).padStart(64, "0"));
      const searchIds = rewards.map((_, index) => `H4sIAAAAAAAAA02MOwqAQBBDryKptxBLS4_gBWTRUQZmP7ijKOLd3dXGVC8hyYWkVreE9kKIysGjRfDCnnAb6BkpB71lX4W56sROlGAwsyit78pxGoef_-FCbhDaSb5evm5qA2ePAnfRA6X_vZh_AAAA-${index}`);
      const response = (payload: unknown) => new Response(JSON.stringify(payload), {
        status: 200,
        // Generous fixture policy avoids waiting for real server windows; the shared courtesy gap remains.
        headers: { "content-type": "application/json", "x-rate-limit-ip": "1000:1:60", "x-rate-limit-ip-state": "1:1:0" },
      });
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        if (url.origin === "https://poe.ninja" && url.pathname === "/poe2/api/economy/exchange/current/overview" && method === "GET") {
          const category = url.searchParams.get("type") ?? "";
          if (["Currency", "Runes", "Expedition", "Verisium", "UncutGems"].includes(category) && url.searchParams.get("league") === "HC Forbidden Rites") {
            state.requests.push({ kind: "exchange", category });
            const items = category === "Currency" ? [{ id: "divine", name: "Divine Orb" }, { id: "exalted", name: "Exalted Orb" }] : [{ id: "fixture", name: `Example ${category}` }];
            const lines = category === "Currency" ? [{ id: "divine", primaryValue: 1 }, { id: "exalted", primaryValue: 1 / 300 }] : [{ id: "fixture", primaryValue: 0.025 }];
            return response({ core: { primary: "divine", rates: { exalted: 300, chaos: 100 } }, items, lines });
          }
        }
        if (url.origin === "https://www.pathofexile.com") {
          if (url.pathname === "/api/trade2/data/items" && !url.search && method === "GET") {
            state.requests.push({ kind: "catalog" });
            return response({ result: [
              { id: "gem", entries: rewards.map(type => ({ type })) },
              { id: "currency", entries: [{ type: "Divine Orb" }, { type: "Example Verisium" }] },
            ] });
          }
          if (url.pathname === "/api/trade2/search/poe2/HC%20Forbidden%20Rites" && method === "POST") {
            const body = JSON.parse(String(init?.body));
            const type = body.query?.type, level = body.query?.filters?.misc_filters?.filters?.gem_level;
            const reward = rewards.indexOf(type);
            state.requests.push({ kind: "search", type, min: level?.min, max: level?.max });
            if (reward < 0 || level?.min !== 20 || level?.max !== 20 || body.query?.status?.option !== "online" || body.sort?.price !== "asc") throw new Error("Smoke trade query was not an exact level-20 reward search");
            return response({ id: searchIds[reward], result: listingIds(reward), total: 4 });
          }
          if (url.pathname.startsWith("/api/trade2/fetch/") && method === "GET") {
            const query = url.searchParams.get("query") ?? "";
            const reward = searchIds.indexOf(query);
            const ids = url.pathname.slice("/api/trade2/fetch/".length).split(",");
            state.requests.push({ kind: "fetch", ids });
            if (reward < 0 || JSON.stringify(ids) !== JSON.stringify(listingIds(reward))) throw new Error("Unexpected smoke listing fetch");
            return response({ result: ids.map((id, index) => ({
              id,
              item: { name: "", baseType: rewards[reward], typeLine: rewards[reward], properties: [{ name: "Level", type: 5, values: [[index === 3 ? "19" : "20 (Max)", 0]] }] },
              listing: { price: { amount: index === 3 ? 0.001 : 10 + reward + index, currency: "chaos" }, account: { name: `fixture-seller-${reward}-${index}` } },
            })) });
          }
        }
        state.requests.push({ kind: "unexpected" });
        throw new Error("Unexpected network request in smoke test");
      };
    }, SKILL_REWARDS);
    await page.evaluate(() => { location.hash = "/tools/price-helper"; });
    await expect(page.getByRole("heading", { name: "Price helper", exact: true })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Refresh prices every 30 minutes" })).not.toBeChecked();
    await expect(page.getByRole("checkbox", { name: "Look up missing reward prices live" })).toBeChecked();
    await page.getByRole("button", { name: "Start scanning", exact: true }).click();
    await expect(page.getByText("Calibrate this list region before scanning.")).toBeVisible();
    const league = page.getByLabel("League", { exact: true });
    await league.fill("HC Forbidden Rites"); await league.press("Tab");
    await expect(page.getByText("Settings saved. Start scanning when ready.")).toBeVisible();
    await page.getByRole("button", { name: "Refresh prices", exact: true }).click();
    await expect(page.getByText("All five price categories refreshed.")).toBeVisible();
    await expect(page.locator(".helper-feed strong")).toHaveText(["Currency", "Runes", "Expedition", "Verisium", "Uncut gems"]);
    await expect(page.getByText("8 official catalogue entries loaded for exact matching.")).toBeVisible();
    // Explicit row checks must also work when automatic missing-price lookups are disabled.
    await page.getByRole("checkbox", { name: "Look up missing reward prices live" }).uncheck();
    await expect(page.getByText("Settings saved. Start scanning when ready.")).toBeVisible();
    const input = ["2x Divine Orb", "3x Example Verisium", "Uncut Skill Gem (Level 19)", "Mystery Missing Reward", "Rain of Blades", ...SKILL_REWARDS.map(name => `Skill Level 20: ${name}`)].join("\n");
    await page.getByLabel("Check an item list").fill(input);
    await page.getByRole("button", { name: "Look up list", exact: true }).click();
    await expect(page.getByRole("cell", { name: "2 div (1 each)", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "7.5 chaos (2.5 each)", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: /could not be matched exactly/ })).toHaveCount(2);
    await expect(page.getByRole("cell", { name: /Gem level unreadable or unspecified/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Check live price", exact: true })).toHaveCount(6);
    const initialRequests = await application.evaluate(() => (globalThis as unknown as { __helperSmoke: { requests: HelperFixtureRequest[] } }).__helperSmoke.requests);
    expect(initialRequests.filter(request => request.kind === "search" || request.kind === "fetch")).toEqual([]);
    expect(initialRequests.filter(request => request.kind === "exchange").map(request => request.category).sort()).toEqual(["Currency", "Expedition", "Runes", "UncutGems", "Verisium"]);
    expect(initialRequests.filter(request => request.kind === "catalog")).toHaveLength(1);

    for (const [index, name] of SKILL_REWARDS.entries()) {
      const row = page.locator("tbody tr").filter({ has: page.getByRole("cell", { name, exact: true }) }).filter({ has: page.getByRole("button", { name: "Check live price", exact: true }) });
      await expect(row).toHaveCount(1);
      await row.getByRole("button", { name: "Check live price", exact: true }).click();
      await expect(row.locator(".helper-source")).toHaveText("Official trade listings · 3 samples. Observed range; quality, corruption and sockets can differ.");
      await expect(row.getByRole("cell").nth(1)).toContainText(`≈${10 + index}–${12 + index} chaos`);
      await expect(row.getByRole("cell").nth(1)).toContainText("level 20");
      await expect(row.getByRole("button", { name: "Open trade search", exact: true })).toBeEnabled();
    }
    const finalRequests = await application.evaluate(() => (globalThis as unknown as { __helperSmoke: { requests: HelperFixtureRequest[] } }).__helperSmoke.requests);
    expect(finalRequests.filter(request => request.kind === "search")).toEqual(SKILL_REWARDS.map(type => ({ kind: "search", type, min: 20, max: 20 })));
    expect(finalRequests.filter(request => request.kind === "fetch")).toHaveLength(6);
    expect(finalRequests.filter(request => request.kind === "unexpected")).toEqual([]);
    const rows = await page.evaluate(text => window.poe2!.priceHelper!.lookup(text), input);
    expect(rows.filter(row => row.source === "trade")).toHaveLength(6);
    expect(JSON.stringify(rows)).not.toContain("fixture-seller");
    expect(rows[0]!.source).not.toBe("trade");
    expect(rows[1]!.source).not.toBe("trade");
    await page.screenshot({ path: testInfo.outputPath("price-helper-rewards.png"), fullPage: true });
    await page.reload();
    await expect(page.getByLabel("League", { exact: true })).toHaveValue("HC Forbidden Rites");
    await expect(page.getByRole("checkbox", { name: "Look up missing reward prices live" })).not.toBeChecked();
    await expect(page.getByText("Scanning off", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("price-helper.png"), fullPage: true });
  });
}
