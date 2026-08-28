export interface CellRef {
  row: number;
  col: number;
}

export interface VotedCell extends CellRef {
  votes: number;
  fraction: number;
}

export interface VoteResult {
  frames: number;
  cells: VotedCell[];
  /** Seen occupied in at least stableMin of frames. */
  stable: VotedCell[];
  /** Seen occupied in some frames but fewer than all — perception flicker. */
  flicker: VotedCell[];
  /** 0 (all frames agree everywhere) to 1 (every touched cell flickers). */
  flickerRate: number;
}

/**
 * Majority vote per cell across several occupancy snapshots. Single-frame
 * transients (hover glow, animation sparkle, capture tearing) show up as
 * flicker instead of flipping the decision.
 */
export function voteOccupancy(snapshots: CellRef[][], stableMin = 0.6): VoteResult {
  const frames = snapshots.length;
  const counts = new Map<string, VotedCell>();
  for (const snapshot of snapshots) {
    for (const cell of snapshot) {
      const key = `${cell.row},${cell.col}`;
      const entry = counts.get(key);
      if (entry) entry.votes += 1;
      else counts.set(key, { row: cell.row, col: cell.col, votes: 1, fraction: 0 });
    }
  }
  const cells = [...counts.values()]
    .map((cell) => ({ ...cell, fraction: frames === 0 ? 0 : cell.votes / frames }))
    .sort((a, b) => a.row - b.row || a.col - b.col);
  const stable = cells.filter((cell) => cell.fraction >= stableMin);
  const flicker = cells.filter((cell) => cell.votes > 0 && cell.votes < frames);
  return {
    frames,
    cells,
    stable,
    flicker,
    flickerRate: cells.length === 0 ? 0 : flicker.length / cells.length,
  };
}
