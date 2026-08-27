import { describe, expect, it } from "vitest";
import { canArmFromUi } from "../src/core/uiPolicy.js";
import { TradeApiMarketProvider } from "../src/core/market.js";
import { backoffMs } from "../src/core/safety.js";
import { detectRegions, ocrLootLabels, processAllowed } from "../src/core/perception.js";

describe("ui and market failure behavior", () => {
  it("allows arming from the companion UI", () => {
    expect(canArmFromUi("public-companion", false)).toBe(true);
    expect(canArmFromUi("authorized-qa", true)).toBe(true);
  });

  it("does not call the undocumented trade endpoint or fabricate prices", async () => {
    let fetchCalls = 0;
    const provider = new TradeApiMarketProvider(async () => {
      fetchCalls += 1;
      return new Response("no", { status: 429 });
    });
    const item = {
      itemClass: "Rings",
      rarity: "Rare",
      name: "x",
      baseType: "Iron Ring",
      requirements: {},
      mods: [],
      identified: true,
      fingerprint: "f",
    };
    expect(provider.supports(item)).toBe(false);
    await expect(
      provider.quote(
        item,
        { league: "Standard", currency: "exalted" },
      ),
    ).rejects.toThrow("trade-provider-disabled-undocumented-api");
    expect(fetchCalls).toBe(0);
    expect(await provider.health()).toMatchObject({ ok: false });
  });

  it("bounds provider backoff", () => {
    expect(backoffMs(0)).toBe(250);
    expect(backoffMs(8)).toBe(30_000);
  });

  it("allowlists processes and detects UI regions", () => {
    expect(processAllowed("PathOfExile.exe", ["PathOfExile"])).toBe(true);
    const regions = detectRegions(1920, 1080);
    expect(regions.inventory.w).toBeGreaterThan(0);
    expect(ocrLootLabels(["Rare Ring", "  "])[0]?.score).toBe(80);
  });
});
