import { STASH_FALLBACK_TAB_FULL_REASON, planTransfers } from "@poe2tc/core";
import { describe, expect, it } from "vitest";
import {
  CHAOS_META,
  DIVINE_META,
  RUSTED_META,
  inventoryCells,
  shadowAt,
  stashCells,
} from "../../helpers/stashWorld.js";

const CATALOG = {
  "divine-1": DIVINE_META,
  "chaos-1": CHAOS_META,
  "rusted-1": RUSTED_META,
};

describe("transferPlanner", () => {
  it("orders planned moves high value first", () => {
    const plan = planTransfers({
      inventory: [
        shadowAt("chaos-1", { kind: "inventory", x: 1, y: 0 }),
        shadowAt("divine-1", { kind: "inventory", x: 0, y: 0 }),
      ],
      tabs: [{ tabId: "currency", cells: stashCells("currency"), tabFull: false }],
      catalog: CATALOG,
    });
    expect(plan.steps.map((step) => step.fingerprint)).toEqual(["divine-1", "chaos-1"]);
    expect(plan.steps[0]?.to).toEqual({ kind: "stash", tabId: "currency", x: 0, y: 0 });
    expect(plan.steps[1]?.to).toEqual({ kind: "stash", tabId: "currency", x: 1, y: 0 });
    expect(plan.blocked).toEqual([]);
  });

  it("uses the fallback tab when the primary tab is full", () => {
    const plan = planTransfers({
      inventory: [shadowAt("divine-1", { kind: "inventory", x: 0, y: 0 })],
      tabs: [
        { tabId: "currency", cells: stashCells("currency", [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }]), tabFull: true },
        { tabId: "dump", cells: stashCells("dump"), tabFull: false },
      ],
      catalog: CATALOG,
    });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.to.tabId).toBe("dump");
    expect(plan.steps[0]?.reason).toContain("fallback");
    expect(plan.blocked).toEqual([]);
  });

  it("blocks when the fallback tab is also full", () => {
    const plan = planTransfers({
      inventory: [shadowAt("divine-1", { kind: "inventory", x: 0, y: 0 })],
      tabs: [
        { tabId: "currency", cells: stashCells("currency", [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }]), tabFull: true },
        { tabId: "dump", cells: stashCells("dump", [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }]), tabFull: true },
      ],
      catalog: CATALOG,
    });
    expect(plan.steps).toEqual([]);
    expect(plan.blocked).toEqual([{ fingerprint: "divine-1", reason: STASH_FALLBACK_TAB_FULL_REASON }]);
  });

  it("returns an empty plan when nothing matches or inventory is empty", () => {
    const unmatched = planTransfers({
      inventory: [shadowAt("keep-1", { kind: "inventory", x: 0, y: 0 })],
      tabs: [{ tabId: "currency", cells: stashCells("currency") }],
      catalog: { "keep-1": { category: "KeepUse", class: "Body Armours", score: 70 } },
    });
    expect(unmatched.steps).toEqual([]);
    expect(unmatched.blocked).toEqual([]);

    const empty = planTransfers({
      inventory: [],
      tabs: [{ tabId: "currency", cells: stashCells("currency") }],
      catalog: CATALOG,
    });
    expect(empty.steps).toEqual([]);
  });

  it("does not invent cells for occupied destinations already reserved by a higher-value item", () => {
    const plan = planTransfers({
      inventory: [
        shadowAt("divine-1", { kind: "inventory", x: 0, y: 0 }),
        shadowAt("chaos-1", { kind: "inventory", x: 1, y: 0 }),
      ],
      tabs: [{ tabId: "currency", cells: inventoryCells([{ x: 0, y: 0, fingerprint: "already" }]).map((cell) => ({ ...cell, tabId: "currency" })) }],
      catalog: CATALOG,
    });
    expect(plan.steps[0]?.to).toEqual({ kind: "stash", tabId: "currency", x: 1, y: 0 });
  });
});
