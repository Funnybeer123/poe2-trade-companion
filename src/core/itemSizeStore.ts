import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LEGAL_SIZES, type StashItem } from "./bagPack.js";
import { CLASS_SIZE_DEFAULTS, sizeKey } from "./itemSizeCatalog.js";
import { looksLikePoeItemText, parseItemText } from "./parseItem.js";
import type { NormalizedItem } from "./types.js";

export { sizeKey } from "./itemSizeCatalog.js";

export type ItemSizeKind = "baseType" | "itemClass";
export type ItemSizeSource = "measured" | "class-default";

export interface GridSize {
  w: number;
  h: number;
}

export interface ItemSizeRecord {
  key: string;
  kind: ItemSizeKind;
  baseType?: string;
  itemClass: string;
  name?: string;
  w: number;
  h: number;
  samples: number;
  source: ItemSizeSource;
  updatedAt: string;
}

export interface ItemSizeDatabase {
  version: 1;
  updatedAt: string;
  records: ItemSizeRecord[];
}

export interface SizeLookup {
  w: number;
  h: number;
  record: ItemSizeRecord;
}

export function itemSizeDatabasePath(root = process.cwd()): string {
  return path.join(root, "fixtures", "item-sizes", "item-sizes.json");
}

export function classSizeKey(itemClass: string): string {
  return `class:${sizeKey(itemClass)}`;
}

export function sizeLabel(w: number, h: number): string {
  return `${w}x${h}`;
}

export function isLegalSize(w: number, h: number): boolean {
  return LEGAL_SIZES.some((size) => size.w === w && size.h === h);
}

export function emptySizeDatabase(): ItemSizeDatabase {
  return { version: 1, updatedAt: new Date(0).toISOString(), records: [] };
}

export function defaultClassRecords(at = new Date(0).toISOString()): ItemSizeRecord[] {
  return CLASS_SIZE_DEFAULTS.map((entry) => ({
    key: classSizeKey(entry.itemClass),
    kind: "itemClass" as const,
    itemClass: entry.itemClass,
    w: entry.w,
    h: entry.h,
    samples: 0,
    source: "class-default" as const,
    updatedAt: at,
  }));
}

export function withClassDefaults(db: ItemSizeDatabase): ItemSizeDatabase {
  const have = new Set(db.records.filter((row) => row.kind === "itemClass").map((row) => row.key));
  const missing = defaultClassRecords(db.updatedAt).filter((row) => !have.has(row.key));
  if (missing.length === 0) return db;
  return { ...db, records: [...db.records, ...missing] };
}

export function loadItemSizeDatabase(file = itemSizeDatabasePath()): ItemSizeDatabase {
  if (!existsSync(file)) return withClassDefaults(emptySizeDatabase());
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as ItemSizeDatabase;
    if (parsed.version !== 1 || !Array.isArray(parsed.records)) return withClassDefaults(emptySizeDatabase());
    return withClassDefaults({
      version: 1,
      updatedAt: parsed.updatedAt ?? new Date(0).toISOString(),
      records: parsed.records.filter((row) => isLegalSize(row.w, row.h) && row.key),
    });
  } catch {
    return withClassDefaults(emptySizeDatabase());
  }
}

export function saveItemSizeDatabase(file: string, db: ItemSizeDatabase): string {
  mkdirSync(path.dirname(file), { recursive: true });
  const next = withClassDefaults({
    ...db,
    version: 1,
    updatedAt: new Date().toISOString(),
    records: [...db.records].sort((a, b) => a.key.localeCompare(b.key)),
  });
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  return file;
}

export function lookupItemSize(
  db: ItemSizeDatabase,
  item: Pick<NormalizedItem, "baseType" | "name" | "itemClass">,
): SizeLookup | undefined {
  const byKey = new Map(db.records.map((row) => [row.key, row]));
  const base = byKey.get(sizeKey(item.baseType));
  if (base) return { w: base.w, h: base.h, record: base };
  const named = item.name !== item.baseType ? byKey.get(sizeKey(item.name)) : undefined;
  if (named) return { w: named.w, h: named.h, record: named };
  const fallback = byKey.get(classSizeKey(item.itemClass));
  if (fallback) return { w: fallback.w, h: fallback.h, record: fallback };
  return undefined;
}

export function enrichItemSize(item: NormalizedItem, db: ItemSizeDatabase): NormalizedItem {
  const found = lookupItemSize(db, item);
  if (!found) return item;
  return { ...item, gridW: found.w, gridH: found.h };
}

export function upsertMeasuredSize(
  db: ItemSizeDatabase,
  item: Pick<NormalizedItem, "baseType" | "name" | "itemClass">,
  measured: GridSize,
  at = new Date().toISOString(),
): { db: ItemSizeDatabase; created: boolean; changed: boolean; record: ItemSizeRecord } {
  if (!isLegalSize(measured.w, measured.h)) {
    throw new Error(`illegal-item-size:${sizeLabel(measured.w, measured.h)}`);
  }
  const key = sizeKey(item.baseType);
  const existing = db.records.find((row) => row.kind === "baseType" && row.key === key);
  if (existing && existing.w * existing.h > measured.w * measured.h) {
    const record = { ...existing, samples: existing.samples + 1, updatedAt: at };
    return {
      db: {
        ...db,
        updatedAt: at,
        records: db.records.map((row) => (row.kind === "baseType" && row.key === key ? record : row)),
      },
      created: false,
      changed: false,
      record,
    };
  }
  const same = existing?.w === measured.w && existing?.h === measured.h;
  const record: ItemSizeRecord = {
    key,
    kind: "baseType",
    baseType: item.baseType,
    itemClass: item.itemClass,
    name: item.name,
    w: measured.w,
    h: measured.h,
    samples: same ? (existing?.samples ?? 0) + 1 : 1,
    source: "measured",
    updatedAt: at,
  };
  const records = existing
    ? db.records.map((row) => (row.kind === "baseType" && row.key === key ? record : row))
    : [...db.records, record];
  return {
    db: { ...db, records, updatedAt: at },
    created: !existing,
    changed: !existing || !same,
    record,
  };
}

const FIXED_CLASSES = new Set([
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
  "Rings",
  "Amulets",
  "Jewels",
  "Gems",
  "Skill Gems",
  "Support Gems",
  "Uncut Skill Gems",
  "Uncut Support Gems",
  "Uncut Spirit Gems",
  "Charms",
  "Relics",
  "Flasks",
  "Life Flasks",
  "Mana Flasks",
  "Hybrid Flasks",
  "Utility Flasks",
  "Belts",
  "Helmets",
  "Gloves",
  "Boots",
  "Foci",
  "Bucklers",
  "Talismans",
  "Quivers",
  "Shields",
  "Sceptres",
  "Claws",
  "Flails",
  "Wands",
  "Daggers",
  "Staves",
  "Quarterstaves",
  "Two Hand Maces",
  "Two Handed Maces",
  "Two Hand Axes",
  "Two Handed Axes",
  "Two Hand Swords",
  "Two Handed Swords",
  "One Hand Maces",
  "One Handed Maces",
  "One Hand Axes",
  "One Handed Axes",
  "One Hand Swords",
  "One Handed Swords",
  "Bows",
  "Crossbows",
  "Spears",
]);

export function classDefaultSize(itemClass: string): GridSize | undefined {
  const row = defaultClassRecords().find((entry) => entry.key === classSizeKey(itemClass));
  return row ? { w: row.w, h: row.h } : undefined;
}

export function isFixedItemClass(itemClass: string): boolean {
  return FIXED_CLASSES.has(itemClass);
}

export function resolvedMeasuredSize(itemClass: string, measured: GridSize): GridSize {
  if (isFixedItemClass(itemClass)) return classDefaultSize(itemClass) ?? measured;
  return measured;
}

export function boundingLegalSize(cells: Array<{ row: number; col: number }>): GridSize | undefined {
  if (cells.length === 0) return undefined;
  const minR = Math.min(...cells.map((cell) => cell.row));
  const maxR = Math.max(...cells.map((cell) => cell.row));
  const minC = Math.min(...cells.map((cell) => cell.col));
  const maxC = Math.max(...cells.map((cell) => cell.col));
  const w = maxC - minC + 1;
  const h = maxR - minR + 1;
  if (!isLegalSize(w, h)) return undefined;
  const have = new Set(cells.map((cell) => `${cell.row},${cell.col}`));
  let filled = 0;
  for (let row = minR; row <= maxR; row += 1) {
    for (let col = minC; col <= maxC; col += 1) {
      if (have.has(`${row},${col}`)) filled += 1;
    }
  }
  if (filled / (w * h) < 0.7) return undefined;
  return { w, h };
}

function cellsTouch(
  a: Array<{ row: number; col: number }>,
  b: Array<{ row: number; col: number }>,
): boolean {
  const have = new Set(a.map((cell) => `${cell.row},${cell.col}`));
  return b.some((cell) =>
    [
      `${cell.row},${cell.col}`,
      `${cell.row - 1},${cell.col}`,
      `${cell.row + 1},${cell.col}`,
      `${cell.row},${cell.col - 1}`,
      `${cell.row},${cell.col + 1}`,
    ].some((key) => have.has(key)),
  );
}

export function mergeSameItemFragments<T extends { fingerprint: string; itemClass: string }>(
  fragments: Array<{ item: T; cells: Array<{ row: number; col: number }>; w: number; h: number }>,
): Array<{ item: T; cells: Array<{ row: number; col: number }>; w: number; h: number }> {
  const byPrint = new Map<string, typeof fragments>();
  for (const fragment of fragments) {
    const list = byPrint.get(fragment.item.fingerprint) ?? [];
    list.push(fragment);
    byPrint.set(fragment.item.fingerprint, list);
  }
  const merged: Array<{ item: T; cells: Array<{ row: number; col: number }>; w: number; h: number }> = [];
  for (const group of byPrint.values()) {
    const unused = [...group];
    while (unused.length) {
      const cluster = [unused.shift()!];
      let grew = true;
      while (grew) {
        grew = false;
        for (let i = unused.length - 1; i >= 0; i -= 1) {
          if (cluster.some((part) => cellsTouch(part.cells, unused[i]!.cells))) {
            cluster.push(unused.splice(i, 1)[0]!);
            grew = true;
          }
        }
      }
      const cells = cluster.flatMap((fragment) => fragment.cells);
      const boxed = boundingLegalSize(cells);
      const size = classDefaultSize(cluster[0]!.item.itemClass) ?? boxed ?? { w: cluster[0]!.w, h: cluster[0]!.h };
      merged.push({ item: cluster[0]!.item, cells, w: size.w, h: size.h });
    }
  }
  return merged;
}

export function learnFromClipboard(
  db: ItemSizeDatabase,
  rawText: string,
  measured: GridSize,
): {
  db: ItemSizeDatabase;
  item: NormalizedItem;
  created: boolean;
  changed: boolean;
  skipped?: "not-an-item";
} {
  if (!looksLikePoeItemText(rawText)) {
    return { db, item: parseItemText(rawText), created: false, changed: false, skipped: "not-an-item" };
  }
  const item = parseItemText(rawText);
  const next = upsertMeasuredSize(db, item, resolvedMeasuredSize(item.itemClass, measured));
  return { db: next.db, item: enrichItemSize(item, next.db), created: next.created, changed: next.changed };
}

export function indexByGridSize(db: ItemSizeDatabase): Record<string, ItemSizeRecord[]> {
  const buckets: Record<string, ItemSizeRecord[]> = {};
  for (const size of LEGAL_SIZES) buckets[sizeLabel(size.w, size.h)] = [];
  for (const record of db.records) {
    const label = sizeLabel(record.w, record.h);
    buckets[label] ??= [];
    buckets[label].push(record);
  }
  for (const label of Object.keys(buckets)) {
    buckets[label] = buckets[label]!.sort((a, b) => a.key.localeCompare(b.key));
  }
  return buckets;
}

export function bucketSpritesBySize(items: StashItem[]): Record<string, StashItem[]> {
  const buckets: Record<string, StashItem[]> = {};
  for (const size of LEGAL_SIZES) buckets[sizeLabel(size.w, size.h)] = [];
  for (const item of items) {
    const label = sizeLabel(item.w, item.h);
    buckets[label] ??= [];
    buckets[label].push(item);
  }
  return buckets;
}

export function knownBaseTypes(db: ItemSizeDatabase): Set<string> {
  return new Set(db.records.filter((row) => row.kind === "baseType").map((row) => row.key));
}
