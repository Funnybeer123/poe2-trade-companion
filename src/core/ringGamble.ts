import type { GridMark } from "./calibrationProfile.js";
import { observeAdvancedAffixes } from "./stashValuation.js";
import { isCoreRingRoll, ringSynergies } from "./ringSynergies.js";
import { looksLikePoeItemText, parseItemText } from "./parseItem.js";

/** Fixed Jewellery slot: first column, second row. Vendor cells are square. */
export function gambleRingPosition(grid: GridMark): { x: number; y: number } {
  if (![grid.x, grid.y, grid.w, grid.h].every(Number.isFinite) || grid.x < 0 || grid.y < 0 ||
    grid.cols !== 12 || grid.w <= 0 || grid.h < 2 * grid.w / 12)
    throw new Error("Invalid Jewellery stock calibration.");
  const cell = grid.w / 12;
  return { x: grid.x + cell / 2, y: grid.y + cell * 1.5 };
}

export function worldAngeLabels<T extends { text: string; x: number; w: number }>(lines: T[], left: number, width: number): T[] {
  return lines.filter(line => /^ange$/i.test(line.text.trim()) && line.x >= left && line.x + line.w < left + width * .8);
}

export interface GambleCell { slot: number; state: "empty" | "item" | "unread"; text: string }
/** Retry observation only, never a purchase or sale. Require a fresh agreeing pair. */
export async function readGambleCell(slot: number, emptyPixels: boolean, copy: () => Promise<string>): Promise<GambleCell> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const a = await copy(), b = await copy();
    if (a && a === b && looksLikePoeItemText(a)) return { slot, state: "item", text: a };
    if (!a && !b && emptyPixels) return { slot, state: "empty", text: "" };
  }
  return { slot, state: "unread", text: "" };
}
export interface RingVerdict { action: "keep" | "craft" | "review" | "vendor"; reasons: string[] }
export function evaluateGambledRing(text: string): RingVerdict {
  const result = (action: RingVerdict["action"], ...reasons: string[]): RingVerdict => ({ action, reasons });
  if (!looksLikePoeItemText(text)) return result("review", "Unreadable item.");
  const item = parseItemText(text);
  if (item.itemClass !== "Rings" || !item.identified) return result("review", "Not an identified ring.");
  if (item.rarity === "Unique" || item.corrupted || /mirrored|fractured|sanctified/i.test(text)) return result("keep", "Special item; retain for review.");
  const explicit = item.mods.filter(mod => !mod.implicit && !["implicit", "enchant"].includes(mod.kind ?? ""));
  const affixes = observeAdvancedAffixes(text, explicit);
  const limit = item.rarity === "Magic" ? 1 : 3;
  if (!/^(Magic|Rare)$/.test(item.rarity) || !explicit.length || !affixes?.complete ||
    affixes.prefixes > limit || affixes.suffixes > limit ||
    explicit.some(mod => !Number.isInteger(mod.observedTier) || mod.observedTier! < 1))
    return result("review", "Complete advanced prefix/suffix tiers are required; copy with Ctrl+Alt+C.");
  const strong = explicit.filter(mod => mod.observedTier! <= 2 && isCoreRingRoll(mod));
  const synergies = ringSynergies(explicit);
  const usefulGroups = new Set(explicit.filter(mod => mod.observedTier! <= 3 && isCoreRingRoll(mod)).map(mod => mod.affixGroup));
  const cleanBase = item.rarity === "Magic" || affixes.prefixes + affixes.suffixes <= 2;
  // One premium roll does not rescue a rare clogged with weak affixes.
  // Sparse bases can still be built on; developed rares need another useful roll.
  const supportedStrong = strong.length > 0 && (cleanBase || usefulGroups.size >= 2);
  const room = item.rarity === "Magic" || affixes.prefixes < 3 || affixes.suffixes < 3;
  if (supportedStrong || synergies.length) return result(room ? "craft" : "keep",
    ...strong.map(mod => `Observed T${mod.observedTier}: ${mod.text}.`), ...synergies,
    `${affixes.prefixes} prefix / ${affixes.suffixes} suffix affixes; ${room ? "crafting candidate, not guaranteed profit" : "full rare; retain for use or sale review"}.`);
  if (strong.length) return result("vendor", "Isolated T1/T2 roll on a rare with three or more affixes; no second useful T1–T3 core affix or supported synergy. An open slot alone does not make it a crafting candidate.");
  return result("vendor", "No useful core T1/T2 explicit roll or supported substantial stat synergy; utility tiers alone do not qualify.");
}

export interface RingGamblePort {
  open(): Promise<void>;
  snapshot(): Promise<GambleCell[]>;
  buy(): Promise<void>;
  buyMany?(count: number): Promise<void>;
  sell(cell: GambleCell): Promise<void>;
  sellMany?(cells: GambleCell[], expected: GambleCell[]): Promise<void>;
  evaluate(text: string): RingVerdict;
  record(event: Record<string, unknown>): void;
}
function validate(cells: GambleCell[]) {
  if (cells.length !== 60 || new Set(cells.map(c => c.slot)).size !== 60 ||
    cells.some(c => !Number.isInteger(c.slot) || c.slot < 0 || c.slot >= 60 || c.state === "unread" ||
      c.state === "item" && !looksLikePoeItemText(c.text))) throw new Error("Inventory could not be fully verified; stopping.");
}
const same = (a: GambleCell, b: GambleCell) => a.state === b.state && a.text === b.text;
/** One bounded batch. No resume: ambiguous actions must be inspected, never retried. */
export async function runRingGamble(port: RingGamblePort, maxPurchases = 60) {
  if (!Number.isInteger(maxPurchases) || maxPurchases < 1 || maxPurchases > 60) throw new Error("Purchase cap must be 1–60.");
  await port.open();
  let current = await port.snapshot(); validate(current);
  const acquired: GambleCell[] = [];
  port.record({ phase: "baseline", cells: current });
  if (port.buyMany && current.some(c => c.state === "empty")) {
    const count = Math.min(maxPurchases, current.filter(c => c.state === "empty").length);
    port.record({ phase: "buy-pending", count });
    await port.buyMany(count);
    const after = await port.snapshot(); validate(after);
    const changed = after.filter(c => !same(current.find(old => old.slot === c.slot)!, c));
    if (changed.length > count || changed.some(c => current.find(old => old.slot === c.slot)?.state !== "empty" ||
      c.state !== "item" || parseItemText(c.text).itemClass !== "Rings"))
      throw new Error("Unexpected purchase result; inspect the inventory before restarting.");
    acquired.push(...changed); current = after;
    for (const cell of changed) port.record({ phase: "purchased", cell });
    if (changed.length < count) port.record({ phase: "purchase-stopped", reason: "Burst added fewer rings than requested; never retry ambiguous purchases.", requested: count, added: changed.length });
  } else {
  for (let count = 0; count < maxPurchases && current.some(c => c.state === "empty"); count++) {
    port.record({ phase: "buy-pending", count });
    await port.buy();
    const after = await port.snapshot(); validate(after);
    const changed = after.filter(c => !same(current.find(old => old.slot === c.slot)!, c));
    if (!changed.length) { port.record({ phase: "purchase-stopped", reason: "No ring added: funds, stock, or capacity unavailable." }); break; }
    if (changed.length !== 1 || current.find(c => c.slot === changed[0]!.slot)?.state !== "empty" ||
      changed[0]!.state !== "item" || parseItemText(changed[0]!.text).itemClass !== "Rings") throw new Error("Unexpected purchase result; inspect the inventory before restarting.");
    acquired.push(changed[0]!); current = after;
    port.record({ phase: "purchased", cell: changed[0] });
  }
  }
  const sold = await sellRingBatch(port, current, acquired);
  const result = { purchased: acquired.length, sold, retained: acquired.length - sold };
  port.record({ phase: "complete", ...result }); return result;
}

/** Explicit rescan command authorizes disposal of existing rings, with no purchases. */
export async function rescanRingBag(port: RingGamblePort) {
  await port.open();
  const current = await port.snapshot(); validate(current);
  port.record({ phase: "baseline", mode: "rescan", cells: current });
  const candidates = current.filter(cell => cell.state === "item" && parseItemText(cell.text).itemClass === "Rings");
  const sold = await sellRingBatch(port, current, candidates);
  const result = { inspected: candidates.length, sold, retained: candidates.length - sold };
  port.record({ phase: "complete", ...result }); return result;
}

async function sellRingBatch(port: RingGamblePort, current: GambleCell[], candidates: GambleCell[]) {
  if (port.sellMany) {
    const rejected = candidates.filter(cell => {
      const verdict = port.evaluate(cell.text);
      port.record({ phase: "evaluated", cell, verdict });
      return verdict.action === "vendor";
    });
    if (!rejected.length) return 0;
    const batch = rejected, slots = new Set(batch.map(cell => cell.slot));
    const before = await port.snapshot(); validate(before);
    if (before.some(c => !same(current.find(old => old.slot === c.slot)!, c))) throw new Error("Inventory changed before sale; stopping.");
    port.record({ phase: "sell-pending", cells: batch });
    await port.sellMany(batch, before);
    const after = await port.snapshot(); validate(after);
    if (after.some(c => slots.has(c.slot) ? c.state !== "empty" : !same(before.find(old => old.slot === c.slot)!, c)))
      throw new Error("Sale was not verified; stopping without retry.");
    for (const cell of batch) port.record({ phase: "sold", slot: cell.slot });
    return batch.length;
  }
  let sold = 0;
  for (const cell of candidates) {
    const verdict = port.evaluate(cell.text);
    port.record({ phase: "evaluated", cell, verdict });
    if (verdict.action !== "vendor") continue;
    const before = await port.snapshot(); validate(before);
    if (before.some(c => !same(current.find(old => old.slot === c.slot)!, c))) throw new Error("Inventory changed before sale; stopping.");
    port.record({ phase: "sell-pending", cell, verdict });
    await port.sell(cell);
    const after = await port.snapshot(); validate(after);
    if (after.find(c => c.slot === cell.slot)?.state !== "empty" || after.some(c => c.slot !== cell.slot && !same(before.find(old => old.slot === c.slot)!, c)))
      throw new Error("Sale was not verified; stopping without retry.");
    current = after; sold++; port.record({ phase: "sold", slot: cell.slot });
  }
  return sold;
}
