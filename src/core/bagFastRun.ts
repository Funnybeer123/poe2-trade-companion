import { assessBatch, type LeagueKnowledge } from "./batchTriage.js";
import { bagDecision, captureBagObservations, cellKey, eligibleBagEquipment, exactText, wisdomCount,
  type BagCellObservation, type BagPosition } from "./bagAssessment.js";
import { createBagSession, validateBagSession, type BagAction, type BagReceipt, type BagScene, type BagSession } from "./bagSession.js";
import type { BagCellLook, BagCursorLook } from "./bagFastVision.js";
import { knownPhysicalItemSize } from "./itemSizeCatalog.js";
import { looksLikePoeItemText, parseItemText } from "./parseItem.js";
import type { StashValuationReport, StashValuationRow, StashValuationSettings } from "./stashValuation.js";

/** One-action in-map workflow: one read per PHYSICAL item, one Shift-held Wisdom
 * chain with a counted scroll decrement, then serial drops. The accountability
 * rules of the staged runner are kept where they protect items:
 *  - intent is recorded durably before every mutating input, results after;
 *  - a drop needs the exact ledger text re-read at the click position immediately
 *    before the pickup, positive source departure while held, and afterwards a
 *    positively clean cursor with every other tracked footprint unchanged;
 *  - any ambiguity stops the run; nothing is retried without evidence that the
 *    previous input changed nothing. */
export interface FastSafety {
  at: string; evidence: string; mapInstance: string; context: BagScene["context"]; loading: boolean; foreground: boolean;
  inventoryOpen: boolean; obstructed: boolean; alive: boolean; calibration: string; ground: { x: number; y: number };
}
export interface FastLook {
  at: string; evidence: string; inventoryOpen: boolean;
  /** "unobserved" when the pointer was not parked inside a probe region. */
  cursor: BagCursorLook | "unobserved";
  /** Tracked physical items by ledger row id. */
  footprints: Record<string, BagCellLook>;
  /** Every positively empty cell key in this view. */
  emptyCells: string[];
}
export interface FastRead { text: string; copied: boolean; ms: number }
export type FastLogEntry = { kind: string } & Record<string, unknown>;
export interface FastBagPorts {
  now(): string;
  /** Stop, pause, focus, process and same-map checks. Throws to halt all input. Every
   * input port below performs this check itself before its native event; the runner
   * adds it at decision boundaries. */
  checkpoint(): Promise<void>;
  safety(scope: "full" | "hud"): Promise<FastSafety>;
  /** Positive two-position empty-cursor proof; becomes the run's pixel baseline. */
  baseline(): Promise<FastLook>;
  track(items: Array<{ id: string; cells: BagPosition[]; excludeCount: boolean }>): void;
  look(pointer: "probe" | "ground"): Promise<FastLook>;
  read(cell: BagPosition, mode: "scan" | "careful"): Promise<FastRead>;
  arm(cell: BagPosition): Promise<void>;
  chain(cells: BagPosition[]): Promise<void>;
  pickup(cell: BagPosition): Promise<void>;
  release(): Promise<void>;
  /** Must flush durably or throw BEFORE the caller issues input. */
  record(entry: FastLogEntry): void;
  saveSession(session: BagSession): void;
  progress?(message: string): void;
}
export interface FastBagOptions {
  id: string;
  origin: BagSession["origin"];
  settings?: StashValuationSettings;
  knowledge?: LeagueKnowledge;
  maxIdentifications: number;
  maxDrops: number;
  /** Life/HUD evidence older than this is refreshed before another pickup. */
  safetyFreshMs?: number;
}
export interface FastBagTiming {
  totalMs: number; safetyMs: number; baselineMs: number; scanMs: number; assessMs: number;
  identifyMs: number; dropMs: number; reads: number; readMs: number[]; dropItemMs: number[];
}
export interface FastBagResult {
  session: BagSession;
  timing: FastBagTiming;
  scrollsUsed: number;
  leftUnidentified: string[];
  notes: string[];
}
export class FastBagStop extends Error {
  constructor(message: string, readonly held: "none" | "wisdom" | "item" | "unknown" = "none") { super(message); this.name = "FastBagStop"; }
}

const atTopLeft = (row: StashValuationRow) => row.row === 0 && row.col === 0 && row.cells?.length === 1;
const allCells = (): BagPosition[] => Array.from({ length: 60 }, (_, n) => ({ row: Math.floor(n / 12), col: n % 12 }));

function assertSafe(safety: FastSafety, pinned?: FastSafety): void {
  if (safety.context !== "map" || !safety.mapInstance || safety.loading || !safety.foreground || !safety.inventoryOpen ||
    safety.obstructed || !safety.alive || pinned && (pinned.mapInstance !== safety.mapInstance || pinned.calibration !== safety.calibration)) {
    throw new FastBagStop("Map, focus, inventory, life or modal evidence is unsafe; no further input.");
  }
}

export async function runFastBag(options: FastBagOptions, ports: FastBagPorts): Promise<FastBagResult> {
  for (const [name, value] of [["max-identifications", options.maxIdentifications], ["max-drops", options.maxDrops]] as const) {
    if (!Number.isInteger(value) || value < 0 || value > 59) throw new Error(name + " must be an integer from 0 to 59.");
  }
  const started = Date.now(), freshMs = options.safetyFreshMs ?? 2500;
  const timing: FastBagTiming = { totalMs: 0, safetyMs: 0, baselineMs: 0, scanMs: 0, assessMs: 0, identifyMs: 0, dropMs: 0, reads: 0, readMs: [], dropItemMs: [] };
  const notes: string[] = [], leftUnidentified: string[] = [];
  const timed = async <T>(key: "safetyMs" | "baselineMs" | "scanMs" | "identifyMs" | "dropMs", work: () => Promise<T>) => {
    const t = Date.now(); try { return await work(); } finally { timing[key] += Date.now() - t; }
  };
  const read = async (cell: BagPosition, mode: "scan" | "careful") => {
    let result = await ports.read(cell, mode); timing.reads++; timing.readMs.push(result.ms);
    // A silent fast read is retried once with the conservative hover before it counts as unread.
    if (mode === "scan" && !looksLikePoeItemText(result.text)) { result = await ports.read(cell, "careful"); timing.reads++; timing.readMs.push(result.ms); }
    return looksLikePoeItemText(result.text) ? result.text : "";
  };

  ports.record({ kind: "start", id: options.id, maxIdentifications: options.maxIdentifications, maxDrops: options.maxDrops });
  await ports.checkpoint();
  let safety = await timed("safetyMs", () => ports.safety("full"));
  assertSafe(safety);
  const pinned = safety;
  let safetyAt = Date.now();
  const base = await timed("baselineMs", () => ports.baseline());
  if (base.cursor !== "clean" || !base.inventoryOpen) throw new FastBagStop("The cursor is not provably empty over an open inventory; nothing was touched.", "unknown");

  // --- Scan: row-major order means an uncovered occupied cell is always the
  // top-left cell of its physical item, so ONE read plus the known footprint
  // covers the item. Unknown footprints fall back to per-cell reads and stay
  // uncertain in the shared ledger; they can never authorize input.
  const empties = new Set(base.emptyCells), covered = new Set<string>(), cells: BagCellObservation[] = [];
  await timed("scanMs", async () => {
    for (const cell of allCells()) {
      const key = cellKey(cell);
      if (covered.has(key)) continue;
      if (empties.has(key)) { cells.push({ ...cell, state: "empty", evidence: base.evidence + ":pixel-empty:" + key }); continue; }
      const text = await read(cell, "scan");
      if (!text) { cells.push({ ...cell, state: "unread", evidence: base.evidence + ":no-copy:" + key }); continue; }
      const parsed = parseItemText(text), size = parsed.itemClass === "Relics" ? undefined : knownPhysicalItemSize(parsed.itemClass, parsed.baseType);
      const footprint: BagPosition[] = [];
      if (size) for (let r = 0; r < size.h; r++) for (let c = 0; c < size.w; c++) footprint.push({ row: cell.row + r, col: cell.col + c });
      const fits = size && footprint.every(p => p.row < 5 && p.col < 12 && !covered.has(cellKey(p)) && !empties.has(cellKey(p)));
      for (const p of fits ? footprint : [cell]) {
        covered.add(cellKey(p));
        cells.push({ ...p, state: "item", rawText: text, confirmation: text,
          evidence: `${base.evidence}:read:${key}:${fits ? `known-footprint:${size!.w}x${size!.h}+pixel-occupancy` : "single-cell"}` });
      }
      if (cell.col === 11 || footprint.some(p => p.col === 11)) ports.progress?.(`Read inventory through row ${cell.row + 1}/5.`);
    }
  });
  const scene = (at: string, evidence: string, cursor: BagScene["cursor"], sceneCells: BagCellObservation[] = []): BagScene => ({
    at, evidence, mapInstance: pinned.mapInstance, context: "map", foreground: true, inventoryOpen: true, obstructed: false, alive: true,
    loading: false, calibration: pinned.calibration, ground: { ...pinned.ground, valid: true, evidence: safety.evidence }, cursor, cells: sceneCells });
  const assessStarted = Date.now();
  const captured = captureBagObservations(options.id, cells, options.settings, base.at, options.knowledge);
  timing.assessMs += Date.now() - assessStarted;
  const initial = createBagSession(captured, scene(base.at, base.evidence, { state: "empty", evidence: base.evidence + ":two-position-empty" }, cells), options.origin);
  ports.saveSession(initial);
  const knowledge = options.knowledge;
  let report: StashValuationReport = structuredClone(initial.report);
  const receipts: BagReceipt[] = [], identifiedIds: string[] = [], droppedIds: string[] = [];
  let scrollsUsed = 0, lastLook: FastLook = base, scrollGone = false;

  const finishSession = (): BagSession => {
    const gone = new Set(droppedIds);
    const finalCells: BagCellObservation[] = allCells().map(cell => ({ ...cell, state: "empty" as const, evidence: lastLook.evidence + ":model-empty:" + cellKey(cell) }));
    for (const row of report.rows) {
      if (gone.has(row.id) || scrollGone && atTopLeft(row)) continue;
      for (const c of row.cells!) Object.assign(finalCells.find(f => f.row === c.row && f.col === c.col)!,
        { state: "item", rawText: row.rawText, confirmation: row.rawText, evidence: lastLook.evidence + ":tracked:" + row.id });
    }
    const session: BagSession = { ...structuredClone(initial), report: structuredClone(report),
      scene: scene(lastLook.at, lastLook.evidence, { state: "empty", evidence: lastLook.evidence }, finalCells),
      receipts: structuredClone(receipts), identifiedIds: [...identifiedIds], droppedIds: [...droppedIds] };
    validateBagSession(session);
    return session;
  };
  const complete = (): FastBagResult => { timing.totalMs = Date.now() - started; return { session: finishSession(), timing, scrollsUsed, leftUnidentified, notes }; };
  const action = (kind: BagAction["kind"], row: StashValuationRow, chained = false): BagAction => ({ id: report.id + ":action:" + receipts.length, kind, itemId: row.id,
    cell: kind === "arm" ? { row: 0, col: 0 } : { row: row.row!, col: row.col! }, ground: { ...pinned.ground }, ...(chained ? { chained: true } : {}) });

  try {
    if (!report.capture?.complete || report.unreadCells.length) {
      throw new FastBagStop("The bag could not be read completely (" + report.unreadCells.map(c => `${c.row},${c.col}`).join(" ") + "); nothing was identified or dropped.");
    }
    ports.track(report.rows.map(row => ({ id: row.id, cells: row.cells!, excludeCount: !!wisdomCount(row.rawText) })));
    const baselineEmpty = new Set(base.emptyCells);
    /** Every tracked footprint must look as expected and no new object may appear. */
    const assertLook = (look: FastLook, expect: { cursor?: BagCursorLook; gone?: string[]; mayChange?: string[]; mayVanish?: string[]; held?: FastBagStop["held"] }) => {
      lastLook = look;
      const held = expect.held ?? "none";
      if (!look.inventoryOpen) throw new FastBagStop("The inventory panel is no longer visible; no further input.", held);
      if (expect.cursor && look.cursor !== expect.cursor) throw new FastBagStop(`Cursor evidence is ${look.cursor}, expected ${expect.cursor}; evidence: ${look.evidence}`, look.cursor === "clean" ? "none" : held === "none" ? "unknown" : held);
      const gone = new Set([...droppedIds, ...(expect.gone ?? [])]), seenEmpty = new Set(look.emptyCells);
      for (const row of report.rows) {
        const want = gone.has(row.id) || scrollGone && atTopLeft(row) ? "empty" : "same", got = look.footprints[row.id];
        if (got === want || want === "same" && (got === "changed" && expect.mayChange?.includes(row.id) || got === "empty" && expect.mayVanish?.includes(row.id))) continue;
        throw new FastBagStop(`Bag item at ${row.row},${row.col} looks ${got ?? "untracked"}, expected ${want}; evidence: ${look.evidence}`, held);
      }
      for (const key of baselineEmpty) if (!seenEmpty.has(key)) throw new FastBagStop(`A new object appeared in bag cell ${key}; evidence: ${look.evidence}`, held);
    };
    const refreshSafety = async () => {
      if (Date.now() - safetyAt <= freshMs) return;
      safety = await timed("safetyMs", () => ports.safety("hud")); assertSafe(safety, pinned); safetyAt = Date.now();
    };

    // --- Identify: arm once, one Shift-held chain, then account for every scroll.
    await timed("identifyMs", async () => {
      const scroll = report.rows.find(atTopLeft), count = scroll ? wisdomCount(scroll.rawText) : undefined;
      const unidentified = report.rows.filter(row => eligibleBagEquipment(row.rawText) && !parseItemText(row.rawText).identified);
      if (!unidentified.length || options.maxIdentifications === 0) return;
      if (!scroll || !count) { notes.push("No Scroll of Wisdom stack in bag cell (0,0); unidentified equipment was kept."); leftUnidentified.push(...unidentified.map(r => r.id)); return; }
      const targets = unidentified.slice(0, Math.min(count, options.maxIdentifications));
      leftUnidentified.push(...unidentified.slice(targets.length).map(r => r.id));
      let armedLook: FastLook | undefined;
      const beforeArm = lastLook;
      for (let attempt = 0; attempt < 2 && !armedLook; attempt++) {
        await ports.checkpoint(); await refreshSafety();
        ports.record({ kind: "intent", action: "arm", attempt, scrolls: count, targets: targets.map(t => t.id) });
        await ports.arm({ row: 0, col: 0 });
        const look = await ports.look("probe");
        if (look.cursor === "clean") { assertLook(look, { cursor: "clean" }); ports.record({ kind: "result", action: "arm", armed: false, evidence: look.evidence }); continue; }
        assertLook(look, { cursor: "occupied", held: "wisdom" }); armedLook = look;
      }
      if (!armedLook) throw new FastBagStop("Scroll of Wisdom did not arm after two verified attempts; no scroll was used.");
      const before = scene(beforeArm.at, beforeArm.evidence, { state: "empty", evidence: beforeArm.evidence });
      const arm: BagReceipt = { action: action("arm", targets[0]!), before, after: scene(armedLook.at, armedLook.evidence, { state: "wisdom", evidence: armedLook.evidence + ":probe-occupied+all-art-present" }), state: "verified" };
      receipts.push(arm);
      ports.record({ kind: "intent", action: "identify-chain", targets: targets.map(t => ({ id: t.id, cell: { row: t.row, col: t.col } })), scrolls: count });
      await ports.checkpoint();
      await ports.chain(targets.map(t => ({ row: t.row!, col: t.col! })));
      const after = await ports.look("probe");
      // The last scroll leaves (0,0) empty; the text accounting below decides whether that is legitimate.
      assertLook(after, { cursor: "clean", mayChange: targets.map(t => t.id), mayVanish: targets.length >= count ? [scroll.id] : [], held: "unknown" });
      // Text is the identity receipt: same class, base, rarity and level, now identified.
      const updates: Array<{ row: StashValuationRow; text: string }> = [];
      for (const row of targets) {
        const text = await read({ row: row.row!, col: row.col! }, "scan"), old = parseItemText(row.rawText), now = text ? parseItemText(text) : undefined;
        if (!now || now.itemClass !== old.itemClass || now.rarity !== old.rarity || now.itemLevel !== old.itemLevel || now.baseType !== old.baseType) {
          throw new FastBagStop(`The item at ${row.row},${row.col} no longer matches its captured identity after identification.`);
        }
        if (now.identified) updates.push({ row, text });
        else if (exactText(text) !== exactText(row.rawText)) throw new FastBagStop(`The item at ${row.row},${row.col} changed without being identified.`);
        else leftUnidentified.push(row.id);
      }
      const remaining = count - updates.length;
      const scrollText = await read({ row: 0, col: 0 }, "scan");
      if (remaining > 0 ? wisdomCount(scrollText) !== remaining : scrollText !== "" || !after.emptyCells.includes("0,0")) {
        throw new FastBagStop(`Scroll accounting failed: ${updates.length} identification(s) verified from ${count} scroll(s), but the stack reads ${wisdomCount(scrollText) ?? "nothing"}.`);
      }
      scrollsUsed = updates.length; scrollGone = remaining === 0;
      for (const { row, text } of updates) {
        const ledger = report.rows.find(r => r.id === row.id)!;
        ledger.rawText = text; ledger.fingerprint = parseItemText(text).fingerprint; identifiedIds.push(row.id);
      }
      const ledgerScroll = report.rows.find(atTopLeft)!;
      if (remaining > 0) Object.assign(ledgerScroll, { rawText: scrollText, quantity: remaining }); else ledgerScroll.quantity = 0;
      const t = Date.now(); report = assessBatch(report, report.settings, ports.now(), knowledge); timing.assessMs += Date.now() - t;
      const done = scene(after.at, after.evidence, { state: "empty", evidence: after.evidence + ":probe-clean" });
      updates.forEach(({ row }, index) => receipts.push({ action: action("identify", row, true),
        before: index === 0 ? structuredClone(arm.after!) : done, after: done, state: "verified" }));
      // Identification may redraw art; the post-identification look becomes those items' reference.
      ports.track(updates.map(({ row }) => ({ id: row.id, cells: row.cells!, excludeCount: false })));
      if (remaining > 0) ports.track([{ id: ledgerScroll.id, cells: ledgerScroll.cells!, excludeCount: true }]);
      ports.record({ kind: "result", action: "identify-chain", identified: updates.map(u => u.row.id), scrollsUsed, remaining, evidence: after.evidence });
      ports.progress?.(`Identified ${updates.length} item(s) with ${scrollsUsed} scroll(s).`);
    });

    // --- Drop: serial and individually verified.
    await timed("dropMs", async () => {
      let drops = 0;
      for (const row of report.rows) {
        if (drops >= options.maxDrops) break;
        if (droppedIds.includes(row.id) || !parseItemText(row.rawText).identified || bagDecision(row, report, ports.now()).action !== "drop") continue;
        const itemStarted = Date.now(), cell = { row: row.row!, col: row.col! }, beforePickup = lastLook;
        await ports.checkpoint(); await refreshSafety();
        ports.record({ kind: "intent", action: "pickup", id: row.id, cell });
        let heldLook: FastLook | undefined;
        for (let attempt = 0; attempt < 2 && !heldLook; attempt++) {
          if (exactText(await read(cell, "scan")) !== exactText(row.rawText)) throw new FastBagStop(`The item at ${cell.row},${cell.col} no longer matches the assessed text; it was not picked up.`);
          await ports.checkpoint();
          await ports.pickup(cell);
          const look = await ports.look("ground");
          if (look.footprints[row.id] === "same") {
            // Evidence that the click changed nothing: the item is in place and the cursor is positively clean.
            assertLook(await ports.look("probe"), { cursor: "clean", held: "unknown" });
            ports.record({ kind: "result", action: "pickup", id: row.id, lifted: false, attempt, evidence: look.evidence }); continue;
          }
          assertLook(look, { gone: [row.id], held: "item" }); heldLook = look;
        }
        if (!heldLook) throw new FastBagStop(`The item at ${cell.row},${cell.col} could not be picked up after two verified attempts.`);
        const held = scene(heldLook.at, heldLook.evidence, { state: "item", rawText: row.rawText, evidence: heldLook.evidence + ":sole-source-departure-after-exact-read" });
        const pickup: BagReceipt = { action: action("pickup", row), before: scene(beforePickup.at, beforePickup.evidence, { state: "empty", evidence: beforePickup.evidence }), after: held, state: "verified" };
        ports.record({ kind: "intent", action: "drop", id: row.id, ground: pinned.ground, evidence: heldLook.evidence });
        await ports.checkpoint();
        await ports.release();
        const after = await ports.look("probe");
        assertLook(after, { cursor: "clean", gone: [row.id], held: "item" });
        receipts.push(pickup);
        const dropAction = action("drop", row);
        const released = scene(after.at, after.evidence, { state: "empty", evidence: after.evidence + ":probe-clean" });
        released.groundReceipt = { actionId: dropAction.id, rawText: row.rawText, evidence: after.evidence + ":released-with-bag-otherwise-unchanged" };
        receipts.push({ action: dropAction, before: held, after: released, state: "verified" });
        droppedIds.push(row.id); drops++;
        timing.dropItemMs.push(Date.now() - itemStarted);
        ports.record({ kind: "result", action: "drop", id: row.id, evidence: after.evidence });
      }
      if (drops) ports.progress?.(`Dropped ${drops} low-priority item(s).`);
    });
    const result = complete();
    ports.saveSession(result.session);
    ports.record({ kind: "final", identified: identifiedIds.length, dropped: droppedIds.length, timing });
    return result;
  } catch (error) {
    ports.record({ kind: "stop", message: error instanceof Error ? error.message : String(error), held: error instanceof FastBagStop ? error.held : "unknown",
      identified: identifiedIds.length, dropped: droppedIds.length });
    // Verified progress is durable even when the run stops; unverified input stays only in the action log.
    try { ports.saveSession(finishSession()); } catch { /* The action log already holds the stop. */ }
    throw error;
  }
}
