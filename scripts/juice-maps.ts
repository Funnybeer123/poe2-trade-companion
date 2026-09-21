/**
 * T15 waystone juicer — Alchemy / Regal → fill with Exalts → Vaal on the
 * stash tab already on screen. Orbs come from the bag so the maps tab is
 * never left mid-recipe.
 *
 *   npx tsx scripts/juice-maps.ts --current              # dry-run (default)
 *   npx tsx scripts/juice-maps.ts --from-clipboard
 *   npx tsx scripts/juice-maps.ts --from-file=items.txt
 *   npx tsx scripts/juice-maps.ts --current --live        # ALSO needs POE2_JUICE_LIVE=1
 *
 * Flags: --max-maps=N --max-steps=N --json
 *
 * Safety:
 *   - Dry-run is the default. Live needs BOTH --live and POE2_JUICE_LIVE=1.
 *   - --current never clicks the tab strip; stash + bag must already be open.
 *   - Numpad 5 pauses, numpad 0 stops. Ctrl+Shift+Esc latches the host.
 *   - Refuses to start live while another win-input-host is running.
 *   - One Ctrl+C sweep. Alchemy/Regal from that scan, then 3 Exalts on every
 *     uncorrupted T15 rare and one Vaal. No mid-run re-reads.
 *   - Hold Shift the whole time an orb is picked up so stacks pull from
 *     inventory. One right-click starts use-mode; later piles feed under Shift.
 *     After each slam, Ctrl+C that well. An empty well plus a waystone on an
 *     empty bag cell means the map was picked up — stop and park it.
 *   - After each Vaal, wait for a complete Ctrl+C. Corrupted T15 stays.
 *     Still-clean T15 is a missed click and is retried. Empty well means the
 *     stone is on the cursor: bag drop, ctrl-click, next Vaal.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { startWinHost } from "../src/adapters/winHost.js";
import { SortHarness, SortStop } from "../src/adapters/sortHarness.js";
import { loadProfile } from "../src/core/calibrationStore.js";
import {
  BAG_CELLS,
  activeStashGrid,
  mapsStashGrid,
  type GridMark,
} from "../src/core/calibrationProfile.js";
import { cellCenterTwoCorner } from "../src/core/gridMath.js";
import { markToScreenGrid } from "../src/core/gridLattice.js";
import { resolvePhysicalClient } from "../src/core/screenLayout.js";
import { ORB_NAMES, type OrbId } from "../src/core/crafting.js";
import { parseItemText } from "../src/core/parseItem.js";
import {
  allocateOrbClicks,
  describeJuicePlan,
  inspectWaystone,
  inventoryOpenFromOcr,
  isWaystoneClass,
  juiceOrbForPhase,
  JUICE_BATCH_PHASES,
  MAPS_TIER15_CLICK,
  mapsSpecialtyFromOcr,
  planWaystoneJuice,
  planJuiceFromScan,
  currencyStackCount,
  takePickups,
  stashOpenFromOcr,
  type JuiceBatchPhase,
  type JuiceBatchTarget,
  type JuicePlan,
  type JuiceStepRecord,
} from "../src/core/waystoneJuice.js";

const root = path.resolve(process.env.POE2_STASH_DATA_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const userTemplateDir = path.join(process.env.APPDATA ?? "", "poe2-trade-companion", "perception-templates");
const fixtureTemplateDir = path.join(root, "fixtures", "perception", "templates");
const templateDir =
  process.env.POE2_TEMPLATE_DIR ??
  (existsSync(path.join(userTemplateDir, "calibration.json")) ? userTemplateDir : fixtureTemplateDir);
const outDir = path.join(root, "artifacts", "crafting");

const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(name);
const value = (name: string): string | undefined =>
  argv.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);

const liveRequested = flag("--live") && !flag("--dry-run");
const live = liveRequested && process.env.POE2_JUICE_LIVE === "1";
const asJson = flag("--json");
const maxSteps = Math.max(1, Number(value("--max-steps") ?? 400));
const maxMaps = Math.max(1, Number(value("--max-maps") ?? 200));
const currentTab = flag("--current") || !flag("--tab");

if (liveRequested && !live) {
  console.error("--live also requires POE2_JUICE_LIVE=1 in the environment. Refusing.");
  process.exit(1);
}

if (!currentTab) {
  console.error("v1 only juices the stash tab already on screen. Pass --current (and open the T15 tab first).");
  process.exit(1);
}

function otherHostRunning(): boolean {
  try {
    const probe = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "(Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -like '*win-input-host.ps1*' } | Where-Object { (Get-Process -Id $_.ParentProcessId -ErrorAction SilentlyContinue) }).Count",
      ],
      { timeout: 15_000, encoding: "utf8" },
    );
    return Number(String(probe.stdout ?? "0").trim()) > 0;
  } catch {
    return true;
  }
}

function planOnly(texts: Array<{ label: string; text: string }>): void {
  const results = texts.map((entry) => ({
    label: entry.label,
    plan: planWaystoneJuice(entry.text),
  }));
  if (asJson) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  for (const { label, plan } of results) {
    console.log(describeJuicePlan(label, plan));
    console.log("");
  }
  const auto = results.filter((entry) => entry.plan.autoEligible).length;
  console.log(`${results.length} item(s) planned — ${auto} auto-eligible T15 juice step(s).`);
}

const fromFile = value("--from-file");
if (fromFile) {
  const raw = readFileSync(path.resolve(fromFile), "utf8");
  const texts: Array<{ label: string; text: string }> = [];
  if (raw.trimStart().startsWith("{")) {
    raw.split(/\r?\n/).forEach((line, index) => {
      if (!line.trim()) return;
      try {
        const parsed = JSON.parse(line) as { text?: string };
        if (parsed.text) texts.push({ label: `line ${index + 1}`, text: parsed.text });
      } catch {
        // skip unparseable lines
      }
    });
  } else {
    raw
      .split(/\r?\n\s*\r?\n\s*\r?\n/)
      .map((block) => block.trim())
      .filter(Boolean)
      .forEach((block, index) => texts.push({ label: `item ${index + 1}`, text: block }));
  }
  planOnly(texts);
  process.exit(0);
}

if (flag("--from-clipboard")) {
  const probe = spawnSync("powershell.exe", ["-NoProfile", "-Command", "Get-Clipboard -Raw"], {
    timeout: 10_000,
    encoding: "utf8",
  });
  const text = String(probe.stdout ?? "").trim();
  if (!text) {
    console.error("Clipboard is empty — copy an item in game first (hover + Ctrl+C).");
    process.exit(1);
  }
  planOnly([{ label: "clipboard item", text }]);
  process.exit(0);
}

if (live && otherHostRunning()) {
  console.error(
    "Another win-input-host is running (sorting test / app / daemon). Live juicing refuses to share the mouse — run dry, or stop the other automation first.",
  );
  process.exit(1);
}

const profile = loadProfile(templateDir);
if (!profile.bagGrid) {
  console.error("No calibrated bag grid — calibrate under Tools → Calibration first.");
  process.exit(1);
}
if (!profile.stashGrid && !profile.quadStashGrid) {
  console.error("No calibrated stash grid — calibrate under Tools → Calibration first.");
  process.exit(1);
}

const bag = profile.bagGrid;
const bagCols = bag.cols || BAG_CELLS.cols;
const bagRows = bag.rows || BAG_CELLS.rows;

interface ScreenGrid {
  topLeft: { x: number; y: number };
  bottomRight: { x: number; y: number };
}

interface CellRead {
  row: number;
  col: number;
  x: number;
  y: number;
  text: string;
}

interface OrbStack {
  id: OrbId;
  cell: CellRead;
  count: number;
}

function markToScreen(clientLeft: number, clientTop: number, mark: GridMark): ScreenGrid {
  return markToScreenGrid(clientLeft, clientTop, mark);
}

const host = startWinHost({ requestTimeoutMs: 45_000 });
const controlHost = startWinHost({ requestTimeoutMs: 10_000 });
const harness = new SortHarness(host, controlHost, { outDir, dryRun: !live, fast: true });
mkdirSync(outDir, { recursive: true });
const journalFile = path.join(outDir, "juice-journal.jsonl");

function journal(record: JuiceStepRecord): void {
  try {
    appendFileSync(journalFile, `${JSON.stringify(record)}\n`);
  } catch {
    // journaling must never abort a juice session
  }
}

async function resolveClient(): Promise<{ left: number; top: number }> {
  const rect = await host.send({ op: "rect" });
  if (!rect.ok) throw new Error("poe-window-not-found");
  const probeFile = path.join(outDir, `juice-probe-${Date.now()}.bmp`);
  const captured = await host.send({ op: "capture", path: probeFile });
  if (!captured.ok) throw new Error(String(captured.error ?? "capture-failed"));
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
  return { left: client.left, top: client.top };
}

async function confirmPanels(facts?: {
  stashOpen: boolean;
  invOpen: boolean;
  occupiedStash: Array<{ row: number; col: number }>;
  stashGridSize?: { cols: number; rows: number };
}): Promise<{
  stashOpen: boolean;
  invOpen: boolean;
  mapsSpecialty: boolean;
  chromeFailed: boolean;
}> {
  let stashOpen = facts?.stashOpen === true;
  let invOpen = facts?.invOpen === true;
  if (!stashOpen || !invOpen) {
    const stashBand = await host.send({ op: "ocr", left: 450, top: 100, width: 700, height: 110 });
    const invBand = await host.send({ op: "ocr", left: 2900, top: 100, width: 800, height: 110 });
    if (stashOpenFromOcr(String(stashBand.text ?? ""))) stashOpen = true;
    if (inventoryOpenFromOcr(String(invBand.text ?? ""))) invOpen = true;
  }
  const mapsBand = await host.send({ op: "ocr", left: 20, top: 150, width: 1350, height: 420 });
  const mapsText = String(mapsBand.text ?? "");
  const mapsSpecialty = mapsSpecialtyFromOcr(mapsText);
  const chromeFailed = facts?.stashGridSize?.cols === 24 && (facts.occupiedStash.length ?? 0) > 200;
  console.log(
    `panels stash=${stashOpen} bag=${invOpen} maps=${mapsSpecialty} chromeFailed=${chromeFailed}` +
      (mapsText.trim() ? ` · maps OCR "${mapsText.replace(/\s+/g, " ").slice(0, 80)}"` : " · maps OCR empty"),
  );
  return { stashOpen, invOpen, mapsSpecialty, chromeFailed };
}

async function perceivePanels(): Promise<{
  stashOpen: boolean;
  invOpen: boolean;
  occupiedStash: Array<{ row: number; col: number }>;
  stashGridSize?: { cols: number; rows: number };
} | undefined> {
  try {
    const rect = await host.send({ op: "rect" });
    if (!rect.ok) return undefined;
    const probeFile = path.join(outDir, `juice-check-${Date.now()}.bmp`);
    const captured = await host.send({ op: "capture", path: probeFile });
    if (!captured.ok) return undefined;
    const { readBmpBgr, bgrToGray } = await import("../src/adapters/bmp.js");
    const { perceiveUi } = await import("../src/core/uiPerception.js");
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
    const facts = perceiveUi(bgrToGray(bgr), client, {}, profile, bgr);
    return {
      stashOpen: facts.stashPanelOpen === true,
      invOpen: facts.inventoryPanelOpen === true,
      occupiedStash: facts.occupiedStash.map((cell) => ({ row: cell.row, col: cell.col })),
      stashGridSize: facts.stashGridSize,
    };
  } catch {
    return undefined;
  }
}

async function sweepCells(
  grid: ScreenGrid,
  cols: number,
  rows: number,
  cells: Array<{ row: number; col: number }>,
  label: string,
  opts: { hoverMs?: number; copyWaitMs?: number; fast?: boolean } = {},
): Promise<CellRead[]> {
  const hoverMs = opts.hoverMs ?? 55;
  const copyWaitMs = opts.copyWaitMs ?? 160;
  const fast = opts.fast ?? true;
  const reads: CellRead[] = [];
  const byRow = new Map<number, Array<{ row: number; col: number }>>();
  for (const cell of cells) {
    const list = byRow.get(cell.row) ?? [];
    list.push(cell);
    byRow.set(cell.row, list);
  }
  for (const row of [...byRow.keys()].sort((a, b) => a - b)) {
    await harness.checkpoint(label);
    const targets = (byRow.get(row) ?? []).sort((a, b) => a.col - b.col);
    const points = targets.map((cell) => cellCenterTwoCorner(grid, cell.col, cell.row, cols, rows));
    const sentinel = `poe2-juice-sweep-${Date.now()}-${row}`;
    const reply = await host.send({ op: "copysweep", points, hoverMs, copyWaitMs, fast, sentinel });
    const texts = Array.isArray(reply.texts) ? (reply.texts as string[]) : [];
    points.forEach((point, index) => {
      const text = texts[index] ?? "";
      const cell = targets[index]!;
      if (text && /Item Class:/i.test(text)) {
        reads.push({ row: cell.row, col: cell.col, x: point.x, y: point.y, text });
      }
    });
  }
  return reads;
}

function allCells(cols: number, rows: number): Array<{ row: number; col: number }> {
  const cells: Array<{ row: number; col: number }> = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) cells.push({ row, col });
  }
  return cells;
}

function findOrbStacks(reads: CellRead[]): OrbStack[] {
  const stacks: OrbStack[] = [];
  for (const read of reads) {
    const parsed = parseItemText(read.text);
    if (!/currency/i.test(parsed.itemClass)) continue;
    const entry = (Object.entries(ORB_NAMES) as Array<[OrbId, string]>).find(
      ([, name]) =>
        name.toLowerCase() === parsed.baseType.toLowerCase() ||
        name.toLowerCase() === parsed.name.toLowerCase(),
    );
    if (!entry) continue;
    stacks.push({ id: entry[0], cell: read, count: currencyStackCount(read.text) });
  }
  return stacks;
}

function flattenBatchPoints(
  waystones: CellRead[],
  clicks: JuiceBatchTarget[],
): Array<{ x: number; y: number; row: number; col: number }> {
  const byCell = new Map(waystones.map((read) => [`${read.row},${read.col}`, read]));
  const points: Array<{ x: number; y: number; row: number; col: number }> = [];
  for (const click of clicks) {
    const cell = byCell.get(`${click.row},${click.col}`);
    if (!cell) continue;
    for (let slam = 0; slam < click.slams; slam += 1) {
      points.push({ x: cell.x, y: cell.y, row: cell.row, col: cell.col });
    }
  }
  return points;
}

async function applyOrbBatch(
  pickups: Array<{ x: number; y: number; count: number }>,
  points: Array<{ x: number; y: number }>,
  putBack: boolean,
  label: string,
  expect: string,
  probe?: { x: number; y: number },
): Promise<{ count: number; emptyCursor: boolean; heldWaystone: boolean; verified: number }> {
  if (points.length === 0 || pickups.length === 0) {
    return { count: 0, emptyCursor: false, heldWaystone: false, verified: 0 };
  }
  await harness.checkpoint(label);
  const reply = await host.send({
    op: "orbbatch",
    pickups,
    points,
    putBack,
    shift: true,
    gapMs: 65,
    pickupMs: 120,
    expect,
    probeX: probe?.x,
    probeY: probe?.y,
  });
  return {
    count: Math.max(0, Number(reply.count ?? 0)),
    emptyCursor: reply.emptyCursor === true || reply.emptyCursor === "True",
    heldWaystone: reply.heldWaystone === true || reply.heldWaystone === "True",
    verified: Math.max(0, Number(reply.verified ?? 0)),
  };
}

async function parkHeldWaystone(slot: { row: number; col: number; x: number; y: number }): Promise<void> {
  await harness.checkpoint("bag drop held waystone");
  await harness.click(slot.x, slot.y, `drop held waystone in bag r${slot.row}c${slot.col}`);
  await harness.sleep(70, false);
  await harness.checkpoint("ctrl-click held waystone into maps");
  await host.send({ op: "ctrlclick", x: slot.x, y: slot.y });
  await harness.sleep(90, false);
}

async function returnToTier15(origin: { left: number; top: number }): Promise<void> {
  await harness.checkpoint("return to T15 XV");
  await host.send({
    op: "click",
    x: origin.left + MAPS_TIER15_CLICK.x,
    y: origin.top + MAPS_TIER15_CLICK.y,
  });
  await harness.sleep(80, false);
}

function summarizeOrbs(stacks: OrbStack[]): string {
  return stacks.map((stack) => `${stack.count}× ${ORB_NAMES[stack.id]}`).join(", ") || "none";
}

let exitCode = 0;
try {
  const rect = await host.send({ op: "rect" });
  if (!rect.ok) throw new Error("poe-window-not-found — is Path of Exile 2 running?");
  await host.send({ op: "focus" });
  harness.startKeyListener();
  console.log(
    `juice-maps ${live ? "LIVE" : "DRY-RUN"} · current stash tab · max ${maxMaps} map(s) / ${maxSteps} step(s)` +
      " — numpad: 5 pause · 0 stop",
  );
  console.log(`calibration ${templateDir}`);

  const facts = await perceivePanels();
  const panels = await confirmPanels(facts);
  if (!panels.stashOpen) {
    throw new Error(
      "stash-and-bag-required — open your T15 stash tab and inventory before juicing (--current will not click the tab strip).",
    );
  }
  if (!panels.invOpen) {
    console.log("bag chrome/OCR uncertain — will confirm by reading bag cells");
  }

  const origin = await resolveClient();
  const mapsGrid = mapsStashGrid(profile);
  const useMapsGrid = Boolean(mapsGrid) && (panels.mapsSpecialty || panels.chromeFailed);
  if ((panels.mapsSpecialty || panels.chromeFailed) && !mapsGrid) {
    throw new Error(
      "maps-grid-uncalibrated — open Tools → Calibration, screenshot the Maps tab, and draw Maps around the waystone wells only (not the T1–T16 strip).",
    );
  }
  const stashMark = useMapsGrid ? mapsGrid : activeStashGrid(profile, facts?.stashGridSize);
  if (!stashMark) throw new Error("stash-grid-unresolved — recalibrate the stash panel.");
  const stashCols = stashMark.cols;
  const stashRows = stashMark.rows;
  const stashGrid = markToScreen(origin.left, origin.top, stashMark);
  const bagGrid = markToScreen(origin.left, origin.top, bag);

  const occupancyMatchesGrid =
    !useMapsGrid &&
    (facts?.occupiedStash.length ?? 0) > 0 &&
    facts?.stashGridSize?.cols === stashCols &&
    facts.stashGridSize.rows === stashRows;
  const stashTargets = occupancyMatchesGrid ? facts!.occupiedStash : allCells(stashCols, stashRows);
  console.log(
    `${useMapsGrid ? "maps" : "stash"} ${stashCols}×${stashRows} · sweeping ${stashTargets.length}`,
  );

  const stashReads = await sweepCells(stashGrid, stashCols, stashRows, stashTargets, "reading stash", {
    hoverMs: 70,
    copyWaitMs: 280,
    fast: false,
  });
  const bagReads = await sweepCells(bagGrid, bagCols, bagRows, allCells(bagCols, bagRows), "reading bag", {
    hoverMs: 70,
    copyWaitMs: 220,
    fast: false,
  });
  if (bagReads.length === 0 && !panels.invOpen) {
    throw new Error(
      "stash-and-bag-required — inventory did not copy any items. Open the bag and keep Path of Exile focused.",
    );
  }
  const orbStacks = findOrbStacks(bagReads);
  const occupiedBag = new Set(bagReads.map((read) => `${read.row},${read.col}`));
  const emptyBagSlots = allCells(bagCols, bagRows)
    .filter((cell) => !occupiedBag.has(`${cell.row},${cell.col}`))
    .map((cell) => {
      const point = cellCenterTwoCorner(bagGrid, cell.col, cell.row, bagCols, bagRows);
      return { ...cell, x: point.x, y: point.y };
    });
  const waystones = stashReads.filter((read) => isWaystoneClass(parseItemText(read.text).itemClass));
  const alreadyCorrupted = waystones.filter((read) => inspectWaystone(parseItemText(read.text)).corrupted).length;
  const juiceable = waystones.filter((read) => planWaystoneJuice(read.text).autoEligible);
  const planned = planJuiceFromScan(waystones);
  const alchemyRerolls = waystones.filter((read) => {
    const plan = planWaystoneJuice(read.text);
    return plan.action === "alchemy" && /^magic$/i.test(plan.inspection.rarity);
  }).length;

  console.log(
    `stash: ${stashReads.length} readable cell(s) — ${waystones.length} waystone(s), ` +
      `${alreadyCorrupted} already corrupted, ${alchemyRerolls} weak magic(s) queued for Alchemy reroll, ` +
      `${juiceable.length} T15 juice candidate(s), bag orbs: ${summarizeOrbs(orbStacks)}, ` +
      `${emptyBagSlots.length} empty bag cell(s) for Vaal ejects`,
  );
  console.log(
    `scan complete — one sweep · ${planned.alchemy.length} Alchemy, ${planned.regal.length} Regal, ` +
      `${planned.exalt.length} maps × 3 Exalts, ${planned.vaal.length} Vaal. No re-reads.`,
  );

  const touched = new Set<string>();
  let stepsTaken = 0;
  let mapsTouched = 0;

  const noteTouch = (row: number, col: number): boolean => {
    const key = `${row},${col}`;
    if (!touched.has(key)) {
      if (mapsTouched >= maxMaps) return false;
      touched.add(key);
      mapsTouched += 1;
    }
    return true;
  };

  const journalClick = (cell: CellRead, phase: JuiceBatchPhase, slams: number): void => {
    const plan: JuicePlan = planWaystoneJuice(cell.text);
    const parsed = parseItemText(cell.text);
    for (let i = 0; i < slams; i += 1) {
      journal({
        at: new Date().toISOString(),
        cell: { row: cell.row, col: cell.col },
        action: phase,
        orb: juiceOrbForPhase(phase),
        score: plan.score,
        rewardTags: plan.inspection.rewardTags,
        dangerTags: plan.inspection.dangerTags,
        itemName: parsed.name || parsed.baseType,
        itemClass: parsed.itemClass,
        tier: plan.inspection.tier,
        affixCount: plan.inspection.explicitAffixCount,
        dryRun: !live,
      });
    }
  };

  const syncStacks = (id: ReturnType<typeof juiceOrbForPhase>, working: Array<{ count: number }>): void => {
    const refs = orbStacks.filter((stack) => stack.id === id);
    refs.forEach((stack, index) => {
      if (working[index] != null) stack.count = working[index]!.count;
    });
  };

  for (const phase of JUICE_BATCH_PHASES) {
    if (stepsTaken >= maxSteps) {
      console.log(`session step cap (${maxSteps}) reached — stopping.`);
      break;
    }
    const orbId = juiceOrbForPhase(phase);
    const targets = planned[phase].filter((target) => noteTouch(target.row, target.col));
    console.log(`phase ${phase}: ${targets.length} stone(s) · ${summarizeOrbs(orbStacks.filter((stack) => stack.id === orbId)) || `no ${ORB_NAMES[orbId]}`}`);
    if (targets.length === 0) continue;

    if (phase === "vaal") {
      let remaining = targets.filter((target) => waystones.some((read) => read.row === target.row && read.col === target.col));
      for (const target of remaining) {
        const cell = waystones.find((read) => read.row === target.row && read.col === target.col);
        if (!cell) continue;
        console.log(describeJuicePlan(`stash r${cell.row}c${cell.col} ${planWaystoneJuice(cell.text).inspection.name}`, planWaystoneJuice(cell.text)));
      }
      if (!live) {
        console.log(`    DRY-RUN: would Shift-Vaal ${remaining.length} stone(s); bag+ctrl-click only when the well is empty.`);
        stepsTaken += remaining.length;
        continue;
      }
      let stillCleanStrikes = 0;
      while (remaining.length > 0 && stepsTaken < maxSteps) {
        const vaalRefs = orbStacks.filter((stack) => stack.id === "vaal" && stack.count > 0);
        if (vaalRefs.length === 0) {
          console.log("    no Vaal Orb in the bag — stopping the Vaal batch.");
          break;
        }
        const points = remaining
          .map((target) => waystones.find((read) => read.row === target.row && read.col === target.col))
          .filter((cell): cell is CellRead => Boolean(cell))
          .map((cell) => ({ x: cell.x, y: cell.y, row: cell.row, col: cell.col }));
        const pickups = vaalRefs.map((stack) => ({ x: stack.cell.x, y: stack.cell.y, count: stack.count }));
        await harness.checkpoint(`vaalburst ${points.length}`);
        const probe = emptyBagSlots[0];
        const reply = await host.send({
          op: "vaalburst",
          pickups,
          points,
          gapMs: 70,
          hoverMs: 70,
          copyWaitMs: 280,
          pickupMs: 120,
          retries: 3,
          fast: false,
          expect: ORB_NAMES.vaal,
          probeX: probe?.x,
          probeY: probe?.y,
        });
        const applied = Math.max(0, Number(reply.applied ?? 0));
        const ejected = reply.ejected === true || reply.ejected === "True";
        const stillClean = reply.stillClean === true || reply.stillClean === "True" || reply.failed === true || reply.failed === "True";
        const pickupIndex = Number(reply.pickupIndex ?? -1);
        const stackLeft = Math.max(0, Number(reply.stackLeft ?? 0));
        if (pickupIndex >= 0) {
          vaalRefs.forEach((stack, index) => {
            if (index < pickupIndex) stack.count = 0;
            if (index === pickupIndex) stack.count = stackLeft;
          });
        }
        const done = remaining.slice(0, applied);
        for (const target of done) {
          const cell = waystones.find((read) => read.row === target.row && read.col === target.col);
          if (cell) journalClick(cell, phase, 1);
        }
        stepsTaken += applied;
        remaining = remaining.slice(applied);
        if (stillClean) {
          const stuck = remaining[0];
          stillCleanStrikes += 1;
          console.log(
            `    VAAL ${applied} corrupted in well · r${stuck?.row ?? "?"}c${stuck?.col ?? "?"} still clean after 3 clicks — retry ${stillCleanStrikes}`,
          );
          if (stillCleanStrikes >= 2 && remaining.length > 0) {
            console.log(`    skipping r${stuck?.row}c${stuck?.col} — Ctrl+C never saw Corrupted`);
            remaining = remaining.slice(1);
            stillCleanStrikes = 0;
          }
          continue;
        }
        stillCleanStrikes = 0;
        if (applied === 0) {
          console.log("    Vaal burst applied nothing — stopping.");
          break;
        }
        if (!ejected) {
          console.log(`    VAAL ${applied} corrupted in well (Ctrl+C saw Corrupted) — no bag`);
          if (remaining.length === 0) break;
          const stillHaveVaals = orbStacks.some((stack) => stack.id === "vaal" && stack.count > 0);
          if (!stillHaveVaals) {
            console.log(`    ${remaining.length} well(s) left but no Vaal Orb — stopping.`);
            break;
          }
          console.log(`    ${remaining.length} well(s) still queued — continuing`);
          continue;
        }
        const slot = emptyBagSlots[0];
        if (!slot) {
          console.log("    Vaal left a stone on the cursor, but the bag is full — stopping.");
          break;
        }
        emptyBagSlots.shift();
        const held = done[done.length - 1];
        console.log(
          `    well empty after Vaal r${held?.row ?? "?"}c${held?.col ?? "?"} — held on cursor, bag r${slot.row}c${slot.col}, ctrl-click, next Vaal`,
        );
        if (held) {
          const cell = waystones.find((read) => read.row === held.row && read.col === held.col);
          if (cell) {
            const plan = planWaystoneJuice(cell.text);
            journal({
              at: new Date().toISOString(),
              cell: { row: cell.row, col: cell.col },
              action: "vaal",
              orb: "vaal",
              score: plan.score,
              rewardTags: plan.inspection.rewardTags,
              dangerTags: plan.inspection.dangerTags,
              itemName: plan.inspection.name,
              itemClass: parseItemText(cell.text).itemClass,
              tier: plan.inspection.tier,
              affixCount: plan.inspection.explicitAffixCount,
              dryRun: false,
              parked: true,
            });
          }
        }
        await parkHeldWaystone(slot);
        await returnToTier15(origin);
      }
      console.log("");
      continue;
    }

    const available = orbStacks.filter((stack) => stack.id === orbId).reduce((sum, stack) => sum + stack.count, 0);
    const alloc = allocateOrbClicks(available, targets);
    if (alloc.clicks.length === 0) {
      console.log(`    no ${ORB_NAMES[orbId]} left — skipping the ${phase} batch.`);
      continue;
    }
    const points = flattenBatchPoints(waystones, alloc.clicks);
    if (points.length === 0) continue;
    for (const click of alloc.clicks) {
      const cell = waystones.find((read) => read.row === click.row && read.col === click.col);
      if (!cell) continue;
      console.log(describeJuicePlan(`stash r${cell.row}c${cell.col} ${planWaystoneJuice(cell.text).inspection.name}`, planWaystoneJuice(cell.text)));
      journalClick(cell, phase, click.slams);
    }
    const working = orbStacks
      .filter((stack) => stack.id === orbId)
      .map((stack) => ({ count: stack.count, x: stack.cell.x, y: stack.cell.y }));
    const taken = takePickups(working, points.length);
    syncStacks(orbId, working);
    stepsTaken += taken.used;
    if (!live) {
      console.log(
        `    DRY-RUN: would Shift-batch ${taken.used}× ${ORB_NAMES[orbId]} across ${alloc.clicks.length} stone(s)` +
          (taken.putBack ? " · leftover stays on the last stack" : " · stacks would empty (no put-back)"),
      );
      continue;
    }
    console.log(
      `    BATCH ${taken.used}× ${ORB_NAMES[orbId]} on ${alloc.clicks.length} stone(s) · Shift held` +
        (taken.putBack ? " · leftover put back" : " · stacks empty, no put-back"),
    );
    let pending = points.slice(0, taken.used);
    let pickupQueue = taken.pickups;
    while (pending.length > 0 && pickupQueue.length > 0) {
      const batch = await applyOrbBatch(
        pickupQueue,
        pending,
        taken.putBack,
        `batch ${pending.length}× ${ORB_NAMES[orbId]}`,
        ORB_NAMES[orbId],
        emptyBagSlots[0],
      );
      if (batch.verified > 0) {
        console.log(`    ${batch.verified} well(s) still had a waystone after the slam`);
      }
      if (!batch.heldWaystone) break;
      const slot = emptyBagSlots[0];
      if (!slot) {
        console.log("    a waystone was on the cursor, but the bag is full — stopping this phase.");
        break;
      }
      emptyBagSlots.shift();
      console.log(`    empty-orb click picked up a waystone — parking in bag r${slot.row}c${slot.col}, then next pile`);
      await parkHeldWaystone(slot);
      await returnToTier15(origin);
      pending = pending.slice(batch.count);
      pickupQueue = pickupQueue.slice(1);
    }
    console.log("");
  }
  await harness.dispose({ outcome: "complete", stepsTaken, live, mapsTouched });
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
