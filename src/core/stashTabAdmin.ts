/**
 * Stash tab administration: the palette offered by the in-game Stash Tab
 * Settings dialog, the gear-slot tab layout we want to build, and the guards
 * that keep the executor away from tabs it must never rewrite.
 *
 * Pure logic only — the live dialog driving lives in `adapters/stashTabKit`.
 */
import { isPricedTabLabel } from "./tabFolders.js";

/** Geometry of the colour lattice inside the Stash Tab Settings dialog. */
export const COLOUR_GRID = {
  originX: 356,
  originY: 648,
  pitchX: 76,
  pitchY: 82,
  cols: 9,
  rows: 3,
} as const;

export interface StashTabColour {
  /** Stable id used in plans and tests. */
  name: string;
  row: number;
  col: number;
  /** Swatch colour sampled from the live dialog, for reporting/preview. */
  hex: string;
}

/**
 * The 27 selectable swatches, sampled from the live dialog. The dialog renders
 * a 10th column, but it is the current-colour preview strip and not selectable.
 */
export const STASH_TAB_COLOURS: readonly StashTabColour[] = [
  { name: "dark-tan", row: 0, col: 0, hex: "#5f4e31" },
  { name: "dark-red", row: 0, col: 1, hex: "#550000" },
  { name: "dark-magenta", row: 0, col: 2, hex: "#710052" },
  { name: "dark-purple", row: 0, col: 3, hex: "#260055" },
  { name: "navy", row: 0, col: 4, hex: "#00007e" },
  { name: "dark-green", row: 0, col: 5, hex: "#004800" },
  { name: "olive", row: 0, col: 6, hex: "#607e00" },
  { name: "amber", row: 0, col: 7, hex: "#faa800" },
  { name: "black", row: 0, col: 8, hex: "#2a2a2a" },
  { name: "brown", row: 1, col: 0, hex: "#bd5a00" },
  { name: "red", row: 1, col: 1, hex: "#bd0000" },
  { name: "magenta", row: 1, col: 2, hex: "#c90098" },
  { name: "purple", row: 1, col: 3, hex: "#5700b1" },
  { name: "blue", row: 1, col: 4, hex: "#0000fa" },
  { name: "green", row: 1, col: 5, hex: "#00bd00" },
  { name: "lime", row: 1, col: 6, hex: "#bdf100" },
  { name: "yellow", row: 1, col: 7, hex: "#fad200" },
  { name: "grey", row: 1, col: 8, hex: "#858585" },
  { name: "peach", row: 2, col: 0, hex: "#fabd7e" },
  { name: "salmon", row: 2, col: 1, hex: "#fa7e7e" },
  { name: "pink", row: 2, col: 2, hex: "#fa7edc" },
  { name: "lavender", row: 2, col: 3, hex: "#be7efa" },
  { name: "sky", row: 2, col: 4, hex: "#7eb1fa" },
  { name: "mint", row: 2, col: 5, hex: "#7efa7e" },
  { name: "pale-lime", row: 2, col: 6, hex: "#ecfa7e" },
  { name: "pale-yellow", row: 2, col: 7, hex: "#fafa97" },
  { name: "white", row: 2, col: 8, hex: "#dadada" },
];

export function colourByName(name: string): StashTabColour | undefined {
  return STASH_TAB_COLOURS.find((colour) => colour.name === name);
}

/** Screen point of a swatch, in the dialog's fixed coordinate space. */
export function colourPoint(colour: Pick<StashTabColour, "row" | "col">): { x: number; y: number } {
  if (
    colour.col < 0 ||
    colour.col >= COLOUR_GRID.cols ||
    colour.row < 0 ||
    colour.row >= COLOUR_GRID.rows
  ) {
    throw new Error(`colour swatch out of range: row ${colour.row}, col ${colour.col}`);
  }
  return {
    x: COLOUR_GRID.originX + colour.col * COLOUR_GRID.pitchX,
    y: COLOUR_GRID.originY + colour.row * COLOUR_GRID.pitchY,
  };
}

export interface GearSlotTab {
  /** Stable key for the slot. */
  key: string;
  /** Tab name to write into the Name field. */
  tabName: string;
  /** Canonical PoE2 item classes routed to this tab. */
  itemClasses: readonly string[];
  /** Palette swatch name; unique across the layout. */
  colour: string;
}

/**
 * One tab per equipment slot, in the order the user asked for them. Colours are
 * all drawn from the saturated middle palette row so adjacent tabs stay
 * distinguishable at a glance.
 */
export const GEAR_SLOT_TABS: readonly GearSlotTab[] = [
  {
    key: "weapons",
    tabName: "Weapons",
    colour: "red",
    itemClasses: [
      "One Hand Axes",
      "One Hand Maces",
      "One Hand Swords",
      "Two Hand Axes",
      "Two Hand Maces",
      "Two Hand Swords",
      "Bows",
      "Crossbows",
      "Claws",
      "Daggers",
      "Flails",
      "Quarterstaves",
      "Sceptres",
      "Spears",
      "Staves",
      "Wands",
    ],
  },
  { key: "helmets", tabName: "Helmets", colour: "yellow", itemClasses: ["Helmets"] },
  { key: "amulets", tabName: "Amulets", colour: "magenta", itemClasses: ["Amulets", "Talismans"] },
  { key: "rings", tabName: "Rings", colour: "purple", itemClasses: ["Rings"] },
  { key: "gloves", tabName: "Gloves", colour: "lime", itemClasses: ["Gloves"] },
  { key: "belts", tabName: "Belts", colour: "brown", itemClasses: ["Belts", "Charms"] },
  { key: "body-armours", tabName: "Body Armours", colour: "green", itemClasses: ["Body Armours"] },
  { key: "boots", tabName: "Boots", colour: "blue", itemClasses: ["Boots"] },
  {
    key: "off-hands",
    tabName: "Off-hands",
    colour: "amber",
    itemClasses: ["Shields", "Bucklers", "Foci", "Quivers"],
  },
];

export function isRemoveOnlyTabLabel(label: string): boolean {
  return /remove.?only/i.test(label);
}

/** Currency words that only ever appear in a `~price N <currency>` tab name. */
const PRICE_CURRENCIES =
  /\b(divine|exalted?|chaos|alchemy|alch|annul(?:ment)?|regal|vaal|augmentation|transmutation|mirror|orb|scroll|jeweller|fusing|chance|blessed)\b/i;

/**
 * Priced-tab detection that survives OCR garble.
 *
 * The tab strip clips and mis-reads labels — a live survey turned
 * "~price 5 exalted" into "rice 5 exalted" and bare "exalted", neither of
 * which matches the strict `~price N` form. Any label pairing a currency word
 * with a number is treated as priced. Over-refusing costs us a candidate tab;
 * under-refusing destroys a public listing.
 */
export function looksPricedTabLabel(label: string): boolean {
  if (isPricedTabLabel(label)) return true;
  if (/\bprice\b/i.test(label)) return true;
  return PRICE_CURRENCIES.test(label) && /\d/.test(label);
}

/** A tab the automation must never rename, recolour, or deposit into. */
export function isProtectedTabLabel(label: string): boolean {
  return looksPricedTabLabel(label) || isRemoveOnlyTabLabel(label);
}

/**
 * A label the DRAIN flow may select as a withdraw-only source (the
 * 2026-08-30 rule change: Remove-only tabs are legitimate sources inside an
 * explicit drain flow, and nothing else). Priced protection outranks the
 * drain flag — a garbled label that reads both priced and Remove-only stays
 * untouchable, because over-refusing costs a drain candidate while
 * under-refusing destroys a public listing.
 */
export function isDrainableRemoveOnlyLabel(label: string): boolean {
  return isRemoveOnlyTabLabel(label) && !looksPricedTabLabel(label);
}

export interface StashTabState {
  /** Position within its container (top-level strip or folder row). */
  index: number;
  label: string;
  /** Folder the tab sits in, when known. */
  folder?: string;
  /** Grid width in cells; 24 means a quad tab. */
  gridCols?: number;
  occupiedCells?: number;
}

export function isQuadTab(tab: Pick<StashTabState, "gridCols">): boolean {
  return tab.gridCols === 24;
}

export interface TabAssignment {
  slot: GearSlotTab;
  /** Label of the existing tab to rewrite. */
  targetLabel: string;
}

export interface StashTabPlan {
  version: 1;
  assignments: TabAssignment[];
  /** Slots with no tab available to take them. */
  unassigned: GearSlotTab[];
}

export interface PlanOptions {
  /** Only these labels may be rewritten; anything else is refused. */
  editableLabels: readonly string[];
  /** Require a 24-wide grid for every destination. */
  requireQuad?: boolean;
  slots?: readonly GearSlotTab[];
  /**
   * Opt in to rewriting priced (`~price ...`) tabs.
   *
   * Renaming one removes its public price, delisting the stock inside, so this
   * must be switched on deliberately per run by someone who owns the listings.
   * Remove-only tabs are refused regardless of this flag.
   */
  allowPricedTabs?: boolean;
}

/**
 * Pair each gear slot with a tab the caller has explicitly authorised for
 * rewriting. Tabs whose name carries a public price, and Remove-only tabs, are
 * never eligible even when listed as editable — the name IS the listing.
 */
export function buildGearTabPlan(
  tabs: readonly StashTabState[],
  options: PlanOptions,
): StashTabPlan {
  const slots = options.slots ?? GEAR_SLOT_TABS;
  const editable = new Set(options.editableLabels);
  const candidates = tabs.filter(
    (tab) =>
      editable.has(tab.label) &&
      // Remove-only is absolute; priced tabs need an explicit opt-in.
      !isRemoveOnlyTabLabel(tab.label) &&
      (options.allowPricedTabs || !looksPricedTabLabel(tab.label)) &&
      (!options.requireQuad || isQuadTab(tab)),
  );
  // Roomier tabs first — a quad tab must not be spent on a late slot while an
  // early one (Weapons) gets a 12-wide tab — then emptiest first, so among
  // equally-sized tabs we rewrite the least-used space.
  const ordered = [...candidates].sort(
    (a, b) =>
      (b.gridCols ?? 0) - (a.gridCols ?? 0) ||
      (a.occupiedCells ?? 0) - (b.occupiedCells ?? 0) ||
      a.index - b.index,
  );
  const assignments: TabAssignment[] = [];
  const unassigned: GearSlotTab[] = [];
  for (const slot of slots) {
    const tab = ordered.shift();
    if (!tab) {
      unassigned.push(slot);
      continue;
    }
    assignments.push({ slot, targetLabel: tab.label });
  }
  return { version: 1, assignments, unassigned };
}

/**
 * Structural and safety checks; a non-empty result must block execution.
 *
 * `allowPricedTabs` must be passed the same value the plan was built with,
 * otherwise a plan that deliberately targets priced tabs is rejected here.
 */
export function validateStashTabPlan(
  plan: StashTabPlan,
  options: { allowPricedTabs?: boolean } = {},
): string[] {
  const errors: string[] = [];
  const seenTargets = new Set<string>();
  const seenColours = new Set<string>();
  const seenNames = new Set<string>();
  for (const { slot, targetLabel } of plan.assignments) {
    if (!options.allowPricedTabs && looksPricedTabLabel(targetLabel)) {
      errors.push(`refusing to rename "${targetLabel}" — the name is its public price`);
    }
    if (isRemoveOnlyTabLabel(targetLabel)) {
      errors.push(`refusing to touch Remove-only tab "${targetLabel}"`);
    }
    if (seenTargets.has(targetLabel)) errors.push(`tab "${targetLabel}" assigned twice`);
    seenTargets.add(targetLabel);

    if (!slot.tabName.trim()) errors.push(`slot ${slot.key}: empty tab name`);
    if (looksPricedTabLabel(slot.tabName)) {
      errors.push(`slot ${slot.key}: new name "${slot.tabName}" would look like a public price`);
    }
    if (seenNames.has(slot.tabName)) errors.push(`duplicate new tab name: ${slot.tabName}`);
    seenNames.add(slot.tabName);

    if (!colourByName(slot.colour)) errors.push(`slot ${slot.key}: unknown colour "${slot.colour}"`);
    if (seenColours.has(slot.colour)) {
      errors.push(`duplicate colour "${slot.colour}" — colours must be unique`);
    }
    seenColours.add(slot.colour);
  }
  return errors;
}

/**
 * Names of the folders whose contents are managed separately and whose headers
 * must never be right-clicked as if they were tabs.
 *
 * Matching is exact after normalisation on purpose: the loose matcher treats
 * "Great Gear" as similar to "Gear", which would wrongly skip a real tab.
 */
export function isFolderLabel(label: string, folders: readonly string[]): boolean {
  const key = label.toLowerCase().replace(/[^a-z0-9]/g, "");
  return folders.some((folder) => folder.toLowerCase().replace(/[^a-z0-9]/g, "") === key);
}

/** Sequential name for the nth managed tab, 1-based: T1, T2, T3, … */
export function sequentialTabName(index: number, prefix = "T"): string {
  return `${prefix}${index}`;
}

/* ---------- Shared contract between the main service and the renderer ---------- */

export interface SurveyedStashTab extends StashTabState {
  /** Name carries a public price, so it must never be rewritten. */
  priced: boolean;
  removeOnly: boolean;
  /** Neither priced nor Remove-only: safe to rename and recolour. */
  editable: boolean;
}

export interface StashTabSurveyResult {
  folderName: string;
  topRow: string[];
  tabs: SurveyedStashTab[];
}

export interface StashTabApplyOutcome {
  targetLabel: string;
  newName: string;
  colour: string;
  applied: boolean;
  reason?: string;
}

export interface StashTabAdminStatus {
  running: boolean;
  phase: "idle" | "surveying" | "planning" | "applying";
  lastError?: string;
  lastSurveyAt?: string;
}

export type StashTabAdminEvent =
  | { kind: "phase"; phase: StashTabAdminStatus["phase"] }
  | { kind: "log"; line: string }
  | { kind: "tab"; tab: SurveyedStashTab }
  | { kind: "applied"; outcome: StashTabApplyOutcome }
  | { kind: "error"; message: string };

/** Which gear tab an item class belongs in, or undefined when it is not gear. */
export function slotForItemClass(
  itemClass: string,
  slots: readonly GearSlotTab[] = GEAR_SLOT_TABS,
): GearSlotTab | undefined {
  const wanted = itemClass.trim().toLowerCase();
  if (!wanted) return undefined;
  return slots.find((slot) => slot.itemClasses.some((entry) => entry.toLowerCase() === wanted));
}

/** Highlight-box query that lights up exactly this slot's classes. */
export function highlightQueryForSlot(slot: GearSlotTab): string {
  return slot.itemClasses.map((itemClass) => `"class: ${itemClass}"`).join(" ");
}
