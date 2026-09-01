/**
 * Map triage: with the Scroll of Wisdom stack parked in bag cell (0,0),
 * identify every unidentified piece of gear in the bag, evaluate each newly
 * identified item against the value-tier regex rules, and drop the ones that
 * aren't worth carrying onto the ground of the current map.
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
 * Safety invariants:
 *   - only items THIS RUN identified are ever evaluated for dropping; nothing
 *     else in the bag (currency, the scroll stack, waystones, already
 *     identified gear) is ever picked up;
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
}

function spritesTouch(a: TriageSprite, b: TriageSprite): boolean {
  return (
    a.row <= b.row + b.h &&
    b.row <= a.row + a.h &&
    a.col <= b.col + b.w &&
    b.col <= a.col + a.w
  );
}

/**
 * Sprite segmentation sometimes splits one item into two regions. Two reads
 * with the same fingerprint whose regions touch are one item — keep the
 * top-left read so later clicks target it once. Distinct identical items
 * that do NOT touch are preserved.
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
    const duplicate =
      fingerprint !== undefined &&
      out.some(
        (kept) => fingerprintOf(kept) === fingerprint && spritesTouch(kept.sprite, read.sprite),
      );
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
 * Turn copy-confirmed sprite reads into compaction inputs. Perception alone
 * over-detects (decorative cell art scores as occupancy), so ONLY reads
 * whose rep cell copied real item text survive; split regions merge by
 * fingerprint; and when the size catalog knows the item class, the
 * catalog's w×h overrides the pixel-detected region (clamped in-grid).
 */
export function confirmedCompactionItems(
  reads: readonly SpriteRead[],
  grid: { cols: number; rows: number },
): ConfirmedBagItem[] {
  const merged = mergeAdjacentDuplicates(reads.filter((read) => read.text.trim() !== ""));
  return merged.map((read) => {
    const classified = classifyBagRead(read.text);
    const catalog = classified.parsed ? classDefaultSize(classified.parsed.itemClass) : undefined;
    const w = Math.min(catalog?.w ?? read.sprite.w, grid.cols);
    const h = Math.min(catalog?.h ?? read.sprite.h, grid.rows);
    return {
      pick: { x: read.sprite.x, y: read.sprite.y },
      item: {
        id: read.sprite.id,
        row: Math.min(read.sprite.row, grid.rows - h),
        col: Math.min(read.sprite.col, grid.cols - w),
        w,
        h,
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
  const occ = new Set<string>();
  const key = (row: number, col: number) => `${row},${col}`;
  for (const cell of opts.reserved ?? []) occ.add(key(cell.row, cell.col));
  const footprint = (item: { row: number; col: number; w: number; h: number }): string[] => {
    const cells: string[] = [];
    for (let r = 0; r < item.h; r += 1) {
      for (let c = 0; c < item.w; c += 1) cells.push(key(item.row + r, item.col + c));
    }
    return cells;
  };
  const placed = new Map<string, CompactionItem>();
  for (const item of items) {
    for (const cell of footprint(item)) occ.add(cell);
    placed.set(item.id, { ...item });
  }

  const order = [...items].sort(
    (a, b) => b.h - a.h || b.w * b.h - a.w * a.h || a.col - b.col || a.row - b.row,
  );
  const moves: CompactionMove[] = [];
  for (const original of order) {
    const item = placed.get(original.id)!;
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

export const MAP_TRIAGE = {
  /** ms between the scroll right-click and the identify left-click. */
  armDelayMs: 220,
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
    "Inscribed Ultimatum",
    "Waystones",
    "Tablet",
    "Tablets",
    "Wombgifts",
    "Runes",
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
  /** min(scroll stack, unid gear cells): identifies this run may attempt. */
  budget: number;
  issues: string[];
}

/**
 * Build the plan from a full-bag sweep. The scroll MUST be the item in the
 * very top-left cell (0,0) — that is the contract the user set up, and it
 * doubles as the arming check: no scroll there, no run.
 */
export function planMapTriage(reads: readonly BagCellRead[]): MapTriagePlan {
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
  for (const read of reads) {
    if (read.row === 0 && read.col === 0) continue;
    const classified = classifyBagRead(read.text);
    if (classified.kind !== "unid-gear" || !classified.parsed) continue;
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
      `scroll-short: ${unidGear.length} unidentified gear cell(s) but only ${scroll.stack} scroll(s) — the last ${unidGear.length - scroll.stack} stay unidentified`,
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
 * threshold, or was heuristically promoted. Everything else the run just
 * identified is map litter and drops — EXCEPT safety verdicts (text the
 * evaluator refused to trust), which always stay in the bag.
 *
 * `keepUnknown` narrows dropping to explicit dump verdicts only.
 */
export function decideDrop(verdict: TierVerdict, keepUnknown = false): DropDecision {
  if (verdict.tier === "keep" || verdict.tier === "sell") {
    return { drop: false, tier: verdict.tier, reason: verdict.reasons[0] ?? "matched a good rule" };
  }
  if (verdict.tier === "dump") {
    return { drop: true, tier: verdict.tier, reason: verdict.reasons[0] ?? "matched a dump rule" };
  }
  if (verdict.source === "safety") {
    return { drop: false, tier: verdict.tier, reason: verdict.reasons[0] ?? "safety verdict — stays" };
  }
  if (keepUnknown) {
    return { drop: false, tier: verdict.tier, reason: "matched no rule (kept by --keep-unknown)" };
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
    const verdict = evaluate(text);
    const parsed = classifyBagRead(text).parsed;
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
