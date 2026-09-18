import { cellKey, wisdomCount, type BagPosition } from "../../src/core/bagAssessment.js";
import type { FastBagPorts, FastLogEntry, FastLook, FastSafety } from "../../src/core/bagFastRun.js";
import type { BagSession } from "../../src/core/bagSession.js";
import { CLASS_SIZE_DEFAULTS } from "../../src/core/itemSizeCatalog.js";
import { parseItemText } from "../../src/core/parseItem.js";
import { AT } from "./batchFixtures.js";
import { weakText, wisdom, type FixtureItem } from "./bagFixtures.js";

export interface FastSimItem { id: number; text: string; row: number; col: number; w: number; h: number }
export type FastSimEvent = { kind: "record"; entry: FastLogEntry } | { kind: "input"; op: string; cell?: BagPosition; cells?: BagPosition[] } | { kind: "save" };
export interface FastSimFaults {
  /** Return the replacement text (or "" for a silent read) for the Nth read at a cell. */
  read?(cell: BagPosition, count: number, text: string): string | undefined;
  armFails?: number;
  /** Item ids the Shift chain skips without using a scroll. */
  chainSkips?(item: FastSimItem): boolean;
  /** Scrolls consumed per identification (1 is correct). */
  scrollsPerUse?: number;
  pickupMisses?: number;
  dropRefused?: boolean;
  identifiedText?(item: FastSimItem): string;
  beforeInput?(op: string, sim: ReturnType<typeof fastSimulator>): void;
  record?(entry: FastLogEntry): void;
  save?(session: BagSession): void;
  safety?(scope: "full" | "hud", count: number): Partial<FastSafety>;
  look?(look: FastLook, pointer: "probe" | "ground"): FastLook;
}

/** Simulated game for orchestration faults only. This is NOT pixel evidence; the
 * vision module and the native-transport adapter have their own tests. */
export function fastSimulator(items: FixtureItem[], faults: FastSimFaults = {}) {
  let next = 0;
  const bag: FastSimItem[] = items.map(item => {
    const size = CLASS_SIZE_DEFAULTS.find(s => s.itemClass === parseItemText(item.text).itemClass);
    return { id: next++, text: item.text, row: item.row, col: item.col, w: item.w ?? size?.w ?? 1, h: item.h ?? size?.h ?? 1 };
  });
  const events: FastSimEvent[] = [], reads = new Map<string, number>(), tracked = new Map<string, { cells: BagPosition[]; art: string }>();
  const sessions: BagSession[] = [];
  let held: FastSimItem | "wisdom" | undefined, pointer: "probe" | "ground" | "bag" = "bag", armFails = faults.armFails ?? 0, pickupMisses = faults.pickupMisses ?? 0, safetyCount = 0;
  const at = (cell: BagPosition) => bag.find(item => cell.row >= item.row && cell.row < item.row + item.h && cell.col >= item.col && cell.col < item.col + item.w);
  const art = (cells: BagPosition[]) => { const item = at(cells[0]!); return item && cells.every(c => at(c) === item) && cells.length === item.w * item.h ? "art:" + item.id : cells.some(at) ? "mixed" : "empty"; };
  const input = (op: string, extra: { cell?: BagPosition; cells?: BagPosition[] } = {}) => { faults.beforeInput?.(op, sim); events.push({ kind: "input", op, ...extra }); };
  const look = (where: "probe" | "ground"): FastLook => {
    pointer = where;
    const footprints: FastLook["footprints"] = {};
    for (const [id, item] of tracked) { const now = art(item.cells); footprints[id] = now === "empty" ? "empty" : now === item.art ? "same" : "changed"; }
    const emptyCells: string[] = [];
    for (let row = 0; row < 5; row++) for (let col = 0; col < 12; col++) if (!at({ row, col })) emptyCells.push(cellKey({ row, col }));
    const result: FastLook = { at: AT, evidence: "synthetic:look:" + events.length, inventoryOpen: true, cursor: where === "probe" ? held ? "occupied" : "clean" : "unobserved", footprints, emptyCells };
    return faults.look?.(result, where) ?? result;
  };
  const ports: FastBagPorts = {
    now: () => AT, checkpoint: async () => {},
    safety: async scope => ({ at: AT, evidence: "synthetic:safety", mapInstance: "synthetic-map-1", context: "map", loading: false, foreground: true, inventoryOpen: true,
      obstructed: false, alive: true, calibration: "synthetic-12x5", ground: { x: 400, y: 300 }, ...faults.safety?.(scope, safetyCount++) }),
    baseline: async () => look("probe"),
    track: list => { for (const item of list) tracked.set(item.id, { cells: item.cells, art: art(item.cells) }); },
    look: async where => look(where),
    read: async cell => {
      input("read", { cell }); pointer = "bag";
      const count = (reads.get(cellKey(cell)) ?? 0) + 1; reads.set(cellKey(cell), count);
      const actual = at(cell)?.text ?? "", text = faults.read?.(cell, count, actual) ?? actual;
      return { text, copied: !!text, ms: 1 };
    },
    arm: async cell => { input("arm", { cell }); if (armFails-- > 0) return; if (wisdomCount(at(cell)?.text ?? "")) held = "wisdom"; },
    chain: async cells => {
      input("chain", { cells });
      for (const cell of cells) {
        const item = at(cell), scroll = at({ row: 0, col: 0 });
        if (held !== "wisdom" || !item || !scroll || parseItemText(item.text).identified || faults.chainSkips?.(item)) continue;
        // Identification keeps class, base, rarity and level; only the modifiers appear.
        item.text = faults.identifiedText?.(item) ?? item.text.replace(/\n--------\nUnidentified$/, "") + weakText().split("--------\n").at(-1)!;
        const left = wisdomCount(scroll.text)! - (faults.scrollsPerUse ?? 1);
        if (left > 0) scroll.text = wisdom(left); else { bag.splice(bag.indexOf(scroll), 1); held = undefined; }
      }
      held = undefined; // Releasing Shift ends the chain.
    },
    pickup: async cell => { input("pickup", { cell }); if (pickupMisses-- > 0) return; const item = at(cell); if (item && !held) { bag.splice(bag.indexOf(item), 1); held = item; } },
    release: async () => { input("release"); if (pointer === "ground" && held && held !== "wisdom" && !faults.dropRefused) { sim.ground.push(held); held = undefined; } },
    record: entry => { faults.record?.(entry); events.push({ kind: "record", entry }); },
    saveSession: session => { faults.save?.(session); sessions.push(structuredClone(session)); events.push({ kind: "save" }); },
  };
  const sim = { ports, bag, events, sessions, ground: [] as FastSimItem[], get held() { return held; }, set held(value) { held = value; },
    inputs: () => events.filter((e): e is Extract<FastSimEvent, { kind: "input" }> => e.kind === "input"),
    add(item: FixtureItem) { bag.push({ id: next++, text: item.text, row: item.row, col: item.col, w: item.w ?? 1, h: item.h ?? 1 }); } };
  return sim;
}
