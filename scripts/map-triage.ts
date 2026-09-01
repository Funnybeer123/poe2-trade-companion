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
 * Flags: --keep-unknown   only drop explicit dump-rule matches
 *        --max-drops=N    cap on ground drops per run (default 59)
 *        --drop-x=N --drop-y=N   absolute screen point for the ground click
 *
 * Preconditions the script enforces before any mutating click:
 *   - the inventory is open (OCR banner truth; presses `i` only when the
 *     banner says it is closed) and the stash panel is NOT open (a stash
 *     means hideout/town, where ground drops are refused);
 *   - the very top-left bag cell (0,0) Ctrl+C-verifies as Scroll of Wisdom.
 *
 * Numpad 5 pauses, numpad 0 stops (same harness as the sorter). Every
 * identify and drop lands in artifacts/map-triage/journal.jsonl.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { bgrToGray, readBmpBgr } from "../src/adapters/bmp.js";
import { startWinHost } from "../src/adapters/winHost.js";
import { occupiedFromRgbScores, scoreGridCellsRgb } from "../src/core/cellOccupancy.js";
import { SortHarness, SortStop } from "../src/adapters/sortHarness.js";
import { loadProfile } from "../src/core/calibrationStore.js";
import { BAG_CELLS } from "../src/core/calibrationProfile.js";
import { cellCenterTwoCorner } from "../src/core/gridMath.js";
import { resolvePhysicalClient, type ScreenRect } from "../src/core/screenLayout.js";
import { evaluateWithAppraisal } from "../src/core/appraisal.js";
import { detectSpriteItems } from "../src/core/itemSprites.js";
import {
  classifyBagRead,
  confirmedCompactionItems,
  decideDrop,
  mergeAdjacentDuplicates,
  planLeftCompaction,
  planMapTriage,
  runDropPass,
  runIdentifyPass,
  type BagCellRead,
  type CompactionItem,
  type IdentifiedCell,
  type MapTriageCell,
  type MapTriageOps,
  type TriageSprite,
} from "../src/core/mapTriage.js";
import { starterPriceTable, validatePriceTable, type PriceTable } from "../src/core/priceTable.js";
import {
  DEFAULT_TIER_THRESHOLDS,
  starterValueTierRules,
  type ValueTierRules,
  type ValueTierThresholds,
} from "../src/core/valueTiers.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templateDir = path.join(root, "fixtures", "perception", "templates");
const outDir = path.join(root, "artifacts", "map-triage");

const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(name);
const value = (name: string): string | undefined =>
  argv.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);

const live = flag("--run") && !flag("--dry-run");
const keepUnknown = flag("--keep-unknown");
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
const { cols, rows } = BAG_CELLS;

const host = startWinHost({ requestTimeoutMs: 45_000 });
const controlHost = startWinHost({ requestTimeoutMs: 10_000 });
const harness = new SortHarness(host, controlHost, { outDir, dryRun: !live, fast: true });
mkdirSync(outDir, { recursive: true });
const journalFile = path.join(outDir, "journal.jsonl");

function journal(record: Record<string, unknown>): void {
  try {
    appendFileSync(journalFile, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
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

/** Same triage export the sorter uses; starter tiers when no export exists. */
function loadTriageConfig(): {
  rules: ValueTierRules;
  thresholds: ValueTierThresholds;
  priceTable: PriceTable;
  source: string;
} {
  let rules = starterValueTierRules();
  let thresholds: ValueTierThresholds = { ...DEFAULT_TIER_THRESHOLDS };
  let priceTable = starterPriceTable();
  let source = "starter tiers (no artifacts/tab-admin/triage.json export)";
  const file = path.join(root, "artifacts", "tab-admin", "triage.json");
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as {
        rules?: ValueTierRules;
        thresholds?: ValueTierThresholds;
        priceTable?: unknown;
      };
      if (parsed.rules?.keep && parsed.rules.sell && parsed.rules.dump) rules = parsed.rules;
      if (parsed.thresholds) thresholds = { ...thresholds, ...parsed.thresholds };
      const tableCheck = validatePriceTable(parsed.priceTable);
      if (tableCheck.valid && tableCheck.table) priceTable = tableCheck.table;
      source = "artifacts/tab-admin/triage.json";
    } catch (error) {
      console.log(`triage.json unreadable (${String(error)}) — using starter tiers`);
    }
  }
  return { rules, thresholds, priceTable, source };
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
  const stashBand = await host.send({ op: "ocr", left: 450, top: 100, width: 700, height: 110 });
  const invBand = await host.send({ op: "ocr", left: 2900, top: 100, width: 800, height: 110 });
  return {
    stash: /stash/i.test(String(stashBand.text ?? "")),
    inventory: /inventor/i.test(String(invBand.text ?? "")),
  };
}

async function ensureBagOpenInMap(): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const panels = await panelsViaOcr();
    if (panels.stash) {
      throw new Error(
        "stash-panel-open — a stash means hideout/town, where ground drops are refused. Run this inside a map.",
      );
    }
    if (panels.inventory) return;
    // `i` toggles the bag, so only press it after OCR says it is closed.
    await host.send({ op: "focus" });
    await harness.sleep(250, false);
    await host.send({ op: "hotkey", keys: "i" });
    await harness.sleep(700, false);
  }
  throw new Error("inventory-not-openable — the INVENTORY banner never appeared");
}

async function copyItemAt(x: number, y: number): Promise<string> {
  const sentinel = `poe2-map-triage-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  await host.send({ op: "move", x, y });
  await harness.sleep(140, false);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const cleared = await host.send({ op: "setclipboard", text: sentinel });
    if (!cleared.ok) return "";
    await host.send({ op: "hotkey", keys: "ctrlc" });
    await harness.sleep(attempt === 0 ? 160 : 260, false);
    const copied = await host.send({ op: "clipboard" });
    const text = String(copied.text ?? "");
    if (copied.ok && text !== sentinel && /Item Class:/i.test(text)) return text;
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

async function runCareful(client: ScreenRect, triage: ReturnType<typeof loadTriageConfig>): Promise<void> {
  const reads = await sweepBag(client);
  const plan = planMapTriage(reads);
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
    if (identifyResult.aborted === "item-stuck-on-cursor") {
      throw new Error(
        "item-stuck-on-cursor — an identify click lifted an item and it could not be returned. " +
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
        evaluate: (itemText) =>
          evaluateWithAppraisal(itemText, {
            rules: triage.rules,
            thresholds: triage.thresholds,
            priceTable: triage.priceTable,
          }),
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
      if (dropResult.aborted?.startsWith("pickup-failed")) {
        throw new Error(`${dropResult.aborted} — cursor state unknown; check the game before continuing.`);
      }
    } else {
      console.log("Nothing newly identified — nothing to evaluate or drop.");
    }
  }
}

/* ------------------------------------------------------------------------ */
/* Fast mode (default): one hover/click per ITEM, batched copies, then a    */
/* left-compaction of whatever stayed. Ground truth still brackets every    */
/* phase — it is just batched instead of per-cell.                          */
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

/**
 * One capture serves BOTH the DPI-scaled client resolve and sprite
 * segmentation — the fast path's only screenshot (a second full-screen
 * capture per run cost ~700ms for nothing).
 */
async function captureClientSprites(): Promise<{ client: ScreenRect; sprites: TriageSprite[] }> {
  const rect = await host.send({ op: "rect" });
  if (!rect.ok) throw new Error("poe-window-not-found — is Path of Exile 2 running?");
  const probeFile = path.join(outDir, `sprites-${Date.now()}.bmp`);
  const captured = await host.send({ op: "capture", path: probeFile });
  if (!captured.ok) throw new Error(String(captured.error ?? "capture-failed"));
  const bgr = readBmpBgr(probeFile);
  rmSync(probeFile, { force: true });
  const client = resolvePhysicalClient(
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
  const frame = bgrToGray(bgr);
  const region = { x: client.left + bag.x, y: client.top + bag.y, w: bag.w, h: bag.h };
  const grid = fastGrid(client);
  const sprites = detectSpriteItems(frame, client, region, cols, rows).map((item) => {
    const center = cellCenterTwoCorner(
      grid,
      item.grab.col + (item.w - 1) / 2,
      item.grab.row + (item.h - 1) / 2,
      cols,
      rows,
    );
    return {
      id: item.id,
      row: item.grab.row,
      col: item.grab.col,
      w: item.w,
      h: item.h,
      x: item.grab.x,
      y: item.grab.y,
      cx: center.x,
      cy: center.y,
    };
  });
  // RGB safety net: gray-scale sprite detection misses items on the game's
  // RED cell tint (live-observed three times — a sceptre, gloves, a spear,
  // all left uncompacted). Any RGB-occupied cell no sprite covers becomes a
  // synthetic 1x1 region; the eval sweep copy-confirms or discards it, and
  // the catalog corrects its size.
  const spriteCovered = new Set<string>();
  for (const sprite of sprites) {
    for (let r = 0; r < sprite.h; r += 1) {
      for (let c = 0; c < sprite.w; c += 1) spriteCovered.add(`${sprite.row + r},${sprite.col + c}`);
    }
  }
  for (const cell of occupiedFromRgbScores(scoreGridCellsRgb(bgr, client, region, cols, rows))) {
    if (spriteCovered.has(`${cell.row},${cell.col}`)) continue;
    spriteCovered.add(`${cell.row},${cell.col}`);
    sprites.push({
      id: `rgb-${cell.row},${cell.col}`,
      row: cell.row,
      col: cell.col,
      w: 1,
      h: 1,
      x: cell.x,
      y: cell.y,
      cx: cell.x,
      cy: cell.y,
    });
  }
  return { client, sprites };
}

/** Batched hover+Ctrl+C over many points — one host round trip. */
async function copyPoints(points: Array<{ x: number; y: number }>, label: string): Promise<string[]> {
  if (points.length === 0) return [];
  const sentinel = `poe2-map-fast-${Date.now()}-${label}`;
  const reply = await host.send({ op: "copysweep", points, hoverMs: 100, sentinel });
  const texts = Array.isArray(reply.texts) ? (reply.texts as string[]) : [];
  return points.map((_, index) => String(texts[index] ?? ""));
}

function coversTopLeft(sprite: TriageSprite): boolean {
  return sprite.row === 0 && sprite.col === 0;
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
  // Park spot for an item of UNKNOWN size stuck on the cursor: the centre
  // of the biggest free rectangle (up to 2x4 covers every gear size), so
  // the footprint fits wherever the game centres it.
  const findParkPoint = (covered: ReadonlySet<string>): { x: number; y: number } | undefined => {
    for (const [w, h] of [
      [2, 4],
      [2, 3],
      [2, 2],
      [1, 2],
      [1, 1],
    ] as const) {
      for (let col = cols - w; col >= 0; col -= 1) {
        for (let row = rows - h; row >= 0; row -= 1) {
          let free = true;
          for (let r = 0; r < h && free; r += 1) {
            for (let c = 0; c < w && free; c += 1) {
              if (covered.has(`${row + r},${col + c}`) || (row + r === 0 && col + c === 0)) free = false;
            }
          }
          if (free) return placePoint(row, col, w, h);
        }
      }
    }
    return undefined;
  };
  return { grid, stepX, stepY, cellPoint, regionCenter, placePoint, findParkPoint };
}

const calibrationFile = path.join(outDir, "move-calibration.json");

interface MoveCalibration {
  /** Bag-to-bag pick/place click gap (calibrated by --calibrate-moves). */
  gapMs: number;
  /**
   * Pickup→ground-drop gap. The game refuses drops that come too hot on the
   * pickup's heels (35ms refused, 200ms landed — live 2026-08-31), so this
   * self-tunes: each run's verified first drop steps it down on success and
   * raises the floor on a retry.
   */
  dropGapMs: number;
  dropFloorMs: number;
}

function loadCalibration(): MoveCalibration {
  const fallback: MoveCalibration = { gapMs: 140, dropGapMs: 200, dropFloorMs: 60 };
  try {
    if (existsSync(calibrationFile)) {
      const parsed = JSON.parse(readFileSync(calibrationFile, "utf8")) as Partial<MoveCalibration>;
      const clamp = (raw: unknown, low: number, high: number, dflt: number): number => {
        const num = Number(raw);
        return Number.isFinite(num) && num >= low && num <= high ? Math.round(num) : dflt;
      };
      return {
        gapMs: clamp(parsed.gapMs, 30, 300, fallback.gapMs),
        dropGapMs: clamp(parsed.dropGapMs, 40, 300, fallback.dropGapMs),
        dropFloorMs: clamp(parsed.dropFloorMs, 40, 300, fallback.dropFloorMs),
      };
    }
  } catch {
    // fall through to the proven defaults
  }
  return fallback;
}

function saveCalibration(next: MoveCalibration): void {
  try {
    let existing: Record<string, unknown> = {};
    if (existsSync(calibrationFile)) {
      existing = JSON.parse(readFileSync(calibrationFile, "utf8")) as Record<string, unknown>;
    }
    writeFileSync(calibrationFile, JSON.stringify({ ...existing, ...next }, null, 2));
  } catch {
    // tuning persistence must never abort a run
  }
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
  let capture = await captureClientSprites();
  let helpers = makeGridHelpers(capture.client);
  let texts = await copyPoints(
    capture.sprites.map((sprite) => ({ x: sprite.x, y: sprite.y })),
    "calib",
  );
  let confirmed = confirmedCompactionItems(
    capture.sprites.map((sprite, index) => ({ sprite, text: texts[index] ?? "" })),
    { cols, rows },
  );
  if (confirmed.length === 0) {
    await ensureBagOpenInMap();
    capture = await captureClientSprites();
    helpers = makeGridHelpers(capture.client);
    texts = await copyPoints(
      capture.sprites.map((sprite) => ({ x: sprite.x, y: sprite.y })),
      "calib2",
    );
    confirmed = confirmedCompactionItems(
      capture.sprites.map((sprite, index) => ({ sprite, text: texts[index] ?? "" })),
      { cols, rows },
    );
  }
  const { cellPoint, regionCenter, placePoint } = helpers;
  const candidates = confirmed
    .filter((entry) => !(entry.item.row === 0 && entry.item.col === 0))
    .sort((a, b) => a.item.w * a.item.h - b.item.w * b.item.h);
  const test = candidates[0];
  if (!test) throw new Error("calibration needs at least one item in the bag (besides the scroll)");
  const { w, h } = test.item;
  const fingerprint = test.fingerprint ?? "";

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
    await harness.checkpoint(`calibrated move at gap ${gap}`);
    const burst = await host.send({
      op: "clickburst",
      points: [regionCenter(at.row, at.col, w, h), placePoint(to.row, to.col, w, h)],
      gapMs: gap,
    });
    if (!burst.ok) throw new Error(`calibration-burst-failed:${burst.error}`);
    await harness.sleep(120, false);
    const [fromText, toText] = await copyPoints([cellPoint(at.row, at.col), cellPoint(to.row, to.col)], "calv");
    const toParsed = classifyBagRead(toText ?? "").parsed;
    if (!fromText?.trim() && toText?.trim() && (!fingerprint || toParsed?.fingerprint === fingerprint)) {
      at = to;
      return true;
    }
    // Recovery: item still at origin (pickup missed — benign), or on the
    // cursor (placement missed — put it down at the destination).
    if (fromText?.trim()) return false;
    await clickAt(placePoint(to.row, to.col, w, h).x, placePoint(to.row, to.col, w, h).y, "recover: place held item");
    await harness.sleep(180, false);
    const check = (await copyPoints([cellPoint(to.row, to.col)], "calr"))[0] ?? "";
    if (check.trim()) {
      at = to;
      return false;
    }
    const back = (await copyPoints([cellPoint(at.row, at.col)], "calb"))[0] ?? "";
    if (!back.trim()) {
      stuck = true;
    }
    return false;
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
  const { writeFileSync } = await import("node:fs");
  writeFileSync(calibrationFile, JSON.stringify({ gapMs: sweet, calibratedAt: new Date().toISOString(), table }, null, 2));
  console.log(
    `CALIBRATED: ${sweet}ms click gap (confirmed over ${8 - confirmFailures} clean moves) — ` +
      "drop and compaction bursts will use it from the next run.",
  );
}

async function clickAt(x: number, y: number, why: string, shift = false): Promise<void> {
  await harness.checkpoint(why);
  const reply = await host.send(shift ? { op: "click", x, y, shift: true } : { op: "click", x, y });
  if (!reply.ok) throw new Error(`click-failed(${why}):${reply.error}`);
}

async function runFast(triage: ReturnType<typeof loadTriageConfig>): Promise<void> {
  const t0 = Date.now();

  // 1. One screenshot resolves the client AND segments the bag into items.
  let capture = await captureClientSprites();

  // 2. Scroll contract doubles as the bag-open check: the Scroll of Wisdom
  //    at (0,0) only Ctrl+C-verifies with the inventory open, so the OCR
  //    banner dance (~1s) runs ONLY when this fails.
  const scrollPointOf = (c: ScreenRect) => cellCenterTwoCorner(fastGrid(c), 0, 0, cols, rows);
  let scrollProbe = scrollPointOf(capture.client);
  let scrollRead = classifyBagRead(await copyItemAt(scrollProbe.x, scrollProbe.y));
  if (scrollRead.kind !== "scroll") {
    console.log("· scroll not readable — falling back to OCR panel check");
    await ensureBagOpenInMap();
    capture = await captureClientSprites();
    scrollProbe = scrollPointOf(capture.client);
    scrollRead = classifyBagRead(await copyItemAt(scrollProbe.x, scrollProbe.y));
    if (scrollRead.kind !== "scroll") {
      throw new Error("scroll-of-wisdom-not-verified — park the stack at bag (0,0)");
    }
  }
  const { client, sprites } = capture;
  const scrollPoint = scrollProbe;
  const scrolls = scrollRead.stack ?? 1;

  const { grid, stepX, stepY, cellPoint, regionCenter, placePoint, findParkPoint } = makeGridHelpers(client);

  // 3. One batched copy per detected item, with the cursor-preflight park
  //    point riding along as one extra sweep point (its expected-empty read
  //    used to cost two full retry copies ≈ 2.4s).
  const targets = sprites.filter((sprite) => !coversTopLeft(sprite));
  const covered = new Set<string>();
  for (const sprite of sprites) {
    for (let r = 0; r < sprite.h; r += 1) {
      for (let c = 0; c < sprite.w; c += 1) covered.add(`${sprite.row + r},${sprite.col + c}`);
    }
  }
  const parkPoint = live ? findParkPoint(covered) : undefined;
  const sweepPoints = targets.map((sprite) => ({ x: sprite.x, y: sprite.y }));
  if (parkPoint) sweepPoints.push(parkPoint);
  const texts = await copyPoints(sweepPoints, "eval");
  const parkText = parkPoint ? (texts[targets.length] ?? "") : "";
  const targetTexts = texts.slice(0, targets.length);
  const phantomCount = targetTexts.filter((text) => !text.trim()).length;
  const reads = mergeAdjacentDuplicates(
    targets
      .map((sprite, index) => ({ sprite, text: targetTexts[index] ?? "" }))
      .filter((read) => read.text.trim() !== ""),
  );

  // Cursor preflight (live only): if a previous run left an item on the
  // cursor, ANY later click would swap it into the bag unpredictably.
  // Click the empty-verified park cell: a full cursor parks its item there
  // (it becomes a normal bag item and gets triaged); an empty cursor
  // no-ops. Runs BEFORE the first game-affecting click of the run.
  const addSyntheticRead = (point: { x: number; y: number }, text: string): void => {
    const parkedRow = Math.min(rows - 1, Math.floor((point.y - grid.topLeft.y) / stepY));
    const parkedCol = Math.min(cols - 1, Math.floor((point.x - grid.topLeft.x) / stepX));
    const parsed = classifyBagRead(text).parsed;
    reads.push({
      sprite: {
        id: `parked-${parkedRow},${parkedCol}`,
        row: parkedRow,
        col: parkedCol,
        w: parsed?.gridW ?? 1,
        h: parsed?.gridH ?? 1,
        x: point.x,
        y: point.y,
        cx: point.x,
        cy: point.y,
      },
      text,
    });
  };
  if (parkPoint && parkText.trim()) {
    // Sprite detection missed an item sitting on the park cell — fold it in.
    addSyntheticRead(parkPoint, parkText);
  } else if (parkPoint) {
    await clickAt(parkPoint.x, parkPoint.y, "preflight: clear any held item");
    await harness.sleep(150, false);
    const after = (await copyPoints([parkPoint], "preflight"))[0] ?? "";
    if (after.trim()) {
      console.log("! preflight parked a held item — a previous run left it on the cursor");
      addSyntheticRead(parkPoint, after);
    }
  }

  const byKind = (kind: string) => reads.filter((read) => classifyBagRead(read.text).kind === kind);
  const unid = byKind("unid-gear");
  console.log(
    `bag: ${reads.length} item(s) (${phantomCount} phantom region(s) ignored) — ` +
      `${unid.length} unidentified gear, ${byKind("identified-gear").length} identified gear, ` +
      `${byKind("other").length} other · ${scrolls} scroll(s) · ${Date.now() - t0}ms to here`,
  );

  const readDoneAt = Date.now();
  const evaluate = (itemText: string) =>
    evaluateWithAppraisal(itemText, {
      rules: triage.rules,
      thresholds: triage.thresholds,
      priceTable: triage.priceTable,
    });

  if (!live) {
    for (const read of reads) {
      const classified = classifyBagRead(read.text);
      if (classified.kind === "identified-gear") {
        const decision = decideDrop(evaluate(read.text), keepUnknown);
        console.log(
          `  · r${read.sprite.row}c${read.sprite.col} ${classified.parsed?.name ?? "?"} — ` +
            `${decision.drop ? "WOULD DROP" : "keep"} (${decision.tier}: ${decision.reason})`,
        );
      } else if (classified.kind === "unid-gear") {
        console.log(
          `  · r${read.sprite.row}c${read.sprite.col} unidentified ${classified.parsed?.itemClass ?? "?"} — would identify`,
        );
      }
    }
    console.log("DRY-RUN complete (fast). Rerun with --run to identify, drop, and compact.");
    return;
  }

  // 4. Identify chain: arm the scroll ONCE, then ONE burst of left-clicks
  //    with shift HELD DOWN across the whole burst (a per-click shift tap
  //    cancels the game's repeat-use mode — live-tested 2026-08-31).
  if (unid.length > 0) {
    if (unid.length > scrolls) {
      console.log(`! only ${scrolls} scroll(s) for ${unid.length} unid item(s) — the rest stay unidentified`);
    }
    const chain = unid.slice(0, scrolls);
    await clickAtRight(scrollPoint.x, scrollPoint.y, "arm Scroll of Wisdom");
    // The game needs a beat to arm identify mode — clicks that land sooner
    // than ~300ms after the right-click are silently ignored (live-tested).
    await harness.sleep(320, false);
    await harness.checkpoint("identify chain");
    const burst = await host.send({
      op: "clickburst",
      points: chain.map((read) => ({ x: read.sprite.x, y: read.sprite.y })),
      shift: true,
      gapMs: 80,
    });
    if (!burst.ok) throw new Error(`identify-burst-failed:${burst.error}`);
    await harness.sleep(200, false);

    // 5. One batched re-read of the chained reps. Empty read = the chain
    //    lifted that item — click it back and re-read. Still-unidentified
    //    read = the chain skipped it — per-item re-arm fallback.
    const verifyChain = async (batch: typeof chain, label: string): Promise<typeof chain> => {
      const after = await copyPoints(
        batch.map((read) => ({ x: read.sprite.x, y: read.sprite.y })),
        label,
      );
      const stillUnid: typeof chain = [];
      for (let index = 0; index < batch.length; index += 1) {
        const read = batch[index]!;
        let text = after[index] ?? "";
        if (!text.trim()) {
          console.log(`! r${read.sprite.row}c${read.sprite.col} read empty after identify — returning it`);
          await clickAt(read.sprite.cx, read.sprite.cy, "return lifted item");
          await harness.sleep(160, false);
          text = await copyItemAt(read.sprite.x, read.sprite.y);
          if (!text.trim()) {
            throw new Error("item-stuck-on-cursor — check the game before running anything else");
          }
        }
        read.text = text;
        if (classifyBagRead(text).kind === "unid-gear") stillUnid.push(read);
      }
      return stillUnid;
    };

    const leftovers = await verifyChain(chain, "verify");
    if (leftovers.length > 0) {
      console.log(`· ${leftovers.length} item(s) missed by the chain — per-item re-arm fallback`);
      for (const read of leftovers) {
        await clickAtRight(scrollPoint.x, scrollPoint.y, "re-arm Scroll of Wisdom");
        await harness.sleep(320, false);
        await clickAt(read.sprite.x, read.sprite.y, `identify r${read.sprite.row}c${read.sprite.col}`);
        await harness.sleep(250, false);
      }
      const stubborn = await verifyChain(leftovers, "verify2");
      for (const read of stubborn) {
        console.log(
          `! r${read.sprite.row}c${read.sprite.col} would not identify — it stays in the bag unidentified`,
        );
      }
    }
  }

  const identifyDoneAt = Date.now();

  // 6. Decide and drop. Only clipboard-confirmed identified gear is ever
  //    dropped; still-unidentified and unreadable items always stay.
  const groundPoint = {
    x: Number(value("--drop-x") ?? Math.round(client.left + client.width * 0.44)),
    y: Number(value("--drop-y") ?? Math.round(client.top + client.height * 0.6)),
  };
  const decisions = reads
    .map((read) => ({ read, classified: classifyBagRead(read.text) }))
    .filter((entry) => entry.classified.kind === "identified-gear")
    .map((entry) => ({
      ...entry,
      decision: decideDrop(evaluate(entry.read.text), keepUnknown),
    }));
  const toDrop = decisions.filter((entry) => entry.decision.drop).slice(0, maxDrops);
  const kept = decisions.filter((entry) => !entry.decision.drop);

  if (toDrop.length > 0) {
    // Ground-click safety, paid only when drops are imminent: with the
    // stash panel open the "ground" point is stash UI and a held item
    // would DEPOSIT there instead of dropping — refuse before any pickup.
    const stashBand = await host.send({ op: "ocr", left: 450, top: 100, width: 700, height: 110 });
    if (/stash/i.test(String(stashBand.text ?? ""))) {
      throw new Error("stash-panel-open — refusing to drop (hideout/town?); nothing was touched");
    }
    // First drop alone, then verify in three steps: a pre-click copy of
    // the origin cell distinguishes "pickup never happened" (item still
    // there) from "item gone"; the put-back probe click + copy then
    // distinguishes "dropped" from "refused, still on the cursor". Airtight
    // against both failure modes before the burst touches anything else.
    const first = toDrop[0]!;
    const dropFirstOnce = async (gap: number): Promise<"dropped" | "pickup-missed" | "refused"> => {
      await harness.checkpoint("first drop");
      const burst = await host.send({
        op: "clickburst",
        points: [
          { x: first.read.sprite.cx, y: first.read.sprite.cy },
          { x: groundPoint.x, y: groundPoint.y },
        ],
        gapMs: gap,
      });
      if (!burst.ok) throw new Error(`drop-burst-failed:${burst.error}`);
      await harness.sleep(160, false);
      const still = (await copyPoints([{ x: first.read.sprite.x, y: first.read.sprite.y }], "probe0"))[0] ?? "";
      if (still.trim()) return "pickup-missed";
      await clickAt(first.read.sprite.cx, first.read.sprite.cy, "probe: confirm first drop landed");
      await harness.sleep(150, false);
      const probe = (await copyPoints([{ x: first.read.sprite.x, y: first.read.sprite.y }], "probe1"))[0] ?? "";
      return probe.trim() ? "refused" : "dropped";
    };
    // Self-tuning drop gap: the verified first drop doubles as the probe.
    // Success steps next run's gap down 25ms; a bounce raises the floor so
    // the failed speed is never probed again, and ONE conservative retry
    // separates "too fast" from "the player can't drop here".
    let dropGap = Math.max(calibration.dropFloorMs, calibration.dropGapMs);
    const probedGap = dropGap;
    let firstResult = await dropFirstOnce(dropGap);
    if (firstResult !== "dropped" && dropGap < 200) {
      console.log(`! first drop ${firstResult} at ${dropGap}ms — retrying once at 200ms`);
      dropGap = 200;
      firstResult = await dropFirstOnce(dropGap);
      if (firstResult === "dropped") {
        // The 200ms retry landing proves the spot was fine — the probed
        // speed was too hot. Raise the floor so it is never probed again.
        saveCalibration({ ...calibration, dropGapMs: 200, dropFloorMs: Math.max(calibration.dropFloorMs, probedGap + 25) });
      }
      // An abort leaves the calibration untouched: an environmental refusal
      // (bad spot, not in a map) must not poison the speed floor.
    }
    if (firstResult !== "dropped") {
      journal({ phase: "fast", aborted: `drop-${firstResult}`, dropped: 0 });
      throw new Error(
        `drop-refused (${firstResult}) — the first drop would not land. Stand on open ground inside a map ` +
          "(or adjust --drop-x/--drop-y) and rerun; nothing else was touched.",
      );
    }
    if (dropGap === probedGap) {
      // Clean first drop at the probed speed: step next run's gap down.
      const tunedNext = Math.max(calibration.dropFloorMs, dropGap - 25);
      if (tunedNext !== calibration.dropGapMs) {
        saveCalibration({ ...calibration, dropGapMs: tunedNext });
      }
    }
    if (toDrop.length > 1) {
      // The rest as one burst: pickup, ground, pickup, ground, ...
      await harness.checkpoint("drop burst");
      const rest = toDrop.slice(1);
      const restBurst = await host.send({
        op: "clickburst",
        points: rest.flatMap((entry) => [
          { x: entry.read.sprite.cx, y: entry.read.sprite.cy },
          { x: groundPoint.x, y: groundPoint.y },
        ]),
        gapMs: dropGap,
      });
      if (!restBurst.ok) throw new Error(`drop-burst-failed:${restBurst.error}`);
      await harness.sleep(200, false);
      // End probe: catches drops that stopped landing mid-burst — the last
      // item would be on the cursor; clicking its cell puts it back.
      const last = rest[rest.length - 1]!.read.sprite;
      await clickAt(last.cx, last.cy, "probe: confirm drops landed");
      await harness.sleep(150, false);
      const probe = (await copyPoints([{ x: last.x, y: last.y }], "probe2"))[0] ?? "";
      if (probe.trim()) {
        journal({ phase: "fast", aborted: "drop-refused-late", dropped: toDrop.length - 1 });
        throw new Error(
          "drop-refused — a later drop bounced back (did the drop spot become blocked?); compaction skipped",
        );
      }
    }
  }
  for (const entry of kept) {
    console.log(
      `· kept ${entry.classified.parsed?.name ?? "?"} (${entry.decision.tier}: ${entry.decision.reason})`,
    );
  }
  console.log(`Dropped ${toDrop.length}, kept ${kept.length} — ${Date.now() - t0}ms`);
  journal({
    phase: "fast",
    scrolls,
    identified: unid.length,
    dropped: toDrop.map((entry) => ({
      row: entry.read.sprite.row,
      col: entry.read.sprite.col,
      itemName: entry.classified.parsed?.name ?? "",
      tier: entry.decision.tier,
      reason: entry.decision.reason,
    })),
    kept: kept.map((entry) => ({
      row: entry.read.sprite.row,
      col: entry.read.sprite.col,
      itemName: entry.classified.parsed?.name ?? "",
      tier: entry.decision.tier,
    })),
  });
  const dropDoneAt = Date.now();
  let compactMoves = 0;

  // 7. Compact what stayed to the left edge. NO fresh sweep: the eval phase
  //    already copy-confirmed every item's position and size, and the drop
  //    phase freed known cells — so the post-drop layout is a known model.
  //    Plan once, execute every move as ONE click burst, then verify only
  //    the moved targets with one batched copy. An already-compact bag
  //    plans zero moves and costs zero clicks and zero reads.
  if (!noCompact) {
    const plannedOccupancy = (items: readonly CompactionItem[]): Set<string> => {
      const covered = new Set<string>(["0,0"]);
      for (const item of items) {
        for (let r = 0; r < item.h; r += 1) {
          for (let c = 0; c < item.w; c += 1) covered.add(`${item.row + r},${item.col + c}`);
        }
      }
      return covered;
    };

    /** Plan from the given model, burst the moves, verify moved targets by copy. */
    const compactFromModel = async (
      confirmed: ReturnType<typeof confirmedCompactionItems>,
      label: string,
    ): Promise<{ count: number; ok: boolean }> => {
      const moves = planLeftCompaction(
        confirmed.map((entry) => entry.item),
        { cols, rows, reserved: [{ row: 0, col: 0 }] },
      );
      if (moves.length === 0) return { count: 0, ok: true };
      const byId = new Map(confirmed.map((entry) => [entry.item.id, entry]));
      await harness.checkpoint(`${label}: ${moves.length} move(s)`);
      const burst = await host.send({
        op: "clickburst",
        points: moves.flatMap((move) => [
          byId.get(move.id)!.pick,
          placePoint(move.to.row, move.to.col, move.w, move.h),
        ]),
        gapMs: moveGapMs,
      });
      if (!burst.ok) throw new Error(`compact-burst-failed:${burst.error}`);
      await harness.sleep(280, false);
      const checks = await copyPoints(
        moves.map((move) => cellPoint(move.to.row, move.to.col)),
        label,
      );
      return { count: moves.length, ok: checks.every((text) => text.trim() !== "") };
    };

    const droppedIds = new Set(toDrop.map((entry) => entry.read.sprite.id));
    const model = confirmedCompactionItems(
      reads.filter((read) => !droppedIds.has(read.sprite.id)),
      { cols, rows },
    );
    const first = await compactFromModel(model, "compact");
    compactMoves = first.count;
    if (first.count === 0) {
      console.log("Bag already left-compacted — no moves needed.");
    } else if (!first.ok) {
      // A target read empty: a placement bounced or landed shifted. Park
      // any held item (a no-op click when the cursor is empty), then ONE
      // corrective pass from fresh clipboard-confirmed reality.
      const park = findParkPoint(
        plannedOccupancy(model.map((entry) => entry.item)),
      );
      if (park) {
        await clickAt(park.x, park.y, "park any held item");
        await harness.sleep(200, false);
      }
      const freshSprites = (await captureClientSprites()).sprites.filter(
        (sprite) => !coversTopLeft(sprite),
      );
      const freshTexts = await copyPoints(
        freshSprites.map((sprite) => ({ x: sprite.x, y: sprite.y })),
        "compact-fix",
      );
      const freshModel = confirmedCompactionItems(
        freshSprites.map((sprite, index) => ({ sprite, text: freshTexts[index] ?? "" })),
        { cols, rows },
      );
      const second = await compactFromModel(freshModel, "compact-fix");
      compactMoves += second.count;
      if (!second.ok) console.log("! compaction still off after the corrective pass — rerun to finish");
    }
    console.log(`Compaction: ${compactMoves} move(s) — total ${Date.now() - t0}ms`);
    journal({ phase: "compact", moves: compactMoves });
  }

  const endAt = Date.now();
  const stillUnidAtEnd = reads.filter((read) => classifyBagRead(read.text).kind === "unid-gear").length;
  recordBenchmark({
    at: new Date().toISOString(),
    items: reads.length,
    identified: Math.max(0, unid.length - stillUnidAtEnd),
    dropped: toDrop.length,
    moves: compactMoves,
    readMs: readDoneAt - t0,
    identifyMs: identifyDoneAt - readDoneAt,
    dropMs: dropDoneAt - identifyDoneAt,
    compactMs: endAt - dropDoneAt,
    totalMs: endAt - t0,
    msPerItem: reads.length > 0 ? Math.round((endAt - t0) / reads.length) : endAt - t0,
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
  const triage = loadTriageConfig();
  console.log(
    `map-triage ${live ? "LIVE" : "DRY-RUN"}${careful ? " CAREFUL" : " FAST"} · rules from ${triage.source}` +
      `${keepUnknown ? " · keep-unknown" : ""} · max drops ${maxDrops} — numpad: 5 pause · 0 stop`,
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
  const stopped = error instanceof SortStop;
  console.log(String(error instanceof Error ? error.message : error));
  if (!stopped) exitCode = 1;
  await harness.dispose({ outcome: stopped ? "stopped" : "failed" });
} finally {
  await controlHost.close();
  await host.close();
}
process.exit(exitCode);
