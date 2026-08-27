import type { FillMove } from "./bagPack.js";
import type { OccupiedCell } from "./uiPerception.js";

export interface FillDiagnosis {
  planned: number;
  bagBefore: number;
  bagAfter: number;
  gained: number;
  expectedGain: number;
  failures: Array<{ reason: string; detail?: string }>;
}

export function diagnoseFillRun(
  bagBefore: OccupiedCell[],
  planned: FillMove[],
  bagAfter: OccupiedCell[],
): FillDiagnosis {
  const before = new Set(bagBefore.map((cell) => `${cell.row},${cell.col}`));
  const after = new Set(bagAfter.map((cell) => `${cell.row},${cell.col}`));
  const expectedGain = planned.reduce((sum, move) => sum + move.item.cells.length, 0);
  let landed = 0;
  const failures: FillDiagnosis["failures"] = [];
  for (const move of planned) {
    const covered = move.item.cells.every((cell) => {
      const row = move.dest.row + (cell.row - Math.min(...move.item.cells.map((part) => part.row)));
      const col = move.dest.col + (cell.col - Math.min(...move.item.cells.map((part) => part.col)));
      return after.has(`${row},${col}`);
    });
    if (covered) landed += move.item.cells.length;
    else failures.push({ reason: "item-did-not-land", detail: `${move.item.w}x${move.item.h}@${move.dest.row},${move.dest.col}` });
  }
  const gained = [...after].filter((key) => !before.has(key)).length;
  if (planned.length > 0 && landed === 0) {
    failures.push({ reason: "few-items-landed", detail: `gained ${gained}, expected ${expectedGain}` });
  }
  return {
    planned: planned.length,
    bagBefore: bagBefore.length,
    bagAfter: bagAfter.length,
    gained,
    expectedGain,
    failures,
  };
}
