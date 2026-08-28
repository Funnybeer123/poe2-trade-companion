/**
 * Class-routed stash sorting: identifies every item in the bag via hover +
 * Ctrl+C, groups them by the tab routes in tab-routes.json, then for each
 * destination tab: switches to it (verified by a stash-content signature
 * change), ctrl-click deposits that class group, and switches back to the
 * source tab (verified again). Unrouted items stay in the bag.
 *
 * Usage:
 *   npx tsx scripts/assistive-sort-tabs.ts                # plan only (no tab switches, no deposits)
 *   npx tsx scripts/assistive-sort-tabs.ts --run          # live sort
 *   npx tsx scripts/assistive-sort-tabs.ts --probe        # verify each configured tab point switches tabs
 *   npx tsx scripts/assistive-sort-tabs.ts --init-config  # write a template tab-routes.json to edit
 */
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bgrToGray, readBmpBgr } from "../src/adapters/bmp.js";
import { startWinHost } from "../src/adapters/winHost.js";
import { WinHostInputSink } from "../src/adapters/winHostInputSink.js";
import { emptyBagMask, findPlacement, stashItems, type StashItem } from "../src/core/bagPack.js";
import { RuntimeCapabilities, resolveBuildMode } from "../src/core/capabilities.js";
import { GameInputController } from "../src/core/gameInputController.js";
import { KillSwitch } from "../src/core/killSwitch.js";
import { loadProfile } from "../src/core/calibrationStore.js";
import { parseItemText } from "../src/core/parseItem.js";
import { resolvePhysicalClient, type ScreenRect } from "../src/core/screenLayout.js";
import { scenario } from "../src/core/scenarios.js";
import {
  groupItemsByRoute,
  loadTabRoutes,
  saveTabRoutes,
  signatureDistance,
  stashContentSignature,
  TAB_RETURN_MAX_DISTANCE,
  TAB_SWITCH_MIN_DISTANCE,
  tabGuardBoxes,
  tabRoutesPath,
  type TabPoint,
} from "../src/core/tabRouter.js";
import { reconcileTransfer } from "../src/core/transferReconciler.js";
import { validateTransferInput } from "../src/core/transferInputGuard.js";
import type { InputAction } from "../src/core/types.js";
import { perceiveUi, type UiFacts } from "../src/core/uiPerception.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templateDir = path.join(root, "fixtures", "perception", "templates");
const artifactDir = path.join(root, "artifacts", "assistive-cli");
const live = process.argv.includes("--run");
const probeOnly = process.argv.includes("--probe");

if (process.argv.includes("--init-config")) {
  const file = saveTabRoutes(templateDir, {
    version: 1,
    client: { width: 3840, height: 2160 },
    source: { label: "dump", x: 255, y: 219 },
    routes: [{ tab: { label: "example", x: 565, y: 219 }, classes: ["Rings", "Amulets"] }],
  });
  console.log(`Template written: ${file} â€” edit labels, click points, and classes, then re-run.`);
  process.exit(0);
}

const config = loadTabRoutes(templateDir);
if (!config) {
  console.error(`No ${tabRoutesPath(templateDir)} â€” run with --init-config first.`);
  process.exit(1);
}
const profile = loadProfile(templateDir);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const host = startWinHost();

interface Snapshot {
  facts: UiFacts;
  client: ScreenRect;
  signature: number[];
}

try {
  const target = await host.send({ op: "rect" });
  if (!target.ok) throw new Error("PoE window not found");
  const mode = resolveBuildMode(process.env.POE2_BUILD_MODE);
  const allowlist = (process.env.POE2_PROCESS_ALLOWLIST ??
    "PathOfExileSteam.exe,PathOfExile.exe,PathOfExile_x64Steam.exe")
    .split(/[;,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const targetProcess = String(target.process ?? "PathOfExile");
  const processName = /\.exe$/i.test(targetProcess) ? targetProcess : `${targetProcess}.exe`;
  const capabilities = new RuntimeCapabilities({
    mode,
    buildAllowsQa: true,
    qaAcknowledged: true,
    assistiveAcknowledged: false,
    allowlist,
    bannerVisible: true,
    emergencyStopRegistered: true,
  });
  if (!capabilities.isProcessAllowed(processName)) throw new Error("process-not-allowlisted");

  let clientRef: ScreenRect | undefined;
  const sink = new WinHostInputSink(host, {
    allowedProcesses: allowlist,
    requireForeground: true,
    actionGuard: (action) =>
      clientRef
        ? validateTransferInput([action], profile, clientRef, tabGuardBoxes(config))
        : { ok: true },
  });
  const controller = new GameInputController(sink, new KillSwitch(), mode);
  // Hover + Ctrl+C identification is read-only, so the scenario always runs
  // live; plan mode simply exits before any tab switch or deposit happens.
  const sortScenario = scenario({
    id: "assistive-tab-sort",
    name: "Assistive class-routed tab sorting",
    enabledModules: ["stash"],
    dryRun: false,
    actionsPerMinute: Number(process.env.POE2_ACTIONS_PER_MINUTE ?? 240),
  });

  async function audited(actions: InputAction[], reason: string, ctrl = false): Promise<void> {
    const decision = {
      module: "stash" as const,
      rule: "class-routed-tab-sort",
      reason,
      intended: actions,
      confidence: 0.95,
    };
    const traces = ctrl
      ? await controller.executeBatch(decision, sortScenario, processName, "tab-sort", true, { ctrl: true })
      : await controller.execute(decision, sortScenario, processName, "tab-sort", true);
    appendFileSync(
      path.join(artifactDir, "qa-action-trace.jsonl"),
      `${traces.map((trace) => JSON.stringify(trace)).join("\n")}\n`,
    );
    const failed = traces.find((trace) => trace.result !== "emitted");
    if (failed) throw new Error(`${failed.result}:${failed.reason}`);
  }

  /** Game focus flaps between inputs; refocus once and retry before failing. */
  async function auditedSteady(actions: InputAction[], reason: string, ctrl = false): Promise<void> {
    try {
      await audited(actions, reason, ctrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/focus/i.test(message)) throw error;
      await audited([{ kind: "focus" }], `refocus-before-retry: ${reason}`);
      await sleep(350);
      await audited(actions, `${reason} (retry)`, ctrl);
    }
  }

  async function snapshot(tag: string): Promise<Snapshot> {
    const file = path.join(artifactDir, `tab-sort-${Date.now()}-${tag}.bmp`);
    const captured = await host.send({ op: "capture", path: file });
    if (!captured.ok) throw new Error(String(captured.error ?? "capture-failed"));
    const client = resolvePhysicalClient(
      {
        left: Number(captured.left),
        top: Number(captured.top),
        width: Number(captured.width),
        height: Number(captured.height),
      },
      Number(target.monitorWidth) || Number(captured.width),
      Number(target.monitorHeight) || Number(captured.height),
      { left: Number(target.monitorLeft ?? 0), top: Number(target.monitorTop ?? 0) },
    );
    clientRef = client;
    const bgr = readBmpBgr(file);
    const { rmSync } = await import("node:fs");
    rmSync(file, { force: true });
    const frame = bgrToGray(bgr);
    const facts = perceiveUi(frame, client, {}, profile, bgr);
    const signature = facts.stashRegion
      ? stashContentSignature(frame, client, facts.stashRegion)
      : [];
    return { facts, client, signature };
  }

  function tabScreenPoint(client: ScreenRect, tab: TabPoint): { x: number; y: number } {
    return { x: client.left + tab.x, y: client.top + tab.y };
  }

  async function switchTab(client: ScreenRect, tab: TabPoint, reason: string): Promise<Snapshot> {
    const point = tabScreenPoint(client, tab);
    await auditedSteady([{ kind: "click", x: point.x, y: point.y }], reason);
    await sleep(600);
    const after = await snapshot(`switch-${tab.label}`);
    if (!after.facts.stashPanelOpen) throw new Error(`stash-closed-after-switch-${tab.label}`);
    return after;
  }

  const initial = await snapshot("initial");
  if (!initial.facts.stashPanelOpen) throw new Error("stash-not-open");
  console.log(
    `state: ${initial.facts.reason} stash=${initial.facts.occupiedStash.length} bag=${initial.facts.occupiedBag.length}`,
  );

  if (probeOnly) {
    await audited([{ kind: "focus" }], "focus for tab probe");
    const sourceSig = initial.signature;
    for (const route of config.routes) {
      const at = await switchTab(initial.client, route.tab, `probe-switch-${route.tab.label}`);
      const distance = signatureDistance(sourceSig, at.signature);
      console.log(
        `probe ${route.tab.label}: switched=${distance >= TAB_SWITCH_MIN_DISTANCE} distance=${distance.toFixed(1)} stashCells=${at.facts.occupiedStash.length}`,
      );
      const back = await switchTab(at.client, config.source, "probe-return-source");
      const backDistance = signatureDistance(sourceSig, back.signature);
      console.log(
        `probe return: restored=${backDistance <= TAB_RETURN_MAX_DISTANCE} distance=${backDistance.toFixed(1)}`,
      );
    }
    process.exit(0);
  }

  if (!initial.facts.inventoryPanelOpen || !initial.facts.inventoryRegion) throw new Error("bag-not-open");
  const bagItems = stashItems(initial.facts.occupiedBag, 12).slice(0, 40);
  if (bagItems.length === 0) {
    console.log("Bag is empty â€” fill it from the source tab first (npm run assistive:fill).");
    process.exit(0);
  }

  await audited([{ kind: "focus" }], "focus for item identification");
  const identified: Array<StashItem & { itemClass?: string; name?: string }> = [];
  for (const item of bagItems) {
    await auditedSteady([{ kind: "move", x: item.grab.x, y: item.grab.y }], "hover bag item for identification");
    await sleep(110);
    await host.send({ op: "setclipboard", text: "" });
    await sleep(40);
    await auditedSteady([{ kind: "key", key: "ctrl+c" }], "copy hovered bag item");
    await sleep(90);
    const clip = await host.send({ op: "clipboard" });
    const text = String(clip.text ?? "");
    if (!/Item Class:/i.test(text)) {
      identified.push(item);
      continue;
    }
    const parsed = parseItemText(text);
    identified.push({ ...item, itemClass: parsed.itemClass, name: parsed.name || parsed.baseType });
  }

  const groups = groupItemsByRoute(identified, config);
  console.log(`identified ${identified.length} bag items:`);
  for (const [label, group] of groups.byLabel) {
    console.log(`  -> ${label}: ${group.items.map((entry) => `${entry.name ?? entry.id} (${entry.itemClass})`).join(", ")}`);
  }
  if (groups.unrouted.length) {
    console.log(`  unrouted (stays in bag): ${groups.unrouted.map((entry) => `${entry.name ?? entry.id} (${entry.itemClass ?? "?"})`).join(", ")}`);
  }
  if (!live) {
    console.log("Plan only. Re-run with --run to sort.");
    process.exit(0);
  }

  const summary: Array<{ tab: string; moved: number; rejected: number }> = [];
  let current = initial;
  for (const [label, group] of groups.byLabel) {
    const before = current;
    const at = await switchTab(before.client, group.route.tab, `switch-to-${label}`);
    const distance = signatureDistance(before.signature, at.signature);
    if (before.facts.occupiedStash.length > 0 && distance < TAB_SWITCH_MIN_DISTANCE) {
      console.error(`switch to ${label} not confirmed (distance ${distance.toFixed(1)}) â€” skipping group`);
      current = await switchTab(at.client, config.source, "return-after-unconfirmed-switch");
      summary.push({ tab: label, moved: 0, rejected: group.items.length });
      continue;
    }
    // Only ctrl-click items that actually have room in the destination tab —
    // the game silently refuses transfers whose footprint has no free rect.
    const gridSize = at.facts.stashGridSize ?? { cols: 24, rows: 24 };
    const freeMask = emptyBagMask(at.facts.occupiedStash, gridSize.cols, gridSize.rows);
    const deposits: typeof group.items = [];
    const noSpace: typeof group.items = [];
    for (const entry of group.items) {
      const dest = findPlacement(entry.cells, freeMask);
      if (!dest) {
        noSpace.push(entry);
        continue;
      }
      const minR = Math.min(...entry.cells.map((cell) => cell.row));
      const minC = Math.min(...entry.cells.map((cell) => cell.col));
      for (const cell of entry.cells) {
        const row = freeMask[dest.row + cell.row - minR];
        if (row) row[dest.col + cell.col - minC] = false;
      }
      deposits.push(entry);
    }
    if (noSpace.length > 0) {
      console.log(
        `${label}: no room for ${noSpace.map((entry) => `${entry.name ?? entry.id} (${entry.w}x${entry.h})`).join(", ")}`,
      );
    }
    if (deposits.length === 0) {
      summary.push({ tab: label, moved: 0, rejected: group.items.length });
      current = await switchTab(at.client, config.source, "return-no-deposits");
      continue;
    }
    await auditedSteady(
      deposits.map((entry) => ({ kind: "click" as const, x: entry.grab.x, y: entry.grab.y })),
      `deposit-${deposits.length}-items-to-${label}`,
      true,
    );
    // Deposit animations lag the click; poll the bag until the group's cells
    // actually clear instead of judging from one early frame.
    let after = at;
    let remaining = deposits;
    for (let poll = 0; poll < 4; poll += 1) {
      await sleep(poll === 0 ? 350 : 250);
      after = await snapshot(`deposited-${label}-${poll}`);
      const occupied = new Set(after.facts.occupiedBag.map((cell) => `${cell.row},${cell.col}`));
      remaining = remaining.filter((entry) =>
        entry.cells.some((cell) => occupied.has(`${cell.row},${cell.col}`)),
      );
      if (remaining.length === 0) break;
    }
    const reconciled = reconcileTransfer("bag-to-stash", deposits, at.facts, after.facts);
    const moved = deposits.length - remaining.length;
    console.log(
      `${label}: moved=${moved} stillInBag=${remaining.length} noSpace=${noSpace.length} (reconciler: ${reconciled.moved.length}/${reconciled.rejected.length}/${reconciled.ambiguous.length})`,
    );
    summary.push({ tab: label, moved, rejected: remaining.length + noSpace.length });
    current = await switchTab(after.client, config.source, "return-to-source");
    const backDistance = signatureDistance(initial.signature, current.signature);
    if (backDistance > TAB_RETURN_MAX_DISTANCE) {
      console.error(`source tab not restored (distance ${backDistance.toFixed(1)}) â€” stopping for safety`);
      break;
    }
  }
  const finalState = await snapshot("final");
  console.log(
    JSON.stringify(
      {
        ok: true,
        summary,
        unrouted: groups.unrouted.length,
        bagCellsAfter: finalState.facts.occupiedBag.length,
      },
      null,
      2,
    ),
  );
} finally {
  await host.close();
}
