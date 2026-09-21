import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DECK_ACTIONS } from "../src/shared/deckActions.js";

const juice = readFileSync("scripts/juice-maps.ts", "utf8");
const service = readFileSync("src/main/stashTabAdminService.ts", "utf8");

describe("T15 juice wiring", () => {
  it("registers the Stream Deck catalog entry after existing finish-gear so XL page 1 keys stay put", () => {
    const ids = DECK_ACTIONS.map((entry) => entry[0]);
    expect(ids).toContain("script.juice-maps");
    expect(ids.indexOf("script.juice-maps")).toBeGreaterThan(ids.indexOf("script.finish-gear"));
  });

  it("double-gates live clicks and prefers the user's Maps calibration over fixtures", () => {
    expect(juice).toContain('process.env.POE2_JUICE_LIVE === "1"');
    expect(juice).toContain("maps-grid-uncalibrated");
    expect(juice).toContain("perception-templates");
    expect(juice).toContain("mapsStashGrid");
    expect(juice).toContain("markToScreenGrid");
    expect(juice).toContain("one sweep");
    expect(juice).toContain("maps × 3 Exalts");
    expect(juice).toContain("No re-reads");
    expect(juice).toContain("Alchemy reroll");
    expect(juice).toContain("planJuiceFromScan");
    expect(juice).toContain("takePickups");
    expect(juice).toContain("vaalburst");
    expect(juice).toContain("well empty after Vaal");
    expect(juice).toContain("still queued");
    expect(juice).toContain("already corrupted");
    expect(juice).toContain("fast: true");
    expect(juice).toContain("fast: false");
    expect(juice).toContain("currencyStackCount");
    expect(juice).toContain("probeX");
    expect(juice).toContain("pickupMs");
    expect(juice).toContain("heldWaystone");
    expect(juice).toContain("emptyCursor");
    expect(juice).toContain("well(s) still had a waystone after the slam");
    expect(juice).toContain("empty-orb click picked up a waystone");
    expect(juice).toContain("still clean after 3 clicks");
    expect(juice).toContain("Ctrl+C saw Corrupted");
    expect(juice).toContain("retries: 3");
    expect(juice).toContain("Shift held");
    expect(juice).toContain("parkHeldWaystone");
    expect(juice).toContain("returnToTier15");
    expect(juice).toContain("MAPS_TIER15_CLICK");
    expect(juice).toContain("allocateOrbClicks");
    expect(juice).toContain("JUICE_BATCH_PHASES");
    expect(juice).toContain("phase ${phase}");
    expect(juice).toContain('op: "ctrlclick"');
    expect(juice).toContain('op: "orbbatch"');
    expect(juice).toContain("pickups");
    expect(juice).toContain("stacks empty, no put-back");
    expect(juice).not.toContain('keys: "escape"');
    expect(service).toContain('kind === "juice-maps" ? { POE2_JUICE_LIVE: "1" }');
  });
});
