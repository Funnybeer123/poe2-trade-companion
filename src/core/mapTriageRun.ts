/** One map-bag run over a clipboard-confirmed layout. No OS or network access. */
import {
  classifyBagRead,
  confirmedCompactionItems,
  decideDrop,
  planLeftCompaction,
  resolveBagFootprints,
  type BagCellRead,
  type SpriteRead,
} from "./mapTriage.js";
import {
  runFastCompactionPass,
  runFastDropPass,
  runFastIdentifyPass,
  type FastTriageOps,
} from "./mapTriageExecution.js";
import type { ParsedItem } from "./types.js";
import type { TierVerdict } from "./valueTiers.js";

type Point = { x: number; y: number };

export interface MapTriageRunOptions {
  cells: readonly BagCellRead[];
  grid: { cols: number; rows: number };
  lookupSize?: (item: ParsedItem) => { w: number; h: number } | undefined;
  evaluate(text: string): TierVerdict;
  /** Record local review/training context; this hook must never request market data. */
  observeEvaluation?(itemText: string, verdict: TierVerdict): void;
  ops: FastTriageOps;
  live: boolean;
  /** Unknown valuations stay by default; false is an explicit opt-in to dropping. */
  keepUnknown?: boolean;
  maxDrops?: number;
  noCompact?: boolean;
  groundPoint: Point;
  cellPoint(row: number, col: number): Point;
  placePoint(row: number, col: number, w: number, h: number): Point;
  moveGapMs: number;
  dropGapMs: number;
  /** Verify stash closed immediately before any mutating phase. */
  beforeMutations(): Promise<void>;
  event?(record: Record<string, unknown>): void;
}

export interface MapTriageEvaluation {
  id: string;
  row: number;
  col: number;
  name: string;
  verdict: TierVerdict;
  drop: boolean;
  reason: string;
}

export interface MapTriageRunResult {
  items: number;
  scrolls: number;
  unidentified: number;
  identified: number;
  dropped: number;
  moves: number;
  decisions: MapTriageEvaluation[];
  aborted?: string;
}

export async function runMapTriage(options: MapTriageRunOptions): Promise<MapTriageRunResult> {
  const result: MapTriageRunResult = {
    items: 0, scrolls: 0, unidentified: 0, identified: 0, dropped: 0, moves: 0, decisions: [],
  };
  const abort = (reason: string): MapTriageRunResult => {
    result.aborted = reason;
    options.event?.({ phase: "abort", reason, ...result });
    return result;
  };
  const topLeft = options.cells.find((cell) => cell.row === 0 && cell.col === 0);
  const scroll = classifyBagRead(topLeft?.text ?? "");
  if (scroll.kind !== "scroll") return abort("scroll-missing");
  if (!scroll.stack || scroll.stack < 1) return abort("scroll-empty");
  result.scrolls = scroll.stack;
  const maxDrops = options.maxDrops ?? 59;
  if (!Number.isInteger(maxDrops) || maxDrops < 0) return abort("invalid-max-drops");

  const model = resolveBagFootprints(options.cells, options.grid, options.lookupSize);
  if (model.issues.length) return abort(`bag-layout-unverified: ${model.issues.join("; ")}`);
  const reads = model.reads.filter((read) => classifyBagRead(read.text).kind !== "scroll");
  result.items = reads.length;
  result.unidentified = reads.filter((read) => classifyBagRead(read.text).kind === "unid-gear").length;
  const evaluate = (): void => {
    result.decisions = reads.flatMap((read) => {
      const item = classifyBagRead(read.text);
      if (item.kind !== "identified-gear" || !item.parsed) return [];
      const verdict = options.evaluate(read.text);
      options.observeEvaluation?.(read.text, verdict);
      const decision = decideDrop(verdict, options.keepUnknown ?? true);
      return [{ id: read.sprite.id, row: read.sprite.row, col: read.sprite.col,
        name: item.parsed.name || item.parsed.baseType, verdict, drop: decision.drop, reason: decision.reason }];
    });
  };
  if (!options.live) {
    evaluate();
    options.event?.({ phase: "preview", ...result });
    return result;
  }

  const returnPoint = (read: SpriteRead): Point => options.placePoint(
    read.sprite.row, read.sprite.col, read.sprite.w, read.sprite.h,
  );
  if (result.unidentified) {
    await options.beforeMutations();
    const identified = await runFastIdentifyPass({
      reads, scrollPoint: options.cellPoint(0, 0), ops: options.ops, returnPoint,
    });
    result.identified = identified.identifiedIds.length;
    options.event?.({ phase: "identify", ...identified });
    if (identified.aborted) return abort(identified.aborted);
  }

  evaluate();
  options.event?.({ phase: "evaluate", decisions: result.decisions });
  const ids = new Set(result.decisions.filter((entry) => entry.drop).slice(0, maxDrops).map((entry) => entry.id));
  let droppedIds: string[] = [];
  if (ids.size) {
    await options.beforeMutations();
    const drop = await runFastDropPass({
      candidates: reads.filter((read) => ids.has(read.sprite.id)), groundPoint: options.groundPoint,
      ops: options.ops, dropGapMs: options.dropGapMs, returnPoint,
    });
    droppedIds = drop.droppedIds;
    result.dropped = droppedIds.length;
    options.event?.({ phase: "drop", ...drop });
    if (drop.aborted) return abort(drop.aborted);
    // A changed/gone item invalidates the saved layout. Never compact from it.
    if (drop.skipped.length) return abort(`bag-changed: ${drop.skipped.map((skip) => skip.reason).join(", ")}`);
  }
  if (!options.noCompact) {
    const gone = new Set(droppedIds);
    const confirmed = confirmedCompactionItems(
      model.reads.filter((read) => !gone.has(read.sprite.id)), options.grid,
    );
    const moves = planLeftCompaction(confirmed.map((entry) => entry.item), {
      ...options.grid, reserved: [{ row: 0, col: 0 }],
    });
    if (moves.length) {
      await options.beforeMutations();
      const compact = await runFastCompactionPass({
        confirmed, moves, ...options.grid, ops: options.ops,
        cellPoint: options.cellPoint, placePoint: options.placePoint, moveGapMs: options.moveGapMs,
      });
      result.moves = compact.movedIds.length;
      options.event?.({ phase: "compact", ...compact });
      if (compact.aborted) return abort(compact.aborted);
    }
  }
  return result;
}
