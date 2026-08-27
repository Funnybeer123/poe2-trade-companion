import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyBlockedCells,
  applyStashClickOffset,
  assistiveMemoryPath,
  clearScenarioMemory,
  emptyMemory,
  learnFromDeposit,
  learnFromFill,
  learnStashClick,
  loadAssistiveMemory,
  nextEmptyReturn,
  planEmptyStashPlacement,
  returnTargetsFromKnown,
  saveAssistiveMemory,
  scenarioExclusions,
  scenarioMemoryKey,
} from "../src/core/assistiveMemory.js";
import type { StashItem } from "../src/core/bagPack.js";
import type { UiFacts } from "../src/core/uiPerception.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function item(row: number, col: number, w = 2, h = 4): StashItem {
  return {
    id: `${row},${col}:${w}x${h}`,
    grab: { row, col, x: 40 + col * 10, y: 80 + row * 10 },
    cells: [{ row, col }],
    w,
    h,
  };
}

function facts(bag: number, stash: Array<{ row: number; col: number }>): UiFacts {
  return {
    optionsOpen: false,
    loading: false,
    stashPanelOpen: true,
    inventoryPanelOpen: true,
    vendorPanelOpen: false,
    stashChestVisible: false,
    inventoryRegion: { x: 1000, y: 300, w: 480, h: 450 },
    stashRegion: { x: 80, y: 144, w: 736, h: 630 },
    occupiedBag: Array.from({ length: bag }, (_, i) => ({ row: 0, col: i, x: 0, y: 0 })),
    occupiedStash: stash.map((cell) => ({ ...cell, x: 0, y: 0 })),
    stashItems: [],
    stashGridSize: { cols: 24, rows: 24 },
    bagEmpty: bag === 0,
    confidence: 0.9,
    reason: "stash-and-bag-open",
    scores: {
      sceneOpen: -1,
      sceneClosed: -1,
      stashPanel: 1,
      inventoryPanel: 1,
      chest: -1,
      options: -1,
      stashGrid: true,
      inventoryGrid: true,
    },
  };
}

describe("assistive memory", () => {
  it("persists only confirmed moves for the matching unique scenario", () => {
    const root = mkdtempSync(path.join(tmpdir(), "assistive-memory-"));
    dirs.push(root);
    const beltScope = scenarioMemoryKey("quad", "class: belts");
    const armourScope = scenarioMemoryKey("quad", "class: body armours");
    const remembered = learnFromFill(emptyMemory(), [item(5, 0)], beltScope, true);
    saveAssistiveMemory(root, remembered);
    const loaded = loadAssistiveMemory(root);
    const exclude = scenarioExclusions(loaded, beltScope, true);
    expect(exclude.has("5,0")).toBe(true);
    expect(scenarioExclusions(loaded, armourScope, true)).toEqual(new Set());
    expect(applyBlockedCells(loaded, new Set())).toEqual(new Set());
  });

  it("remembers withdrawn cells after a fill and only returns leftovers to empty ones", () => {
    const withdrawn = [item(5, 0), item(8, 2)];
    const memory = learnFromFill(emptyMemory(), withdrawn);
    expect(memory.lastWithdrawn.map((cell) => cell.key)).toEqual(["5,0", "8,2"]);
    const open = facts(2, [{ row: 8, col: 2 }]);
    const targets = returnTargetsFromKnown(open, withdrawn, memory, ["5,0", "8,2", "9,9"]);
    expect(targets.map((target) => target.key)).toEqual(["5,0"]);
    expect(nextEmptyReturn(open, targets, new Set())?.key).toBe("5,0");
    expect(nextEmptyReturn(open, targets, new Set(["5,0"]))).toBeUndefined();
  });

  it("requires the complete item footprint to be free before planning a return", () => {
    const armour = item(5, 4, 2, 3);
    const blockedInterior = facts(6, [{ row: 7, col: 5 }]);
    expect(returnTargetsFromKnown(blockedInterior, [armour], emptyMemory(), [])).toEqual([]);

    const open = facts(6, []);
    const targets = returnTargetsFromKnown(open, [armour], emptyMemory(), []);
    expect(targets).toEqual([
      expect.objectContaining({ key: "5,4", w: 2, h: 3 }),
    ]);
    expect(nextEmptyReturn(open, targets, new Set(), { w: 1, h: 3 })).toBeUndefined();
    expect(nextEmptyReturn(open, targets, new Set(), { w: 2, h: 3 })?.key).toBe("5,4");
  });

  it("does not plan a 2x3 item into a 3x1 stash gap", () => {
    const threeByOneGap = facts(
      6,
      Array.from({ length: 24 * 24 }, (_, i) => ({
        row: Math.floor(i / 24),
        col: i % 24,
      })).filter((cell) => !(cell.row === 4 && cell.col >= 3 && cell.col < 6)),
    );
    expect(planEmptyStashPlacement(threeByOneGap, { w: 2, h: 3 })).toBeUndefined();

    threeByOneGap.occupiedStash = threeByOneGap.occupiedStash.filter(
      (cell) => !(cell.row >= 6 && cell.row < 9 && cell.col >= 7 && cell.col < 9),
    );
    expect(planEmptyStashPlacement(threeByOneGap, { w: 2, h: 3 })).toMatchObject({
      row: 6,
      col: 7,
      w: 2,
      h: 3,
    });
  });

  it("does not block withdrawn cells after a successful empty deposit", () => {
    const scope = scenarioMemoryKey("quad", "");
    const targets = [{ key: "5,0", x: 40, y: 80, row: 5, col: 0, w: 2, h: 4 }];
    const remembered = learnFromFill(emptyMemory(), [item(5, 0)], scope, true);
    const landed = learnFromDeposit(remembered, facts(2, []), facts(0, [{ row: 5, col: 0 }]), targets, [], scope, true);
    expect(landed.scenarios[0]?.blockedStash).toEqual([]);
    expect(landed.scenarios[0]?.confirmedAnchors).toEqual(["5,0"]);
    const returned = learnFromDeposit(emptyMemory(), facts(2, []), facts(0, []), targets, ["8,2"], scope);
    expect(returned.scenarios).toEqual([]);
  });

  it("blocks a leftover return only when the item failed to land", () => {
    const scope = scenarioMemoryKey("quad", "");
    const targets = [{ key: "8,2", x: 80, y: 120, row: 8, col: 2, w: 2, h: 4 }];
    const failed = learnFromDeposit(emptyMemory(), facts(2, []), facts(2, []), targets, ["8,2"], scope);
    expect(failed.scenarios[0]?.blockedStash).toEqual([
      expect.objectContaining({ key: "8,2", reason: "deposit-rejected", samples: 1 }),
    ]);
    expect(returnTargetsFromKnown(facts(2, []), [item(8, 2)], failed, [], scope)).toEqual([]);
    const landed = learnFromDeposit(emptyMemory(), facts(2, []), facts(1, [{ row: 8, col: 2 }]), targets, ["8,2"], scope);
    expect(landed.scenarios).toEqual([]);
  });

  it("drops legacy global exclusions instead of applying stale cells", () => {
    const root = mkdtempSync(path.join(tmpdir(), "assistive-memory-"));
    dirs.push(root);
    mkdirSync(path.dirname(assistiveMemoryPath(root)), { recursive: true });
    writeFileSync(
      assistiveMemoryPath(root),
      JSON.stringify({
        version: 1,
        blockedStash: [{ key: "5,0", reason: "legacy", samples: 99, updatedAt: "2025-01-01" }],
        lastWithdrawn: [],
        updatedAt: "2025-01-01",
      }),
    );
    expect(loadAssistiveMemory(root).scenarios).toEqual([]);
  });

  it("clears only the requested stash-tab and query scope", () => {
    const belts = scenarioMemoryKey("quad", "class: belts");
    const armour = scenarioMemoryKey("normal", "class: body armours");
    let memory = learnFromFill(emptyMemory(), [item(1, 1)], belts, true);
    memory = learnFromFill(memory, [item(2, 2)], armour, true);
    const cleared = clearScenarioMemory(memory, belts);
    expect(scenarioExclusions(cleared, belts, true)).toEqual(new Set());
    expect(scenarioExclusions(cleared, armour, true)).toEqual(new Set(["2,2"]));
    expect(cleared.lastWithdrawnScenario).toBe(armour);
    expect(returnTargetsFromKnown(facts(1, []), [], cleared, [], belts)).toEqual([]);
    expect(returnTargetsFromKnown(facts(1, []), [], cleared, [], armour).map((target) => target.key)).toEqual([
      "2,2",
    ]);
  });

  it("learns a STASH click offset and applies it to the next planned point", () => {
    const root = mkdtempSync(path.join(tmpdir(), "assistive-memory-"));
    dirs.push(root);
    const learned = learnStashClick(emptyMemory(), { x: 1680, y: 271 }, { x: 1664, y: 248 });
    expect(learned.stashClick).toMatchObject({ dx: -16, dy: -23, planned: { x: 1680, y: 271 }, actual: { x: 1664, y: 248 } });
    saveAssistiveMemory(root, learned);
    const loaded = loadAssistiveMemory(root);
    expect(applyStashClickOffset({ x: 1680, y: 271 }, loaded.stashClick)).toEqual({ x: 1664, y: 248 });
    const ignored = learnStashClick(emptyMemory(), { x: 1702, y: 236 }, { x: 1434, y: 1043 });
    expect(ignored.stashClick).toBeUndefined();
  });
});
