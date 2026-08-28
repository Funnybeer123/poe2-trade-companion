/**
 * Remove-only tab drainer: for each source:dest pair, repeatedly navigates to
 * the source tab (OCR-aligned dropdown click), fills the bag through the
 * audited fill service, navigates to the destination tab, and empties the bag
 * — until the source is empty, the destination stops accepting, or the trip
 * budget runs out. Every transfer goes through the same verified fill/empty
 * pipeline used everywhere else.
 *
 * Usage: npx tsx scripts/assistive-drain-tabs.ts --pairs=3:6,5:6 [--overflow=0,12] [--max-trips=40]
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startWinHost } from "../src/adapters/winHost.js";
import { loadProfile } from "../src/core/calibrationStore.js";
import { resolveBuildMode } from "../src/core/capabilities.js";
import { KillSwitch } from "../src/core/killSwitch.js";
import { alignWindow, snapRows, type ListRow, type OcrLine } from "../src/core/tabList.js";
import { AssistiveRunService } from "../src/main/assistiveRunService.js";
import { readFileSync } from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templateDir = path.join(root, "fixtures", "perception", "templates");

const pairsArg = process.argv.find((arg) => arg.startsWith("--pairs="))?.slice(8);
if (!pairsArg) {
  console.error("Usage: --pairs=SRC:DEST[,SRC:DEST...] [--overflow=IDX,IDX] [--max-trips=N]");
  process.exit(1);
}
const pairs = pairsArg.split(",").map((token) => {
  const [source, dest] = token.split(":").map(Number);
  if (!Number.isInteger(source) || !Number.isInteger(dest)) throw new Error(`bad pair: ${token}`);
  return { source: source!, dest: dest! };
});
const overflow = (process.argv.find((arg) => arg.startsWith("--overflow="))?.slice(11) ?? "")
  .split(",")
  .filter(Boolean)
  .map(Number);
const maxTrips = Number(process.argv.find((arg) => arg.startsWith("--max-trips="))?.slice(12) ?? 60);
const sweepMode = process.argv.includes("--sweep");

const inventoryFile = path.join(root, "artifacts", "tab-survey", "tab-inventory.json");
const inventory = JSON.parse(readFileSync(inventoryFile, "utf8")) as {
  canonical: string[];
  tabs: Array<{ index: number; label: string; removeOnly: boolean }>;
};
const canonical = inventory.canonical;

const LIST_REGION = { left: 1340, top: 180, width: 760, height: 1430 };
const LIST_ROW_X = 1700;
const LIST_CENTER = { x: 1700, y: 800 };
const LIST_TOGGLE = { x: 1259, y: 219 };
const PARK = { x: 660, y: 1900 };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const nav = startWinHost({ requestTimeoutMs: 30_000 });

async function readWindow(): Promise<ListRow[]> {
  await nav.send({ op: "move", x: PARK.x, y: PARK.y });
  await sleep(130);
  const reply = await nav.send({ op: "ocr", ...LIST_REGION });
  if (!reply.ok) return [];
  return snapRows((Array.isArray(reply.lines) ? reply.lines : []) as OcrLine[]);
}

async function gotoTab(index: number): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await nav.send({ op: "wheel", x: LIST_CENTER.x, y: LIST_CENTER.y, steps: 12 });
    await sleep(300);
    let window = await readWindow();
    if (window.length < 5) {
      await nav.send({ op: "click", x: LIST_TOGGLE.x, y: LIST_TOGGLE.y });
      await sleep(700);
      window = await readWindow();
      if (window.length < 5) continue;
    }
    let shift = alignWindow(window, canonical) ?? 0;
    if (index >= shift + window.length) {
      const bottom = window.at(-1)!;
      await nav.send({ op: "click", x: LIST_ROW_X, y: bottom.clickY });
      await sleep(650);
      window = await readWindow();
      const aligned = alignWindow(window, canonical);
      if (aligned === undefined) continue;
      shift = aligned;
    }
    const row = window[index - shift];
    if (!row) continue;
    const clicked = await nav.send({ op: "click", x: LIST_ROW_X, y: row.clickY });
    if (!clicked.ok) continue;
    await sleep(650);
    return;
  }
  throw new Error(`goto-tab-${index}-failed`);
}

const service = new AssistiveRunService({
  mode: resolveBuildMode(process.env.POE2_BUILD_MODE),
  qaOptIn: true,
  killSwitch: new KillSwitch(),
  memoryRoot: root,
  artifactDir: path.join(root, "artifacts", "assistive-cli"),
  // Drains never involve a vendor; the vendor box overlaps the open tab-list
  // dropdown and produces false vendor-open aborts, so suppress it here.
  profile: () => ({ ...loadProfile(templateDir), ventorBagGrid: undefined }),
  onEvent: (event) => {
    if (event.phase === "benchmark" || event.phase === "complete") {
      console.log(`  [${event.phase}] ${event.message}`);
    }
  },
});

const allowlist = (process.env.POE2_PROCESS_ALLOWLIST ?? "PathOfExileSteam.exe,PathOfExile.exe,PathOfExile_x64Steam.exe")
  .split(/[;,]/)
  .map((entry) => entry.trim())
  .filter(Boolean);

async function run(kind: "fill" | "empty") {
  try {
    return await service.start({
      kind,
      dryRun: false,
      wantedClasses: [],
      uniqueAcrossCycles: false,
      qaAcknowledged: true,
      allowlist,
      actionsPerMinute: Number(process.env.POE2_ACTIONS_PER_MINUTE ?? 240),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.log(`  [${kind}] service error: ${reason}`);
    return { ok: false, reason, bagCells: -1, stashCells: -1 } as Awaited<ReturnType<typeof service.start>>;
  }
}

interface DrainStats {
  trips: number;
  cellsMoved: number;
}

/**
 * Specialty tabs (currency/essence/delirium layouts) defeat grid perception,
 * so drain them by ctrl-clicking a lattice of points covering the panel:
 * empty slots are no-ops, every real item transfers to the bag. Progress is
 * judged purely by bag occupancy growth.
 */
const SWEEP_BOX = { x: 40, y: 262, w: 1250, h: 1240 };
const SWEEP_STEP = 56;

async function snapshotFacts() {
  const rect = await nav.send({ op: "rect" });
  if (!rect.ok) throw new Error("target-window-missing");
  const probeFile = path.join(root, "artifacts", "assistive-cli", `sweep-${Date.now()}.bmp`);
  const captured = await nav.send({ op: "capture", path: probeFile });
  if (!captured.ok) throw new Error(String(captured.error ?? "capture-failed"));
  const { readBmpBgr, bgrToGray } = await import("../src/adapters/bmp.js");
  const { rmSync } = await import("node:fs");
  const { perceiveUi } = await import("../src/core/uiPerception.js");
  const { resolvePhysicalClient } = await import("../src/core/screenLayout.js");
  const { occupiedFromRgbScores, scoreGridCellsRgb } = await import("../src/core/cellOccupancy.js");
  const bgr = readBmpBgr(probeFile);
  rmSync(probeFile, { force: true });
  const client = resolvePhysicalClient(
    { left: Number(captured.left), top: Number(captured.top), width: Number(captured.width), height: Number(captured.height) },
    Number(rect.monitorWidth) || Number(captured.width),
    Number(rect.monitorHeight) || Number(captured.height),
    { left: Number(rect.monitorLeft ?? 0), top: Number(rect.monitorTop ?? 0) },
  );
  const frame = bgrToGray(bgr);
  const facts = perceiveUi(frame, client, {}, loadProfile(templateDir), bgr);
  let rgbStash: Array<{ x: number; y: number }> = [];
  if (facts.stashRegion && facts.stashGridSize) {
    rgbStash = occupiedFromRgbScores(
      scoreGridCellsRgb(bgr, client, facts.stashRegion, facts.stashGridSize.cols, facts.stashGridSize.rows),
    );
  }
  let unionBag = facts.occupiedBag.length;
  if (facts.inventoryPanelOpen && facts.inventoryRegion) {
    const { occupiedFromScores, scoreGridCells } = await import("../src/core/itemSprites.js");
    const gray = occupiedFromScores(scoreGridCells(frame, client, facts.inventoryRegion, 12, 5));
    const keys = new Set(facts.occupiedBag.map((cell) => `${cell.row},${cell.col}`));
    for (const cell of gray) keys.add(`${cell.row},${cell.col}`);
    unionBag = keys.size;
  }
  return { facts, client, rgbStash, unionBag };
}

/** A bag report taken while the panel is closed says nothing — reopen and recount. */
async function verifiedBagCount(): Promise<number> {
  let snap = await snapshotFacts();
  if (!snap.facts.inventoryPanelOpen) {
    await nav.send({ op: "focus" });
    await sleep(300);
    await nav.send({ op: "hotkey", keys: "i" });
    await sleep(700);
    snap = await snapshotFacts();
    if (!snap.facts.inventoryPanelOpen) throw new Error("bag-not-visible");
  }
  return snap.unionBag;
}

async function burstWithRetry(points: Array<{ x: number; y: number }>): Promise<void> {
  for (let i = 0; i < points.length; i += 40) {
    const slice = points.slice(i, i + 40);
    let burst = await nav.send({ op: "ctrlburst", points: slice });
    if (!burst.ok && /focus/i.test(String(burst.error ?? ""))) {
      await nav.send({ op: "focus" });
      await sleep(400);
      burst = await nav.send({ op: "ctrlburst", points: slice });
    }
    if (!burst.ok) throw new Error(`sweep-burst-failed:${burst.error}`);
    await sleep(110);
  }
}

/**
 * Targeted first: ctrl-click only cells the classifiers flag as occupied
 * (union of gray and RGB — phantom-tolerant but far smaller than a blind
 * lattice). When a targeted pass stops producing, fall back to staggered
 * lattice passes that also catch anything perception misses entirely.
 */
async function sweepSourceIntoBag(targeted: boolean, latticePhase: number): Promise<number> {
  const before = await snapshotFacts();
  let points: Array<{ x: number; y: number }>;
  const candidates = new Map<string, { x: number; y: number }>();
  for (const cell of before.facts.occupiedStash) candidates.set(`${cell.x},${cell.y}`, { x: cell.x, y: cell.y });
  for (const cell of before.rgbStash) candidates.set(`${cell.x},${cell.y}`, { x: cell.x, y: cell.y });
  if (targeted && candidates.size > 0) {
    points = [...candidates.values()];
  } else {
    const offset = latticePhase % 2 === 0 ? 0 : Math.floor(SWEEP_STEP / 2);
    const left = before.client.left;
    const top = before.client.top;
    points = [];
    for (let y = SWEEP_BOX.y + offset; y < SWEEP_BOX.y + SWEEP_BOX.h; y += SWEEP_STEP) {
      for (let x = SWEEP_BOX.x + offset; x < SWEEP_BOX.x + SWEEP_BOX.w; x += SWEEP_STEP) {
        points.push({ x: left + x, y: top + y });
      }
    }
  }
  await nav.send({ op: "focus" });
  await sleep(250);
  await burstWithRetry(points);
  await sleep(350);
  return verifiedBagCount();
}

try {
  const rect = await nav.send({ op: "rect" });
  if (!rect.ok) throw new Error("PoE window not found");

  let totalTrips = 0;
  let stopAll = false;
  const stats = new Map<string, DrainStats>();
  const overflowQueue = [...overflow];

  for (const pair of pairs) {
    if (stopAll) break;
    let dest = pair.dest;
    const key = `${pair.source}->${dest}`;
    const stat: DrainStats = { trips: 0, cellsMoved: 0 };
    stats.set(key, stat);
    console.log(`\n=== drain #${pair.source} "${canonical[pair.source]}" -> #${dest} "${canonical[dest]}" ===`);
    let bagAfterDeposit = 0;
    let latticeNoGain = 0;
    let latticePhase = 0;
    let targetedNext = true;
    for (;;) {
      if (totalTrips >= maxTrips) {
        console.log("trip budget exhausted");
        break;
      }
      await gotoTab(pair.source);
      let bagCells: number;
      let fillReason = "sweep";
      if (sweepMode) {
        const arrival = await snapshotFacts();
        if (arrival.facts.occupiedStash.length === 0 && arrival.rgbStash.length === 0) {
          console.log("source visibly empty — skipping");
          break;
        }
        const wasTargeted = targetedNext;
        bagCells = await sweepSourceIntoBag(targetedNext, latticePhase);
        if (bagCells - bagAfterDeposit <= 0) {
          if (wasTargeted) {
            // Classifier candidates exhausted — mop up with the blind lattice.
            targetedNext = false;
            continue;
          }
          latticePhase += 1;
          latticeNoGain += 1;
          if (latticeNoGain >= 2) {
            console.log(`sweep exhausted (bag ${bagCells}) — source drained or remaining items cannot move`);
            break;
          }
          continue;
        }
        targetedNext = true;
        latticeNoGain = 0;
      } else {
        const fill = await run("fill");
        if (!fill.ok && fill.reason !== "no-more-auto-fit" && fill.reason !== "bag-full") {
          console.log(`fill stopped: ${fill.reason}`);
          break;
        }
        fillReason = fill.reason;
        bagCells = fill.bagCells ?? 0;
      }
      if (bagCells === 0) {
        console.log(`source empty (${fillReason})`);
        break;
      }
      totalTrips += 1;
      stat.trips += 1;
      // Hard invariant: the bag must reach zero before any new sweep. Deposit
      // into the destination, verify with independent perception, retry, and
      // escalate through overflow tabs; if nothing accepts the rest, stop the
      // whole run rather than churn with a partially full bag.
      const emptyInto = async (tabIndex: number): Promise<number> => {
        await gotoTab(tabIndex);
        await run("empty");
        let count = await verifiedBagCount();
        for (let retry = 0; retry < 2 && count > 0; retry += 1) {
          console.log(`  bag still holds ${count} cells at #${tabIndex} — re-running empty`);
          await run("empty");
          count = await verifiedBagCount();
        }
        return count;
      };
      let leftover = await emptyInto(dest);
      while (leftover > 0) {
        const next = overflowQueue.shift();
        if (next === undefined) {
          console.log(`bag cannot be fully emptied (${leftover} cells stuck) — stopping the run`);
          stopAll = true;
          break;
        }
        console.log(`destination full — overflowing to #${next} "${canonical[next]}"`);
        leftover = await emptyInto(next);
        if (leftover === 0) {
          // This tab absorbed everything: future trips go straight here, and
          // it stays available as overflow for later pairs.
          dest = next;
          overflowQueue.unshift(next);
        }
      }
      stat.cellsMoved += bagCells - leftover;
      console.log(`trip ${stat.trips}: moved ~${bagCells - leftover} cells (bag now ${leftover})`);
      if (stopAll) break;
      bagAfterDeposit = 0;
      if (fillReason === "source-empty") {
        console.log("source empty");
        break;
      }
    }
  }

  console.log("\n=== drain summary ===");
  for (const [key, stat] of stats) {
    console.log(`${key}: ${stat.trips} trips, ~${stat.cellsMoved} cells moved`);
  }
} finally {
  await nav.close();
}
