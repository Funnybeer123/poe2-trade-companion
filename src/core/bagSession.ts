import { assessBatch } from "./batchTriage.js";
import { bagDecision, captureBagLedger, cellKey, eligibleBagEquipment, exactText, sameCells, wisdomCount,
  validateBagObservations, type BagCellObservation, type BagPosition } from "./bagAssessment.js";
import { knowledgeForReport } from "./leagueKnowledge.js";
import { parseItemText } from "./parseItem.js";
import { validateSavedStashReport } from "./savedStashPricing.js";
import type { StashValuationReport, StashValuationRow } from "./stashValuation.js";

export interface BagScene {
  at: string;
  evidence: string;
  mapInstance: string;
  context: "map" | "town" | "hideout" | "unknown";
  foreground: boolean;
  inventoryOpen: boolean;
  obstructed: boolean;
  alive: boolean;
  loading: boolean;
  calibration: string;
  ground: { x: number; y: number; valid: boolean; evidence: string };
  cursor: { state: "empty" | "wisdom" | "item" | "unknown"; rawText?: string; evidence: string };
  cells: BagCellObservation[];
  /** A newly observed label associated with this one pending ground action. */
  groundReceipt?: { actionId: string; rawText: string; evidence: string };
}
export type BagMutation = "arm" | "identify" | "pickup" | "drop";
export interface BagAction {
  id: string; kind: BagMutation; itemId: string;
  /** Actual input cell: Wisdom (0,0) for arm, equipment source otherwise. */
  cell: BagPosition; ground: { x: number; y: number };
  /** Identification inside one Shift-held Wisdom chain: the chain's single verified
   * arm precedes it, possibly through earlier chained identifications. */
  chained?: true;
}
export interface BagReceipt {
  action: BagAction;
  before: BagScene;
  after?: BagScene;
  state: "pending" | "verified";
}
export interface BagSession {
  schemaVersion: 1;
  origin: "replay" | "live";
  original: StashValuationReport;
  report: StashValuationReport;
  scene: BagScene;
  receipts: BagReceipt[];
  droppedIds: string[];
  identifiedIds: string[];
}
export interface BagSessionPorts {
  observe(request?: BagObservationRequest): Promise<BagScene>;
  mutate(action: BagAction): Promise<void>;
  /** Must honor pause/stop before observations and every native input boundary. */
  checkpoint(): Promise<void>;
  /** Must synchronously commit (including flush) or throw BEFORE input. */
  save(session: BagSession): void;
  now(): string;
}
export interface BagObservationRequest {
  phase: "before" | "after" | "reconcile";
  itemId?: string;
  cells?: BagPosition[];
  rawText?: string;
  action?: BagAction;
}
export interface BagStageLimits {
  maxDrops?: number;
  maxIdentifications?: number;
}

export function validateBagScene(scene: BagScene): void {
  if (!scene || !Number.isFinite(Date.parse(scene.at)) || typeof scene.evidence !== "string" || !scene.evidence ||
    typeof scene.mapInstance !== "string" || !["map", "town", "hideout", "unknown"].includes(scene.context) ||
    ![scene.foreground, scene.inventoryOpen, scene.obstructed, scene.alive, scene.loading].every(v => typeof v === "boolean") ||
    typeof scene.calibration !== "string" || !scene.calibration || !scene.ground ||
    ![scene.ground.x, scene.ground.y].every(Number.isFinite) || typeof scene.ground.valid !== "boolean" || !scene.ground.evidence ||
    !scene.cursor || !["empty", "wisdom", "item", "unknown"].includes(scene.cursor.state) || !scene.cursor.evidence ||
    scene.cursor.rawText !== undefined && typeof scene.cursor.rawText !== "string" || !Array.isArray(scene.cells)) throw new Error("Invalid bag scene evidence.");
  // Validate geometry and read-pair types even on an unsafe scene.
  validateBagObservations(scene.cells);
}
export function validateBagSession(value: unknown): asserts value is BagSession {
  if (!value || typeof value !== "object") throw new Error("Invalid bag session.");
  const s = value as BagSession;
  if (s.schemaVersion !== 1 || !["live", "replay"].includes(s.origin) || !Array.isArray(s.receipts) ||
    !Array.isArray(s.droppedIds) || !Array.isArray(s.identifiedIds)) throw new Error("Invalid bag session metadata.");
  for (const report of [s.original, s.report]) {
    const errors = validateSavedStashReport(report);
    if (errors.length) throw new Error(errors.join(" "));
    if (report.settings.captureSource !== "inventory" || report.rows.some(r => r.sourceKind !== "inventory" || r.sourceTab !== "Inventory") ||
      report.scannedItems !== report.rows.length || report.rows.length > 60 || report.rows.some(r => !r.cells?.length ||
        r.row !== r.cells[0]!.row || r.col !== r.cells[0]!.col)) throw new Error("Session requires physical inventory rows.");
    const occupied = report.rows.flatMap(r => r.cells!.map(cellKey));
    if (new Set(occupied).size !== occupied.length) throw new Error("Overlapping physical identities in saved bag.");
    knowledgeForReport(report);
  }
  if (s.original.id !== s.report.id || s.original.league !== s.report.league ||
    s.original.rows.length !== s.report.rows.length || s.report.rows.some(row => !s.original.rows.some(r => r.id === row.id && sameCells(r.cells!, row.cells!)))) throw new Error("Bag physical identities changed.");
  validateBagScene(s.scene);
  const ids = new Set<string>(), identified: string[] = [], dropped: string[] = [];
  for (let i = 0; i < s.receipts.length; i++) {
    const r = s.receipts[i]!;
    if (!r?.action || !r.before || !["pending", "verified"].includes(r.state) || ids.has(r.action.id) ||
      !["arm", "identify", "pickup", "drop"].includes(r.action.kind) ||
      r.action.id !== s.report.id + ":action:" + i || !s.report.rows.some(row => row.id === r.action.itemId &&
        (r.action.kind === "arm" ? r.action.cell?.row === 0 && r.action.cell?.col === 0 : row.row === r.action.cell?.row && row.col === r.action.cell?.col)) ||
      r.state === "pending" && (i !== s.receipts.length - 1 || r.after !== undefined) || r.state === "verified" && !r.after) throw new Error("Invalid bag action history.");
    validateBagScene(r.before);
    if (r.after) validateBagScene(r.after);
    if (!r.action.ground || r.action.ground.x !== r.before.ground.x || r.action.ground.y !== r.before.ground.y) throw new Error("Action ground differs from observed evidence.");
    const previous = s.receipts[i - 1];
    const needs = r.action.kind === "identify" ? "arm" : r.action.kind === "drop" ? "pickup" : undefined;
    if (r.action.chained !== undefined && (r.action.chained !== true || r.action.kind !== "identify")) throw new Error("Invalid chained mutation.");
    const chainedOk = r.action.chained && previous?.state === "verified" && (previous.action.kind === "arm" || previous.action.kind === "identify" && previous.action.chained);
    if (needs && !chainedOk && (previous?.action.kind !== needs || previous.action.itemId !== r.action.itemId || previous.state !== "verified")) throw new Error("Missing prerequisite mutation receipt.");
    if (r.after) {
      const expectedCursor = r.action.kind === "arm" ? "wisdom" : r.action.kind === "pickup" ? "item" : "empty";
      if (r.after.cursor.state !== expectedCursor) throw new Error("Verified mutation lacks its cursor receipt.");
      if (r.action.kind === "drop" && (r.after.groundReceipt?.actionId !== r.action.id || !r.after.groundReceipt.evidence ||
        !r.before.cursor.rawText || exactText(r.after.groundReceipt.rawText) !== exactText(r.before.cursor.rawText))) throw new Error("Verified drop lacks matching ground evidence.");
    }
    ids.add(r.action.id);
    if (r.state === "verified" && r.action.kind === "identify") identified.push(r.action.itemId);
    if (r.state === "verified" && r.action.kind === "drop") dropped.push(r.action.itemId);
  }
  if (new Set(identified).size !== identified.length || new Set(dropped).size !== dropped.length ||
    JSON.stringify(identified) !== JSON.stringify(s.identifiedIds) || JSON.stringify(dropped) !== JSON.stringify(s.droppedIds)) throw new Error("Counts lack unique per-item receipts.");
}

function guardScene(scene: BagScene, session: BagSession, now: string, cursor: BagScene["cursor"]["state"]): void {
  validateBagScene(scene);
  const age = Date.parse(now) - Date.parse(scene.at);
  if (!Number.isFinite(age) || age < 0 || age > 2000 || scene.context !== "map" || !scene.mapInstance ||
    scene.mapInstance !== session.scene.mapInstance || !scene.foreground || !scene.inventoryOpen || scene.obstructed ||
    !scene.alive || scene.loading || scene.calibration !== session.scene.calibration ||
    !scene.ground.valid || scene.ground.x !== session.scene.ground.x || scene.ground.y !== session.scene.ground.y || scene.cursor.state !== cursor) {
    throw new Error("Map/focus/modal/calibration/ground/cursor evidence is unsafe or stale; no further input.");
  }
}
function observedReport(scene: BagScene, session: BagSession): StashValuationReport {
  const r = captureBagLedger(session.report.id, scene.cells, session.report.settings, scene.at, knowledgeForReport(session.report));
  if (!r.capture?.complete || r.unreadCells.length) throw new Error("Full bag coverage required; empty clipboard is not empty-cell evidence.");
  return r;
}
function sameItem(a: StashValuationRow, b: StashValuationRow) {
  return exactText(a.rawText) === exactText(b.rawText) && sameCells(a.cells!, b.cells!);
}
function assertBag(scene: BagScene, session: BagSession, absent: string[] = [], changed: string[] = []): StashValuationReport {
  const current = observedReport(scene, session);
  const expected = session.report.rows.filter(row => !session.droppedIds.includes(row.id) && !absent.includes(row.id) &&
    !(atTopLeft(row) && row.quantity === 0));
  if (expected.length !== current.rows.length || expected.some(row => !current.rows.some(r =>
    sameCells(row.cells!, r.cells!) && (changed.includes(row.id) || sameItem(row, r))))) throw new Error("Current physical bag differs from captured batch; stopped.");
  return current;
}
const atTopLeft = (r: StashValuationRow) => r.row === 0 && r.col === 0 && r.cells?.length === 1;
const currentAt = (r: StashValuationReport, row: StashValuationRow) => r.rows.find(v => sameCells(v.cells!, row.cells!));

export function createBagSession(report: StashValuationReport, scene: BagScene, origin: BagSession["origin"]): BagSession {
  const session: BagSession = { schemaVersion: 1, origin, original: structuredClone(report), report: structuredClone(report),
    scene: structuredClone(scene), receipts: [], droppedIds: [], identifiedIds: [] };
  validateBagSession(session);
  return session;
}

/** A mutation is issued once. Every exception leaves the pending receipt for explicit
 * reconciliation; there are no blind retries, recovery clicks, or bulk drops. */
export async function runBagStage(saved: BagSession, stage: "identify" | "drop" | "reconcile", ports: BagSessionPorts,
  limits: number | BagStageLimits = 1): Promise<BagSession> {
  validateBagSession(saved);
  const maxDrops = typeof limits === "number" ? limits : limits.maxDrops ?? 1;
  const maxIdentifications = typeof limits === "number" ? 59 : limits.maxIdentifications ?? 59;
  if (!Number.isInteger(maxDrops) || maxDrops < 0 || maxDrops > 59) throw new Error("max-drops must be an integer from 0 to 59.");
  if (!Number.isInteger(maxIdentifications) || maxIdentifications < 0 || maxIdentifications > 59) throw new Error("max-identifications must be an integer from 0 to 59.");
  const s = structuredClone(saved);
  const pending = s.receipts.at(-1)?.state === "pending" ? s.receipts.at(-1)! : undefined;
  const armed = !pending && s.receipts.at(-1)?.action.kind === "arm" ? s.receipts.at(-1)! : undefined;
  if (pending && stage !== "reconcile") throw new Error("Pending mutation requires read-only reconciliation; never retry it.");
  if (!pending && (s.receipts.at(-1)?.action.kind === "pickup" || armed && stage !== "identify")) {
    throw new Error("Interrupted cursor transaction requires operator inspection; do not repeat arming/pickup or start another stage.");
  }
  const save = () => ports.save(structuredClone(s));
  const observe = async (request: BagObservationRequest) => { await ports.checkpoint(); return ports.observe(request); };
  const observationFor = (phase: BagObservationRequest["phase"], row: StashValuationRow, action?: BagAction): BagObservationRequest =>
    ({ phase, itemId: row.id, cells: structuredClone(row.cells!), rawText: row.rawText, action: action && structuredClone(action) });
  const issue = async (kind: BagMutation, row: StashValuationRow, before: BagScene) => {
    await ports.checkpoint();
    guardScene(before, s, ports.now(), kind === "identify" ? "wisdom" : kind === "drop" ? "item" : "empty");
    const action: BagAction = { id: s.report.id + ":action:" + s.receipts.length, kind, itemId: row.id,
      cell: kind === "arm" ? { row: 0, col: 0 } : { row: row.row!, col: row.col! }, ground: { x: before.ground.x, y: before.ground.y } };
    const receipt: BagReceipt = { action, before: structuredClone(before), state: "pending" };
    s.receipts.push(receipt); save(); // A write failure prevents the mutation.
    await ports.checkpoint();
    // Disk flush or a pause can age the observation after the first guard.
    guardScene(before, s, ports.now(), kind === "identify" ? "wisdom" : kind === "drop" ? "item" : "empty");
    await ports.mutate(structuredClone(action));
    return { receipt, after: await observe(observationFor("after", row, action)) };
  };
  const finish = (receipt: BagReceipt, after: BagScene) => {
    receipt.after = structuredClone(after); receipt.state = "verified"; s.scene = structuredClone(after); save();
  };
  const verifyArming = (receipt: BagReceipt, after: BagScene) => {
    guardScene(after, s, ports.now(), "wisdom"); assertBag(after, s);
    const row = s.report.rows.find(r => r.id === receipt.action.itemId)!;
    if (!eligibleBagEquipment(row.rawText) || parseItemText(row.rawText).identified || s.identifiedIds.includes(row.id)) {
      throw new Error("Armed Wisdom transaction no longer targets an unidentified equipment item.");
    }
    const scroll = s.report.rows.find(atTopLeft);
    if (!scroll || !wisdomCount(scroll.rawText) || scroll.quantity === 0) throw new Error("Verified Wisdom stack required in bag (0,0).");
    finish(receipt, after);
  };
  const verifyIdentification = (receipt: BagReceipt, after: BagScene) => {
    guardScene(after, s, ports.now(), "empty");
    const row = s.report.rows.find(r => r.id === receipt.action.itemId)!;
    const old = parseItemText(row.rawText);
    const scroll = s.report.rows.find(atTopLeft);
    const count = scroll && wisdomCount(scroll.rawText);
    if (!scroll || !count) throw new Error("Wisdom stack identity/count unavailable.");
    const observed = assertBag(after, s, count === 1 ? [scroll.id] : [], [row.id, scroll.id]);
    const identified = currentAt(observed, row), remaining = currentAt(observed, scroll);
    const parsed = identified && parseItemText(identified.rawText);
    if (!identified || !parsed?.identified || old.identified || parsed.itemClass !== old.itemClass || parsed.rarity !== old.rarity ||
      parsed.itemLevel !== old.itemLevel || parsed.baseType !== old.baseType ||
      (count === 1 ? !!remaining : !remaining || wisdomCount(remaining.rawText) !== count - 1)) throw new Error("Identification identity/scroll-decrement receipt failed.");
    row.rawText = identified.rawText; row.fingerprint = parsed.fingerprint;
    if (remaining) Object.assign(scroll, { rawText: remaining.rawText, quantity: count - 1 });
    // The consumed stack remains in the ledger with a zero quantity and original text.
    else scroll.quantity = 0;
    s.identifiedIds.push(row.id);
    s.report = assessBatch(s.report, s.report.settings, ports.now(), knowledgeForReport(s.report));
    finish(receipt, after);
  };
  const verifyDrop = (receipt: BagReceipt, after: BagScene) => {
    const row = s.report.rows.find(r => r.id === receipt.action.itemId)!;
    guardScene(after, s, ports.now(), "empty");
    assertBag(after, s, [row.id]);
    if (after.groundReceipt?.actionId !== receipt.action.id || !after.groundReceipt.evidence ||
      exactText(after.groundReceipt.rawText) !== exactText(row.rawText)) throw new Error("Ground receipt unavailable; departure alone cannot prove a drop.");
    s.droppedIds.push(row.id); finish(receipt, after);
  };
  if (stage === "reconcile") {
    if (!pending) return s;
    const row = s.report.rows.find(r => r.id === pending.action.itemId)!;
    const after = await observe(observationFor("reconcile", row, pending.action));
    if (pending.action.kind === "arm") verifyArming(pending, after);
    else if (pending.action.kind === "identify") verifyIdentification(pending, after);
    else if (pending.action.kind === "drop") verifyDrop(pending, after);
    else throw new Error("Interrupted arming/pickup needs operator inspection; no automatic recovery click.");
    return s;
  }
  // A zero-count consumed stack is absent physically, but preserved historically.
  // Each future bag comparison handles it as a completed departure.
  const activeRows = () => s.report.rows.filter(r => !s.droppedIds.includes(r.id) && !(atTopLeft(r) && r.quantity === 0));
  // After identification with exactly one scroll, the identification stage ends.
  let drops = 0, identifications = 0;
  // Read-only reconciliation can prove an interrupted arm completed. Continuing
  // may then use that same cursor transaction once, without spending another arm.
  if (armed && maxIdentifications > 0) {
    const row = s.report.rows.find(r => r.id === armed.action.itemId)!;
    const before = await observe(observationFor("before", row, armed.action));
    guardScene(before, s, ports.now(), "wisdom"); assertBag(before, s);
    if (!eligibleBagEquipment(row.rawText) || parseItemText(row.rawText).identified || s.identifiedIds.includes(row.id)) {
      throw new Error("Armed Wisdom transaction no longer targets an unidentified equipment item.");
    }
    const scroll = s.report.rows.find(atTopLeft);
    if (!scroll || !wisdomCount(scroll.rawText) || scroll.quantity === 0) throw new Error("Verified Wisdom stack required in bag (0,0).");
    const result = await issue("identify", row, before);
    verifyIdentification(result.receipt, result.after); identifications++;
    if (s.report.rows.find(atTopLeft)?.quantity === 0) return s;
  }
  for (const row of activeRows()) {
    if (!eligibleBagEquipment(row.rawText)) continue;
    const identified = parseItemText(row.rawText).identified;
    if (stage === "identify" && (identifications >= maxIdentifications || identified || s.identifiedIds.includes(row.id))) continue;
    if (stage === "drop" && (drops >= maxDrops || bagDecision(row, s.report, ports.now()).action !== "drop")) continue;
    const before = await observe(observationFor("before", row));
    guardScene(before, s, ports.now(), "empty"); assertBag(before, s);
    if (stage === "identify") {
      const scroll = s.report.rows.find(atTopLeft);
      if (!scroll || !wisdomCount(scroll.rawText) || scroll.quantity === 0) throw new Error("Verified Wisdom stack required in bag (0,0).");
      const armed = await issue("arm", row, before);
      verifyArming(armed.receipt, armed.after);
      const result = await issue("identify", row, armed.after);
      verifyIdentification(result.receipt, result.after);
      identifications++;
      if (s.report.rows.find(atTopLeft)?.quantity === 0) break;
    } else {
      if (!identified || bagDecision(row, s.report, ports.now()).action !== "drop") continue;
      const picked = await issue("pickup", row, before);
      guardScene(picked.after, s, ports.now(), "item"); assertBag(picked.after, s, [row.id]);
      if (!picked.after.cursor.rawText || exactText(picked.after.cursor.rawText) !== exactText(row.rawText)) throw new Error("Intended cursor-held identity unverified; no ground click.");
      finish(picked.receipt, picked.after);
      const result = await issue("drop", row, picked.after);
      verifyDrop(result.receipt, result.after); drops++;
    }
  }
  return s;
}
