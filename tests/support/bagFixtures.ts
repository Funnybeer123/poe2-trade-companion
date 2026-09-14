import { captureBagObservations, cellKey, type BagCellObservation } from "../../src/core/bagAssessment.js";
import { createBagSession, type BagAction, type BagScene, type BagSession, type BagSessionPorts } from "../../src/core/bagSession.js";
import { CLASS_SIZE_DEFAULTS } from "../../src/core/itemSizeCatalog.js";
import { parseItemText } from "../../src/core/parseItem.js";
import { affix, text, AT } from "./batchFixtures.js";
export const weakText = () => text([affix("Suffix", 8, "+8% to Fire Resistance"), affix("Suffix", 8, "+8% to Cold Resistance"),
  affix("Suffix", 8, "+8% to Lightning Resistance"), affix("Prefix", 8, "+12 to maximum Life")]);
export const wisdom = (count = 10) => "Item Class: Stackable Currency\nRarity: Currency\nScroll of Wisdom\n--------\nStack Size: " + count + " / 40";
export const unid = () => text([], { status: "Unidentified" });
export interface FixtureItem { text: string; row: number; col: number; w?: number; h?: number }
export function scene(items: FixtureItem[]): BagScene {
  const cells: BagCellObservation[] = Array.from({ length: 60 }, (_, n) => ({ row: Math.floor(n / 12), col: n % 12,
    state: "empty", evidence: "synthetic:empty:" + n }));
  for (const item of items) {
    const size = CLASS_SIZE_DEFAULTS.find(s => s.itemClass === parseItemText(item.text).itemClass);
    for (let r = 0; r < (item.h ?? size?.h ?? 1); r++) for (let c = 0; c < (item.w ?? size?.w ?? 1); c++) {
      const cell = cells.find(cell => cell.row === item.row + r && cell.col === item.col + c);
      if (!cell || cell.state !== "empty") throw new Error("Overlapping/out-of-bounds fixture.");
      Object.assign(cell, { state: "item", rawText: item.text, confirmation: item.text, evidence: "synthetic:item:" + cellKey(cell) });
    }
  }
  return { at: AT, evidence: "synthetic:scene", mapInstance: "synthetic-map-1", context: "map", foreground: true,
    inventoryOpen: true, obstructed: false, alive: true, loading: false, calibration: "synthetic-12x5",
    cursor: { state: "empty", evidence: "synthetic:empty-cursor" }, ground: { x: 400, y: 300, valid: true, evidence: "synthetic:ground" }, cells };
}
export function session(items: FixtureItem[]): BagSession {
  const s = scene(items);
  return createBagSession(captureBagObservations("bag-test", s.cells, undefined, AT), s, "replay");
}
/** Simulated game, only for deterministic faults. This is NOT screenshot evidence. */
export function simulator(initial: BagSession, options: {
  mutate?: (action: BagAction, scene: BagScene, actions: BagAction[]) => void;
  save?: (session: BagSession) => void;
  checkpoint?: (count: number) => void;
} = {}) {
  let current = structuredClone(initial.scene), latest = structuredClone(initial), count = 0;
  const actions: BagAction[] = [], saves: BagSession[] = [];
  const replace = (row: number, col: number, rawText?: string) => {
    const cell = current.cells.find(c => c.row === row && c.col === col)!;
    Object.assign(cell, rawText ? { state: "item", rawText, confirmation: rawText } : { state: "empty", rawText: undefined, confirmation: undefined });
  };
  const ports: BagSessionPorts = { now: () => AT,
    checkpoint: async () => { options.checkpoint?.(++count); },
    observe: async () => structuredClone(current),
    save: s => { options.save?.(s); latest = structuredClone(s); saves.push(latest); },
    mutate: async action => {
      actions.push(structuredClone(action));
      const row = latest.report.rows.find(r => r.id === action.itemId)!;
      if (action.kind === "arm") current.cursor = { state: "wisdom", evidence: "synthetic:armed" };
      if (action.kind === "identify") {
        for (const c of row.cells!) replace(c.row, c.col, weakText());
        const scroll = current.cells[0]!.rawText!;
        const n = Number(/Stack Size: (\d+)/.exec(scroll)![1]);
        replace(0, 0, n === 1 ? undefined : wisdom(n - 1));
        current.cursor = { state: "empty", evidence: "synthetic:empty-cursor" };
      }
      if (action.kind === "pickup") {
        for (const c of row.cells!) replace(c.row, c.col);
        current.cursor = { state: "item", rawText: row.rawText, evidence: "synthetic:held-item" };
      }
      if (action.kind === "drop") {
        current.cursor = { state: "empty", evidence: "synthetic:empty-cursor" };
        current.groundReceipt = { actionId: action.id, rawText: row.rawText, evidence: "synthetic:new-label" };
      }
      options.mutate?.(action, current, actions);
    },
  };
  return { ports, actions, saves, get latest() { return latest; }, get current() { return current; }, set current(s: BagScene) { current = s; } };
}
