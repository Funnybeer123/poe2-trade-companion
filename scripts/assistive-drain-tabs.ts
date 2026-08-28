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
  profile: () => loadProfile(templateDir),
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
  return service.start({
    kind,
    dryRun: false,
    wantedClasses: [],
    uniqueAcrossCycles: false,
    qaAcknowledged: true,
    allowlist,
    actionsPerMinute: Number(process.env.POE2_ACTIONS_PER_MINUTE ?? 240),
  });
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

let sweepPass = 0;

async function sweepSourceIntoBag(): Promise<number> {
  const rect = await nav.send({ op: "rect", });
  if (!rect.ok) throw new Error("target-window-missing");
  const left = Number(rect.left);
  const top = Number(rect.top);
  // Stagger alternate passes by half a step so slot centers a fixed lattice
  // straddles still get hit on the next pass.
  const offset = sweepPass % 2 === 0 ? 0 : Math.floor(SWEEP_STEP / 2);
  sweepPass += 1;
  const points: Array<{ x: number; y: number }> = [];
  for (let y = SWEEP_BOX.y + offset; y < SWEEP_BOX.y + SWEEP_BOX.h; y += SWEEP_STEP) {
    for (let x = SWEEP_BOX.x + offset; x < SWEEP_BOX.x + SWEEP_BOX.w; x += SWEEP_STEP) {
      points.push({ x: left + x, y: top + y });
    }
  }
  await nav.send({ op: "focus" });
  await sleep(250);
  for (let i = 0; i < points.length; i += 40) {
    const burst = await nav.send({ op: "ctrlburst", points: points.slice(i, i + 40) });
    if (!burst.ok) throw new Error(`sweep-burst-failed:${burst.error}`);
    await sleep(120);
  }
  await sleep(400);
  const probeFile = path.join(root, "artifacts", "assistive-cli", `sweep-${Date.now()}.bmp`);
  const captured = await nav.send({ op: "capture", path: probeFile });
  if (!captured.ok) return -1;
  const { readBmpBgr, bgrToGray } = await import("../src/adapters/bmp.js");
  const { rmSync } = await import("node:fs");
  const { perceiveUi } = await import("../src/core/uiPerception.js");
  const { resolvePhysicalClient } = await import("../src/core/screenLayout.js");
  const bgr = readBmpBgr(probeFile);
  rmSync(probeFile, { force: true });
  const client = resolvePhysicalClient(
    { left: Number(captured.left), top: Number(captured.top), width: Number(captured.width), height: Number(captured.height) },
    Number(rect.monitorWidth) || Number(captured.width),
    Number(rect.monitorHeight) || Number(captured.height),
    { left: Number(rect.monitorLeft ?? 0), top: Number(rect.monitorTop ?? 0) },
  );
  const facts = perceiveUi(bgrToGray(bgr), client, {}, loadProfile(templateDir), bgr);
  return facts.occupiedBag.length;
}

try {
  const rect = await nav.send({ op: "rect" });
  if (!rect.ok) throw new Error("PoE window not found");

  let totalTrips = 0;
  const stats = new Map<string, DrainStats>();
  const overflowQueue = [...overflow];

  for (const pair of pairs) {
    let dest = pair.dest;
    const key = `${pair.source}->${dest}`;
    const stat: DrainStats = { trips: 0, cellsMoved: 0 };
    stats.set(key, stat);
    console.log(`\n=== drain #${pair.source} "${canonical[pair.source]}" -> #${dest} "${canonical[dest]}" ===`);
    let bagAfterDeposit = 0;
    let noGainPasses = 0;
    for (;;) {
      if (totalTrips >= maxTrips) {
        console.log("trip budget exhausted");
        break;
      }
      await gotoTab(pair.source);
      let bagCells: number;
      let fillReason = "sweep";
      if (sweepMode) {
        bagCells = await sweepSourceIntoBag();
        if (bagCells < 0) {
          console.log("sweep probe capture failed");
          break;
        }
        if (bagCells - bagAfterDeposit <= 0) {
          noGainPasses += 1;
          // Two consecutive empty passes (both lattice phases) means done.
          if (noGainPasses >= 2) {
            console.log(`sweep gained nothing twice (bag ${bagCells}) — source drained or remaining items cannot move`);
            break;
          }
          continue;
        }
        noGainPasses = 0;
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
      await gotoTab(dest);
      const empty = await run("empty");
      totalTrips += 1;
      stat.trips += 1;
      const leftover = empty.bagCells ?? 0;
      bagAfterDeposit = leftover;
      stat.cellsMoved += bagCells - leftover;
      console.log(`trip ${stat.trips}: moved ~${bagCells - leftover} cells (leftover ${leftover})`);
      if (leftover > 0) {
        const next = overflowQueue.shift();
        if (next === undefined) {
          console.log("destination full and no overflow tabs left — stopping this pair");
          break;
        }
        console.log(`destination full — switching to overflow tab #${next} "${canonical[next]}"`);
        dest = next;
        await gotoTab(dest);
        const spill = await run("empty");
        if ((spill.bagCells ?? 0) > 0) {
          console.log("overflow tab also refused items — stopping");
          break;
        }
      }
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
