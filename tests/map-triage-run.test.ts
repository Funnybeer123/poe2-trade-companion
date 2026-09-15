import { describe, expect, it, vi } from "vitest";
import { runMapTriage, type MapTriageRunOptions } from "../src/core/mapTriageRun.js";
import { classifyBagRead, type BagCellRead } from "../src/core/mapTriage.js";
import type { FastTriageOps, TriagePoint } from "../src/core/mapTriageExecution.js";
import type { TierVerdict } from "../src/core/valueTiers.js";

const scroll = (n: number) => `Item Class: Stackable Currency\nRarity: Currency\nScroll of Wisdom\n--------\nStack Size: ${n}/40`;
const ring = (name: string, unid = false) => `Item Class: Rings\nRarity: Rare\n${unid ? "" : `${name}\n`}Gold Ring\n--------\nItem Level: 80\n--------\n${unid ? "Unidentified" : "+10 to maximum Life"}`;
const orb = "Item Class: Stackable Currency\nRarity: Currency\nExalted Orb\n--------\nStack Size: 2/20";
const verdict = (tier: TierVerdict["tier"], source: TierVerdict["source"] = "rule"): TierVerdict =>
  ({ tier, source, reasons: ["test evaluation"], matchedRules: [] });

function scenario() {
  const state = new Map<string, string>([["0,0", scroll(10)], ["0,4", ring("Junk", true)], ["0,7", ring("Keeper")], ["1,0", orb]]);
  const key = (point: TriagePoint) => `${point.y},${point.x}`;
  const point = (row: number, col: number) => ({ x: col, y: row });
  const cells: BagCellRead[] = Array.from({ length: 60 }, (_, i) => {
    const row = Math.floor(i / 12), col = i % 12;
    return { row, col, ...point(row, col), text: state.get(`${row},${col}`) ?? "" };
  });
  let held = "", armed = false, stopped = false;
  const clicks: string[] = [];
  const copy = vi.fn(async (points: TriagePoint[]) => points.map((p) => state.get(key(p)) ?? ""));
  const leftClick = async (p: TriagePoint) => {
    clicks.push(key(p));
    if (p.x < 0) { held = ""; return; }
    const text = state.get(key(p)) ?? "";
    if (armed) {
      if (classifyBagRead(text).kind === "unid-gear") {
        state.set(key(p), ring("Junk"));
        state.set("0,0", scroll(9));
      }
      return;
    }
    if (held) { state.set(key(p), held); held = text; }
    else if (text) { held = text; state.delete(key(p)); }
  };
  const ops: FastTriageOps = {
    copyPoints: copy,
    identifyBurst: async (points) => {
      const texts: string[] = [];
      for (const p of points) {
        await leftClick(p);
        texts.push(state.get(key(p)) ?? "");
        if (classifyBagRead(texts[texts.length - 1]).kind !== "identified-gear") {
          armed = false;
          return { count: texts.length, texts, verificationFailed: true };
        }
      }
      armed = false;
      return { count: texts.length, texts };
    },
    rightClick: async () => { armed = true; },
    leftClick,
    clickBurst: async (points, options) => {
      for (const p of points) await leftClick(p);
      if (options.shift) armed = false;
    },
    sleep: async () => undefined,
    checkpoint: async () => undefined,
    shouldStop: () => stopped,
  };
  const options: MapTriageRunOptions = {
    cells, grid: { cols: 12, rows: 5 }, evaluate: (text) => verdict(text.includes("Keeper") ? "keep" : "dump"),
    ops, live: true, maxDrops: 59, groundPoint: { x: -10, y: -10 },
    cellPoint: point, placePoint: (row, col) => point(row, col), moveGapMs: 35, dropGapMs: 200,
    beforeMutations: vi.fn(async () => undefined),
  };
  return { state, cells, options, clicks, copy, stop: () => { stopped = true; }, get held() { return held; } };
}

describe("complete map triage run (offline cursor simulation)", () => {
  it("identifies, evaluates, drops junk and compacts with only the necessary item clicks", async () => {
    const game = scenario();
    const result = await runMapTriage(game.options);
    expect(result.aborted).toBeUndefined();
    expect(result).toMatchObject({ items: 3, unidentified: 1, identified: 1, dropped: 1, moves: 1 });
    expect(game.clicks).toHaveLength(6); // one identify, three drop/probe, two bag moves
    expect(game.held).toBe("");
    expect(game.state.get("0,0")).toBe(scroll(9));
    expect([...game.state.values()].filter((text) => text.includes("Keeper"))).toHaveLength(1);
    expect([...game.state.values()].some((text) => text.includes("Junk"))).toBe(false);
    expect([...game.state.values()]).toContain(orb);
  });

  it("preview uses the supplied evaluator and sends no execution reads or clicks", async () => {
    const game = scenario();
    const evaluate = vi.fn(() => verdict("sell", "heuristic"));
    const result = await runMapTriage({ ...game.options, live: false, evaluate });
    expect(result.aborted).toBeUndefined();
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(result.decisions[0]).toMatchObject({ name: "Keeper", drop: false });
    expect(game.copy).not.toHaveBeenCalled();
    expect(game.options.beforeMutations).not.toHaveBeenCalled();
    expect(game.clicks).toEqual([]);
  });

  it("recognises adjacent Augments as separate one-cell items and never identifies or drops them", async () => {
    const game = scenario();
    for (const cell of game.cells) cell.text = cell.row === 0 && cell.col === 0 ? scroll(10) : "";
    const augment = (name: string) => `Item Class: Augment\nRarity: Currency\n${name}\n--------\nStack Size: 1/10`;
    game.cells[12].text = augment("Boar Idol");
    game.cells[24].text = augment("Greater Robust Rune");
    game.cells[36].text = augment("Greater Robust Rune");
    const evaluate = vi.fn(() => verdict("dump"));
    const result = await runMapTriage({ ...game.options, evaluate });
    expect(result).toMatchObject({ items: 3, unidentified: 0, identified: 0, dropped: 0, moves: 0 });
    expect(result.aborted).toBeUndefined();
    expect(evaluate).not.toHaveBeenCalled();
    expect(game.copy).not.toHaveBeenCalled();
    expect(game.clicks).toEqual([]);
  });

  it("missing/zero scroll, incomplete geometry and invalid drop cap abort before any mutation", async () => {
    for (const defect of ["scroll-missing", "scroll-empty", "layout", "cap"]) {
      const game = scenario();
      if (defect === "scroll-missing") game.cells[0].text = orb;
      if (defect === "scroll-empty") game.cells[0].text = scroll(0);
      if (defect === "layout") game.cells.pop();
      const result = await runMapTriage({ ...game.options, maxDrops: defect === "cap" ? Number.NaN : 59 });
      expect(result.aborted).toBeTruthy();
      expect(game.clicks).toEqual([]);
      expect(game.options.beforeMutations).not.toHaveBeenCalled();
    }
  });

  it("stash refusal prevents identification as well as drops and moves", async () => {
    const game = scenario();
    await expect(runMapTriage({ ...game.options, beforeMutations: async () => { throw new Error("stash-panel-open"); } })).rejects.toThrow("stash-panel-open");
    expect(game.clicks).toEqual([]);
  });

  it("keep-unknown and max-drops=0 retain items while no-compact retains positions", async () => {
    for (const variant of [{ keepUnknown: true, maxDrops: 59 }, { keepUnknown: false, maxDrops: 0 }]) {
      const game = scenario();
      const result = await runMapTriage({ ...game.options, ...variant, noCompact: true, evaluate: () => verdict("unknown", "default") });
      expect(result.aborted).toBeUndefined();
      expect(result.dropped).toBe(0);
      expect(result.moves).toBe(0);
      expect(game.clicks).toHaveLength(1);
      expect(game.state.get("0,4")).toContain("Junk");
      expect(game.state.get("0,7")).toContain("Keeper");
    }
  });

  it("keeps unknown valuations by default and records each identified item for local review", async () => {
    const game = scenario();
    const unknown = verdict("unknown", "default");
    const observeEvaluation = vi.fn();
    const result = await runMapTriage({ ...game.options, noCompact: true,
      evaluate: () => unknown, observeEvaluation });
    expect(result.aborted).toBeUndefined();
    expect(result.dropped).toBe(0);
    expect(result.decisions.every((decision) => !decision.drop)).toBe(true);
    expect(observeEvaluation).toHaveBeenCalledTimes(2);
    expect(observeEvaluation).toHaveBeenCalledWith(ring("Junk"), unknown);
    expect(observeEvaluation).toHaveBeenCalledWith(ring("Keeper"), unknown);
    expect(game.clicks).toHaveLength(1); // identify only
  });

  it("preserves explicit opt-in to dropping unknown gear", async () => {
    const game = scenario();
    const result = await runMapTriage({ ...game.options, keepUnknown: false, noCompact: true,
      evaluate: () => verdict("unknown", "default") });
    expect(result.aborted).toBeUndefined();
    expect(result.dropped).toBe(2);
    expect(result.decisions.every((decision) => decision.drop)).toBe(true);
    expect(game.clicks).toHaveLength(7); // identify plus two verified three-click drops
    expect(game.state.get("0,4")).toBeUndefined();
    expect(game.state.get("0,7")).toBeUndefined();
  });

  it("observes preview evaluations without copying, identifying, dropping, or moving", async () => {
    const game = scenario();
    const observeEvaluation = vi.fn();
    const result = await runMapTriage({ ...game.options, live: false,
      evaluate: () => verdict("unknown", "default"), observeEvaluation });
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].drop).toBe(false);
    expect(observeEvaluation).toHaveBeenCalledTimes(1);
    expect(observeEvaluation.mock.calls[0][0]).toBe(ring("Keeper"));
    expect(game.copy).not.toHaveBeenCalled();
    expect(game.clicks).toEqual([]);
  });

  it("stopped execution cannot advance into drop or compaction", async () => {
    const game = scenario();
    game.stop();
    const result = await runMapTriage(game.options);
    expect(result.aborted).toBe("stop-requested");
    expect(game.clicks).toEqual([]);
  });

  it("an already compacted bag of keepers has zero execution reads or clicks", async () => {
    const game = scenario();
    for (const cell of game.cells) cell.text = cell.row === 0 && cell.col === 0 ? scroll(10) : "";
    game.cells[12].text = ring("Keeper");
    const result = await runMapTriage(game.options);
    expect(result).toMatchObject({ identified: 0, dropped: 0, moves: 0 });
    expect(result.aborted).toBeUndefined();
    expect(game.copy).not.toHaveBeenCalled();
    expect(game.options.beforeMutations).not.toHaveBeenCalled();
    expect(game.clicks).toEqual([]);
  });
});
