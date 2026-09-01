import { describe, expect, it } from "vitest";
import type { TriagedCell } from "../src/core/bagTriage.js";
import { BAG_AREA } from "../src/core/gearSort.js";
import {
  planVendorStaging,
  VENDOR_STAGING_POLICY,
} from "../src/core/vendorStaging.js";
import type { TierVerdict } from "../src/core/valueTiers.js";

function cellWith(
  verdict: TierVerdict,
  row = 0,
  col = 0,
  point?: { x: number; y: number },
): TriagedCell {
  return {
    row,
    col,
    x: point?.x ?? 2500 + col * 70,
    y: point?.y ?? 1200 + row * 70,
    status: "copied",
    verdict,
  };
}

const ruleDump: TierVerdict = { tier: "dump", source: "rule", reasons: [], matchedRules: ["junk"] };
const safetyDump: TierVerdict = { tier: "dump", source: "safety", reasons: [], matchedRules: [] };
const keep: TierVerdict = { tier: "keep", source: "rule", reasons: [], matchedRules: [] };

describe("vendor staging", () => {
  it("stages only rule- or price-sourced dump cells inside the bag area", () => {
    const plan = planVendorStaging({
      cells: [
        cellWith(ruleDump, 0, 0),
        cellWith(keep, 0, 1),
        cellWith(safetyDump, 0, 2),
        cellWith(ruleDump, 0, 3, { x: 10, y: 10 }),
      ],
      bagArea: BAG_AREA,
      vendorPanelOpen: true,
      inputAllowed: true,
    });
    expect(plan.ok).toBe(true);
    expect(plan.clicks).toHaveLength(1);
    expect(plan.excluded.map((entry) => entry.reason).sort()).toEqual([
      "outside-bag-area",
      "tier-keep",
      "verdict-source-safety",
    ]);
    expect(plan.requiresHumanConfirm).toBe(true);
    expect(plan.policy).toBe(VENDOR_STAGING_POLICY);
  });

  it("refuses to plan when the vendor panel is closed or input is blocked", () => {
    const closed = planVendorStaging({
      cells: [cellWith(ruleDump)],
      bagArea: BAG_AREA,
      vendorPanelOpen: false,
      inputAllowed: true,
    });
    expect(closed.ok).toBe(false);
    expect(closed.clicks).toHaveLength(0);
    expect(closed.blockedReasons.join(" ")).toMatch(/vendor sell panel/);

    const latched = planVendorStaging({
      cells: [cellWith(ruleDump)],
      bagArea: BAG_AREA,
      vendorPanelOpen: true,
      inputAllowed: false,
    });
    expect(latched.ok).toBe(false);
    expect(latched.blockedReasons.join(" ")).toMatch(/kill switch|not allowed/i);
  });

  it("caps a pass and orders clicks row-major", () => {
    const cells = [cellWith(ruleDump, 1, 0), cellWith(ruleDump, 0, 1), cellWith(ruleDump, 0, 0)];
    const plan = planVendorStaging({
      cells,
      bagArea: BAG_AREA,
      vendorPanelOpen: true,
      inputAllowed: true,
      maxItems: 2,
    });
    expect(plan.stagedCells.map((entry) => [entry.row, entry.col])).toEqual([
      [0, 0],
      [0, 1],
    ]);
    expect(plan.excluded.some((entry) => entry.reason === "over-pass-limit")).toBe(true);
  });

  it("plans only item clicks — every click maps to a staged bag cell", () => {
    const plan = planVendorStaging({
      cells: [cellWith(ruleDump, 0, 0), cellWith(ruleDump, 1, 2)],
      bagArea: BAG_AREA,
      vendorPanelOpen: true,
      inputAllowed: true,
    });
    expect(plan.clicks).toEqual(plan.stagedCells.map((entry) => ({ x: entry.x, y: entry.y })));
    expect(plan.requiresHumanConfirm).toBe(true);
  });
});
