/**
 * Vendor staging: plan the ctrl-clicks that move dump-tier items from the
 * bag into an open vendor sell window.
 *
 * HARD POLICY: this module plans item staging only. It never plans, and no
 * caller may add, a click on the vendor's accept/confirm control. Accepting
 * the sale is the one irreversible step (past the buyback buffer) and it is
 * reserved for the human. `requiresHumanConfirm` is part of the plan type so
 * every consumer carries the invariant forward.
 */

import { clampToArea, type Cell, type ClickArea } from "./gearSort.js";
import type { TriagedCell } from "./bagTriage.js";

export const VENDOR_STAGING_POLICY =
  "Vendor staging moves items into the sell window only. The accept/confirm click is never automated; a human completes or cancels the sale." as const;

export interface VendorStagingRequest {
  /** Triaged bag cells; only dump-tier, rule/price-sourced cells stage. */
  cells: readonly TriagedCell[];
  /** The bag grid area; staging clicks may only land here. */
  bagArea: ClickArea;
  /** Perception says the vendor sell panel is open right now. */
  vendorPanelOpen: boolean;
  /** Kill-switch / mode gate from the caller's runtime. */
  inputAllowed: boolean;
  /** Cap on staged items per pass. */
  maxItems?: number;
}

export interface VendorStagingPlan {
  ok: boolean;
  /** Ctrl-click points, in row-major order. Empty when not ok. */
  clicks: Cell[];
  stagedCells: TriagedCell[];
  /** Cells excluded from staging and why. */
  excluded: Array<{ cell: TriagedCell; reason: string }>;
  blockedReasons: string[];
  requiresHumanConfirm: true;
  policy: typeof VENDOR_STAGING_POLICY;
}

export const VENDOR_STAGING_LIMITS = {
  maxItemsPerPass: 60,
} as const;

export function planVendorStaging(request: VendorStagingRequest): VendorStagingPlan {
  const blockedReasons: string[] = [];
  if (!request.inputAllowed) blockedReasons.push("Input is not allowed (kill switch or runtime mode).");
  if (!request.vendorPanelOpen) blockedReasons.push("The vendor sell panel is not open.");

  const excluded: Array<{ cell: TriagedCell; reason: string }> = [];
  const inArea = new Set(clampToArea([...request.cells], request.bagArea));
  const staged: TriagedCell[] = [];
  const maxItems = Math.min(
    request.maxItems ?? VENDOR_STAGING_LIMITS.maxItemsPerPass,
    VENDOR_STAGING_LIMITS.maxItemsPerPass,
  );

  const orderedCells = [...request.cells].sort((a, b) => a.row - b.row || a.col - b.col);
  for (const cell of orderedCells) {
    if (cell.verdict.tier !== "dump") {
      excluded.push({ cell, reason: `tier-${cell.verdict.tier}` });
      continue;
    }
    if (cell.verdict.source !== "rule" && cell.verdict.source !== "price-table") {
      // A dump verdict can only come from an explicit rule or price entry;
      // anything else (safety/default) must never reach a vendor window.
      excluded.push({ cell, reason: `verdict-source-${cell.verdict.source}` });
      continue;
    }
    if (!inArea.has(cell)) {
      excluded.push({ cell, reason: "outside-bag-area" });
      continue;
    }
    if (staged.length >= maxItems) {
      excluded.push({ cell, reason: "over-pass-limit" });
      continue;
    }
    staged.push(cell);
  }

  const ok = blockedReasons.length === 0 && staged.length > 0;
  if (blockedReasons.length === 0 && staged.length === 0) {
    blockedReasons.push("No dump-tier items are eligible to stage.");
  }
  const ordered = [...staged].sort((a, b) => a.row - b.row || a.col - b.col);
  return {
    ok,
    clicks: ok ? ordered.map((cell) => ({ x: cell.x, y: cell.y })) : [],
    stagedCells: ok ? ordered : [],
    excluded,
    blockedReasons,
    requiresHumanConfirm: true,
    policy: VENDOR_STAGING_POLICY,
  };
}
