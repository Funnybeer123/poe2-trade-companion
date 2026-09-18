/**
 * Numpad-hotkey game action daemon. Blocks on the host op `waitkey` (only
 * fires while PoE is the foreground window) and dispatches one action at a
 * time. See docs/HANDOFF-hotkey-actions.md for the full spec and open
 * questions.
 *
 * Key mapping (decided 2026-08-28): Num1=Stash, Num2=Sort, Num3=Fill, Num4=Vendor.
 * Num6=Identify (in-map identify & drop via scripts/map-triage.ts; added 2026-08-31).
 * Num4=Shop since 2026-09-03 (the vendor stub is unbound by default): price the
 * bag and list it into the price-bucket merchant tabs via scripts/shop-buckets.ts.
 *
 * Usage: npx tsx scripts/action-daemon.ts
 * Stop with Ctrl+C (trips the kill switch; the daemon exits after the
 * in-flight action, if any, finishes).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { startWinHost } from "../src/adapters/winHost.js";
import { DrainKit } from "../src/adapters/drainKit.js";
import { loadProfile } from "../src/core/calibrationStore.js";
import { loadHotkeyBindings } from "../src/core/hotkeyBindings.js";
import { actionForKey, HOTKEY_ACTIONS } from "../src/shared/hotkeyActions.js";
import { DEFAULT_POE_PROCESS_ALLOWLIST, resolveBuildMode } from "../src/core/capabilities.js";
import { KillSwitch } from "../src/core/killSwitch.js";
import { resolveScriptLaunch, type ScriptLaunchOptions } from "../src/core/scriptLauncher.js";

import { AssistiveRunService } from "../src/main/assistiveRunService.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templateDir = path.join(root, "fixtures", "perception", "templates");
const artifactDir = path.join(root, "artifacts");
mkdirSync(artifactDir, { recursive: true });
const logFile = path.join(artifactDir, "action-daemon.log");



function log(entry: { action: string; phase: string; message?: string }): void {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  console.log(line);
  appendFileSync(logFile, `${line}\n`);
}

const allowlist = (process.env.POE2_PROCESS_ALLOWLIST ?? DEFAULT_POE_PROCESS_ALLOWLIST.join(","))
  .split(/[;,]/)
  .map((entry) => entry.trim())
  .filter(Boolean);

const host = startWinHost({ requestTimeoutMs: 35_000 });
const kit = new DrainKit(host, root, templateDir);
const killSwitch = new KillSwitch();
const fillService = new AssistiveRunService({
  mode: resolveBuildMode(process.env.POE2_BUILD_MODE),
  qaOptIn: true,
  killSwitch,
  memoryRoot: root,
  artifactDir: path.join(root, "artifacts", "assistive-cli"),
  // Fill is a hideout stash operation that never involves a vendor, and an open
  // tab-list dropdown covers the stash grid while its coloured rows make the
  // vendor box look open — a false vendor-open abort. Same suppression as
  // scripts/assistive-drain-tabs.ts. Num4 does not use this service.
  profile: () => ({ ...loadProfile(templateDir), ventorBagGrid: undefined }),
  onEvent: (event) => log({ action: "fill", phase: event.phase, message: event.message }),
});

// Num5/0/8/9 stay reserved: they are the harness control keys (pause/stop/
// step verdicts) inside every spawned run, so no action may launch on them
// (normalizeHotkeyBindings refuses them). Bindings are re-read from
// artifacts/hotkey-bindings.json on every keypress, so edits made in the
// app's Tools → Hotkeys panel apply without restarting the daemon.
function currentBindings(): ReturnType<typeof loadHotkeyBindings> {
  return loadHotkeyBindings(root);
}

function bindingSummary(): string {
  const { bindings } = currentBindings();
  const parts = HOTKEY_ACTIONS.filter((action) => bindings[action.id] !== null).map(
    (action) => `Num${bindings[action.id]}=${action.label}`,
  );
  return parts.join(" ") || "(no actions bound)";
}

function spawnScript(args: string[], label: string, environment?: NodeJS.ProcessEnv, launchOptions?: ScriptLaunchOptions): Promise<number> {
  return new Promise((resolve, reject) => {
    // `npx.cmd` cannot be spawned without a shell on current Node (EINVAL), and resolving
    // tsx through npx costs over a second per keypress. See src/core/scriptLauncher.ts.
    const launch = resolveScriptLaunch(root, args, launchOptions);
    log({ action: label, phase: "launch", message: launch.source });
    const child = spawn(launch.command, launch.args, {
      cwd: root,
      shell: launch.shell,
      stdio: ["ignore", "pipe", "pipe"],
      ...(environment ? { env: { ...process.env, ...environment } } : {}),
    });
    const relay = (stream: NodeJS.ReadableStream, phase: string) => {
      stream.on("data", (chunk: Buffer) => {
        for (const chunkLine of chunk.toString("utf8").split(/\r?\n/)) {
          if (chunkLine.trim()) log({ action: label, phase, message: chunkLine.trim() });
        }
      });
    };
    relay(child.stdout, "child");
    relay(child.stderr, "child-stderr");
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

/** Num1: validate panels via OCR (reopens stash via world nameplate if needed), deposit bag, retry once with shift. */
async function actionStash(): Promise<void> {
  await kit.ensurePanelsOpen();
  await kit.depositBag();
  let { count, keys } = await kit.verifiedBag();
  if (count > 0) {
    log({ action: "stash", phase: "retry", message: `${count} cell(s) stayed in bag; retrying deposit with shift` });
    await kit.depositBag(true);
    ({ count, keys } = await kit.verifiedBag());
  }
  if (count > 0) {
    log({
      action: "stash",
      phase: "warning",
      message: `AFFINITY TAB FULL? ${count} cells stayed: ${[...keys].sort().join(", ")}`,
    });
    return;
  }
  log({ action: "stash", phase: "result", message: "Bag emptied" });
}

/** Num2: delegate to the existing class-routed sorter as a subprocess. */
async function actionSort(): Promise<void> {
  const code = await spawnScript(["scripts/assistive-sort-tabs.ts", "--run"], "sort");
  log({ action: "sort", phase: "result", message: `assistive-sort-tabs --run exited ${code}` });
}

/** Num3: stash -> bag via the audited fill service, in-process. */
async function actionFill(): Promise<void> {
  const result = await fillService.start({
    kind: "fill",
    dryRun: false,
    wantedClasses: [],
    uniqueAcrossCycles: false,
    qaAcknowledged: true,
    allowlist,
    actionsPerMinute: 240,
  });
  log({
    action: "fill",
    phase: "result",
    message: `ok=${result.ok} reason=${result.reason} bagCells=${result.bagCells} stashCells=${result.stashCells}`,
  });
}

/**
 * Num6 captures once, identifies equipment, then drops only verified low-priority items.
 */
async function actionIdentify(): Promise<void> {
  const desktopRoot = process.platform === "win32" && process.env.APPDATA ? path.join(process.env.APPDATA, "poe2-trade-companion") : root;
  const dataRoot = path.resolve(process.env.POE2_BAG_DATA_ROOT ?? process.env.POE2_STASH_DATA_ROOT ?? desktopRoot);
  const journal = path.join(dataRoot, "artifacts", "map-triage", `bag-${Date.now()}-${randomUUID()}.jsonl`);
  // The desktop button and Num6 run the same prebuilt worker whenever it is current.
  const code = await spawnScript(["scripts/map-triage.ts", "--stage=workflow", "--run", "--journal=" + journal], "identify", { POE2_BAG_DATA_ROOT: dataRoot },
    { bundle: "dist-electron/map-triage.cjs", bundleSources: ["scripts/map-triage.ts", "scripts/win-bag-host.ps1", "src/core", "src/adapters", "src/main"] });
  log({ action: "identify", phase: "result", message: `verified identify-and-drop workflow exited ${code}; journal: ${journal}` });
}

/**
 * Num7: from inside a map — /hideout, sell all junk gear to ZELINA, and
 * re-enter the same map through its portal. Every phase verified; unknown
 * UI capture-and-stops. See scripts/vendor-cycle.ts.
 */
async function actionVendorCycle(): Promise<void> {
  const code = await spawnScript(["scripts/vendor-cycle.ts", "--run"], "vendor-cycle");
  log({ action: "vendor-cycle", phase: "result", message: `vendor-cycle --run exited ${code}` });
}

/** Existing vendor action now cleans rejected rings at Ange without buying. */
async function actionVendor(): Promise<void> {
  const desktopRoot = process.platform === "win32" && process.env.APPDATA ? path.join(process.env.APPDATA, "poe2-trade-companion") : root;
  const dataRoot = path.resolve(process.env.POE2_BAG_DATA_ROOT ?? process.env.POE2_STASH_DATA_ROOT ?? desktopRoot);
  const journal = path.join(dataRoot, "artifacts", "map-triage", "rings-cleanup-" + Date.now() + "-" + randomUUID() + ".jsonl");
  const code = await spawnScript(["scripts/ring-gamble.ts", "--rescan", "--run", "--journal=" + journal,
    "--calibration=" + path.join(dataRoot, "perception-templates", "calibration.json"),
    "--perception=" + path.join(dataRoot, "artifacts", "map-triage", "live-perception.json")], "vendor",
    { POE2_BAG_DATA_ROOT: dataRoot }, { bundle: "dist-electron/ring-gamble.cjs",
      bundleSources: ["scripts/ring-gamble.ts", "src/core", "src/adapters"] });
  log({ action: "vendor", phase: "result", message: "Ring cleanup exited " + code });
}
let busy = false;
let lastActionAt = 0;
let shuttingDown = false;
const DEBOUNCE_MS = 1_500;

process.on("SIGINT", () => {
  log({ action: "daemon", phase: "stopping", message: "SIGINT received; finishing any in-flight action then exiting" });
  shuttingDown = true;
  killSwitch.trip();
});

/**
 * Num4 (default): shop-buckets --live — refresh the price feed for the
 * configured league, appraise the bag (feed + trade2 comps), and list each
 * item in its bucket tab. Overlays show every click; no step gating, Numpad
 * 0 still stops. See docs/HANDOFF-shop-listings.md.
 */
async function actionShop(): Promise<void> {
  const code = await spawnScript(["scripts/shop-buckets.ts", "--live"], "shop");
  log({ action: "shop", phase: "result", message: `shop-buckets --live exited ${code}` });
}

async function runAction(name: string, key: number): Promise<void> {
  log({ action: name, phase: "start", message: `Num${key} pressed` });
  try {
    if (name === "stash") await actionStash();
    else if (name === "shop") await actionShop();
    else if (name === "sort") await actionSort();
    else if (name === "fill") await actionFill();
    else if (name === "vendor") await actionVendor();
    else if (name === "identify") await actionIdentify();
    else if (name === "vendor-cycle") await actionVendorCycle();
    else log({ action: name, phase: "error", message: `no handler for action "${name}"` });
  } catch (error) {
    log({ action: name, phase: "error", message: error instanceof Error ? error.message : String(error) });
  }
}

async function mainLoop(): Promise<void> {
  log({ action: "daemon", phase: "listening", message: `${bindingSummary()} (editable in the app: Tools → Hotkeys). Ctrl+C to stop.` });
  while (!shuttingDown) {
    const reply = await host.send({ op: "waitkey", timeoutMs: 30_000 });
    if (shuttingDown) break;
    if (!reply.ok) continue; // timeout; reissue
    const key = Number(reply.key);
    const name = actionForKey(currentBindings().bindings, key);
    if (!name) continue;
    if (busy) {
      log({ action: name, phase: "ignored", message: "an action is already running" });
      continue;
    }
    const now = Date.now();
    if (now - lastActionAt < DEBOUNCE_MS) {
      log({ action: name, phase: "debounced", message: `Num${key} within ${DEBOUNCE_MS}ms of the last action` });
      continue;
    }
    lastActionAt = now;
    busy = true;
    await runAction(name, key);
    busy = false;
  }
  await host.close();
}

mainLoop()
  .then(() => {
    log({ action: "daemon", phase: "stopped", message: "exiting" });
    process.exit(0);
  })
  .catch((error) => {
    log({ action: "daemon", phase: "fatal", message: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  });
