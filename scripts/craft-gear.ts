/**
 * Crafting runner — plans (and, when explicitly armed, applies) value crafts
 * on the items sitting in the player bag.
 *
 *   npx tsx scripts/craft-gear.ts                     # dry-run against the live bag
 *   npx tsx scripts/craft-gear.ts --from-clipboard    # plan one copied item, no game input
 *   npx tsx scripts/craft-gear.ts --from-file=items.txt
 *   npx tsx scripts/craft-gear.ts --live              # ALSO needs POE2_CRAFT_LIVE=1
 *
 * Flags: --budget=N (ex per item), --min-confidence=N, --max-steps=N,
 *        --json (machine-readable plans on stdout)
 *
 * Craft-to-sell loop (docs/CRAFTING.md "Craft-to-sell loop"):
 *   --from-tab=<label>  withdraw that stash tab (the sorter's Craft tab) into
 *                       the bag first — indexed by Ctrl+C ground truth,
 *                       withdrawn verified-serial; dry-run only reports.
 *   --then-list         after the crafting pass, hand the bag to
 *                       scripts/shop-buckets.ts (dry-run unless THIS run is
 *                       live) — only once this script's input host is closed
 *                       and no other host is running.
 *
 * Safety model (see docs/CRAFTING.md):
 *   - Dry-run is the default. Live mode needs BOTH --live and
 *     POE2_CRAFT_LIVE=1, and refuses to start while another input host is
 *     running (e.g. the sorting automation under test).
 *   - Only additive orbs are ever applied unattended (transmute, augment,
 *     regal, exalt) and only when the plan's confidence clears the gate.
 *     Chaos/annul/divine/vaal are printed as recommendations, never clicked.
 *   - Numpad 5 pauses, numpad 0 stops. Ctrl+Shift+Esc latches the host.
 *   - Every applied step re-reads the item (Ctrl+C) and re-plans before the
 *     next orb; every step lands in artifacts/crafting/craft-journal.jsonl.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { startWinHost } from "../src/adapters/winHost.js";
import { SortHarness, SortStop } from "../src/adapters/sortHarness.js";
import { GearSorter } from "../src/adapters/gearSorter.js";
import { StashTabKit } from "../src/adapters/stashTabKit.js";
import { packTripByDest, type IdentifiedItem } from "../src/core/gearSort.js";
import { labelsEqualFolded } from "../src/core/tabList.js";
import { loadProfile } from "../src/core/calibrationStore.js";
import { BAG_CELLS } from "../src/core/calibrationProfile.js";
import { cellCenterTwoCorner } from "../src/core/gridMath.js";
import { resolvePhysicalClient } from "../src/core/screenLayout.js";
import {
  DEFAULT_CRAFT_POLICY,
  ORB_NAMES,
  planCraft,
  type CraftPlan,
  type CraftStepRecord,
  type OrbId,
} from "../src/core/crafting.js";
import { parseItemText } from "../src/core/parseItem.js";
import { loadTriageExport } from "../src/adapters/triageLoader.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templateDir = path.join(root, "fixtures", "perception", "templates");
const outDir = path.join(root, "artifacts", "crafting");

const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(name);
const value = (name: string): string | undefined =>
  argv.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);

const liveRequested = flag("--live") && !flag("--dry-run");
const live = liveRequested && process.env.POE2_CRAFT_LIVE === "1";
const asJson = flag("--json");
const fromTab = value("--from-tab")?.trim();
const thenList = flag("--then-list");
const maxSteps = Math.max(1, Number(value("--max-steps") ?? 40));
const policy = {
  ...DEFAULT_CRAFT_POLICY,
  ...(value("--budget") ? { perItemBudget: Number(value("--budget")) } : {}),
  ...(value("--min-confidence") ? { minAutoConfidence: Number(value("--min-confidence")) } : {}),
};

if (liveRequested && !live) {
  console.error("--live also requires POE2_CRAFT_LIVE=1 in the environment. Refusing.");
  process.exit(1);
}

/**
 * Another running input host means another automation (the sorting test, the
 * app, the action daemon) owns the game window. Live crafting must never
 * fight it for the mouse.
 */
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
    return true; // cannot verify → assume busy, stay safe
  }
}

// The app's price table export (artifacts/tab-admin/triage.json) with the
// legacy placeholders stripped and the newest feed snapshot merged, so orb
// costs are the real rates — src/adapters/triageLoader.ts.
const priceTable = loadTriageExport(root, { log: () => undefined }).priceTable;

function describePlan(label: string, plan: CraftPlan): string {
  const head =
    `${label}: ${plan.action.toUpperCase()}` +
    (plan.orb ? ` (${ORB_NAMES[plan.orb]}, ${plan.cost} ex)` : "") +
    ` · confidence ${plan.confidence} (${plan.band})` +
    ` · EV ${plan.expectedProfit >= 0 ? "+" : ""}${plan.expectedProfit} ex` +
    ` · est. value ${plan.estimatedValue} ex` +
    (plan.autoEligible ? " · AUTO" : " · manual");
  return [head, ...plan.reasons.map((reason) => `    ${reason}`)].join("\n");
}

function planOnly(texts: Array<{ label: string; text: string }>): void {
  const results = texts.map((entry) => ({
    label: entry.label,
    plan: planCraft(entry.text, { priceTable, policy }),
  }));
  if (asJson) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  for (const { label, plan } of results) {
    console.log(describePlan(label, plan));
    console.log("");
  }
  const auto = results.filter((entry) => entry.plan.autoEligible).length;
  console.log(
    `${results.length} item(s) planned — ${auto} auto-eligible at confidence ≥ ${policy.minAutoConfidence}.`,
  );
}

// ---------------------------------------------------------------------------
// Offline modes: no host, no game, zero input.
// ---------------------------------------------------------------------------

const fromFile = value("--from-file");
if (fromFile) {
  const raw = readFileSync(path.resolve(fromFile), "utf8");
  // Items separated by blank-line runs of 2+ or JSONL with {text} records.
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

// ---------------------------------------------------------------------------
// Game mode: sweep the bag, plan every item, optionally apply.
// ---------------------------------------------------------------------------

if (live && otherHostRunning()) {
  console.error(
    "Another win-input-host is running (sorting test / app / daemon). Live crafting refuses to share the mouse — run dry, or stop the other automation first.",
  );
  process.exit(1);
}

const profile = loadProfile(templateDir);
if (!profile.bagGrid) {
  console.error("No calibrated bag grid — calibrate under Tools → Calibration first.");
  process.exit(1);
}
const bag = profile.bagGrid;
const cols = bag.cols || BAG_CELLS.cols;
const rows = bag.rows || BAG_CELLS.rows;

/**
 * Calibration boxes are client-relative; hovers need physical screen
 * coordinates. One capture resolves the DPI-scaled client origin (the same
 * dance every other live script does) — live testing caught this the first
 * time the sweep silently hovered the wrong screen region.
 */
interface ScreenGrid {
  topLeft: { x: number; y: number };
  bottomRight: { x: number; y: number };
}

async function resolveScreenGrid(): Promise<ScreenGrid> {
  const rect = await host.send({ op: "rect" });
  if (!rect.ok) throw new Error("poe-window-not-found");
  const probeFile = path.join(outDir, `craft-probe-${Date.now()}.bmp`);
  const captured = await host.send({ op: "capture", path: probeFile });
  if (!captured.ok) throw new Error(String(captured.error ?? "capture-failed"));
  const { rmSync } = await import("node:fs");
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
  return {
    topLeft: { x: client.left + bag.x, y: client.top + bag.y },
    bottomRight: { x: client.left + bag.x + bag.w, y: client.top + bag.y + bag.h },
  };
}

interface BagRead {
  row: number;
  col: number;
  x: number;
  y: number;
  text: string;
}

const host = startWinHost({ requestTimeoutMs: 45_000 });
const controlHost = startWinHost({ requestTimeoutMs: 10_000 });
const harness = new SortHarness(host, controlHost, { outDir, dryRun: !live, fast: true });
mkdirSync(outDir, { recursive: true });
const journalFile = path.join(outDir, "craft-journal.jsonl");

function journal(record: CraftStepRecord): void {
  try {
    appendFileSync(journalFile, `${JSON.stringify(record)}\n`);
  } catch {
    // journaling must never abort a craft session
  }
}

async function copyItemAt(x: number, y: number): Promise<string> {
  const sentinel = `poe2-craft-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
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

async function passiveBagCheck(): Promise<
  { occupied: number; stashOpen: boolean; invOpen: boolean } | undefined
> {
  try {
    const rect = await host.send({ op: "rect" });
    if (!rect.ok) return undefined;
    const probeFile = path.join(outDir, `craft-check-${Date.now()}.bmp`);
    const captured = await host.send({ op: "capture", path: probeFile });
    if (!captured.ok) return undefined;
    const { readBmpBgr, bgrToGray } = await import("../src/adapters/bmp.js");
    const { rmSync } = await import("node:fs");
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
      occupied: facts.occupiedBag.length,
      stashOpen: facts.stashPanelOpen === true,
      invOpen: facts.inventoryPanelOpen === true,
    };
  } catch {
    return undefined;
  }
}

async function sweepBag(grid: ScreenGrid): Promise<BagRead[]> {
  const reads: BagRead[] = [];
  for (let row = 0; row < rows; row += 1) {
    await harness.checkpoint("reading bag");
    const points = Array.from({ length: cols }, (_, col) =>
      cellCenterTwoCorner(grid, col, row, cols, rows),
    );
    const sentinel = `poe2-craft-sweep-${Date.now()}-${row}`;
    const reply = await host.send({ op: "copysweep", points, hoverMs: 130, sentinel });
    const texts = Array.isArray(reply.texts) ? (reply.texts as string[]) : [];
    points.forEach((point, col) => {
      const text = texts[col] ?? "";
      if (text && /Item Class:/i.test(text)) {
        reads.push({ row, col, x: point.x, y: point.y, text });
      }
    });
  }
  return reads;
}

interface OrbStack {
  id: OrbId;
  cell: BagRead;
  count: number;
}

function findOrbStacks(reads: BagRead[]): OrbStack[] {
  const stacks: OrbStack[] = [];
  for (const read of reads) {
    const parsed = parseItemText(read.text);
    if (!/currency/i.test(parsed.itemClass)) continue;
    const entry = (Object.entries(ORB_NAMES) as Array<[OrbId, string]>).find(
      ([, name]) => name.toLowerCase() === parsed.baseType.toLowerCase() ||
        name.toLowerCase() === parsed.name.toLowerCase(),
    );
    if (!entry) continue;
    const stackProperty = parsed.properties.find((property) => /^stack size$/i.test(property.name));
    const count = stackProperty?.rolls?.[0]?.value ?? 1;
    stacks.push({ id: entry[0], cell: read, count: Math.max(1, Math.floor(count)) });
  }
  return stacks;
}

/**
 * --from-tab: pull the sorter's Craft tab into the bag before the sweep,
 * through the sorter's own public seams — listSources/scanTab index the tab
 * by Ctrl+C ground truth, packTripByDest keeps the batch to what the bag
 * places, withdrawItemsSerial ctrl-clicks ONE item at a time and only
 * continues after the bag pixel-verifiably grew. Dry-run reports the batch
 * and touches nothing. Every indexed item also lands in the inventory
 * ledger (artifacts/tab-admin/inventory.jsonl).
 */
async function withdrawFromTab(label: string): Promise<void> {
  const ledgerFile = path.join(root, "artifacts", "tab-admin", "inventory.jsonl");
  const sorter = new GearSorter(host, harness, new StashTabKit(host), {
    root,
    templateDir,
    dryRun: !live,
    debug: false,
    maxChestClicks: 2,
    runId: `craft-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    onObservation: (record) => {
      try {
        appendFileSync(ledgerFile, `${JSON.stringify(record)}\n`);
      } catch {
        // side journal only
      }
    },
  });
  await sorter.ensureSession();
  const sources = await sorter.listSources();
  const source =
    sources.find((entry) => labelsEqualFolded(entry.label, label)) ?? { label, occurrence: 0 };
  const scan = await sorter.scanTab(source);
  if (!scan.ok) {
    if (!live) {
      console.log(
        `--from-tab ${label}: ${scan.reason} — dry-run cannot navigate; open the tab by hand and rerun to preview the batch.`,
      );
      return;
    }
    throw new Error(`--from-tab ${label}: ${scan.reason}`);
  }
  const describe = (item: IdentifiedItem): string => {
    const parsed = parseItemText(item.text);
    return `${parsed.name || parsed.baseType} (${parsed.itemClass}, ${item.cells.length} cell${item.cells.length > 1 ? "s" : ""})`;
  };
  const candidates = scan.modelItems.filter(
    (item) => !/currency/i.test(item.itemClass ?? parseItemText(item.text).itemClass),
  );
  const batch = packTripByDest(candidates, await sorter.bagCellsNow());
  console.log(
    `--from-tab ${label}: ${scan.modelItems.length} item(s) indexed, ${candidates.length} craftable, ` +
      `${batch.length} fit the bag${scan.unread.length > 0 ? `, ${scan.unread.length} unreadable cell(s)` : ""}`,
  );
  for (const item of batch) {
    console.log(`    ${live ? "withdraw" : "would withdraw"} ${describe(item)}`);
  }
  if (!live || batch.length === 0) return;
  const withdrawn = await sorter.withdrawItemsSerial(batch, label);
  console.log(`--from-tab ${label}: ${withdrawn.length}/${batch.length} withdrawn (verified serial)`);
  if (withdrawn.length < batch.length) {
    console.log("    a withdraw did not commit — crafting continues with what reached the bag");
  }
}

async function applyOrb(orb: OrbStack, target: BagRead): Promise<void> {
  // Right-click picks the orb up onto the cursor; left-click applies it.
  await harness.checkpoint(`apply ${ORB_NAMES[orb.id]}`);
  await host.send({ op: "rightclick", x: orb.cell.x, y: orb.cell.y });
  await harness.sleep(220, false);
  await harness.click(target.x, target.y, `apply ${ORB_NAMES[orb.id]} to r${target.row}c${target.col}`);
  await harness.sleep(320, false);
}

let exitCode = 0;
let stopped = false;
/** Each candidate's LAST plan action — "sell" means the bag holds a listing. */
const finalActions = new Map<string, string>();
try {
  const rect = await host.send({ op: "rect" });
  if (!rect.ok) throw new Error("poe-window-not-found — is Path of Exile 2 running?");
  await host.send({ op: "focus" });
  harness.startKeyListener();
  console.log(
    `craft-gear ${live ? "LIVE" : "DRY-RUN"} · budget ${policy.perItemBudget} ex/item · ` +
      `auto gate ≥ ${policy.minAutoConfidence} confidence — numpad: 5 pause · 0 stop` +
      (fromTab ? ` · from-tab ${fromTab}` : "") +
      (thenList ? " · then-list" : ""),
  );

  if (fromTab) await withdrawFromTab(fromTab);

  const grid = await resolveScreenGrid();
  const reads = await sweepBag(grid);
  if (reads.length === 0) {
    // Distinguish "bag is empty" from "sweep read the wrong pixels" — the
    // perception layer sees occupancy without any mouse movement.
    const facts = await passiveBagCheck();
    if (facts && facts.occupied > 0) {
      console.log(
        `warning: the sweep read nothing but perception sees ${facts.occupied} occupied bag cell(s) — ` +
          "calibration and the live window may disagree (recalibrate, or check DPI/window mode).",
      );
    } else if (facts) {
      console.log(
        `bag confirmed empty by perception (stash ${facts.stashOpen ? "open" : "closed"}, ` +
          `inventory ${facts.invOpen ? "open" : "closed"}). Put craft candidates and orbs in the bag, then rerun.`,
      );
    }
  }
  const orbStacks = findOrbStacks(reads);
  const candidates = reads.filter(
    (read) => !/currency/i.test(parseItemText(read.text).itemClass),
  );
  console.log(
    `bag: ${reads.length} occupied cell(s) — ${candidates.length} craft candidate(s), ` +
      `orbs: ${orbStacks.map((stack) => `${stack.count}× ${ORB_NAMES[stack.id]}`).join(", ") || "none"}`,
  );

  let stepsTaken = 0;
  for (const candidate of candidates) {
    let text = candidate.text;
    let spentSoFar = 0;
    for (;;) {
      const plan = planCraft(text, { priceTable, policy, spentSoFar });
      const parsed = parseItemText(text);
      const label = `r${candidate.row}c${candidate.col} ${parsed.name || parsed.baseType}`;
      console.log(describePlan(label, plan));
      finalActions.set(label, plan.action);
      if (!plan.autoEligible || !plan.orb) break;
      const stack = orbStacks.find((entry) => entry.id === plan.orb && entry.count > 0);
      if (!stack) {
        console.log(`    no ${ORB_NAMES[plan.orb]} in the bag — stopping this item.`);
        break;
      }
      if (stepsTaken >= maxSteps) {
        console.log(`    session step cap (${maxSteps}) reached — stopping.`);
        break;
      }
      journal({
        at: new Date().toISOString(),
        cell: { row: candidate.row, col: candidate.col },
        action: plan.action,
        orb: plan.orb,
        cost: plan.cost,
        confidence: plan.confidence,
        scoreBefore: plan.appraisal.valueScore,
        itemName: parsed.name || parsed.baseType,
        itemClass: parsed.itemClass,
        dryRun: !live,
      });
      stepsTaken += 1;
      spentSoFar += plan.cost;
      if (!live) {
        console.log(
          `    DRY-RUN: would apply ${ORB_NAMES[plan.orb]} (${plan.cost} ex, step ${stepsTaken}).`,
        );
        break; // outcomes cannot be simulated — one planned step per item
      }
      await applyOrb(stack, candidate);
      stack.count -= 1;
      const after = await copyItemAt(candidate.x, candidate.y);
      if (!after) {
        console.log("    item unreadable after the orb — stopping this item for manual review.");
        break;
      }
      text = after;
    }
    console.log("");
  }
  await harness.dispose({ outcome: "complete", stepsTaken, live });
} catch (error) {
  stopped = error instanceof SortStop;
  console.log(String(error instanceof Error ? error.message : error));
  if (!stopped) exitCode = 1;
  await harness.dispose({ outcome: stopped ? "stopped" : "failed" });
} finally {
  await controlHost.close();
  await host.close();
}

// --then-list: the crafting host is closed above; shop-buckets starts its
// own. It lists whatever in the bag clears a bucket (keep/dump tiers hold),
// so the SELL-final items from this pass are what it picks up. Never while
// another input host owns the mouse, never after a stop or failure.
if (thenList && exitCode === 0 && !stopped) {
  const sells = [...finalActions.entries()].filter(([, action]) => action === "sell");
  if (otherHostRunning()) {
    console.error(
      "--then-list: another win-input-host is still running — not starting shop-buckets. Stop it and run `npx tsx scripts/shop-buckets.ts` yourself.",
    );
    exitCode = 1;
  } else {
    console.log(
      `--then-list: ${sells.length} item(s) finished at SELL — handing the bag to shop-buckets (${live ? "--live" : "dry-run"})`,
    );
    for (const [label] of sells) console.log(`    ${label}`);
    const listed = spawnSync("npx", ["--yes", "tsx", "scripts/shop-buckets.ts", ...(live ? ["--live"] : [])], {
      cwd: root,
      stdio: "inherit",
      shell: true,
    });
    exitCode = listed.status ?? 1;
  }
}
process.exit(exitCode);
