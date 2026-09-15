/**
 * Map triage runner — inside a map, identify all unidentified gear in the
 * bag using the Scroll of Wisdom stack parked in bag cell (0,0), evaluate
 * each newly identified item against the value-tier regex rules
 * (artifacts/tab-admin/triage.json), and drop the not-good ones on the
 * ground.
 *
 *   npx tsx scripts/map-triage.ts            # dry-run: sweep, plan, report
 *   npx tsx scripts/map-triage.ts --run      # live
 *
 * Flags: --keep-unknown   retain unknown valuations (default; wins over --drop-unknown)
 *        --drop-unknown   explicitly allow dropping rule-less unknown gear
 *        --max-drops=N    cap on ground drops per run (default 59)
 *        --drop-x=N --drop-y=N   absolute screen point for the ground click
 *
 * Preconditions the script enforces before any mutating click:
 *   - the inventory is open (clipboard scroll truth; no blind I toggle)
 *     and the stash panel is NOT open;
 *   - the very top-left bag cell (0,0) Ctrl+C-verifies as Scroll of Wisdom.
 * FAST resolves complete clipboard footprints; it never moves pixel guesses.
 *
 * Numpad 5 pauses, numpad 0 stops (same harness as the sorter). Every
 * identify and drop lands in artifacts/map-triage/journal.jsonl.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { startWinHost } from "../src/adapters/winHost.js";
import { SortHarness, SortStop } from "../src/adapters/sortHarness.js";
import { loadProfile } from "../src/core/calibrationStore.js";
import { BAG_CELLS } from "../src/core/calibrationProfile.js";
import { cellCenterTwoCorner } from "../src/core/gridMath.js";
import { resolvePhysicalClient, type ScreenRect } from "../src/core/screenLayout.js";
import {
  classifyBagRead,
  planMapTriage,
  resolveBagFootprints,
  runDropPass,
  runIdentifyPass,
  type BagCellRead,
  type IdentifiedCell,
  type MapTriageCell,
  type MapTriageOps,
} from "../src/core/mapTriage.js";
import { loadTriageExport, type TriageExport } from "../src/adapters/triageLoader.js";
import { copyPoints as kitCopyPoints, panelsViaOcr as kitPanelsViaOcr } from "../src/adapters/bagKit.js";
import { mapTriageControlHost, mapTriageHost } from "../src/adapters/mapTriageHost.js";
import { runMapTriage } from "../src/core/mapTriageRun.js";
import { describeDecision } from "../src/core/itemDecision.js";
import { runFastCompactionPass, type FastTriageOps } from "../src/core/mapTriageExecution.js";
import { itemSizeDatabasePath, loadItemSizeDatabase, lookupItemSize } from "../src/core/itemSizeStore.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templateDir = path.join(root, "fixtures", "perception", "templates");
const outDir = path.join(root, "artifacts", "map-triage");
const runId = new Date().toISOString();

const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(name);
const value = (name: string): string | undefined =>
  argv.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);

const live = flag("--run") && !flag("--dry-run");
const keepUnknown = flag("--keep-unknown") || !flag("--drop-unknown");
const maxDrops = Math.max(0, Number(value("--max-drops") ?? 59));
// Opt-in widening (careful mode only): also evaluate gear the sweep already
// found identified. Fast mode always evaluates all gear in the bag.
const includeIdentified = flag("--include-identified");
// --careful selects the original per-cell, per-click-verified flow.
const careful = flag("--careful");
const noCompact = flag("--no-compact");

const profile = loadProfile(templateDir);
if (!profile.bagGrid) {
  console.error("bag-grid-not-calibrated — run the calibration flow first.");
  process.exit(1);
}
const bag = profile.bagGrid;
const sizes = loadItemSizeDatabase(itemSizeDatabasePath(root));
const { cols, rows } = BAG_CELLS;

const rawHost = startWinHost({ requestTimeoutMs: null });
const host = mapTriageHost(rawHost, journal);
const rawControlHost = startWinHost({ requestTimeoutMs: 10_000 });
const controlHost = mapTriageControlHost(rawControlHost);
const harness = new SortHarness(host, controlHost, { outDir, dryRun: !live, fast: true });
mkdirSync(outDir, { recursive: true });
const journalFile = path.join(outDir, "journal.jsonl");

function journal(record: Record<string, unknown>): void {
  try {
    appendFileSync(journalFile, `${JSON.stringify({ at: new Date().toISOString(), runId, module: "map-triage", mode: live ? "live" : "preview", ...record })}\n`);
  } catch {
    // journaling must never abort a run
  }
}

const benchmarkFile = path.join(outDir, "benchmark.jsonl");

interface BenchmarkEntry {
  at: string;
  items: number;
  identified: number;
  dropped: number;
  moves: number;
  readMs: number;
  identifyMs: number;
  dropMs: number;
  compactMs: number;
  totalMs: number;
  msPerItem: number;
}

/** Append this run and report the standing record (lowest ms/item, ties by total). */
function recordBenchmark(entry: BenchmarkEntry): void {
  let runs: BenchmarkEntry[] = [];
  try {
    if (existsSync(benchmarkFile)) {
      runs = readFileSync(benchmarkFile, "utf8")
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as BenchmarkEntry);
    }
  } catch {
    // a corrupt benchmark file never blocks a run
  }
  const best = runs.reduce<BenchmarkEntry | undefined>(
    (acc, run) =>
      !acc || run.msPerItem < acc.msPerItem || (run.msPerItem === acc.msPerItem && run.totalMs < acc.totalMs)
        ? run
        : acc,
    undefined,
  );
  try {
    appendFileSync(benchmarkFile, `${JSON.stringify(entry)}\n`);
  } catch {
    // ditto
  }
  const line =
    `BENCHMARK: ${entry.totalMs}ms total · ${entry.msPerItem}ms/item over ${entry.items} item(s) ` +
    `(read ${entry.readMs} · identify ${entry.identifyMs} · drop ${entry.dropMs} · compact ${entry.compactMs})`;
  if (!best) {
    console.log(`${line} — first recorded run, this is the mark to beat.`);
  } else if (entry.msPerItem < best.msPerItem) {
    console.log(`${line} — NEW BEST (previous: ${best.msPerItem}ms/item, ${best.totalMs}ms on ${best.at}).`);
  } else {
    console.log(`${line} — best remains ${best.msPerItem}ms/item (${best.totalMs}ms, ${best.at}).`);
  }
}

async function resolveClient(): Promise<ScreenRect> {
  const rect = await host.send({ op: "rect" });
  if (!rect.ok) throw new Error("poe-window-not-found — is Path of Exile 2 running?");
  const probeFile = path.join(outDir, `probe-${Date.now()}.bmp`);
  const captured = await host.send({ op: "capture", path: probeFile });
  if (!captured.ok) throw new Error(String(captured.error ?? "capture-failed"));
  rmSync(probeFile, { force: true });
  return resolvePhysicalClient(
    {
      left: Number(captured.left),
      top: Number(captured.top),
      width: Number(captured.width),
      height: Number(captured.height),
    },
    Number(rect.monitorWidth) || Number(captured.width),
    Number(rect.monitorHeight) || Number(captured.height),
    { left: Number(rect.monitorLeft ?? 0), top: Number(rect.monitorTop ?? 0) },
  );
}

/** Panel truth is the OCR'd title banners, never grid heuristics. */
async function panelsViaOcr(): Promise<{ stash: boolean; inventory: boolean }> {
  return kitPanelsViaOcr(host);
}

async function ensureBagOpenInMap(): Promise<void> {
  const panels = await panelsViaOcr();
  if (panels.stash) throw new Error("stash-panel-open — close the stash and enter a map");
  // An absent OCR heading is not proof the bag is closed. Never blindly toggle I.
  // The caller verifies the scroll by clipboard before it may touch any item.
}

async function copyItemAt(x: number, y: number): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await harness.checkpoint("verify bag cell");
    const reply = await host.send({ op: "copysweep", points: [{ x, y }], hoverMs: 140,
      sentinel: `poe2-map-cell-${Date.now()}-${attempt}` });
    const text = (reply.texts as string[])[0]!;
    if (text.trim()) return text;
  }
  return "";
}

async function sweepBag(client: ScreenRect): Promise<BagCellRead[]> {
  const grid = {
    topLeft: { x: client.left + bag.x, y: client.top + bag.y },
    bottomRight: { x: client.left + bag.x + bag.w, y: client.top + bag.y + bag.h },
  };
  const reads: BagCellRead[] = [];
  for (let row = 0; row < rows; row += 1) {
    await harness.checkpoint("reading bag");
    const points = Array.from({ length: cols }, (_, col) =>
      cellCenterTwoCorner(grid, col, row, cols, rows),
    );
    const sentinel = `poe2-map-sweep-${Date.now()}-${row}`;
    const reply = await host.send({ op: "copysweep", points, hoverMs: 120, sentinel });
    const texts = Array.isArray(reply.texts) ? (reply.texts as string[]) : [];
    points.forEach((point, col) => {
      reads.push({ row, col, x: point.x, y: point.y, text: texts[col] ?? "" });
    });
  }
  return reads;
}

/* ------------------------------------------------------------------------ */
/* Careful mode (--careful): the original per-cell, per-click-verified flow. */
/* ------------------------------------------------------------------------ */

async function runCareful(client: ScreenRect, triage: TriageExport): Promise<void> {
  const reads = await sweepBag(client);
  const plan = planMapTriage(reads, (item) => lookupItemSize(sizes, item));
  for (const issue of plan.issues) console.log(`! ${issue}`);
  if (!plan.scroll) throw new Error("scroll-of-wisdom-not-verified — aborting before any click");
  console.log(
    `Scroll of Wisdom confirmed at bag (0,0) — ${plan.scroll.stack} scroll(s). ` +
      `${plan.unidGear.length} unidentified gear cell(s); identify budget ${plan.budget}.`,
  );
  for (const cell of plan.unidGear) {
    console.log(`  · r${cell.row}c${cell.col} ${cell.rarity} ${cell.itemClass}`);
  }

  if (!live) {
    console.log(
      plan.unidGear.length === 0
        ? "Nothing to identify. DRY-RUN complete."
        : `DRY-RUN: would identify ${plan.budget} item(s), evaluate each against the tier rules, ` +
          "and drop the not-good ones on the ground. Rerun with --run to do it.",
    );
    journal({ mode: "dry-run", scrolls: plan.scroll.stack, unidGear: plan.unidGear.length });
  } else {
    const ops: MapTriageOps = {
      copyCell: (cell: MapTriageCell) => copyItemAt(cell.x, cell.y),
      rightClick: async (point, why) => {
        await harness.checkpoint(why);
        const reply = await host.send({ op: "rightclick", x: point.x, y: point.y });
        if (!reply.ok) throw new Error(`rightclick-failed:${reply.error}`);
      },
      leftClick: async (point, why) => {
        await harness.click(point.x, point.y, why);
      },
      sleep: (ms) => harness.sleep(ms, false),
      log: (line) => console.log(line),
      shouldStop: () => harness.stopRequested,
    };

    const identifyResult = await runIdentifyPass({ plan, ops });
    console.log(
      `Identified ${identifyResult.identified.length} item(s) with ${identifyResult.scrollsUsed} scroll(s)` +
        (identifyResult.aborted ? ` — identify pass stopped early: ${identifyResult.aborted}` : ""),
    );
    for (const skip of identifyResult.skipped) {
      console.log(`  · skipped r${skip.cell.row}c${skip.cell.col}: ${skip.reason}`);
    }
    journal({
      phase: "identify",
      identified: identifyResult.identified.length,
      scrollsUsed: identifyResult.scrollsUsed,
      skipped: identifyResult.skipped.map((skip) => ({ ...skip.cell, reason: skip.reason })),
      aborted: identifyResult.aborted ?? null,
    });
    if (identifyResult.aborted) {
      throw new Error(
        `${identifyResult.aborted} — identify stopped; dropping skipped. ` +
          "Check the game before running anything else.",
      );
    }

    // The drop pass normally sees only what this run identified. With
    // --include-identified it also gets the cells the sweep already found
    // identified (their sweep text is the full identified text); the drop
    // pass still re-copies and fingerprint-pins every cell before touching
    // it, so stale sweep data can only cause a skip, never a wrong drop.
    const dropCandidates: IdentifiedCell[] = [...identifyResult.identified];
    if (includeIdentified) {
      const covered = new Set(dropCandidates.map((entry) => `${entry.cell.row},${entry.cell.col}`));
      for (const sweepRead of reads) {
        if (covered.has(`${sweepRead.row},${sweepRead.col}`)) continue;
        const classified = classifyBagRead(sweepRead.text);
        if (classified.kind !== "identified-gear" || !classified.parsed) continue;
        dropCandidates.push({
          cell: {
            row: sweepRead.row,
            col: sweepRead.col,
            x: sweepRead.x,
            y: sweepRead.y,
            itemClass: classified.parsed.itemClass,
            rarity: classified.parsed.rarity,
            fingerprint: classified.parsed.fingerprint,
          },
          text: sweepRead.text,
        });
      }
      console.log(
        `--include-identified: ${dropCandidates.length - identifyResult.identified.length} ` +
          "already-identified gear cell(s) join the drop evaluation.",
      );
    }

    if (dropCandidates.length > 0) {
      // Ground click: near the character's feet, left of the inventory
      // panel — minimal walk, no UI underneath.
      const groundPoint = {
        x: Number(value("--drop-x") ?? Math.round(client.left + client.width * 0.44)),
        y: Number(value("--drop-y") ?? Math.round(client.top + client.height * 0.6)),
      };
      const dropResult = await runDropPass({
        identified: dropCandidates,
        groundPoint,
        evaluate: (itemText) => {
          const verdict = triage.evaluate(itemText);
          triage.observeEvaluation?.(itemText, verdict);
          return verdict;
        },
        ops,
        keepUnknown,
        maxDrops,
      });
      for (const keep of dropResult.kept) {
        console.log(`· kept ${keep.itemName} (${keep.tier}: ${keep.reason})`);
      }
      for (const skip of dropResult.skipped) {
        console.log(`· skipped r${skip.cell.row}c${skip.cell.col}: ${skip.reason}`);
      }
      console.log(
        `Dropped ${dropResult.dropped.length}, kept ${dropResult.kept.length}` +
          (dropResult.aborted ? ` — drop pass stopped early: ${dropResult.aborted}` : "."),
      );
      journal({
        phase: "drop",
        groundPoint,
        dropped: dropResult.dropped.map((entry) => ({
          ...entry.cell,
          itemName: entry.itemName,
          tier: entry.tier,
          reason: entry.reason,
        })),
        kept: dropResult.kept.map((entry) => ({
          ...entry.cell,
          itemName: entry.itemName,
          tier: entry.tier,
          reason: entry.reason,
        })),
        skipped: dropResult.skipped.map((skip) => ({ ...skip.cell, reason: skip.reason })),
        aborted: dropResult.aborted ?? null,
      });
      if (dropResult.aborted) {
        throw new Error(`${dropResult.aborted} — cursor state unknown; check the game before continuing.`);
      }
    } else {
      console.log("Nothing newly identified — nothing to evaluate or drop.");
    }
  }
}

/* ------------------------------------------------------------------------ */
/* Fast mode (default): one complete clipboard layout, one identify chain, */
/* then verified item transactions. No pixel-size guesses or repeat moves. */
/* ------------------------------------------------------------------------ */

interface FastGrid {
  topLeft: { x: number; y: number };
  bottomRight: { x: number; y: number };
}

function fastGrid(client: ScreenRect): FastGrid {
  return {
    topLeft: { x: client.left + bag.x, y: client.top + bag.y },
    bottomRight: { x: client.left + bag.x + bag.w, y: client.top + bag.y + bag.h },
  };
}

/** Bounded copy batches retain the proven 100 ms hover and preserve clipboard. */
async function copyPoints(points: Array<{ x: number; y: number }>, label: string): Promise<string[]> {
  const texts: string[] = [];
  for (let start = 0; start < points.length; start += cols) {
    await harness.checkpoint(label);
    texts.push(...await kitCopyPoints(host, points.slice(start, start + cols), `${label}-${start}`));
  }
  return texts;
}

function makeGridHelpers(client: ScreenRect) {
  const grid = fastGrid(client);
  const stepX = (grid.bottomRight.x - grid.topLeft.x) / cols;
  const stepY = (grid.bottomRight.y - grid.topLeft.y) / rows;
  const cellPoint = (row: number, col: number) => cellCenterTwoCorner(grid, col, row, cols, rows);
  const regionCenter = (row: number, col: number, w: number, h: number) =>
    cellCenterTwoCorner(grid, col + (w - 1) / 2, row + (h - 1) / 2, cols, rows);
  // Placement click for a held item: an EVEN dimension puts the region
  // centre exactly on a cell boundary, where the game's footprint rounding
  // is a coin flip (refused placements live-tested) — bias a quarter cell
  // toward the top-left so the alignment is unambiguous.
  const placePoint = (row: number, col: number, w: number, h: number) => {
    const center = regionCenter(row, col, w, h);
    return {
      x: Math.round(center.x - (w % 2 === 0 ? stepX / 4 : 0)),
      y: Math.round(center.y - (h % 2 === 0 ? stepY / 4 : 0)),
    };
  };
  return { grid, stepX, stepY, cellPoint, regionCenter, placePoint };
}

const calibrationFile = path.join(outDir, "move-calibration.json");

interface MoveCalibration {
  /** Bag-to-bag pick/place click gap (calibrated by --calibrate-moves). */
  gapMs: number;
  /**
   * Pickup→ground-drop gap. The game refuses drops that come too hot on the
   * pickup's heels (35ms refused, 200ms landed — live 2026-08-31), so this
   * uses a minimum 200ms floor; a successful drop does not lower the floor.
   */
  dropGapMs: number;
  dropFloorMs: number;
}

function loadCalibration(): MoveCalibration {
  const fallback: MoveCalibration = { gapMs: 140, dropGapMs: 200, dropFloorMs: 200 };
  try {
    if (existsSync(calibrationFile)) {
      const parsed = JSON.parse(readFileSync(calibrationFile, "utf8")) as Partial<MoveCalibration>;
      const clamp = (raw: unknown, low: number, high: number, dflt: number): number => {
        const num = Number(raw);
        return Number.isFinite(num) && num >= low && num <= high ? Math.round(num) : dflt;
      };
      return {
        gapMs: clamp(parsed.gapMs, 35, 300, fallback.gapMs),
        dropGapMs: clamp(parsed.dropGapMs, 40, 300, fallback.dropGapMs),
        dropFloorMs: clamp(parsed.dropFloorMs, 40, 300, fallback.dropFloorMs),
      };
    }
  } catch {
    // fall through to the proven defaults
  }
  return fallback;
}

const calibration = loadCalibration();
const moveGapMs = calibration.gapMs;

/**
 * --calibrate-moves: find the fastest reliable pick/place click gap by
 * ping-ponging one small confirmed item between its spot and a free region,
 * verifying EVERY move by copy (origin empty + destination holds the same
 * fingerprint). Descends 140→35ms until a gap produces a failure, then
 * re-confirms the last clean gap with extra rounds and saves it to
 * move-calibration.json, which normal runs use for drop/compact bursts.
 * Failures recover in place (a held item is put back and counted), so the
 * bag ends intact.
 */
async function runMoveCalibration(): Promise<void> {
  const client = await resolveClient();
  const helpers = makeGridHelpers(client);
  await ensureBagOpenInMap();
  const model = resolveBagFootprints(await sweepBag(client), { cols, rows }, (item) => lookupItemSize(sizes, item));
  if (model.issues.length) throw new Error(`bag-layout-unverified: ${model.issues.join("; ")}`);
  const confirmed = model.items;
  const scroll = model.reads.find((read) => read.sprite.row === 0 && read.sprite.col === 0);
  if (!scroll || classifyBagRead(scroll.text).kind !== "scroll" || !(classifyBagRead(scroll.text).stack ?? 0)) {
    throw new Error("scroll-of-wisdom-not-verified");
  }
  const { cellPoint, placePoint } = helpers;
  const candidates = confirmed
    .filter((entry) => !entry.item.fixed && !(entry.item.row === 0 && entry.item.col === 0))
    .sort((a, b) => a.item.w * a.item.h - b.item.w * b.item.h);
  const test = candidates[0];
  if (!test) throw new Error("calibration needs at least one item in the bag (besides the scroll)");
  const { w, h } = test.item;

  const covered = new Set<string>(["0,0"]);
  for (const entry of confirmed) {
    for (let r = 0; r < entry.item.h; r += 1) {
      for (let c = 0; c < entry.item.w; c += 1) covered.add(`${entry.item.row + r},${entry.item.col + c}`);
    }
  }
  let spare: { row: number; col: number } | undefined;
  for (let col = cols - w; col >= 0 && !spare; col -= 1) {
    for (let row = rows - h; row >= 0 && !spare; row -= 1) {
      let free = true;
      for (let r = 0; r < h && free; r += 1) {
        for (let c = 0; c < w && free; c += 1) {
          if (covered.has(`${row + r},${col + c}`)) free = false;
        }
      }
      if (free) spare = { row, col };
    }
  }
  if (!spare) throw new Error("calibration needs a free region in the bag the size of its smallest item");

  const home = { row: test.item.row, col: test.item.col };
  console.log(
    `calibrating with a ${w}x${h} item at r${home.row}c${home.col} ↔ r${spare.row}c${spare.col} — every move verified by copy`,
  );

  let at = home;
  let stuck = false;
  /** One verified move; returns success and updates `at`. */
  const move = async (to: { row: number; col: number }, gap: number): Promise<boolean> => {
    const result = await runFastCompactionPass({
      confirmed, moves: [{ id: test.item.id, from: { ...at }, to, w, h }],
      cols, rows, cellPoint, placePoint, moveGapMs: gap, ops: makeFastOps(),
    });
    if (result.aborted) {
      // A calibration miss is still an unexplained live move. Abort instead
      // of treating a nonempty target as success or continuing more attempts.
      stuck = true;
      throw new Error(`calibration-${result.aborted}`);
    }
    at = { ...to };
    test.item.row = to.row;
    test.item.col = to.col;
    test.pick = cellPoint(to.row, to.col);
    return true;
  };

  const gaps = [140, 120, 100, 85, 70, 55, 45, 35];
  const table: Array<{ gapMs: number; moves: number; failures: number; avgMsPerMove: number }> = [];
  let sweet = 140;
  for (const gap of gaps) {
    let failures = 0;
    let ms = 0;
    let ok = 0;
    for (let i = 0; i < 6 && !stuck; i += 1) {
      const target = at.row === home.row && at.col === home.col ? spare : home;
      const started = Date.now();
      if (await move(target, gap)) {
        ok += 1;
        ms += Date.now() - started;
      } else {
        failures += 1;
      }
    }
    const avg = ok > 0 ? Math.round(ms / ok) : 0;
    table.push({ gapMs: gap, moves: 6, failures, avgMsPerMove: avg });
    console.log(`gap ${gap}ms: ${failures} failure(s) in 6 moves · ${avg}ms per verified move`);
    if (stuck) throw new Error("calibration item unaccounted for — check the game before continuing");
    if (failures > 0) break;
    sweet = gap;
  }

  // Confirm the sweet spot with a longer clean streak before trusting it.
  let confirmFailures = 0;
  for (let i = 0; i < 8 && !stuck; i += 1) {
    const target = at.row === home.row && at.col === home.col ? spare : home;
    if (!(await move(target, sweet))) confirmFailures += 1;
  }
  if (stuck) throw new Error("calibration item unaccounted for — check the game before continuing");
  if (confirmFailures > 0) {
    const index = gaps.indexOf(sweet);
    sweet = gaps[Math.max(0, index - 1)] ?? 140;
    console.log(`! sweet spot failed confirmation — stepping back to ${sweet}ms`);
  }

  // Leave the item where it started.
  if (!(at.row === home.row && at.col === home.col)) await move(home, sweet);

  appendFileSync(
    calibrationFile.replace(/\.json$/, ".history.jsonl"),
    `${JSON.stringify({ at: new Date().toISOString(), sweet, table })}\n`,
  );
  writeFileSync(calibrationFile, JSON.stringify({ gapMs: sweet, calibratedAt: new Date().toISOString(), table }, null, 2));
  console.log(
    `CALIBRATED: ${sweet}ms click gap (confirmed over ${8 - confirmFailures} clean moves) — ` +
      "bag compaction will use it next run; ground drops keep a separate 200ms floor.",
  );
}

async function clickAt(x: number, y: number, why: string, shift = false): Promise<void> {
  await harness.checkpoint(why);
  const reply = await host.send(shift ? { op: "click", x, y, shift: true } : { op: "click", x, y });
  if (!reply.ok) throw new Error(`click-failed(${why}):${reply.error}`);
}

function makeFastOps(): FastTriageOps {
  return {
    copyPoints,
    identifyBurst: async (points, options) => {
      await harness.checkpoint(options.label);
      const reply = await host.send({ op: "identifyburst", points, gapMs: options.gapMs, hoverMs: 100 });
      return { count: Number(reply.count), texts: reply.texts as string[],
        ...(reply.verificationFailed === true ? { verificationFailed: true } : {}) };
    },
    rightClick: (point, why) => clickAtRight(point.x, point.y, why),
    leftClick: (point, why) => clickAt(point.x, point.y, why),
    clickBurst: async (points, options) => {
      await harness.checkpoint(options.label);
      await host.send({ op: "clickburst", points, gapMs: options.gapMs, hoverMs: options.hoverMs, shift: options.shift ?? false });
    },
    sleep: (ms) => harness.sleep(ms, false),
    checkpoint: (label) => harness.checkpoint(label),
    shouldStop: () => harness.stopRequested,
  };
}

async function runFast(triage: TriageExport): Promise<void> {
  const t0 = Date.now();
  const client = await resolveClient();
  const { cellPoint, placePoint } = makeGridHelpers(client);
  const scrollPoint = cellPoint(0, 0);
  const scrollText = await copyItemAt(scrollPoint.x, scrollPoint.y);
  const scroll = classifyBagRead(scrollText);
  if (scroll.kind !== "scroll" || (scroll.stack ?? 0) < 1) {
    throw new Error("scroll-of-wisdom-not-verified — open inventory with a nonempty scroll stack at (0,0)");
  }
  // A complete cell map proves origin, size, emptiness and identical adjacent
  // items. It replaces pixel regions that missed/split three items in live QA.
  const cells: BagCellRead[] = [{ row: 0, col: 0, ...scrollPoint, text: scrollText }];
  for (let row = 0; row < rows; row += 1) {
    const columns = Array.from({ length: cols }, (_, col) => col).filter((col) => row !== 0 || col !== 0);
    const points = columns.map((col) => cellPoint(row, col));
    const texts = await copyPoints(points, `bag-row-${row}`);
    columns.forEach((col, index) => cells.push({ row, col, ...points[index]!, text: texts[index]! }));
  }
  const readDoneAt = Date.now();
  writeFileSync(path.join(outDir, `bag-read-${Date.now()}.json`), JSON.stringify({ at: new Date().toISOString(), cells }, null, 2));
  const beforeMutations = async (): Promise<void> => {
    await harness.checkpoint("map preflight");
    // Guard before identification too: the stash under a click target can
    // change the meaning of a held-item click. OCR transport errors abort.
    const band = await host.send({ op: "ocr", left: client.left + 450, top: client.top + 100, width: 700, height: 110 });
    if (/stash/i.test(String(band.text ?? ""))) throw new Error("stash-panel-open — refusing map actions");
  };
  const ops = makeFastOps();
  let identifyDoneAt = readDoneAt;
  let dropDoneAt = readDoneAt;
  const result = await runMapTriage({
    cells, grid: { cols, rows }, lookupSize: (item) => lookupItemSize(sizes, item),
    evaluate: triage.evaluate, observeEvaluation: triage.observeEvaluation,
    ops, live, keepUnknown, maxDrops, noCompact,
    groundPoint: {
      x: Number(value("--drop-x") ?? Math.round(client.left + client.width * 0.44)),
      y: Number(value("--drop-y") ?? Math.round(client.top + client.height * 0.6)),
    },
    cellPoint, placePoint, moveGapMs: Math.max(35, moveGapMs),
    dropGapMs: Math.max(200, calibration.dropGapMs, calibration.dropFloorMs), beforeMutations,
    event: (record) => {
      journal(record);
      if (record.phase === "identify") identifyDoneAt = Date.now();
      if (record.phase === "identify" && record.fallbackReason === "inline-copy-unavailable") {
        console.log("· Shift-held copying unavailable — used verified individual identification");
      }
      if (record.phase === "drop") dropDoneAt = Date.now();
    },
  });
  console.log(`bag: ${result.items} item(s) · ${result.unidentified} unidentified gear · ${result.scrolls} scroll(s)`);
  const outcomes = { keep: 0, list: 0, review: 0, "discard-eligible": 0 };
  for (const decision of result.decisions) {
    const appraisal = decision.verdict.appraisal;
    const item = decision.verdict.decision;
    if (item) outcomes[item.outcome] += 1;
    console.log(`  · r${decision.row}c${decision.col} ${decision.name} — ${decision.drop ? (live ? "drop candidate" : "WOULD DROP") : "keep"} ` +
      `(${decision.verdict.tier}: ${decision.reason})${appraisal ? ` · confidence ${appraisal.confidence}%` : ""}` +
      (item ? ` · decision: ${describeDecision(item)}` : ""));
  }
  if (result.decisions.length) {
    console.log(`decisions: ${outcomes.keep} keep · ${outcomes.list} list · ${outcomes.review} review · ` +
      `${outcomes["discard-eligible"]} discard-eligible (proposals${keepUnknown ? "; unknown-tier items retained" : "; --drop-unknown acts on audited proposals only"})`);
  }
  if (result.aborted) throw new Error(result.aborted);
  if (!live) {
    console.log("DRY-RUN complete (fast). No identify, drop or compact clicks. Prices use saved rules/table/learned tiers; no fresh trade lookups.");
    return;
  }
  const endAt = Date.now();
  dropDoneAt = Math.max(dropDoneAt, identifyDoneAt);
  console.log(`Identified ${result.identified}, dropped ${result.dropped}, compacted ${result.moves} move(s) · ${endAt - t0}ms`);
  journal({ phase: "complete", ...result });
  recordBenchmark({
    at: new Date().toISOString(), items: result.items, identified: result.identified, dropped: result.dropped,
    moves: result.moves, readMs: readDoneAt - t0, identifyMs: identifyDoneAt - readDoneAt,
    dropMs: dropDoneAt - identifyDoneAt, compactMs: endAt - dropDoneAt,
    totalMs: endAt - t0, msPerItem: result.items ? Math.round((endAt - t0) / result.items) : endAt - t0,
  });
}

async function clickAtRight(x: number, y: number, why: string): Promise<void> {
  await harness.checkpoint(why);
  const reply = await host.send({ op: "rightclick", x, y });
  if (!reply.ok) throw new Error(`rightclick-failed(${why}):${reply.error}`);
}

let exitCode = 0;
try {
  await host.send({ op: "focus" });
  harness.startKeyListener();
  // Same triage export the sorter uses; starter tiers when no export exists.
  const triage = loadTriageExport(root);
  console.log(
    `map-triage ${live ? "LIVE" : "DRY-RUN"}${careful ? " CAREFUL" : " FAST"} · rules from ${triage.source}` +
      `${keepUnknown ? " · unknowns kept" : " · drop-unknown requested"} · max drops ${maxDrops} — numpad: 5 pause · 0 stop`,
  );

  if (flag("--calibrate-moves")) {
    await runMoveCalibration();
  } else if (careful) {
    const client = await resolveClient();
    await ensureBagOpenInMap();
    await runCareful(client, triage);
  } else {
    await runFast(triage);
  }
  await harness.dispose({ outcome: "complete", live });
} catch (error) {
  const stopped = error instanceof SortStop || /stop-requested/.test(String(error));
  console.log(String(error instanceof Error ? error.message : error));
  if (!stopped) exitCode = 1;
  journal({ phase: "failed", reason: String(error instanceof Error ? error.message : error) });
  try {
    await rawHost.send({ op: "capture", path: path.join(outDir, `failure-${Date.now()}.png`) });
  } catch { /* preserve the original failure */ }
  await harness.dispose({ outcome: stopped ? "stopped" : "failed" });
} finally {
  await rawControlHost.close();
  await rawHost.close();
}
process.exit(exitCode);
