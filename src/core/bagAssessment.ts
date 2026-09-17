import { assessBatch, assessRow, BUNDLED_KNOWLEDGE, type LeagueKnowledge } from "./batchTriage.js";
import { auditPhysicalItems } from "./dumpValuationRun.js";
import { destForItemClass, type IdentifiedItem } from "./gearSort.js";
import { knownPhysicalItemSize } from "./itemSizeCatalog.js";
import { knowledgeForReport } from "./leagueKnowledge.js";
import { looksLikePoeItemText, parseItemText } from "./parseItem.js";
import { defaultStashValuationSettings, unavailableStashQuote, validateStashValuationSettings,
  type StashValuationReport, type StashValuationRow, type StashValuationSettings } from "./stashValuation.js";

export type BagPosition = { row: number; col: number };
/** Each item cell needs an independent clipboard read pair. An adapter may reuse
 * the pair only with new image evidence proving that cell has not changed since
 * its reads; affected cells must be read again. Empty cells require positive
 * visual evidence. A timeout/sentinel/empty clipboard is unread, never empty. */
export interface BagCellObservation extends BagPosition {
  state: "item" | "empty" | "unread";
  rawText?: string;
  confirmation?: string;
  evidence: string;
}
export const exactText = (text: string) => text.replace(/\r/g, "").trim();
export const cellKey = (cell: BagPosition) => cell.row + "," + cell.col;
export const sameCells = (a: readonly BagPosition[], b: readonly BagPosition[]) =>
  a.length === b.length && a.map(cellKey).sort().join(";") === b.map(cellKey).sort().join(";");
export const validCell = (c: BagPosition) => !!c && Number.isInteger(c.row) && Number.isInteger(c.col) &&
  c.row >= 0 && c.row < 5 && c.col >= 0 && c.col < 12;

// Explicit supported equipment list, independent of exclusions and stash destinations.
const equipmentClasses = new Set(["Rings", "Amulets", "Belts", "Helmets", "Gloves", "Boots", "Body Armours",
  "Foci", "Bucklers", "Talismans", "Shields", "Quivers", "Sceptres", "Claws", "Flails", "Wands", "Daggers",
  "Staves", "Quarterstaves", "Bows", "Crossbows", "Spears", "Jewels",
  ...["One Hand", "One Handed", "Two Hand", "Two Handed"].flatMap(p => ["Maces", "Axes", "Swords"].map(c => p + " " + c))]);
export function eligibleBagEquipment(text: string): boolean {
  const parsed = parseItemText(text);
  return looksLikePoeItemText(text) && equipmentClasses.has(parsed.itemClass) &&
    ["Normal", "Magic", "Rare", "Unique"].includes(parsed.rarity) && !/^Quest Item$/im.test(text);
}
export function wisdomCount(text: string): number | undefined {
  const item = parseItemText(text);
  if (!["Currency", "Stackable Currency"].includes(item.itemClass) ||
    ![item.name, item.baseType].includes("Scroll of Wisdom")) return;
  const match = /^Stack Size:\s*([\d,]+)\s*\/\s*([\d,]+)\s*$/im.exec(text);
  if (!match) return;
  const n = Number(match[1]!.replace(/,/g, "")), max = Number(match[2]!.replace(/,/g, ""));
  return Number.isSafeInteger(n) && n > 0 && n <= max ? n : undefined;
}
export const defaultBagSettings = (): StashValuationSettings => ({ ...defaultStashValuationSettings(),
  league: "Forbidden Rites", captureSource: "inventory", assessmentModel: "batch-triage-v1", knowledgeId: BUNDLED_KNOWLEDGE.id });

export function validateBagObservations(cells: BagCellObservation[]): void {
  if (!Array.isArray(cells) || cells.length > 60 || cells.some(c => !validCell(c) || !["item", "empty", "unread"].includes(c.state) ||
    typeof c.evidence !== "string" || !c.evidence.trim() || c.rawText !== undefined && typeof c.rawText !== "string" ||
    c.confirmation !== undefined && typeof c.confirmation !== "string") || new Set(cells.map(cellKey)).size !== cells.length) {
    throw new Error("Invalid bag geometry or cell evidence.");
  }
}

/** Capture identity without running usefulness assessment. The live runner uses
 * this for frequent physical reconciliation, so verification cannot append
 * assessment histories or spend the freshness window recalculating policy. */
export function captureBagLedger(id: string, cells: BagCellObservation[], settings = defaultBagSettings(),
  at = new Date().toISOString(), knowledge: LeagueKnowledge = BUNDLED_KNOWLEDGE): StashValuationReport {
  const issues = validateStashValuationSettings(settings);
  if (issues.length) throw new Error(issues.join(" "));
  if (!id || !Number.isFinite(Date.parse(at)) || settings.captureSource !== "inventory") throw new Error("Invalid bag capture metadata.");
  validateBagObservations(cells);
  const unread: StashValuationReport["unreadCells"] = [];
  const groups = new Map<string, IdentifiedItem>();
  for (let row = 0; row < 5; row++) for (let col = 0; col < 12; col++) {
    const cell = cells.find(c => c.row === row && c.col === col);
    if (cell?.state === "empty" && !cell.rawText && !cell.confirmation) continue;
    if (!cell || cell.state !== "item" || !cell.rawText || !cell.confirmation ||
      !looksLikePoeItemText(cell.rawText) || exactText(cell.rawText) !== exactText(cell.confirmation)) {
      unread.push({ row, col, source: "Inventory", reason: "Missing, stale, ambiguous or unconfirmed cell evidence." }); continue;
    }
    const key = exactText(cell.rawText), item = parseItemText(cell.rawText);
    let group = groups.get(key);
    if (!group) { group = { text: cell.rawText, itemClass: item.itemClass, dest: destForItemClass(item.itemClass), cells: [] }; groups.set(key, group); }
    group.cells.push({ row, col, x: col, y: row });
  }
  const items = auditPhysicalItems([...groups.values()]);
  const rows: StashValuationRow[] = items.map(item => {
    const parsed = parseItemText(item.text), first = item.cells[0]!;
    const size = knownPhysicalItemSize(parsed.itemClass, parsed.baseType);
    const complete = size && parsed.itemClass !== "Relics" && item.cells.length === size.w * size.h &&
      item.cells.every(c => c.row >= first.row && c.row < first.row + size.h && c.col >= first.col && c.col < first.col + size.w);
    if (!complete) unread.push(...item.cells.map(c => ({ row: c.row, col: c.col, source: "Inventory", reason: "Physical footprint not established." })));
    return { id: id + ":Inventory:" + cellKey(first), sourceKind: "inventory", sourceTab: "Inventory", row: first.row, col: first.col,
      cells: item.cells.map(({ row, col }) => ({ row, col })), rawText: item.text, parsed, name: parsed.name,
      baseType: parsed.baseType, itemClass: parsed.itemClass, itemLevel: parsed.itemLevel, fingerprint: parsed.fingerprint,
      quantity: wisdomCount(item.text) ?? 1, scoreVersion: "capture-only", gearScore: 0, craftScore: 0, mods: [],
      quote: unavailableStashQuote(settings.league, "Not requested; local bag capture.", at), decision: "review", status: "stay",
      destination: "Inventory", reasons: ["Exact original capture retained; no market requests."] };
  });
  return { schemaVersion: 1, id, startedAt: at, settings: structuredClone(settings), league: settings.league,
    sourceTab: settings.sourceTab, scoreVersion: "capture-only", mode: "scan", status: unread.length ? "incomplete" : "complete",
    scannedItems: rows.length, rows, unreadCells: unread, errors: [],
    capture: { id, league: settings.league, patch: settings.league === knowledge.league ? knowledge.patch : "unknown",
      complete: !unread.length, completedSources: unread.length ? [] : ["Inventory"] } };
}

/** Full 12×5 coverage, grouping by exact text, then the shared physical-footprint audit.
 * Unknown/partial footprints are ledger rows plus unread cells; they cannot authorize input. */
export function captureBagObservations(id: string, cells: BagCellObservation[], settings = defaultBagSettings(),
  at = new Date().toISOString(), knowledge: LeagueKnowledge = BUNDLED_KNOWLEDGE): StashValuationReport {
  return assessBatch(captureBagLedger(id, cells, settings, at, knowledge), settings, at, knowledge);
}

export interface BagDecision { id: string; action: "keep" | "review" | "drop"; reasons: string[] }
/** Positive local disposal evidence only; never invert a stash route, price failure or score. */
export function bagDecision(row: StashValuationRow, report: StashValuationReport, at = new Date().toISOString()): BagDecision {
  const retain = (action: "keep" | "review", reason: string): BagDecision => ({ id: row.id, action, reasons: [reason, ...row.reasons] });
  if (!eligibleBagEquipment(row.rawText)) return retain("keep", "Protected unsupported/non-equipment item; no scroll or drop.");
  if (!parseItemText(row.rawText).identified) return retain("review", "Unidentified equipment requires a verified identification receipt.");
  // Always recompute from exact current text, saved profile and embedded snapshot.
  const current = assessRow(row, report.settings, at, knowledgeForReport(report)), a = current.assessment!;
  if (a.outcome === "keep" || a.outcome === "craft" || current.decision === "valuable") return retain("keep", "Shared usefulness/crafting/market protection.");
  if (a.outcome !== "low-priority" || a.uncertainty.length || a.override || current.decision === "review") return retain("review", "Shared Review, feedback or incomplete evidence retains this item.");
  if (a.matches.length || a.components.combination > 0 || a.components.craftingPotential > 0) return retain("review", "A modeled opportunity protects this item.");
  if (!report.capture?.complete || report.unreadCells.length || row.sourceKind !== "inventory" || row.sourceTab !== "Inventory" ||
    row.status === "moved" || row.status === "failed" || !row.cells?.length || !row.cells.every(validCell)) return retain("review", "No complete current bag identity; historical stash positions never authorize drops.");
  return { id: row.id, action: "drop", reasons: [...current.reasons,
    "Positive shared Low-priority outcome with known coverage. Heuristic disposal; market value is not proven zero."] };
}
