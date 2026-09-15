/**
 * Map triage: with the Scroll of Wisdom stack parked in bag cell (0,0),
 * identify unidentified gear, evaluate confirmed items, and drop eligible
 * items onto the ground of the current map. The careful pass evaluates only
 * gear identified this run; the fast runner can evaluate all identified gear.
 *
 * This module is pure planning plus injectable pass runners — no screen, no
 * input. The live glue (hover + Ctrl+C, right-click, ground click) lives in
 * scripts/map-triage.ts.
 *
 * Ground-truth model, same as the sorter: the clipboard is the only trusted
 * signal. Every mutating click is bracketed by copies — a cell is re-read
 * before it is touched and re-read after, and any state the copies cannot
 * explain aborts the run instead of guessing.
 *
 * Identification/drop invariants:
 *   - the careful drop pass receives only gear identified this run; the fast
 *     runner may include already identified gear after clipboard verification;
 *   - currency, the scroll stack, and waystones are never identify/drop targets;
 *   - unreadable text never drops; a still-unidentified item never drops;
 *   - a cell whose re-read doesn't match what was evaluated is skipped;
 *   - an empty copy right after an identify click means the item may be stuck
 *     on the cursor: the runner puts it back (click the same cell) and aborts.
 */

import { CLASS_SIZE_DEFAULTS, sizeKey } from "./itemSizeCatalog.js";
import { classDefaultSize } from "./itemSizeStore.js";
import { looksLikePoeItemText, parseItemText } from "./parseItem.js";
import type { ParsedItem } from "./types.js";
import type { TierVerdict } from "./valueTiers.js";

/* ------------------------------------------------------------ fast sprites */

/**
 * One perception-detected item region in the bag. `x/y` is the hover/copy
 * point (top-left cell centre); `cx/cy` is the region centre used for
 * pickup and placement clicks (a held item rides the cursor at its centre).
 */
export interface TriageSprite {
  id: string;
  row: number;
  col: number;
  w: number;
  h: number;
  x: number;
  y: number;
  cx: number;
  cy: number;
}

export interface SpriteRead {
  sprite: TriageSprite;
  text: string;
  /** Exact origin and dimensions established from a complete clipboard sweep. */
  footprint?: BagFootprint;
}

export interface BagFootprint {
  row: number;
  col: number;
  w: number;
  h: number;
}

function containsCell(rect: BagFootprint, cell: { row: number; col: number }): boolean {
  return cell.row >= rect.row && cell.row < rect.row + rect.h &&
    cell.col >= rect.col && cell.col < rect.col + rect.w;
}

function validFootprint(rect: BagFootprint, grid: { cols: number; rows: number }): boolean {
  return [rect.row, rect.col, rect.w, rect.h].every(Number.isInteger) &&
    rect.row >= 0 && rect.col >= 0 && rect.w > 0 && rect.h > 0 &&
    rect.row + rect.h <= grid.rows && rect.col + rect.w <= grid.cols;
}

/**
 * Collapse reads inside the same item footprint, never merely touching
 * regions. The legacy sprite path uses catalog dimensions as a read hint;
 * only resolveBagFootprints establishes authority to move items.
 */
export function mergeAdjacentDuplicates(reads: readonly SpriteRead[]): SpriteRead[] {
  const fingerprintOf = (read: SpriteRead): string | undefined => {
    const classified = classifyBagRead(read.text);
    return classified.parsed?.fingerprint;
  };
  const ordered = [...reads].sort(
    (a, b) => a.sprite.col - b.sprite.col || a.sprite.row - b.sprite.row,
  );
  const out: SpriteRead[] = [];
  for (const read of ordered) {
    const fingerprint = fingerprintOf(read);
    const duplicate = fingerprint !== undefined && out.some((kept) => {
      if (fingerprintOf(kept) !== fingerprint) return false;
      const parsed = classifyBagRead(kept.text).parsed;
      const size = parsed && classDefaultSize(parsed.itemClass);
      const footprint = kept.footprint ?? (size ? { ...kept.sprite, ...size } : undefined);
      if (!footprint || !containsCell(footprint, read.sprite)) return false;
      // Two separately confirmed origins remain distinct even if malformed
      // input claims they overlap; compaction will reject that conflict.
      return !read.footprint || (read.footprint.row === footprint.row &&
        read.footprint.col === footprint.col && read.footprint.w === footprint.w &&
        read.footprint.h === footprint.h);
    });
    if (!duplicate) out.push(read);
  }
  return out;
}

/* -------------------------------------------------------------- compaction */

export interface ConfirmedBagItem {
  /** The clipboard-confirmed cell to grab the item by. */
  pick: { x: number; y: number };
  item: CompactionItem;
  itemClass?: string;
  fingerprint?: string;
}

/**
 * Build movement inputs only from verified footprints. Silently excluding
 * an unknown item would make its occupied space look free, so any uncertain
 * geometry rejects the whole model. Origins are never clamped or guessed.
 */
export function confirmedCompactionItems(
  reads: readonly SpriteRead[],
  grid: { cols: number; rows: number },
): ConfirmedBagItem[] {
  const merged = mergeAdjacentDuplicates(reads.filter((read) => read.text.trim() !== ""));
  const occupied = new Set<string>();
  return merged.map((read) => {
    const classified = classifyBagRead(read.text);
    const footprint = read.footprint;
    if (!classified.parsed) throw new Error(`unreadable-item:${read.sprite.id}`);
    if (!footprint) throw new Error(`unverified-footprint:${read.sprite.id}`);
    if (!validFootprint(footprint, grid) || !containsCell(footprint, read.sprite)) {
      throw new Error(`invalid-footprint:${read.sprite.id}`);
    }
    for (let row = footprint.row; row < footprint.row + footprint.h; row += 1) {
      for (let col = footprint.col; col < footprint.col + footprint.w; col += 1) {
        const key = `${row},${col}`;
        if (occupied.has(key)) throw new Error(`overlapping-footprints:r${row}c${col}`);
        occupied.add(key);
      }
    }
    return {
      pick: { x: read.sprite.x, y: read.sprite.y },
      item: {
        id: read.sprite.id,
        ...footprint,
        ...(classified.kind === "scroll" ? { fixed: true } : {}),
      },
      ...(classified.parsed ? { itemClass: classified.parsed.itemClass } : {}),
      ...(classified.parsed ? { fingerprint: classified.parsed.fingerprint } : {}),
    };
  });
}

export interface CompactionItem {
  id: string;
  row: number;
  col: number;
  w: number;
  h: number;
  /** Fixed items remain occupancy obstacles and are never picked up. */
  fixed?: boolean;
}

export interface CompactionMove {
  id: string;
  from: { row: number; col: number };
  to: { row: number; col: number };
  w: number;
  h: number;
}

/**
 * Greedy left-pack: biggest items first, each moved to the leftmost (then
 * topmost) origin where it fits, tracked against a live occupancy grid so
 * the emitted moves are valid in order. Reserved cells (the scroll at
 * (0,0)) are never targets and never move.
 */
export function planLeftCompaction(
  items: readonly CompactionItem[],
  opts: { cols: number; rows: number; reserved?: ReadonlyArray<{ row: number; col: number }> },
): CompactionMove[] {
  if (![opts.cols, opts.rows].every((n) => Number.isInteger(n) && n > 0)) {
    throw new Error("invalid-bag-grid");
  }
  const occ = new Set<string>();
  const key = (row: number, col: number) => `${row},${col}`;
  const reserved = new Set<string>();
  for (const cell of opts.reserved ?? []) {
    if (!validFootprint({ ...cell, w: 1, h: 1 }, opts)) throw new Error("invalid-reserved-cell");
    reserved.add(key(cell.row, cell.col));
  }
  const footprint = (item: { row: number; col: number; w: number; h: number }): string[] => {
    const cells: string[] = [];
    for (let r = 0; r < item.h; r += 1) {
      for (let c = 0; c < item.w; c += 1) cells.push(key(item.row + r, item.col + c));
    }
    return cells;
  };
  const placed = new Map<string, CompactionItem>();
  for (const item of items) {
    if (!validFootprint(item, opts)) throw new Error(`invalid-footprint:${item.id}`);
    if (placed.has(item.id)) throw new Error(`duplicate-item-id:${item.id}`);
    const cells = footprint(item);
    for (const cell of cells) {
      if (occ.has(cell)) throw new Error(`overlapping-footprints:${cell}`);
      occ.add(cell);
    }
    placed.set(item.id, { ...item, fixed: item.fixed || cells.some((cell) => reserved.has(cell)) });
  }
  for (const cell of reserved) occ.add(cell);

  const order = [...items].sort((a, b) => {
    const bySize = b.h - a.h || b.w * b.h - a.w * a.h;
    if (bySize) return bySize;
    // Fill a one-cell hole directly from the furthest one-cell item.
    // Left-to-right processing shifts every intervening item unnecessarily.
    if (a.w === 1 && a.h === 1) return b.col - a.col || b.row - a.row;
    return a.col - b.col || a.row - b.row;
  });
  const moves: CompactionMove[] = [];
  for (const original of order) {
    const item = placed.get(original.id)!;
    if (item.fixed) continue;
    for (const cell of footprint(item)) occ.delete(cell);
    let target: { row: number; col: number } | undefined;
    search: for (let col = 0; col + item.w <= opts.cols; col += 1) {
      for (let row = 0; row + item.h <= opts.rows; row += 1) {
        if (col > item.col || (col === item.col && row >= item.row)) break search;
        const fits = footprint({ row, col, w: item.w, h: item.h }).every((cell) => !occ.has(cell));
        if (fits) {
          target = { row, col };
          break search;
        }
      }
    }
    if (target) {
      moves.push({
        id: item.id,
        from: { row: item.row, col: item.col },
        to: target,
        w: item.w,
        h: item.h,
      });
      item.row = target.row;
      item.col = target.col;
    }
    for (const cell of footprint(item)) occ.add(cell);
  }
  return moves;
}

export interface MapTriageCell {
  row: number;
  col: number;
  /** Screen hover/click point for the cell centre. */
  x: number;
  y: number;
}

export interface BagCellRead extends MapTriageCell {
  /** Raw Ctrl+C text; empty string means the cell copied nothing. */
  text: string;
}

export interface BagFootprintResult {
  /** One origin read per actual item, including the fixed scroll stack. */
  reads: SpriteRead[];
  /** Empty on any issue: an incomplete model must never expose false space. */
  items: ConfirmedBagItem[];
  issues: string[];
}

/**
 * Resolve a complete cell sweep into exact, non-overlapping item rectangles.
 * Clipboard text is not a unique object ID: adjacent identical items share
 * it. Tile each known size from the first uncovered cell, requiring every
 * cell of that footprint to copy the same item. Measured base sizes take
 * precedence over class defaults; unknown sizes fail closed.
 */
export function resolveBagFootprints(
  reads: readonly BagCellRead[],
  grid: { cols: number; rows: number },
  lookupSize?: (item: ParsedItem) => { w: number; h: number } | undefined,
): BagFootprintResult {
  const issues: string[] = [];
  const resolved: SpriteRead[] = [];
  if (![grid.cols, grid.rows].every((n) => Number.isInteger(n) && n > 0)) {
    return { reads: [], items: [], issues: ["invalid-bag-grid"] };
  }
  const cells = new Map<string, { read: BagCellRead; classified: ClassifiedRead }>();
  for (const read of reads) {
    const key = `${read.row},${read.col}`;
    if (!validFootprint({ ...read, w: 1, h: 1 }, grid)) {
      issues.push(`invalid-cell:r${read.row}c${read.col}`);
    } else if (cells.has(key)) {
      issues.push(`duplicate-cell:r${read.row}c${read.col}`);
    } else {
      cells.set(key, { read, classified: classifyBagRead(read.text) });
    }
  }
  if (cells.size !== grid.cols * grid.rows) {
    issues.push(`incomplete-bag-sweep:${cells.size}/${grid.cols * grid.rows} cells`);
  }
  if (issues.length) return { reads: [], items: [], issues };

  const covered = new Set<string>();
  for (let row = 0; row < grid.rows; row += 1) {
    for (let col = 0; col < grid.cols; col += 1) {
      const key = `${row},${col}`;
      if (covered.has(key)) continue;
      const { read, classified } = cells.get(key)!;
      if (classified.kind === "empty") continue;
      const parsed = classified.parsed;
      if (!parsed) {
        issues.push(`unreadable-item:r${row}c${col}`);
        continue;
      }
      const size = lookupSize?.(parsed) ?? classDefaultSize(parsed.itemClass);
      if (!size) {
        issues.push(`unknown-item-size:r${row}c${col}:${parsed.itemClass}`);
        continue;
      }
      const footprint = { row, col, w: size.w, h: size.h };
      if (!validFootprint(footprint, grid)) {
        issues.push(`invalid-footprint:r${row}c${col}:${size.w}x${size.h}`);
        continue;
      }
      const footprintKeys: string[] = [];
      for (let r = row; r < row + size.h; r += 1) {
        for (let c = col; c < col + size.w; c += 1) footprintKeys.push(`${r},${c}`);
      }
      const conflict = footprintKeys.find((cell) => covered.has(cell) ||
        cells.get(cell)?.classified.parsed?.fingerprint !== parsed.fingerprint);
      if (conflict) {
        issues.push(`unconfirmed-footprint:r${row}c${col}:${size.w}x${size.h}:cell-${conflict}`);
        continue;
      }
      for (const cell of footprintKeys) covered.add(cell);
      const lastCell = cells.get(`${row + size.h - 1},${col + size.w - 1}`)!.read;
      resolved.push({
        sprite: {
          id: `r${row}c${col}`,
          ...footprint,
          x: read.x,
          y: read.y,
          cx: (read.x + lastCell.x) / 2,
          cy: (read.y + lastCell.y) / 2,
        },
        text: read.text,
        footprint,
      });
    }
  }
  return {
    reads: resolved,
    items: issues.length ? [] : confirmedCompactionItems(resolved, grid),
    issues,
  };
}

export const MAP_TRIAGE = {
  /** Live-proven minimum ms for the scroll right-click to arm identification. */
  armDelayMs: 320,
  /** ms after the identify click before the verifying copy. */
  identifySettleMs: 300,
  /** ms between the pickup click and the ground click. */
  pickupDelayMs: 200,
  /** ms after the ground click before the verifying copy. */
  dropSettleMs: 400,
  /** Consecutive identify verifications allowed to fail before aborting. */
  maxIdentifyRetries: 1,
} as const;

/**
 * Classes an unidentified item may have that this feature must never spend a
 * scroll on: currency-likes, map items (waystones/tablets/ultimatums roll new
 * mods when identified — identifying those is a deliberate act, not bag
 * hygiene), gems, and collectibles.
 */
const NON_GEAR_CLASS_KEYS = new Set(
  [
    "Currency",
    "Stackable Currency",
    "Omen",
    "Trial Coins",
    "Vault Keys",
    "Inscribed Ultimatum",
    "Waystones",
    "Tablet",
    "Tablets",
    "Wombgifts",
    "Runes",
    "Augment",
    "Soul Cores",
    "Gems",
    "Skill Gems",
    "Support Gems",
    "Uncut Skill Gems",
    "Uncut Support Gems",
    "Uncut Spirit Gems",
    "Relics",
  ].map(sizeKey),
);

/** Gear = a class the size catalog knows that isn't on the never-identify list. */
export function isGearClass(itemClass: string): boolean {
  const key = sizeKey(itemClass);
  if (!key || NON_GEAR_CLASS_KEYS.has(key)) return false;
  return CLASS_SIZE_DEFAULTS.some((row) => sizeKey(row.itemClass) === key);
}

export type BagReadKind =
  | "empty"
  | "unreadable"
  | "scroll"
  | "unid-gear"
  | "identified-gear"
  | "other";

export interface ClassifiedRead {
  kind: BagReadKind;
  parsed?: ParsedItem;
  /** Current scroll count when kind is "scroll". */
  stack?: number;
}

export function classifyBagRead(text: string): ClassifiedRead {
  if (!text.trim()) return { kind: "empty" };
  if (!looksLikePoeItemText(text)) return { kind: "unreadable" };
  let parsed: ParsedItem;
  try {
    parsed = parseItemText(text);
  } catch {
    return { kind: "unreadable" };
  }
  if (/^scroll of wisdom$/i.test(parsed.baseType) || /^scroll of wisdom$/i.test(parsed.name)) {
    const stackProperty = parsed.properties.find((property) => /^stack size$/i.test(property.name));
    const stack = Math.max(0, Math.floor(stackProperty?.rolls?.[0]?.value ?? 1));
    return { kind: "scroll", parsed, stack };
  }
  if (!isGearClass(parsed.itemClass)) return { kind: "other", parsed };
  return { kind: parsed.identified ? "identified-gear" : "unid-gear", parsed };
}

export interface UnidGearCell extends MapTriageCell {
  itemClass: string;
  rarity: string;
  fingerprint: string;
}

export interface MapTriagePlan {
  /** The verified scroll stack in cell (0,0); absent means the run must not start. */
  scroll?: { cell: MapTriageCell; stack: number };
  unidGear: UnidGearCell[];
  /** min(scroll stack, unidentified items): identifies this run may attempt. */
  budget: number;
  issues: string[];
}

/**
 * Build the plan from a full-bag sweep. The scroll MUST be the item in the
 * very top-left cell (0,0) — that is the contract the user set up, and it
 * doubles as the arming check: no scroll there, no run.
 */
export function planMapTriage(
  reads: readonly BagCellRead[],
  lookupSize?: (item: ParsedItem) => { w: number; h: number } | undefined,
): MapTriagePlan {
  const issues: string[] = [];
  const topLeft = reads.find((read) => read.row === 0 && read.col === 0);
  let scroll: MapTriagePlan["scroll"];
  if (!topLeft) {
    issues.push("scroll-missing: bag cell (0,0) was not swept");
  } else {
    const classified = classifyBagRead(topLeft.text);
    if (classified.kind !== "scroll") {
      issues.push(
        `scroll-missing: bag cell (0,0) holds ${describeRead(classified)} — park the Scroll of Wisdom stack there`,
      );
    } else if ((classified.stack ?? 0) < 1) {
      issues.push("scroll-empty: the Scroll of Wisdom stack at (0,0) reads as 0 scrolls");
    } else {
      scroll = { cell: topLeft, stack: classified.stack ?? 1 };
    }
  }

  const unidGear: UnidGearCell[] = [];
  const covered = new Set<string>();
  const classifiedCells = new Map(reads.map((read) => [
    `${read.row},${read.col}`, classifyBagRead(read.text),
  ]));
  for (const read of [...reads].sort((a, b) => a.row - b.row || a.col - b.col)) {
    if (read.row === 0 && read.col === 0) continue;
    const key = `${read.row},${read.col}`;
    if (covered.has(key)) continue;
    const classified = classifiedCells.get(key)!;
    if (classified.kind !== "unid-gear" || !classified.parsed) continue;
    const size = lookupSize?.(classified.parsed) ?? classDefaultSize(classified.parsed.itemClass);
    const footprintCells: string[] = [];
    if (size) {
      for (let row = read.row; row < read.row + size.h; row += 1) {
        for (let col = read.col; col < read.col + size.w; col += 1) footprintCells.push(`${row},${col}`);
      }
    }
    // Only suppress cells when the complete rectangle confirms one item.
    // Sparse anchors alone cannot distinguish two identical pieces of gear.
    if (footprintCells.length && footprintCells.every((cell) => !covered.has(cell) &&
      classifiedCells.get(cell)?.parsed?.fingerprint === classified.parsed!.fingerprint)) {
      for (const cell of footprintCells) covered.add(cell);
    } else {
      covered.add(key);
    }
    unidGear.push({
      row: read.row,
      col: read.col,
      x: read.x,
      y: read.y,
      itemClass: classified.parsed.itemClass,
      rarity: classified.parsed.rarity,
      fingerprint: classified.parsed.fingerprint,
    });
  }
  unidGear.sort((a, b) => a.row - b.row || a.col - b.col);

  const budget = scroll ? Math.min(scroll.stack, unidGear.length) : 0;
  if (scroll && unidGear.length > scroll.stack) {
    issues.push(
      `scroll-short: ${unidGear.length} unidentified item(s) but only ${scroll.stack} scroll(s) — the last ${unidGear.length - scroll.stack} stay unidentified`,
    );
  }
  return { ...(scroll ? { scroll } : {}), unidGear, budget, issues };
}

function describeRead(classified: ClassifiedRead): string {
  if (classified.kind === "empty") return "nothing";
  if (classified.kind === "unreadable") return "unreadable text";
  const parsed = classified.parsed;
  return parsed ? `${parsed.name || parsed.baseType} (${parsed.itemClass})` : classified.kind;
}

/* ---------------------------------------------------------------- identify */

export interface MapTriageOps {
  /** Hover + Ctrl+C at the cell point; empty string means nothing copied. */
  copyCell(cell: MapTriageCell): Promise<string>;
  rightClick(point: MapTriageCell, why: string): Promise<void>;
  leftClick(point: { x: number; y: number }, why: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
  shouldStop?(): boolean;
}

export interface IdentifiedCell {
  cell: UnidGearCell;
  /** Post-identify Ctrl+C text — the text the drop pass evaluates. */
  text: string;
}

export interface IdentifyPassResult {
  identified: IdentifiedCell[];
  skipped: Array<{ cell: UnidGearCell; reason: string }>;
  scrollsUsed: number;
  /** Set when the pass stopped early; the drop pass may still run on what identified. */
  aborted?: string;
}

/**
 * Right-click the scroll, left-click the unidentified cell, and trust only
 * the re-copy. Each cell is re-read first so a cell another click already
 * identified (or a duplicate read of a multi-cell item) never wastes a
 * scroll or a click.
 */
export async function runIdentifyPass(args: {
  plan: MapTriagePlan;
  ops: MapTriageOps;
}): Promise<IdentifyPassResult> {
  const { plan, ops } = args;
  const identified: IdentifiedCell[] = [];
  const skipped: IdentifyPassResult["skipped"] = [];
  let scrollsUsed = 0;
  if (!plan.scroll) return { identified, skipped, scrollsUsed, aborted: "scroll-missing" };
  let budget = plan.budget;

  for (const cell of plan.unidGear) {
    if (ops.shouldStop?.()) return { identified, skipped, scrollsUsed, aborted: "stop-requested" };
    if (budget <= 0) {
      skipped.push({ cell, reason: "no-scrolls" });
      continue;
    }
    const before = classifyBagRead(await ops.copyCell(cell));
    if (before.kind === "empty") {
      skipped.push({ cell, reason: "vanished" });
      continue;
    }
    if (before.kind === "identified-gear") {
      // Another cell of the same multi-cell item already got the scroll.
      skipped.push({ cell, reason: "already-identified" });
      continue;
    }
    if (before.kind !== "unid-gear") {
      skipped.push({ cell, reason: `not-unid-gear:${before.kind}` });
      continue;
    }
    if (before.parsed?.fingerprint !== cell.fingerprint) {
      skipped.push({ cell, reason: "cell-changed" });
      continue;
    }

    let done = false;
    for (let attempt = 0; attempt <= MAP_TRIAGE.maxIdentifyRetries && !done; attempt += 1) {
      await ops.rightClick(plan.scroll.cell, "arm Scroll of Wisdom");
      await ops.sleep(MAP_TRIAGE.armDelayMs);
      await ops.leftClick(cell, `identify r${cell.row}c${cell.col} (${cell.itemClass})`);
      await ops.sleep(MAP_TRIAGE.identifySettleMs);

      const afterText = await ops.copyCell(cell);
      const after = classifyBagRead(afterText);
      if (after.kind === "empty") {
        // Identify mode did not arm and the left-click picked the item up.
        // Put it straight back into the same cell, verify, and stop the run.
        ops.log(`! r${cell.row}c${cell.col} copied empty after the identify click — returning it to its cell`);
        await ops.leftClick(cell, `return item to r${cell.row}c${cell.col}`);
        await ops.sleep(MAP_TRIAGE.identifySettleMs);
        const restored = classifyBagRead(await ops.copyCell(cell));
        if (restored.kind === "empty") {
          return { identified, skipped, scrollsUsed, aborted: "item-stuck-on-cursor" };
        }
        skipped.push({ cell, reason: "identify-misfire-recovered" });
        return { identified, skipped, scrollsUsed, aborted: "identify-misfire" };
      }
      if (after.kind === "unid-gear") {
        // Still unidentified — the right-click may not have landed (or the
        // stack ran dry despite the budget). One retry on the same cell,
        // then stop: repeating a click sequence that isn't working is how
        // automation goes feral.
        if (attempt < MAP_TRIAGE.maxIdentifyRetries) continue;
        skipped.push({ cell, reason: "identify-failed" });
        return { identified, skipped, scrollsUsed, aborted: "identify-not-working" };
      }
      if (after.kind !== "identified-gear") {
        skipped.push({ cell, reason: `unexpected-after-identify:${after.kind}` });
        done = true;
        break;
      }
      scrollsUsed += 1;
      budget -= 1;
      identified.push({ cell, text: afterText });
      done = true;
    }
  }
  return { identified, skipped, scrollsUsed };
}

/* -------------------------------------------------------------------- drop */

export interface DropDecision {
  drop: boolean;
  tier: TierVerdict["tier"];
  reason: string;
}

/**
 * "Good" = the item matched a keep/sell rule, cleared a price-table
 * threshold, or was promoted (appraisal or build demand). Explicit dump
 * verdicts drop. Safety verdicts (text the evaluator refused to trust)
 * always stay in the bag.
 *
 * Unknown-tier items stay while `keepUnknown` is set (the default). When
 * dropping unknowns is explicitly enabled, a verdict that carries a
 * decision drops ONLY when its audited outcome is `discard-eligible`; a
 * `review` outcome (uncovered class, unjudged lines, near-miss demand …)
 * still stays. A verdict without a decision keeps the legacy behaviour.
 */
export function decideDrop(verdict: TierVerdict, keepUnknown = false): DropDecision {
  if (verdict.source === "safety") {
    return { drop: false, tier: verdict.tier, reason: verdict.reasons[0] ?? "safety verdict — stays" };
  }
  if (verdict.tier === "keep" || verdict.tier === "sell") {
    return { drop: false, tier: verdict.tier, reason: verdict.reasons[0] ?? "matched a good rule" };
  }
  if (verdict.tier === "dump") {
    return { drop: true, tier: verdict.tier, reason: verdict.reasons[0] ?? "matched a dump rule" };
  }
  const decision = verdict.decision;
  if (keepUnknown) {
    return {
      drop: false,
      tier: verdict.tier,
      reason: decision
        ? `retained (${decision.outcome}): ${decision.headline}`
        : "matched no rule (kept by --keep-unknown)",
    };
  }
  if (decision) {
    if (decision.outcome === "discard-eligible") {
      return { drop: true, tier: verdict.tier, reason: decision.headline };
    }
    return { drop: false, tier: verdict.tier, reason: `retained (${decision.outcome}): ${decision.headline}` };
  }
  return { drop: true, tier: verdict.tier, reason: "matched no keep/sell rule" };
}

export interface DroppedCell {
  cell: UnidGearCell;
  itemName: string;
  tier: TierVerdict["tier"];
  reason: string;
}

export interface KeptCell extends DroppedCell {
  verdict: TierVerdict;
}

export interface DropPassResult {
  dropped: DroppedCell[];
  kept: KeptCell[];
  skipped: Array<{ cell: UnidGearCell; reason: string }>;
  aborted?: string;
}

/**
 * Pick up each not-good item and click it onto the ground. Copies bracket
 * both clicks: the pre-pickup copy pins the cell to the exact item that was
 * evaluated, the post-pickup copy proves the item left the cell before the
 * ground click, and the abort paths fire the moment the copies stop making
 * sense (a full cursor would silently swap items on the next click).
 */
export async function runDropPass(args: {
  identified: readonly IdentifiedCell[];
  groundPoint: { x: number; y: number };
  evaluate: (itemText: string) => TierVerdict;
  ops: MapTriageOps;
  keepUnknown?: boolean;
  maxDrops?: number;
}): Promise<DropPassResult> {
  const { identified, groundPoint, evaluate, ops } = args;
  const maxDrops = Math.max(0, Math.floor(args.maxDrops ?? Number.POSITIVE_INFINITY));
  const dropped: DroppedCell[] = [];
  const kept: KeptCell[] = [];
  const skipped: DropPassResult["skipped"] = [];

  for (const { cell, text } of identified) {
    if (ops.shouldStop?.()) return { dropped, kept, skipped, aborted: "stop-requested" };
    const classified = classifyBagRead(text);
    if (classified.kind !== "identified-gear") {
      skipped.push({ cell, reason: `not-identified-gear:${classified.kind}` });
      continue;
    }
    const verdict = evaluate(text);
    const parsed = classified.parsed;
    const itemName = parsed?.name || parsed?.baseType || "unknown item";
    const decision = decideDrop(verdict, args.keepUnknown);
    if (!decision.drop) {
      kept.push({ cell, itemName, tier: decision.tier, reason: decision.reason, verdict });
      continue;
    }
    if (dropped.length >= maxDrops) {
      skipped.push({ cell, reason: "max-drops-reached" });
      continue;
    }

    // Re-pin the cell to the item that was evaluated before touching it.
    const current = classifyBagRead(await ops.copyCell(cell));
    if (current.kind === "empty") {
      skipped.push({ cell, reason: "already-gone" });
      continue;
    }
    if (!current.parsed || current.parsed.fingerprint !== (parsed?.fingerprint ?? "")) {
      skipped.push({ cell, reason: "cell-changed" });
      continue;
    }

    await ops.leftClick(cell, `pick up ${itemName} (r${cell.row}c${cell.col})`);
    await ops.sleep(MAP_TRIAGE.pickupDelayMs);
    const lifted = classifyBagRead(await ops.copyCell(cell));
    if (lifted.kind !== "empty") {
      // The pickup click did not lift the item; the cursor state is unknown,
      // so no ground click — stop before anything can swap.
      return { dropped, kept, skipped, aborted: `pickup-failed:r${cell.row}c${cell.col}` };
    }
    await ops.leftClick(groundPoint, `drop ${itemName} on the ground`);
    await ops.sleep(MAP_TRIAGE.dropSettleMs);
    // The origin cell reads empty whether the drop landed OR the game
    // refused it and left the item on the cursor (e.g. drops are blocked in
    // town/hideout) — so probe: click the origin cell again. A full cursor
    // puts the item back there; an empty cursor no-ops on an empty cell.
    await ops.leftClick(cell, `probe: confirm ${itemName} left the cursor`);
    await ops.sleep(MAP_TRIAGE.pickupDelayMs);
    const probe = classifyBagRead(await ops.copyCell(cell));
    if (probe.kind !== "empty") {
      // Drop refused; the probe returned the item to its cell. Bag intact.
      skipped.push({ cell, reason: "drop-refused" });
      return { dropped, kept, skipped, aborted: "drop-refused (are you in a map?)" };
    }
    dropped.push({ cell, itemName, tier: decision.tier, reason: decision.reason });
    ops.log(`· dropped ${itemName} (${decision.tier}: ${decision.reason})`);
  }
  return { dropped, kept, skipped };
}
