/** Verified FAST execution. The host owns input and cancellation inside each burst. */
import {
  classifyBagRead,
  type CompactionItem,
  type CompactionMove,
  type ConfirmedBagItem,
  type SpriteRead,
} from "./mapTriage.js";
import type { ParsedItem } from "./types.js";

export interface TriagePoint { x: number; y: number }

export interface IdentifyBurstResult {
  count: number;
  texts: string[];
  /** The final attempted click did not inline-verify, so no next click was sent. */
  verificationFailed?: boolean;
}

export interface FastTriageOps {
  /** Failed/partial clipboard operations must throw, rather than become empty cells. */
  copyPoints(points: TriagePoint[], label: string): Promise<string[]>;
  rightClick(point: TriagePoint, why: string): Promise<void>;
  leftClick(point: TriagePoint, why: string): Promise<void>;
  /** One host request; shift stays held throughout. Host checks stop before each click. */
  clickBurst(points: TriagePoint[], options: { gapMs: number; hoverMs?: number; shift?: boolean; label: string }): Promise<void>;
  /**
   * Hold Shift once; after EACH click settle >=200ms then copy and verify the
   * expected class is identified before the next click. Release modifiers on
   * every exit. Failed verification returns early, never falls back to blind clicks.
   */
  identifyBurst(points: Array<TriagePoint & { itemClass: string }>,
    options: { gapMs: number; label: string }): Promise<IdentifyBurstResult>;
  sleep(ms: number): Promise<void>;
  /** Pause/stop gate before each safe unit; it may throw the host's stop error. */
  checkpoint(label: string): Promise<void>;
  shouldStop?(): boolean;
}

export const FAST_TRIAGE_TIMING = {
  armMs: 320,
  identifyGapMs: 80,
  identifySettleMs: 200,
  fallbackSettleMs: 250,
  returnSettleMs: 160,
  dropGapMs: 200,
  dropHoverMs: 100,
  dropSettleMs: 160,
  probeSettleMs: 150,
  moveGapMs: 35,
  moveSettleMs: 280,
} as const;

async function ready(ops: FastTriageOps, label: string): Promise<boolean> {
  if (ops.shouldStop?.()) return false;
  await ops.checkpoint(label);
  return !ops.shouldStop?.();
}

async function copy(ops: FastTriageOps, points: TriagePoint[], label: string): Promise<string[]> {
  const texts = await ops.copyPoints(points, label);
  if (texts.length !== points.length || texts.some((text) => typeof text !== "string")) {
    throw new Error(`clipboard-incomplete:${label}`);
  }
  return texts;
}

function fingerprint(text: string): string | undefined {
  return classifyBagRead(text).parsed?.fingerprint;
}

/** Display names and revealed modifiers change on identify; these visible facts do not. */
export function sameIdentifyIdentity(before: ParsedItem, after: ParsedItem): boolean {
  const base = before.baseType.toLowerCase();
  const revealedBase = after.baseType.toLowerCase();
  // A magic clipboard header can have just one line, including its new affixes.
  const sameBase = base === revealedBase || (
    before.rarity.toLowerCase() === "magic" &&
    (` ${revealedBase} `).includes(` ${base} `)
  );
  return sameBase && before.itemClass === after.itemClass && before.rarity === after.rarity &&
    before.itemLevel === after.itemLevel && before.sockets === after.sockets &&
    before.corrupted === after.corrupted;
}

export interface FastIdentifyResult {
  identifiedIds: string[];
  skippedIds: string[];
  fallbackReason?: "inline-copy-unavailable";
  aborted?: string;
}

/** Arm once, run one shift-held chain, then verify every item before any fallback. */
export async function runFastIdentifyPass(args: {
  reads: SpriteRead[];
  scrollPoint: TriagePoint;
  ops: FastTriageOps;
  /** Quarter-cell-biased origin placement for returning a held multi-cell item. */
  returnPoint: (read: SpriteRead) => TriagePoint;
}): Promise<FastIdentifyResult> {
  const { reads, scrollPoint, ops, returnPoint } = args;
  const result: FastIdentifyResult = { identifiedIds: [], skippedIds: [] };
  const abort = (reason: string): FastIdentifyResult => ({ ...result, aborted: reason });
  if (!await ready(ops, "identify preflight")) return abort("stop-requested");
  const targets = reads.filter((read) => !(read.sprite.row === 0 && read.sprite.col === 0) &&
    classifyBagRead(read.text).kind === "unid-gear");
  const before = await copy(ops, [scrollPoint, ...targets.map((read) => read.sprite)], "identify-pin");
  const scroll = classifyBagRead(before[0]);
  if (scroll.kind !== "scroll") return abort("scroll-missing");
  if (!scroll.stack) return abort("scroll-empty");
  if (targets.length === 0) return result;
  for (let index = 0; index < targets.length; index += 1) {
    if (fingerprint(before[index + 1]) !== fingerprint(targets[index].text) ||
        classifyBagRead(before[index + 1]).kind !== "unid-gear") return abort("identify-cell-changed");
  }
  const chain = targets.slice(0, scroll.stack);
  result.skippedIds.push(...targets.slice(scroll.stack).map((read) => read.sprite.id));
  if (!await ready(ops, "arm identify chain")) return abort("stop-requested");
  await ops.rightClick(scrollPoint, "arm Scroll of Wisdom");
  await ops.sleep(FAST_TRIAGE_TIMING.armMs);
  if (!await ready(ops, "identify chain")) return abort("stop-requested");
  const burst = await ops.identifyBurst(chain.map((read) => ({
    ...read.sprite, itemClass: classifyBagRead(read.text).parsed!.itemClass,
  })), {
    gapMs: FAST_TRIAGE_TIMING.identifyGapMs, label: "identify chain",
  });
  if (!Number.isInteger(burst.count) || burst.count < 1 || burst.count > chain.length ||
      burst.texts.length !== burst.count || burst.texts.some((text) => typeof text !== "string") ||
      (burst.count < chain.length && !burst.verificationFailed)) {
    throw new Error("identify-burst-incomplete");
  }
  if (!await ready(ops, "verify identify chain")) return abort("stop-requested");
  result.skippedIds.push(...chain.slice(burst.count).map((read) => read.sprite.id));

  const verify = async (read: SpriteRead, text: string): Promise<"identified" | "unid" | string> => {
    const after = classifyBagRead(text);
    const original = classifyBagRead(read.text).parsed!;
    if (after.kind === "empty") {
      if (!await ready(ops, "return identify misfire")) return "stop-requested";
      await ops.leftClick(returnPoint(read), "return lifted item to its origin");
      await ops.sleep(FAST_TRIAGE_TIMING.returnSettleMs);
      const restored = (await copy(ops, [read.sprite], "identify-return"))[0];
      return fingerprint(restored) === original.fingerprint ? "identify-misfire" : "item-stuck-on-cursor";
    }
    if (!after.parsed || !sameIdentifyIdentity(original, after.parsed)) return "identify-item-changed";
    if (after.kind === "unid-gear") {
      return after.parsed.fingerprint === original.fingerprint ? "unid" : "identify-item-changed";
    }
    if (after.kind !== "identified-gear") return "identify-unreadable";
    read.text = text;
    result.identifiedIds.push(read.sprite.id);
    return "identified";
  };

  const leftovers: SpriteRead[] = [];
  for (let index = 0; index < burst.count; index += 1) {
    const inlineFailed = burst.verificationFailed && index === burst.count - 1;
    // Ctrl+Shift+C may be unsupported on the client. The normal Ctrl+C read
    // after Shift releases establishes whether this click lifted the item.
    const text = inlineFailed ?
      (await copy(ops, [chain[index].sprite], "identify-inline-failure"))[0] : burst.texts[index];
    const status = await verify(chain[index], text);
    if (status === "unid") leftovers.push(chain[index]);
    else if (status !== "identified") return abort(status);
    if (inlineFailed) {
      if (status === "unid") return abort("identify-not-working");
      // A normal copy has positively proved this click identified the SAME
      // item. This client may not support Ctrl+Shift+C, so finish untouched
      // items using individually armed, normal-Ctrl+C-verified attempts.
      // Never resume a burst whose inline verification did not work.
      result.fallbackReason = "inline-copy-unavailable";
      const remaining = chain.slice(burst.count);
      const remainingIds = new Set(remaining.map((read) => read.sprite.id));
      result.skippedIds = result.skippedIds.filter((id) => !remainingIds.has(id));
      leftovers.push(...remaining);
      break;
    }
  }
  // A missed click gets exactly one fresh, verified attempt. Never queue all retries.
  for (const read of leftovers) {
    if (!await ready(ops, "identify retry")) return abort("stop-requested");
    const [scrollText, itemText] = await copy(ops, [scrollPoint, read.sprite], "identify-retry-pin");
    const retryScroll = classifyBagRead(scrollText);
    if (retryScroll.kind !== "scroll" || !retryScroll.stack) {
      result.skippedIds.push(read.sprite.id);
      return abort(retryScroll.kind === "scroll" ? "scroll-empty" : "scroll-missing");
    }
    if (fingerprint(itemText) !== fingerprint(read.text) || classifyBagRead(itemText).kind !== "unid-gear") {
      return abort("identify-cell-changed");
    }
    if (!await ready(ops, "arm identify retry")) return abort("stop-requested");
    await ops.rightClick(scrollPoint, "re-arm Scroll of Wisdom");
    await ops.sleep(FAST_TRIAGE_TIMING.armMs);
    if (!await ready(ops, "identify retry click")) return abort("stop-requested");
    await ops.leftClick(read.sprite, "identify missed item");
    await ops.sleep(FAST_TRIAGE_TIMING.fallbackSettleMs);
    if (!await ready(ops, "verify identify retry")) return abort("stop-requested");
    const status = await verify(read, (await copy(ops, [read.sprite], "identify-retry-verify"))[0]);
    if (status !== "identified") {
      result.skippedIds.push(read.sprite.id);
      return abort(status === "unid" ? "identify-not-working" : status);
    }
  }
  return result;
}

export interface FastDropResult {
  droppedIds: string[];
  skipped: Array<{ id: string; reason: string }>;
  aborted?: string;
}

/** Each pickup/ground pair finishes its put-back truth probe before another pickup. */
export async function runFastDropPass(args: {
  candidates: readonly SpriteRead[];
  groundPoint: TriagePoint;
  ops: FastTriageOps;
  dropGapMs: number;
  returnPoint: (read: SpriteRead) => TriagePoint;
}): Promise<FastDropResult> {
  const { candidates, groundPoint, ops, returnPoint } = args;
  const result: FastDropResult = { droppedIds: [], skipped: [] };
  const abort = (reason: string): FastDropResult => ({ ...result, aborted: reason });
  for (const read of candidates) {
    const expected = classifyBagRead(read.text);
    if (expected.kind !== "identified-gear" || !expected.parsed ||
        (read.sprite.row === 0 && read.sprite.col === 0)) {
      result.skipped.push({ id: read.sprite.id, reason: "not-droppable-gear" });
      continue;
    }
    if (!await ready(ops, "drop item")) return abort("stop-requested");
    const current = classifyBagRead((await copy(ops, [read.sprite], "drop-pin"))[0]);
    if (current.kind === "empty") {
      result.skipped.push({ id: read.sprite.id, reason: "already-gone" });
      return abort("drop-source-missing");
    }
    if (current.kind !== "identified-gear" || current.parsed?.fingerprint !== expected.parsed.fingerprint) {
      result.skipped.push({ id: read.sprite.id, reason: "cell-changed" });
      return abort("drop-cell-changed");
    }
    if (!await ready(ops, "drop pickup")) return abort("stop-requested");
    await ops.clickBurst([read.sprite, groundPoint], {
      gapMs: Math.max(FAST_TRIAGE_TIMING.dropGapMs, args.dropGapMs),
      hoverMs: FAST_TRIAGE_TIMING.dropHoverMs, label: "drop pickup and ground",
    });
    await ops.sleep(FAST_TRIAGE_TIMING.dropSettleMs);
    if (!await ready(ops, "drop origin check")) return abort("stop-requested");
    const after = (await copy(ops, [read.sprite], "drop-origin"))[0];
    if (after.trim()) return abort(fingerprint(after) === expected.parsed.fingerprint ?
      "drop-pickup-missed" : "drop-item-changed");
    if (!await ready(ops, "drop put-back probe")) return abort("stop-requested");
    await ops.leftClick(returnPoint(read), "probe: confirm drop landed");
    await ops.sleep(FAST_TRIAGE_TIMING.probeSettleMs);
    if (!await ready(ops, "verify drop put-back probe")) return abort("stop-requested");
    const probe = (await copy(ops, [read.sprite], "drop-probe"))[0];
    if (probe.trim()) return abort(fingerprint(probe) === expected.parsed.fingerprint ?
      "drop-refused" : "drop-item-changed");
    result.droppedIds.push(read.sprite.id);
  }
  return result;
}

function cells(item: Pick<CompactionItem, "row" | "col" | "w" | "h">): string[] {
  const out: string[] = [];
  for (let row = item.row; row < item.row + item.h; row += 1) {
    for (let col = item.col; col < item.col + item.w; col += 1) out.push(`${row},${col}`);
  }
  return out;
}

export interface FastCompactionResult { movedIds: string[]; aborted?: string }

/** Validate the whole plan, then issue exactly two clicks per verified move. No corrective cascade. */
export async function runFastCompactionPass(args: {
  confirmed: readonly ConfirmedBagItem[];
  moves: readonly CompactionMove[];
  cols: number;
  rows: number;
  cellPoint: (row: number, col: number) => TriagePoint;
  placePoint: (row: number, col: number, w: number, h: number) => TriagePoint;
  ops: FastTriageOps;
  moveGapMs: number;
}): Promise<FastCompactionResult> {
  const { confirmed, moves, cols, rows, ops, cellPoint, placePoint } = args;
  const result: FastCompactionResult = { movedIds: [] };
  const abort = (reason: string): FastCompactionResult => ({ ...result, aborted: reason });
  if (moves.length === 0) return result;
  const valid = (item: CompactionItem): boolean =>
    [item.row, item.col, item.w, item.h].every(Number.isInteger) &&
    item.row >= 0 && item.col >= 0 && item.w > 0 && item.h > 0 &&
    item.col + item.w <= cols && item.row + item.h <= rows;
  const model = new Map<string, CompactionItem>();
  const byId = new Map(confirmed.map((entry) => [entry.item.id, entry]));
  const occupancy = new Map<string, string>([["0,0", "pinned-scroll"]]);
  for (const entry of confirmed) {
    const item = entry.item;
    if (!entry.fingerprint || !valid(item) || model.has(item.id)) return abort("compact-unverified-model");
    const pinned = item.row === 0 && item.col === 0 && item.w === 1 && item.h === 1;
    for (const cell of cells(item)) {
      if (occupancy.has(cell) && !(pinned && cell === "0,0")) return abort("compact-overlapping-model");
      occupancy.set(cell, item.id);
    }
    model.set(item.id, { ...item });
  }
  const moved = new Set<string>();
  for (const move of moves) {
    const item = model.get(move.id);
    const target = { id: move.id, ...move.to, w: move.w, h: move.h };
    if (!item || item.fixed || moved.has(move.id) || (item.row === 0 && item.col === 0) ||
        item.row !== move.from.row || item.col !== move.from.col ||
        item.w !== move.w || item.h !== move.h || !valid(target)) return abort("compact-invalid-plan");
    for (const cell of cells(item)) occupancy.delete(cell);
    if (cells(target).some((cell) => occupancy.has(cell) || cell === "0,0")) return abort("compact-blocked-target");
    for (const cell of cells(target)) occupancy.set(cell, move.id);
    model.set(move.id, target);
    moved.add(move.id);
  }
  for (const move of moves) {
    const expected = byId.get(move.id)!;
    if (!await ready(ops, "compact move")) return abort("stop-requested");
    const origin = cellPoint(move.from.row, move.from.col);
    const sourceCells = new Set(cells({ ...move.from, w: move.w, h: move.h }));
    const target = { ...move.to, w: move.w, h: move.h };
    const targetCells = new Set(cells(target));
    const pointForCell = (cell: string): TriagePoint => {
      const [row, col] = cell.split(",").map(Number);
      return cellPoint(row, col);
    };
    // A new item in ANY destination cell could swap onto the cursor. Pin the
    // source and every destination cell outside its current footprint together.
    const newCells = [...targetCells].filter((cell) => !sourceCells.has(cell));
    const before = await copy(ops, [origin, ...newCells.map(pointForCell)], "compact-pin");
    if (fingerprint(before[0]) !== expected.fingerprint) {
      return abort("compact-cell-changed");
    }
    if (before.slice(1).some((text) => text.trim())) return abort("compact-target-occupied");
    if (!await ready(ops, "compact pickup")) return abort("stop-requested");
    await ops.clickBurst([origin, placePoint(move.to.row, move.to.col, move.w, move.h)], {
      gapMs: Math.max(FAST_TRIAGE_TIMING.moveGapMs, args.moveGapMs), label: "compact pick and place",
    });
    await ops.sleep(FAST_TRIAGE_TIMING.moveSettleMs);
    if (!await ready(ops, "compact verify")) return abort("stop-requested");
    const cornerCells = [...new Set([
      `${target.row},${target.col}`,
      `${target.row},${target.col + target.w - 1}`,
      `${target.row + target.h - 1},${target.col}`,
      `${target.row + target.h - 1},${target.col + target.w - 1}`,
    ])];
    // One source cell outside the new footprint proves the old position cleared.
    const vacated = [...sourceCells].find((cell) => !targetCells.has(cell));
    const checkPoints = cornerCells.map(pointForCell);
    if (vacated) checkPoints.push(pointForCell(vacated));
    const checks = await copy(ops, checkPoints, "compact-verify");
    if (checks.slice(0, cornerCells.length).some((text) => fingerprint(text) !== expected.fingerprint) ||
        (vacated && checks[cornerCells.length].trim())) {
      // A refused placement may leave this known item held. Recover once only
      // when every cell in BOTH footprints is empty; never swap into an unknown
      // item, park in speculative free space, or continue with a stale model.
      if (!await ready(ops, "compact recovery check")) return abort("stop-requested");
      const recoveryCells = [...new Set([...sourceCells, ...targetCells])];
      const recovery = await copy(ops, recoveryCells.map(pointForCell), "compact-recovery-pin");
      if (recovery.every((text) => !text.trim())) {
        if (!await ready(ops, "compact return held item")) return abort("stop-requested");
        await ops.leftClick(placePoint(move.from.row, move.from.col, move.w, move.h), "return held item to verified empty origin");
        await ops.sleep(FAST_TRIAGE_TIMING.returnSettleMs);
        if (!await ready(ops, "verify compact return")) return abort("stop-requested");
        const restored = await copy(ops, [...sourceCells].map(pointForCell), "compact-recovery-verify");
        if (restored.every((text) => fingerprint(text) === expected.fingerprint)) {
          return abort("compact-placement-refused-recovered");
        }
        return abort("compact-recovery-failed");
      }
      return abort("compact-verify-failed");
    }
    result.movedIds.push(move.id);
  }
  return result;
}
