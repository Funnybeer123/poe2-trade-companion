/**
 * Numpad-hotkey game action daemon. Blocks on the host op `waitkey` (only
 * fires while PoE is the foreground window) and dispatches one action at a
 * time. See docs/HANDOFF-hotkey-actions.md for the full spec and open
 * questions.
 *
 * Key mapping (decided 2026-08-28): Num1=Stash, Num2=Sort, Num3=Fill, Num4=Vendor.
 * Num6=Identify (in-map identify & drop via scripts/map-triage.ts; added 2026-08-31).
 *
 * Usage: npx tsx scripts/action-daemon.ts
 * Stop with Ctrl+C (trips the kill switch; the daemon exits after the
 * in-flight action, if any, finishes).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { startWinHost } from "../src/adapters/winHost.js";
import { DrainKit } from "../src/adapters/drainKit.js";
import { loadProfile } from "../src/core/calibrationStore.js";
import { loadHotkeyBindings } from "../src/core/hotkeyBindings.js";
import { actionForKey, HOTKEY_ACTIONS } from "../src/shared/hotkeyActions.js";
import { DEFAULT_POE_PROCESS_ALLOWLIST, resolveBuildMode } from "../src/core/capabilities.js";
import { KillSwitch } from "../src/core/killSwitch.js";
import type { OcrLine } from "../src/core/tabList.js";
import { AssistiveRunService } from "../src/main/assistiveRunService.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templateDir = path.join(root, "fixtures", "perception", "templates");
const artifactDir = path.join(root, "artifacts");
mkdirSync(artifactDir, { recursive: true });
const logFile = path.join(artifactDir, "action-daemon.log");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

function spawnScript(args: string[], label: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["--yes", "tsx", ...args], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
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
 * Num6: in-map identify & drop. Delegates to the map-triage runner as a
 * subprocess — it verifies the Scroll of Wisdom at bag (0,0), identifies all
 * unidentified gear, evaluates the tier regexes, and drops the not-good
 * items on the ground. The script refuses on its own when the stash panel
 * is open (hideout/town) or the scroll is missing.
 */
async function actionIdentify(): Promise<void> {
  const code = await spawnScript(["scripts/map-triage.ts", "--run"], "identify");
  log({ action: "identify", phase: "result", message: `map-triage --run exited ${code}` });
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

// Windows.Media.Ocr returns zero lines for mid-size crops (1800x1000 and
// 1920x1080 both come back empty) while the full 3840x2160 grab works, so
// nameplate hunting must scan the whole screen. ZELINA also sits at x~1177,
// left of the drain kit's x>=1200 world region.
const FULL_SCREEN_OCR = { left: 0, top: 0, width: 3840, height: 2160 };

async function findNameplate(
  pattern: RegExp,
  region = FULL_SCREEN_OCR,
): Promise<{ x: number; y: number } | undefined> {
  const reply = await host.send({ op: "ocr", ...region });
  const lines = (Array.isArray(reply.lines) ? reply.lines : []) as OcrLine[];
  const plate = lines.find((line) => pattern.test(line.text.trim()));
  if (!plate) return undefined;
  return { x: Math.round(plate.x + plate.w / 2), y: Math.round(plate.y + plate.h / 2 + 70) };
}

/**
 * Num4: locate ZELINA via OCR (hideout-only refusal if not found) and
 * ctrl-click to open her vendor window. The vendor window's sell-pane and
 * confirm-button layout is UNKNOWN — this stops after capturing a screenshot
 * rather than guessing coordinates in the user's live game. A follow-up
 * session must inspect the capture and wire the exact clicks (see
 * docs/HANDOFF-hotkey-actions.md, TODO item 1, Num4 Vendor).
 */
async function actionVendor(): Promise<void> {
  const bag = await kit.verifiedBag();
  if (bag.count === 0) {
    log({ action: "vendor", phase: "result", message: "Bag is empty; nothing to sell" });
    return;
  }
  await host.send({ op: "focus" });
  await sleep(300);
  const plate = await findNameplate(/^zelina$/i);
  if (!plate) {
    log({ action: "vendor", phase: "error", message: "ZELINA nameplate not found (hideout-only refusal)" });
    return;
  }
  const clicked = await host.send({ op: "ctrlclick", x: plate.x, y: plate.y });
  if (!clicked.ok) {
    log({ action: "vendor", phase: "error", message: `ctrlclick on ZELINA failed: ${clicked.error}` });
    return;
  }
  await sleep(2500);
  const shotPath = path.join(artifactDir, `vendor-window-${Date.now()}.bmp`);
  const captured = await host.send({ op: "capture", path: shotPath });
  if (!captured.ok) {
    log({ action: "vendor", phase: "error", message: `vendor-window capture failed: ${captured.error}` });
    return;
  }
  log({
    action: "vendor",
    phase: "blocked",
    message:
      `Opened ZELINA's vendor window and saved a capture to ${shotPath}. ` +
      "Its sell-pane and confirm-button layout is not yet mapped, so this action stops here " +
      "rather than guess clicks. Inspect the capture, then wire the exact coordinates into actionVendor().",
  });
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

async function runAction(name: string, key: number): Promise<void> {
  log({ action: name, phase: "start", message: `Num${key} pressed` });
  try {
    if (name === "stash") await actionStash();
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
