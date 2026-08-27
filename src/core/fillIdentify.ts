import {
  BAG_FILL_TARGET,
  claimItemFootprint,
  fitKnownSize,
  itemFootprintKeys,
  itemsTouch,
  planFillMoves,
  plannedFillCells,
  takeUntilBagCapacity,
  unusedStashItems,
  type StashItem,
} from "./bagPack.js";
import { STASH_SCAN } from "./copyTiming.js";
import { itemMatchesWantedClass } from "./itemClassFilter.js";
import { classDefaultSize, lookupItemSize, type GridSize, type ItemSizeDatabase } from "./itemSizeStore.js";
import { parseItemText } from "./parseItem.js";
import type { OccupiedCell } from "./uiPerception.js";

export const FILL_IDENTIFY = {
  maxCopies: 8,
  maxStalled: 2,
  targetCells: 56,
} as const;

export const FILL_COPY = STASH_SCAN.quad;

export function spriteNeedsCopy(item: StashItem, others: StashItem[], occupiedKeys?: Set<string>): boolean {
  if (item.w * item.h >= 2) return true;
  if (others.some((other) => other.id !== item.id && other.w * other.h <= 2 && itemsTouch(item, other))) {
    return true;
  }
  if (!occupiedKeys) return false;
  const own = new Set(itemFootprintKeys(item));
  for (const [dr, dc] of [
    [0, 1],
    [1, 0],
    [0, -1],
    [-1, 0],
  ] as const) {
    const key = `${item.grab.row + dr},${item.grab.col + dc}`;
    if (occupiedKeys.has(key) && !own.has(key)) return true;
  }
  return false;
}

export function pickCopyTargets(
  planned: StashItem[],
  unused: StashItem[],
  occupiedKeys?: Set<string>,
  maxCopies = FILL_IDENTIFY.maxCopies,
): StashItem[] {
  const seen = new Set<string>();
  const out: StashItem[] = [];
  for (const item of planned) {
    if (out.length >= maxCopies) break;
    if (!spriteNeedsCopy(item, unused, occupiedKeys)) continue;
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

export function replaceSized(pool: StashItem[], next: StashItem): StashItem[] {
  const keys = new Set(itemFootprintKeys(next));
  return [
    ...pool.filter((item) => item.id !== next.id && !itemFootprintKeys(item).some((key) => keys.has(key))),
    next,
  ];
}

export function applyCopiedSize(
  sprite: StashItem,
  text: string,
  sizeDb: ItemSizeDatabase,
  occupiedKeys: Set<string>,
): StashItem | undefined {
  if (!/Item Class:/i.test(text)) return undefined;
  const parsed = parseItemText(text);
  const found = lookupItemSize(sizeDb, parsed);
  if (!found) return undefined;
  return { ...fitKnownSize(sprite, found.w, found.h, occupiedKeys), itemClass: parsed.itemClass };
}

export function wantedClassSizes(wantedClasses: string[]): GridSize[] {
  const seen = new Set<string>();
  const sizes: GridSize[] = [];
  for (const itemClass of wantedClasses) {
    const size = classDefaultSize(itemClass);
    if (!size) continue;
    const key = `${size.w}x${size.h}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sizes.push(size);
  }
  return sizes;
}

export function classSpriteScore(item: StashItem, sizes: GridSize[]): number {
  if (sizes.length === 0) return item.w * item.h;
  if (sizes.some((size) => item.w === size.w && item.h === size.h)) return 100 + item.w * item.h;
  if (sizes.some((size) => item.w <= size.w && item.h <= size.h)) return 50 + item.w * item.h;
  return item.w * item.h;
}

export function pickClassCopyTargets(
  unused: StashItem[],
  wantedClasses: string[],
  maxCopies: number = FILL_IDENTIFY.maxCopies,
): StashItem[] {
  const sizes = wantedClassSizes(wantedClasses);
  return [...unused]
    .sort((a, b) => classSpriteScore(b, sizes) - classSpriteScore(a, sizes) || a.id.localeCompare(b.id))
    .slice(0, maxCopies);
}

export interface SizeFillPoolArgs {
  sprites: StashItem[];
  occupiedStash: OccupiedCell[];
  occupiedBag: OccupiedCell[];
  bagRegion: { x: number; y: number; w: number; h: number };
  stashCols: number;
  exclude: Set<string>;
  sizeDb: ItemSizeDatabase;
  copyItem: (x: number, y: number) => Promise<string>;
  wantedClasses?: string[];
  maxMatches?: number;
}

export interface SizeFillResult {
  items: StashItem[];
  copies: number;
  trusted: number;
  plannedCells: number;
  identifyMs: number;
  skipped: StashItem[];
  classes: string[];
  method?: "copy" | "search";
  query?: string;
  litCells?: number;
}

export function classForSpriteSize(
  sprite: Pick<StashItem, "w" | "h">,
  wantedClasses: string[],
  exactOnly = false,
): string | undefined {
  const exact = wantedClasses.find((itemClass) => {
    const size = classDefaultSize(itemClass);
    return Boolean(size && size.w === sprite.w && size.h === sprite.h);
  });
  if (exact || exactOnly) return exact;
  return wantedClasses.find((itemClass) => {
    const size = classDefaultSize(itemClass);
    return Boolean(size && sprite.w <= size.w && sprite.h <= size.h);
  });
}

export function searchFillPool(args: {
  sprites: StashItem[];
  occupiedStash: OccupiedCell[];
  occupiedBag: OccupiedCell[];
  bagRegion: { x: number; y: number; w: number; h: number };
  stashCols: number;
  exclude: Set<string>;
  wantedClasses: string[];
  query?: string;
  litCells?: number;
}): SizeFillResult {
  const started = Date.now();
  const unused = unusedStashItems(args.sprites, args.exclude);
  const occupiedKeys = new Set(args.occupiedStash.map((cell) => `${cell.row},${cell.col}`));
  const items: StashItem[] = [];
  const skipped: StashItem[] = [];
  const classes: string[] = [];
  const taken = new Set<string>();
  for (const sprite of [...unused].sort((a, b) => b.w * b.h - a.w * a.h || a.id.localeCompare(b.id))) {
    const itemClass = classForSpriteSize(sprite, args.wantedClasses, true);
    if (!itemClass) {
      skipped.push(sprite);
      continue;
    }
    const size = classDefaultSize(itemClass);
    const sized = size ? { ...fitKnownSize(sprite, size.w, size.h, occupiedKeys), itemClass } : { ...sprite, itemClass };
    if (!claimItemFootprint(taken, sized)) {
      skipped.push(sprite);
      continue;
    }
    items.push(sized);
    classes.push(itemClass);
  }
  return {
    items,
    copies: 0,
    trusted: items.length,
    plannedCells: plannedFillCells(
      planFillMoves(args.occupiedStash, args.occupiedBag, args.bagRegion, args.stashCols, items),
    ),
    identifyMs: Date.now() - started,
    skipped,
    classes,
    method: "search",
    query: args.query,
    litCells: args.litCells,
  };
}

export async function sizeFillPool(args: SizeFillPoolArgs): Promise<SizeFillResult> {
  const started = Date.now();
  const wanted = args.wantedClasses ?? [];
  let pool = unusedStashItems(args.sprites, args.exclude);
  const occupiedKeys = new Set(args.occupiedStash.map((cell) => `${cell.row},${cell.col}`));
  const remaining = Math.max(1, 60 - args.occupiedBag.length);
  const sorted = [...pool].sort((a, b) => b.w * b.h - a.w * a.h || a.id.localeCompare(b.id));
  const burst = takeUntilBagCapacity(sorted, remaining, args.stashCols);
  let copies = 0;
  let stalled = 0;
  let lastCells = plannedFillCells(
    planFillMoves(args.occupiedStash, args.occupiedBag, args.bagRegion, args.stashCols, pool),
  );
  const targets = wanted.length
    ? pickClassCopyTargets(pool, wanted, FILL_IDENTIFY.maxCopies)
    : pickCopyTargets(burst, pool, occupiedKeys, FILL_IDENTIFY.maxCopies);
  const toCopy = targets.length > 0 ? targets : burst.slice(0, FILL_IDENTIFY.maxCopies);
  const matches: StashItem[] = [];
  const skipped: StashItem[] = [];
  const classes: string[] = [];
  for (const sprite of toCopy) {
    if (copies >= FILL_IDENTIFY.maxCopies) break;
    const text = await args.copyItem(sprite.grab.x, sprite.grab.y);
    copies += 1;
    if (!/Item Class:/i.test(text)) {
      if (wanted.length) skipped.push(sprite);
      continue;
    }
    const parsed = parseItemText(text);
    if (wanted.length && !itemMatchesWantedClass(parsed, wanted)) {
      skipped.push({ ...sprite, itemClass: parsed.itemClass });
      continue;
    }
    const sized = applyCopiedSize(sprite, text, args.sizeDb, occupiedKeys);
    if (!sized) {
      if (wanted.length) skipped.push({ ...sprite, itemClass: parsed.itemClass });
      continue;
    }
    if (wanted.length) {
      matches.push(sized);
      classes.push(parsed.itemClass);
      pool = replaceSized(pool, sized);
    } else {
      pool = replaceSized(pool, sized);
      if (sized.itemClass) classes.push(sized.itemClass);
    }
    const planPool = wanted.length ? matches : pool;
    const cells = plannedFillCells(
      planFillMoves(args.occupiedStash, args.occupiedBag, args.bagRegion, args.stashCols, planPool),
    );
    if (cells <= lastCells) stalled += 1;
    else stalled = 0;
    lastCells = cells;
    if (wanted.length) {
      const maxMatches = Math.max(1, Math.floor(args.maxMatches ?? Number.POSITIVE_INFINITY));
      if (matches.length >= maxMatches) break;
      if (cells >= remaining) break;
      continue;
    }
    if (stalled >= FILL_IDENTIFY.maxStalled) break;
  }
  const items = wanted.length ? matches : pool;
  const trusted = wanted.length
    ? matches.length
    : pool.filter((item) => !spriteNeedsCopy(item, pool, occupiedKeys)).length;
  return {
    items,
    copies,
    trusted,
    plannedCells: lastCells,
    identifyMs: Date.now() - started,
    skipped,
    classes,
    method: "copy",
  };
}

export function fillTargetCells(occupiedBag: number): number {
  return Math.max(0, Math.max(BAG_FILL_TARGET, FILL_IDENTIFY.targetCells) - occupiedBag);
}
