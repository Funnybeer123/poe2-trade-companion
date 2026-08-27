import type { Freshness, GridCell } from "../world-state/types.js";
import { locationKey, type ReconcileResult, type ShadowItem } from "./types.js";

/** Age after which a still-present shadow item is stale unless a fresh observation reconfirms it. */
export const DEFAULT_SHADOW_STALE_AFTER_MS = 60_000;

export interface ReconcileInput {
  shadow: ShadowItem[];
  inventoryCells: GridCell[];
  stashCells: GridCell[];
  nowMs: number;
  staleAfterMs?: number;
  inventoryFreshness: Freshness;
  stashFreshness: Freshness;
  /**
   * First observation of an empty shadow seeds confirmed items.
   * Never invents fingerprints that were not observed.
   */
  seedIfEmpty?: boolean;
}

function cellLocation(
  kind: ShadowItem["location"]["kind"],
  cell: GridCell,
): ShadowItem["location"] {
  return { kind, tabId: cell.tabId, x: cell.x, y: cell.y };
}

function observedFingerprints(
  kind: ShadowItem["location"]["kind"],
  cells: GridCell[],
  nowMs: number,
): Map<string, ShadowItem> {
  const out = new Map<string, ShadowItem>();
  for (const cell of cells) {
    if (!cell.occupied || cell.itemFingerprint === undefined || cell.itemFingerprint.length === 0) {
      continue;
    }
    const location = cellLocation(kind, cell);
    out.set(locationKey(location), {
      fingerprint: cell.itemFingerprint,
      location,
      lastConfirmedMs: nowMs,
      stale: false,
      mismatch: false,
    });
  }
  return out;
}

function cellsByLocation(
  kind: ShadowItem["location"]["kind"],
  cells: GridCell[],
): Map<string, GridCell> {
  const out = new Map<string, GridCell>();
  for (const cell of cells) {
    out.set(locationKey(cellLocation(kind, cell)), cell);
  }
  return out;
}

function freshnessFor(kind: ShadowItem["location"]["kind"], input: ReconcileInput): Freshness {
  return kind === "inventory" ? input.inventoryFreshness : input.stashFreshness;
}

function isStalePresent(item: ShadowItem, freshness: Freshness, nowMs: number, staleAfterMs: number): boolean {
  if (freshness === "stale") {
    return true;
  }
  if (freshness === "fresh") {
    return false;
  }
  return nowMs - item.lastConfirmedMs >= staleAfterMs;
}

/**
 * Compare shadow items to observed grid cells.
 * Transfer success is `confirmed` after this function — never because an input was sent.
 * Occupied cells without fingerprints do not create items.
 */
export function reconcile(input: ReconcileInput): ReconcileResult {
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_SHADOW_STALE_AFTER_MS;
  const observed = new Map<string, ShadowItem>([
    ...observedFingerprints("inventory", input.inventoryCells, input.nowMs),
    ...observedFingerprints("stash", input.stashCells, input.nowMs),
  ]);
  const occupiedCells = new Map<string, GridCell>([
    ...cellsByLocation("inventory", input.inventoryCells),
    ...cellsByLocation("stash", input.stashCells),
  ]);

  if (input.shadow.length === 0 && input.seedIfEmpty === true) {
    const seeded: ShadowItem[] = [];
    for (const item of observed.values()) {
      const freshness = freshnessFor(item.location.kind, input);
      seeded.push({
        ...item,
        stale: freshness === "stale",
        mismatch: false,
      });
    }
    return {
      confirmed: seeded.filter((item) => !item.stale),
      missing: [],
      unexpected: [],
      stale: seeded.filter((item) => item.stale),
    };
  }

  const confirmed: ShadowItem[] = [];
  const missing: ShadowItem[] = [];
  const unexpected: ShadowItem[] = [];
  const stale: ShadowItem[] = [];
  const handled = new Set<string>();

  for (const item of input.shadow) {
    const key = locationKey(item.location);
    const obs = observed.get(key);
    const cell = occupiedCells.get(key);
    const freshness = freshnessFor(item.location.kind, input);

    if (obs !== undefined && obs.fingerprint === item.fingerprint) {
      handled.add(key);
      const next: ShadowItem = {
        ...item,
        lastConfirmedMs: freshness === "stale" ? item.lastConfirmedMs : input.nowMs,
        stale: isStalePresent(item, freshness, input.nowMs, staleAfterMs),
        mismatch: false,
      };
      if (next.stale) {
        stale.push(next);
      } else {
        confirmed.push(next);
      }
      continue;
    }

    if (obs !== undefined && obs.fingerprint !== item.fingerprint) {
      handled.add(key);
      missing.push({ ...item, mismatch: true, stale: false });
      unexpected.push({ ...obs, mismatch: true, stale: false });
      continue;
    }

    if (cell?.occupied === true && (cell.itemFingerprint === undefined || cell.itemFingerprint.length === 0)) {
      const next: ShadowItem = {
        ...item,
        lastConfirmedMs: freshness === "stale" ? item.lastConfirmedMs : input.nowMs,
        stale: isStalePresent(item, freshness, input.nowMs, staleAfterMs),
        mismatch: false,
      };
      if (next.stale) {
        stale.push(next);
      } else {
        confirmed.push(next);
      }
      continue;
    }

    missing.push({
      ...item,
      mismatch: true,
      stale: false,
    });
  }

  for (const [key, obs] of observed) {
    if (handled.has(key)) {
      continue;
    }
    unexpected.push({ ...obs, mismatch: true, stale: false });
  }

  return { confirmed, missing, unexpected, stale };
}
