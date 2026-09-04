/**
 * Pure planning and decision logic for the gear sorter.
 *
 * Everything here is deterministic and screen-free so the state machine can
 * be tested without a game: click-area clamps, grid-size detection, the
 * Ctrl+C identification model, and the corrections-file analysis that feeds
 * user teaching back into code.
 *
 * The old search/highlight machinery (GEAR_ROUTES, partitionBySearchDim,
 * decideSearchOutcome, withdrawBudget …) was deleted 2026-08-30: ground-truth
 * Ctrl+C identification replaced the stash-search flow entirely, and the dead
 * code still cost compile time, test time, and mental upkeep.
 */
import type { CellScore } from "./itemSprites.js";
import { BAG_COLS, BAG_ROWS, emptyBagMask, findPlacement } from "./bagPack.js";

/** The bag grid holds 12x5 = 60 cells. */
export const BAG_CELL_CAPACITY = 60;

export const GEAR_TAB_NAMES = [
  "Weapons", "Helmets", "Amulets", "Rings", "Gloves",
  "Belts", "Boots", "OffHands", "Body Armor", "Jewels",
  // Per-weapon-class standard tabs (user-added 2026-08-30).
  "1h Mace", "2h Mace", "QuarterStaff", "Bow/Crossbow", "Spears",
  "Wands", "Sceptres", "Staves", "Shields",
] as const;

export const DEFAULT_SOURCES = ["Rings", "Amulets", "Helmets", "Weapons", "Belts", "Gloves"];

/** Anchored to the user's teach recording, not a guess. */
export const SEARCH_BOX = { x: 1035, y: 1786 } as const;

export interface ClickArea {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/**
 * The stash GRID area. Nothing outside it may ever be clicked during a
 * withdraw burst. minY sits below the tab strip rows (y 180-320) but above
 * the true top row's cell centres (~328, from the user's red-box grid
 * calibration — the old 340 floor silently excluded the entire top row).
 * Ground-truth identification only clicks identified item cells, so the
 * old phantom-over-tab-header hazard no longer applies.
 */
export const STASH_AREA: ClickArea = { minX: 27, maxX: 1320, minY: 325, maxY: 1760 };

/** The bag grid area. Deposit clicks may only land here. */
export const BAG_AREA: ClickArea = { minX: 2450, maxX: 3800, minY: 1150, maxY: 1760 };

/**
 * TOP-LEVEL tabs draw the stash grid ONE STRIP ROW HIGHER than folder tabs:
 * with a top-level tab active there is no second tab row, so the panel
 * content starts ~67px up. User-diagnosed from the perception overlay and
 * lattice-measured live (2026-09-01): top-level grid 253..1518 vs folder
 * grid 320..1583. This 1.28-cell offset made reads and clicks agree one row
 * low (sorting "worked"), hid the true top row entirely, and produced the
 * footer "phantom band". Calibrations are stored per state
 * (__default_24x24_toplevel); this delta is the fallback when only the
 * folder-state calibration exists.
 */
export const TOP_LEVEL_GRID_DY = -67;

/** Click floor for top-level sweeps: the top-level grid's row 0 centres sit
 * at ~279, above the folder-state floor (325) but safely below the single
 * strip row (max ~245). */
export const STASH_AREA_TOP_LEVEL: ClickArea = { ...STASH_AREA, minY: 272 };

export interface Cell {
  x: number;
  y: number;
}

export function clampToArea<T extends Cell>(cells: readonly T[], area: ClickArea): T[] {
  return cells.filter(
    (cell) =>
      cell.x >= area.minX && cell.x <= area.maxX && cell.y >= area.minY && cell.y <= area.maxY,
  );
}

/**
 * The stash grid starts near the left edge and is wide. Perception
 * occasionally locks onto the INVENTORY grid instead — bursting those "cells"
 * ctrl-clicks the bag and DEPOSITS items mid-withdraw.
 */
export function stashRegionSane(region: { x: number; w: number } | undefined): boolean {
  return !!region && region.x <= 200 && region.w >= 900;
}

/**
 * Top-level dump-tab labels (T1..T16), tolerant of live OCR garble: "T13"
 * arrives as "O T13", "T10" as "TIO", "T11" as "Til", "T16" as "T161".
 * Remove-only or priced text never matches.
 */
export function isTTabLabel(label: string): boolean {
  return canonicalTTabLabel(label) !== undefined;
}

/**
 * Canonical form of a T-tab label through OCR garble: "O T13"→"T13",
 * "TIO"→"T10", "Til"→"T11". Two garbled reads of the same tab canonicalize
 * identically, so a live row and a synthesized candidate never both queue.
 */
export function canonicalTTabLabel(label: string): string | undefined {
  const normalized = label.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalized.includes("remove") || normalized.includes("price")) return undefined;
  const match = /^o?t([0-9ilo]{1,3})$/.exec(normalized);
  if (!match) return undefined;
  const digits = match[1]!.replace(/[il]/g, "1").replace(/o/g, "0");
  const value = Number(digits);
  return Number.isInteger(value) && value >= 1 && value <= 16 ? `T${value}` : undefined;
}

export interface GridCell extends Cell {
  row: number;
  col: number;
}

/**
 * Decide 12x12 vs 24x24 from boundary-line brightness (see
 * boundaryBrightness24): even-indexed internal lines of a 24-lattice are
 * separators in BOTH layouts; odd ones exist only on a quad. On a quad the
 * two groups read alike (all separator lines); on a standard tab the odd
 * positions cut through cell interiors and read clearly DIFFERENT from the
 * lines — measured live, the interiors are darker (odd 7 vs even 27 on a
 * standard tab), so the test is the absolute gap, not its direction.
 */
export function detectGridDivisions(
  odd: readonly number[],
  even: readonly number[],
): { divisions: 12 | 24; oddMedian: number; evenMedian: number } {
  const median = (values: readonly number[]): number => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)]!;
  };
  const oddMedian = median(odd);
  const evenMedian = median(even);
  const divisions =
    odd.length > 0 && even.length > 0 && Math.abs(oddMedian - evenMedian) > 6 ? 12 : 24;
  return { divisions, oddMedian, evenMedian };
}

/* ---------------- ground-truth item identification ---------------- */

/** Extract the Item Class line from a Ctrl+C item copy. */
export function parseItemClass(itemText: string): string | undefined {
  const match = /Item Class:\s*([^\r\n]+)/i.exec(itemText);
  return match?.[1]?.trim();
}

/**
 * Map a copied Item Class to its gear-folder destination tab, or "junk" for
 * anything that has no home there (flasks, currency, waystones...). This is
 * the authoritative classifier: the item's own text, not pixels.
 */
export function destForItemClass(itemClass: string | undefined): string | "junk" {
  if (!itemClass) return "junk";
  const c = itemClass.toLowerCase();
  if (/ring/.test(c)) return "Rings";
  if (/amulet|talisman/.test(c)) return "Amulets";
  if (/belt|charm/.test(c)) return "Belts";
  if (/helmet/.test(c)) return "Helmets";
  if (/glove/.test(c)) return "Gloves";
  if (/boot/.test(c)) return "Boots";
  if (/body/.test(c)) return "Body Armor";
  if (/jewel/.test(c)) return "Jewels";
  if (/quiver|foc(i|us)/.test(c)) return "OffHands";
  // Weapon classes with their own standard tab (user-added). Order matters:
  // "quarterstav" must match before the broad staff test, "crossbow" before
  // the bare "bow" in the catch-all.
  if (/shield|buckler/.test(c)) return "Shields";
  if (/quarterstav/.test(c)) return "QuarterStaff";
  if (/bow/.test(c)) return "Bow/Crossbow"; // "crossbow" contains "bow" — one home for both
  if (/spear/.test(c)) return "Spears";
  if (/wand/.test(c)) return "Wands";
  if (/sceptre/.test(c)) return "Sceptres";
  if (/stav|staff/.test(c)) return "Staves";
  if (/two.hand(ed)?.mace/.test(c)) return "2h Mace";
  if (/mace/.test(c)) return "1h Mace";
  if (/axe|sword|claw|dagger|flail/.test(c)) {
    return "Weapons"; // classes without a dedicated tab
  }
  return "junk";
}

/** One identified item: its true destination and the cells it covers. */
export interface IdentifiedItem {
  dest: string | "junk";
  itemClass: string | undefined;
  text: string;
  cells: GridCell[];
}

/**
 * Group per-cell copy results into items: cells with IDENTICAL copy text
 * that touch each other (8-neighbour) belong to one multi-cell item. Two
 * identical-text items that are not adjacent stay separate.
 */
export function groupIdentifiedCells(
  reads: ReadonlyArray<{ cell: GridCell; text: string }>,
): IdentifiedItem[] {
  const items: IdentifiedItem[] = [];
  for (const { cell, text } of reads) {
    const home = items.find(
      (item) =>
        item.text === text &&
        item.cells.some(
          (other) => Math.abs(other.row - cell.row) <= 1 && Math.abs(other.col - cell.col) <= 1,
        ),
    );
    if (home) {
      home.cells.push(cell);
    } else {
      const itemClass = parseItemClass(text);
      items.push({ dest: destForItemClass(itemClass), itemClass, text, cells: [cell] });
    }
  }
  return items;
}

/**
 * The GUILD stash's sorted taxonomy (surveyed live 2026-08-30): coarser
 * than the personal Gear folder, with numbered overflow pairs. Routing maps
 * the personal classifier's dest onto the guild tabs; a chain's first tab
 * that is not known full/unreachable wins, and a fully unavailable chain
 * resolves to "junk" (the item stays where it is — never churned).
 *
 * v2 scope (user-authorized 2026-08-31, "get everything moved"): every
 * readable item routes somewhere — gear to its class chain, non-gear by
 * class+name onto the guild's own tabs, and anything unmapped or whose
 * chain is full to the "Duffel Bag" catch-all. "junk" (= stays put) is
 * reserved for unreadable copies and fully unavailable chains.
 */
const GUILD_ARMOUR_CHAIN = ["Armor 1", "Armor 2"] as const;
const GUILD_WEAPON_CHAIN = ["Weapons 1", "Weapons 2"] as const;
const GUILD_TRINKETS = "Jewels/Amulets/Charms";
const GUILD_ARMOUR_DESTS = new Set(["Helmets", "Gloves", "Boots", "Body Armor", "OffHands", "Shields"]);
const GUILD_WEAPON_DESTS = new Set([
  "QuarterStaff",
  "Bow/Crossbow",
  "Spears",
  "Wands",
  "Sceptres",
  "Staves",
  "2h Mace",
  "1h Mace",
  "Weapons",
]);

const GUILD_FALLBACK = "Duffel Bag";

export function guildDestForItem(
  item: Pick<IdentifiedItem, "dest" | "itemClass" | "text">,
  unavailable?: ReadonlySet<string>,
): string | "junk" {
  const open = (label: string) => !unavailable?.has(label);
  const pick = (...chain: string[]) => chain.find(open) ?? "junk";
  if (item.dest !== "junk") {
    // Gear. The guild files uniques together regardless of class — ground
    // truth is the item's own Rarity line; class chain when Uniques is full.
    if (/^Rarity:\s*Unique/im.test(item.text) && open("Uniques")) return "Uniques";
    if (item.dest === "Rings") return pick("Rings", GUILD_FALLBACK);
    if (item.dest === "Amulets" || item.dest === "Jewels") {
      return pick(GUILD_TRINKETS, GUILD_FALLBACK);
    }
    if (item.dest === "Belts") {
      // The personal classifier merges belts and charms; the guild splits
      // them (charms live with the trinkets).
      if (/charm/i.test(item.itemClass ?? "")) return pick(GUILD_TRINKETS, GUILD_FALLBACK);
      return pick("HEAVY BELTS", GUILD_FALLBACK);
    }
    if (GUILD_ARMOUR_DESTS.has(item.dest)) return pick(...GUILD_ARMOUR_CHAIN, GUILD_FALLBACK);
    if (GUILD_WEAPON_DESTS.has(item.dest)) return pick(...GUILD_WEAPON_CHAIN, GUILD_FALLBACK);
    return pick(GUILD_FALLBACK);
  }
  // Non-gear, mapped by class (and name where one class spans guild tabs).
  // An unreadable copy stays put — never move what was never identified.
  if (!item.itemClass) return "junk";
  const cls = item.itemClass.toLowerCase();
  if (/gem/.test(cls)) return pick("Gems", GUILD_FALLBACK);
  if (/flask/.test(cls)) return pick("Flasks", GUILD_FALLBACK);
  if (/waystone|tablet|map/.test(cls)) return pick("Joes Maps", GUILD_FALLBACK);
  if (/currency|omen/.test(cls)) {
    if (/essence/i.test(item.text)) return pick("Essence", GUILD_FALLBACK);
    if (/distilled/i.test(item.text)) return pick("Delirium", GUILD_FALLBACK);
    if (/catalyst|splinter/i.test(item.text)) return pick("Materials", GUILD_FALLBACK);
    return pick("Currency", GUILD_FALLBACK);
  }
  if (/socketable|rune|soul core|relic/.test(cls)) return pick("Materials", GUILD_FALLBACK);
  return pick(GUILD_FALLBACK);
}

/**
 * Which identified items must LEAVE a tab. In a gear-folder tab everything
 * that is not the tab's own class leaves (junk included). In a top-level T
 * tab the roles invert: gear-classed items leave for the folder, junk STAYS
 * (T tabs are where junk lives). `excludeDests` skips items whose home tab
 * is known full — pulling them out would only churn them back.
 */
export function foreignItemsFor(
  items: readonly IdentifiedItem[],
  ownDest: string | undefined,
  excludeDests?: ReadonlySet<string>,
): IdentifiedItem[] {
  return items.filter((item) => {
    const leaves = ownDest === undefined ? item.dest !== "junk" : item.dest !== ownDest;
    return leaves && !excludeDests?.has(item.dest);
  });
}

/**
 * Conservative MINIMUM footprint per item class — never larger than any real
 * variant of the class. Used to VERIFY sprite-continuation claims: an item
 * whose claimed bounding box does not exactly match this footprint must have
 * every claimed (skipped-hover) cell re-read, because the claim may have
 * swallowed a neighbouring item (the ring-beside-helmet bug, 2026-08-30).
 */
export function minFootprintForClass(itemClass: string | undefined): { w: number; h: number } {
  if (!itemClass) return { w: 1, h: 1 };
  const c = itemClass.toLowerCase();
  if (/body/.test(c)) return { w: 2, h: 3 };
  if (/helmet|glove|boot|shield|buckler|foc(i|us)/.test(c)) return { w: 2, h: 2 };
  if (/quiver/.test(c)) return { w: 1, h: 3 };
  if (/axe|mace|sword|bow|claw|dagger|flail|quarterstav|sceptre|spear|stav|wand/.test(c)) {
    return { w: 1, h: 2 };
  }
  return { w: 1, h: 1 };
}

/**
 * Verified claiming, the safety half: a sprite-continuation claim is trusted
 * ONLY when the resulting item's bounding box EXACTLY matches the class's
 * minimum footprint (helmets 2x2, body 2x3 …). Any disagreement — a claim
 * that grew a ring to 1x2, a wand to 2x2, an unknown class past 1x1 — means
 * the skipped cells must be re-hovered before the grouping is believed.
 * Never skip on class-footprint assumptions alone; pixels may only propose,
 * the footprint check plus the re-read dispose.
 */
export function claimNeedsReverify(
  item: Pick<IdentifiedItem, "itemClass" | "cells">,
  claimedKeys: ReadonlySet<string>,
): boolean {
  if (!item.cells.some((cell) => claimedKeys.has(`${cell.row},${cell.col}`))) return false;
  const min = minFootprintForClass(item.itemClass);
  const w = new Set(item.cells.map((cell) => cell.col)).size;
  const h = new Set(item.cells.map((cell) => cell.row)).size;
  return w !== min.w || h !== min.h || item.cells.length !== min.w * min.h;
}

/**
 * Empty-cell keys judged against the TAB'S OWN background: the baseline is
 * the 25th-percentile cell mean (flat colored backgrounds land there), and a
 * cell is empty when it sits near that baseline and is FLAT — low variance
 * and no item-bright pixels. Item art always adds variance, so dim items on
 * dark tabs survive. This is what lets the sweep skip a colored tab's empty
 * space instead of hovering 500 blank cells.
 */
export function emptyCellKeysByBaseline(scores: readonly CellScore[]): Set<string> {
  const means = scores.map((score) => score.mean).sort((a, b) => a - b);
  const baseline = means[Math.floor(means.length * 0.25)] ?? 0;
  const empty = new Set<string>();
  for (const score of scores) {
    if (score.mean < baseline + 10 && score.variance < 90 && score.itemFrac < 0.04) {
      empty.add(`${score.row},${score.col}`);
    }
  }
  return empty;
}

/* ---------------- dropdown visibility (one click, verified) ---------------- */

/**
 * What one dropdown read shows. ≥4 rows is the proven "a real list is open"
 * threshold; below it, zero rows means closed and a stray row or two means an
 * unreadable frame (mid-animation, or world debris past the filters) that
 * must be re-read, never acted on. The context tells the folder's children
 * apart from a scrolled combined-list window showing top-level rows.
 */
export type ListVisibility = "folder" | "top-level" | "ambiguous-open" | "closed" | "unreadable";

export function classifyListRead(
  rowCount: number,
  context: "folder" | "top-level" | "ambiguous",
): ListVisibility {
  if (rowCount >= 4) {
    if (context === "folder") return "folder";
    if (context === "top-level") return "top-level";
    return "ambiguous-open";
  }
  return rowCount === 0 ? "closed" : "unreadable";
}

/**
 * The one decision that prevents toggle fights (three separate livelocks came
 * from list-state confusion): click a toggle ONLY when the observed state
 * must change, re-read when the frame proved nothing. "toggle" always means a
 * single click whose effect the caller verifies on the next read — an
 * unchanged state after the click gets ONE retry, then recovery, never an
 * alternating blind toggle. Wanting "folder" while a scrolled/top window is
 * open still returns "toggle": the close resets the scroll, and the next
 * read decides the (verified) reopen.
 */
export function decideListToggle(
  visibility: ListVisibility,
  want: "folder" | "top-level" | "closed",
): "none" | "toggle" | "reread" {
  if (visibility === "unreadable") return "reread";
  if (visibility === want) return "none";
  return "toggle";
}

/* ---------------- click surfaces ---------------- */

/**
 * Every surface automation may click, as an explicit area. A click whose
 * coordinates fall outside its declared surface is refused BEFORE sending —
 * the clampToArea idea extended beyond the two grids. A strip-scroll click
 * computed while the strip was not on screen once sprayed the top-left of
 * the bare world ("clicking top-left of my screen"), and a drifted cached
 * row Y would click into the game world past the dropdown's bottom edge.
 */
export const CLICK_SURFACES = {
  /** Top strip row: tab headers + scroll arrows (y 180-245). */
  stripTop: { minX: 30, maxX: 1335, minY: 178, maxY: 248 },
  /** Folder strip row (the open folder's tabs), y 250-320. */
  stripFolder: { minX: 30, maxX: 1335, minY: 249, maxY: 322 },
  /** The right-hand dropdown: chevron toggles + row labels (~330px wide). */
  tabList: { minX: 1270, maxX: 1680, minY: 178, maxY: 1615 },
  stash: STASH_AREA,
  bag: BAG_AREA,
} as const satisfies Record<string, ClickArea>;

/** Why a click must be refused, or undefined when it may be sent. */
export function clickRefusal(
  point: Cell,
  surface: ClickArea,
  client?: { left: number; top: number; width: number; height: number },
): string | undefined {
  if (
    client &&
    (point.x < client.left ||
      point.x > client.left + client.width ||
      point.y < client.top ||
      point.y > client.top + client.height)
  ) {
    return "outside the game's client rect";
  }
  if (
    point.x < surface.minX ||
    point.x > surface.maxX ||
    point.y < surface.minY ||
    point.y > surface.maxY
  ) {
    return `outside its surface (x ${surface.minX}-${surface.maxX}, y ${surface.minY}-${surface.maxY})`;
  }
  return undefined;
}

/* ---------------- trip packing ---------------- */

/**
 * Pack ONE withdraw trip so the bag fills with as few DESTINATION groups as
 * possible: navigation is the expensive part of a trip, so a bag of 25 items
 * bound for 12 tabs costs 12 hops while the same bag of rings costs one.
 *
 * Groups are taken largest-first. The group during which the bag first runs
 * out straddles trips (its remainder leads the next trip — one unavoidable
 * extra visit). After that, a NEW destination joins only when its ENTIRE
 * remaining group still places: that replaces a whole future visit for free
 * (big-footprint groups overflow with lots of oddly-shaped space left — six
 * 2x3 armours fill rows 0-2 and leave 24 cells that fit every ring), while
 * a partial split would buy an extra hop for nothing.
 *
 * The budget is a PLACEMENT SIMULATION of the 12x5 bag, not a cell count: a
 * cell count said fifteen 2x2 helmets (57 cells) fit a 58-cell bag, but the
 * bag places only twelve — the leftover strip is one row tall — and the
 * game refused the other three ("not enough space", live 2026-09-01). Each
 * item's rectangular bounding box is placed first-fit into the same mask
 * the game fills; what cannot place does not get withdrawn.
 */
export function packTripByDest(
  leaving: readonly IdentifiedItem[],
  occupiedBag: ReadonlyArray<{ row: number; col: number }>,
): IdentifiedItem[] {
  const groups = new Map<string, IdentifiedItem[]>();
  for (const item of leaving) {
    groups.set(item.dest, [...(groups.get(item.dest) ?? []), item]);
  }
  const cellsOf = (items: readonly IdentifiedItem[]): number =>
    items.reduce((sum, item) => sum + item.cells.length, 0);
  const ordered = [...groups.entries()].sort(
    (a, b) => cellsOf(b[1]) - cellsOf(a[1]) || a[0].localeCompare(b[0]),
  );
  const empty = emptyBagMask(
    occupiedBag.map((cell) => ({ row: cell.row, col: cell.col, x: 0, y: 0 })),
    BAG_COLS,
    BAG_ROWS,
  );
  const itemShape = (item: IdentifiedItem): Array<{ row: number; col: number }> => {
    const minR = Math.min(...item.cells.map((cell) => cell.row));
    const maxR = Math.max(...item.cells.map((cell) => cell.row));
    const minC = Math.min(...item.cells.map((cell) => cell.col));
    const maxC = Math.max(...item.cells.map((cell) => cell.col));
    const shape: Array<{ row: number; col: number }> = [];
    for (let r = 0; r <= maxR - minR; r += 1) {
      for (let c = 0; c <= maxC - minC; c += 1) shape.push({ row: r, col: c });
    }
    return shape;
  };
  const place = (
    item: IdentifiedItem,
    mask: boolean[][],
  ): boolean => {
    const shape = itemShape(item);
    const pos = findPlacement(shape, mask);
    if (!pos) return false;
    for (const cell of shape) mask[pos.row + cell.row]![pos.col + cell.col] = false;
    return true;
  };
  const batch: IdentifiedItem[] = [];
  let overflowed = false;
  for (const [, groupItems] of ordered) {
    if (!overflowed) {
      // Leading groups pack item by item; the group during which the bag
      // first runs out simply straddles trips (its remainder leads the
      // next trip — one unavoidable extra visit).
      for (const item of groupItems) {
        if (place(item, empty)) batch.push(item);
        else overflowed = true;
      }
      continue;
    }
    // After an overflow, a NEW destination joins only when its ENTIRE
    // remaining group places — that replaces a whole future visit and
    // wastes nothing; a partial split would buy an extra hop instead.
    const trial = empty.map((row) => [...row]);
    const placed: IdentifiedItem[] = [];
    for (const item of groupItems) {
      if (!place(item, trial)) break;
      placed.push(item);
    }
    if (placed.length === groupItems.length) {
      for (let r = 0; r < empty.length; r += 1) empty[r] = trial[r]!;
      batch.push(...placed);
    }
  }
  return batch;
}

/* ---------------- withdraw postcondition ---------------- */

/**
 * After a withdraw burst the bag must GROW. "shrank" means the clicks landed
 * on the wrong side and DEPOSITED (stale model / wrong panel); "flat" means
 * nothing came out (missed clicks, covered panel). Either way the caller
 * stops the trip and re-identifies — never re-bursts on a stale model.
 */
export function withdrawObservation(before: number, after: number): "grew" | "flat" | "shrank" {
  if (after > before) return "grew";
  return after === before ? "flat" : "shrank";
}

/* ---------------- empty-bag guarantee ---------------- */

/**
 * The run-end completion decision: the run may not end while depositable
 * identified items remain in the bag. "empty" still needs a second agreeing
 * pixel read (the bounce animation fakes empty frames); "only-undepositable"
 * means everything left is blacklisted and must be REPORTED, cell by cell.
 */
export type BagCompletion = "empty" | "only-undepositable" | "keep-filing";

export function bagCompletionVerdict(
  occupied: ReadonlyArray<{ row: number; col: number }>,
  undepositable: ReadonlySet<string>,
): BagCompletion {
  if (occupied.length === 0) return "empty";
  return occupied.every((cell) => undepositable.has(`${cell.row},${cell.col}`))
    ? "only-undepositable"
    : "keep-filing";
}

export interface BagLeftover {
  /** "row,col" of the item's grab cell. */
  cell: string;
  itemClass?: string;
  dest?: string;
  why: string;
}

/**
 * Name every item still in the bag at run end and WHY it could not leave —
 * leftovers are reported, never silently carried. Reads are the grouped
 * identified items; `unread` cells never yielded item text at all.
 */
export function describeBagLeftovers(
  items: ReadonlyArray<Pick<IdentifiedItem, "itemClass" | "dest" | "cells">>,
  unread: ReadonlyArray<{ row: number; col: number }>,
  context: {
    undepositable: ReadonlySet<string>;
    stuckTabs?: ReadonlyMap<string, ReadonlySet<string>>;
    unavailableDests?: ReadonlySet<string>;
  },
): BagLeftover[] {
  const leftovers: BagLeftover[] = [];
  for (const item of items) {
    const first = item.cells[0];
    if (!first) continue;
    const key = `${first.row},${first.col}`;
    const stuckCell = item.cells.find((cell) =>
      context.undepositable.has(`${cell.row},${cell.col}`),
    );
    let why: string;
    if (stuckCell) {
      const tabs = [...(context.stuckTabs?.get(`${stuckCell.row},${stuckCell.col}`) ?? [])];
      why = `would not deposit anywhere (bounced in ${tabs.join(" and ") || "two different tabs"}, shift+ctrl included)`;
    } else if (item.dest !== "junk" && context.unavailableDests?.has(item.dest)) {
      why = `home tab "${item.dest}" is full or unreachable this session`;
    } else if (item.dest === "junk") {
      why = "junk with no junk tab in this layout (place it by hand)";
    } else {
      why = "no verified deposit landed (check it by hand)";
    }
    leftovers.push({
      cell: key,
      ...(item.itemClass !== undefined ? { itemClass: item.itemClass } : {}),
      dest: item.dest,
      why,
    });
  }
  for (const cell of unread) {
    leftovers.push({
      cell: `${cell.row},${cell.col}`,
      why: "never yielded item text (Ctrl+C silent) — identify it by hand",
    });
  }
  return leftovers;
}

/* ---------------- persistent phantom cells ---------------- */

/**
 * A stash cell that scored occupied but never yielded Ctrl+C text through
 * the full probe battery (center + informed + blind cross) — glare or
 * decorative art. Persisted WITH its pixel signature so later runs skip it
 * instantly instead of re-grinding ~10 hovers per cell per run ("stuck
 * just clicking around", user 2026-09-01). The signature is the safety: a
 * real item landing on the cell changes its mean/variance, the signature
 * stops matching, and the cell gets probed again — nothing real can ever
 * be masked by the blacklist.
 */
export interface PhantomCellRecord {
  tab: string;
  row: number;
  col: number;
  mean: number;
  variance: number;
  at: string;
}

/** Same appearance as when the cell proved phantom: mean within ±12 gray
 * levels and variance within ±35% (glare is static; item art is neither). */
export function phantomSignatureMatches(
  stored: Pick<PhantomCellRecord, "mean" | "variance">,
  current: { mean: number; variance: number },
): boolean {
  if (Math.abs(current.mean - stored.mean) > 12) return false;
  const varBand = Math.max(30, stored.variance * 0.35);
  return Math.abs(current.variance - stored.variance) <= varBand;
}

/* ---------------- corrections ---------------- */

/**
 * One user-taught correction from step mode: they pressed Numpad 9 on a
 * planned click and then clicked (or dragged a box around) the right place.
 * A correction is a bug report with pixel-exact repro — after a session these
 * must be read back and the constants/logic they contradict updated.
 */
export interface CorrectionRecord {
  at: string;
  why: string;
  planned: Cell;
  corrected?: Cell;
  box?: { x: number; y: number; w: number; h: number };
}

export function parseCorrections(jsonl: string): CorrectionRecord[] {
  const records: CorrectionRecord[] = [];
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as CorrectionRecord;
      if (parsed && parsed.why && parsed.planned) records.push(parsed);
    } catch {
      // A truncated trailing line from a killed run is expected; skip it.
    }
  }
  return records;
}

export interface CorrectionSummary {
  why: string;
  count: number;
  /** Mean offset from planned to corrected, in pixels. */
  meanDx: number;
  meanDy: number;
  /** The most recent box the user drew for this step, if any. */
  lastBox?: { x: number; y: number; w: number; h: number };
  records: CorrectionRecord[];
}

/** Effective corrected point: the explicit click, or the drawn box's centre. */
export function correctedPoint(record: CorrectionRecord): Cell | undefined {
  if (record.corrected) return record.corrected;
  if (record.box) {
    return {
      x: Math.round(record.box.x + record.box.w / 2),
      y: Math.round(record.box.y + record.box.h / 2),
    };
  }
  return undefined;
}

/**
 * Group corrections by the step that produced them so a systematic offset
 * ("focus search box is 30px left of where you click") is visible at a
 * glance. Sorted most-corrected first.
 */
export function summarizeCorrections(records: readonly CorrectionRecord[]): CorrectionSummary[] {
  const groups = new Map<string, CorrectionRecord[]>();
  for (const record of records) {
    const list = groups.get(record.why) ?? [];
    list.push(record);
    groups.set(record.why, list);
  }
  const summaries: CorrectionSummary[] = [];
  for (const [why, group] of groups) {
    let dx = 0;
    let dy = 0;
    let counted = 0;
    for (const record of group) {
      const point = correctedPoint(record);
      if (!point) continue;
      dx += point.x - record.planned.x;
      dy += point.y - record.planned.y;
      counted += 1;
    }
    const lastBox = [...group].reverse().find((record) => record.box)?.box;
    summaries.push({
      why,
      count: group.length,
      meanDx: counted ? Math.round(dx / counted) : 0,
      meanDy: counted ? Math.round(dy / counted) : 0,
      ...(lastBox ? { lastBox } : {}),
      records: group,
    });
  }
  return summaries.sort((a, b) => b.count - a.count);
}
