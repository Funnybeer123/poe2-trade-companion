import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRIAGE_ROUTING,
  partitionTriage,
  planBagSweep,
  planTriageDeposits,
  runBagTriage,
  type TriageCell,
  type TriagedCell,
} from "../src/core/bagTriage.js";
import { BAG_AREA } from "../src/core/gearSort.js";
import type { TierVerdict } from "../src/core/valueTiers.js";

function cell(row: number, col: number): TriageCell {
  return { row, col, x: 2500 + col * 70, y: 1200 + row * 70 };
}

function tier(tierId: TierVerdict["tier"], source: TierVerdict["source"] = "rule"): TierVerdict {
  return { tier: tierId, source, reasons: ["test"], matchedRules: [] };
}

function itemText(name: string, marker: string): string {
  return [
    "Item Class: Rings",
    "Rarity: Rare",
    name,
    "Gold Ring",
    "--------",
    "Item Level: 80",
    "--------",
    marker,
  ].join("\n");
}

describe("bag sweep planning", () => {
  it("orders row-major and clamps cells outside the bag area", () => {
    const cells = [cell(1, 3), cell(0, 5), { row: 0, col: 0, x: 100, y: 500 }];
    const planned = planBagSweep(cells, BAG_AREA);
    expect(planned).toHaveLength(2);
    expect(planned[0]).toMatchObject({ row: 0, col: 5 });
    expect(planned[1]).toMatchObject({ row: 1, col: 3 });
  });
});

describe("bag triage sweep", () => {
  it("copies each cell, evaluates once per distinct item, and groups duplicate fingerprints", async () => {
    const texts = new Map<string, string>([
      ["0,0", itemText("Storm Loop", "+30% to Fire Resistance")],
      ["0,1", itemText("Storm Loop", "+30% to Fire Resistance")],
      ["1,0", itemText("Doom Clutch", "+12 to maximum Life")],
    ]);
    let evaluations = 0;
    const summary = await runBagTriage({
      cells: [cell(0, 0), cell(0, 1), cell(1, 0)],
      bagArea: BAG_AREA,
      copyItem: async (x, y) => {
        const col = Math.round((x - 2500) / 70);
        const row = Math.round((y - 1200) / 70);
        return texts.get(`${row},${col}`) ?? "";
      },
      evaluate: (text) => {
        evaluations += 1;
        return text.includes("Fire Resistance") ? tier("keep") : tier("dump");
      },
    });
    expect(summary.copies).toBe(3);
    expect(summary.distinctItems).toBe(2);
    expect(evaluations).toBe(2);
    expect(summary.cells.filter((entry) => entry.status === "grouped")).toHaveLength(1);
    const grouped = summary.cells.find((entry) => entry.status === "grouped");
    expect(grouped?.verdict.tier).toBe("keep");
  });

  it("marks failed copies unknown and stops after repeated failures", async () => {
    const summary = await runBagTriage({
      cells: [cell(0, 0), cell(0, 1), cell(0, 2), cell(0, 3), cell(0, 4)],
      bagArea: BAG_AREA,
      copyItem: async () => "",
      evaluate: () => tier("dump"),
    });
    expect(summary.failures).toBe(3);
    expect(summary.copies).toBe(3);
    expect(summary.cells).toHaveLength(5);
    expect(summary.cells.every((entry) => entry.verdict.tier === "unknown")).toBe(true);
  });

  it("honours the stop signal", async () => {
    let copied = 0;
    const summary = await runBagTriage({
      cells: [cell(0, 0), cell(0, 1)],
      bagArea: BAG_AREA,
      copyItem: async () => {
        copied += 1;
        return itemText("Item", "+1 to something");
      },
      evaluate: () => tier("unknown", "default"),
      shouldStop: () => copied >= 1,
    });
    expect(summary.stopped).toBe(true);
    expect(summary.cells).toHaveLength(1);
  });
});

describe("triage partition and deposits", () => {
  const triaged = (row: number, col: number, verdict: TierVerdict): TriagedCell => ({
    ...cell(row, col),
    status: "copied",
    verdict,
  });

  it("splits by tier and keeps unknown out of special deposits", () => {
    const cells = [
      triaged(0, 0, tier("keep")),
      triaged(0, 1, tier("sell")),
      triaged(0, 2, tier("dump")),
      triaged(0, 3, tier("unknown", "default")),
    ];
    const partition = partitionTriage(cells);
    expect(partition.keep).toHaveLength(1);
    expect(partition.unknown).toHaveLength(1);
    const deposits = planTriageDeposits(partition);
    expect(deposits.map((entry) => entry.tab)).toEqual([
      DEFAULT_TRIAGE_ROUTING.reviewTab,
      DEFAULT_TRIAGE_ROUTING.reviewTab,
      DEFAULT_TRIAGE_ROUTING.dumpTab,
    ]);
    expect(deposits.flatMap((entry) => entry.cells)).not.toContain(cells[3]);
  });

  it("routes sell to its own tab when configured", () => {
    const partition = partitionTriage([triaged(0, 0, tier("sell"))]);
    const deposits = planTriageDeposits(partition, {
      reviewTab: "Review",
      dumpTab: "Dump",
      sellTab: "Sell",
    });
    expect(deposits).toHaveLength(1);
    expect(deposits[0]?.tab).toBe("Sell");
  });
});
