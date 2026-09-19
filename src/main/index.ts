import { app, BrowserWindow, clipboard, globalShortcut, ipcMain, shell } from "electron";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WindowsSpeechRecognizer } from "../adapters/windowsSpeechRecognizer.js";
import { KillSwitch } from "../core/killSwitch.js";
import { parseItemText } from "../core/parseItem.js";
import { enrichItemSize, itemSizeDatabasePath, loadItemSizeDatabase } from "../core/itemSizeStore.js";
import { FixtureMarketProvider } from "../core/market.js";
import { valueItem } from "../core/valuation.js";
import { scoreBuildAwareDesirability } from "../core/gearTargetMatcher.js";
import { compileRules, type ScanHistoryItem } from "../core/scanRules.js";
import { resolveBuildMode } from "../core/capabilities.js";
import { loadHotkeyBindings, saveHotkeyBindings } from "../core/hotkeyBindings.js";
import { HOTKEY_ACTIONS, RESERVED_CONTROL_KEYS } from "../shared/hotkeyActions.js";
import { parseFindRecords } from "../core/sortTriage.js";
import {
  deriveShopState,
  parseListingEvents,
  parseShopConfig,
} from "../core/shopListings.js";
import { salesStats } from "../core/shopPricing.js";
import { generateLootFilter } from "../core/lootFilter.js";
import {
  normalizeVoiceTransferConfig,
  type VoiceTransferConfig,
  type VoiceTransferState,
  type VoiceTransferStatus,
} from "../core/voiceTransfer.js";
import { readMergedProfile, registerCalibrationIpc } from "./calibrationIpc.js";
import { AssistiveRunService, type AssistiveRunRequest } from "./assistiveRunService.js";
import {
  findCompanionRepoRoot,
  gatherCursorHandoffEvidence,
  launchCursorWithPrompt,
  spawnCursorCli,
} from "./cursorHandoff.js";
import { DryRunOverlayWindow } from "./dryRunOverlayWindow.js";
import { StashSortService, type SortStashRequest } from "./stashSortService.js";
import { VoiceTransferService } from "./voiceTransferService.js";
import {
  loadVoiceTransferConfig,
  saveVoiceTransferConfig,
} from "./voiceTransferSettings.js";
import { ITEM_INTELLIGENCE_IPC_VERSION, type ParsedItemEvaluation } from "../shared/ipc.js";
import { openLocalPersistence, type LocalPersistenceDatabase } from "./persistence/index.js";
import { ItemIntelligenceService } from "./itemIntelligenceService.js";
import { PriceFeedService, type PriceFeedConfig } from "./priceFeedService.js";
import { installPriceHelper } from "./priceHelperIntegration.js";
import type { PriceHelperService } from "./priceHelperService.js";
import { registerItemIntelligenceIpc } from "./itemIntelligenceIpc.js";
import { registerScanIpc } from "./scanIpc.js";
import { StashTabAdminService } from "./stashTabAdminService.js";
import { StashValuationService } from "./stashValuationService.js";
import { BagTriageService } from "./bagTriageService.js";
import type { StashTabPlan, SurveyedStashTab } from "../core/stashTabAdmin.js";
import {
  JsonlScanSessionStorage,
  ScanSessionStore,
  type ScanSession,
} from "./scanSessionStore.js";
import { ScannerRuntimeService } from "./scanRuntimeService.js";
import { CombatAssistService, combatStorage } from "./combatAssistService.js";
import { installFollower } from "./followerIntegration.js";
import { defaultCombatConfig } from "../core/combatAssist.js";
import { startEmergencyStopMonitor } from "../adapters/emergencyStopMonitor.js";
import { sendRendererEvent } from "./rendererEvents.js";
import { installWindowActivation } from "./windowActivation.js";
import { backgroundSmokeEnabled } from "./backgroundSmoke.js";
import { prepareBagCountdownWindow } from "./bagCountdownWindow.js";

const execFileAsync = promisify(execFile);
const buildMode = resolveBuildMode(
  typeof __POE2_BUILD_MODE__ === "undefined" ? process.env.POE2_BUILD_MODE : __POE2_BUILD_MODE__,
);
const killSwitch = new KillSwitch();
const backgroundSmoke = backgroundSmokeEnabled(process.argv, process.env);
if (backgroundSmoke) {
  const smokeProfile = path.resolve(process.env.POE2_SMOKE_USER_DATA_DIR!);
  mkdirSync(smokeProfile, { recursive: true });
  app.setPath("userData", smokeProfile);
  killSwitch.trip();
}

let mainWindow: BrowserWindow | undefined;
let activateMainWindow: (() => void) | undefined;
let assistiveService: AssistiveRunService | undefined;
let dryRunOverlay: DryRunOverlayWindow | undefined;
let stashSortService: StashSortService | undefined;
let stashTabAdminService: StashTabAdminService | undefined;
let stashValuationService: StashValuationService | undefined;
let bagTriageService: BagTriageService | undefined;
let voiceService: VoiceTransferService | undefined;
let voiceConfig = normalizeVoiceTransferConfig(undefined);
let registeredVoiceHotkey: string | undefined;
let voiceHotkeyError = "";
let lastClipboard = "";
let localPersistence: LocalPersistenceDatabase | undefined;
let itemIntelligenceService: ItemIntelligenceService | undefined;
let priceFeedService: PriceFeedService | undefined;
let priceHelperService: PriceHelperService | undefined;
let scannerService: ScannerRuntimeService | undefined;
let combatService: CombatAssistService | undefined;
let combatGlobalDryRun = true;
let followerService: ReturnType<typeof installFollower> | undefined;
import { DEFAULT_POE_PROCESS_ALLOWLIST } from "../core/capabilities.js";
let deckServer: import("./deckServer.js").DeckServer | undefined;
let deckRuntime: import("./deckRuntime.js").DeckRuntime | undefined;
let deckPreferences: import("../shared/deckActions.js").DeckPreferences = { dryRun: true, allowlist: [...DEFAULT_POE_PROCESS_ALLOWLIST], transferActionsPerMinute: 240, sortActionsPerMinute: 600 };
let emergencyStopMonitor: ReturnType<typeof startEmergencyStopMonitor> | undefined;

function voiceActive(): boolean { return ["listening", "recognized", "transferring"].includes(voiceService?.status.phase ?? ""); }
function assertBagIdle(fromVoice = false): void {
  if (backgroundSmoke) throw new Error("Game actions are disabled during background UI smoke checks.");
  if (bagTriageService?.status.running) throw new Error("Stop the current bag stage before starting another game action.");
  if (killSwitch.isLatched()) throw new Error("Emergency stop is latched. Rearm first.");
  if (!fromVoice && voiceActive()) throw new Error("Cancel the current voice transfer first.");
  if (assistiveService?.status.running || stashSortService?.status.running || scannerService?.status.running || stashTabAdminService?.status.running || combatService?.status.running || followerService?.driving()) throw new Error("Stop the current game action before starting another.");
}

function quotesFile(): string {
  const candidates = [
    path.join(process.cwd(), "fixtures", "market", "quotes.json"),
    path.join(app.getAppPath(), "fixtures", "market", "quotes.json"),
  ];
  return candidates.find((file) => existsSync(file)) ?? candidates[0];
}

function sizeDatabaseFile(): string {
  const candidates = [
    itemSizeDatabasePath(process.cwd()),
    path.join(app.getAppPath(), "fixtures", "item-sizes", "item-sizes.json"),
  ];
  return candidates.find((file) => existsSync(file)) ?? candidates[0];
}

async function evaluateItemText(
  text: string,
  source: "clipboard" | "paste" | "scan" = "clipboard",
  publishEvaluation = true,
) {
  if (!text.trim()) {
    return {
      schemaVersion: ITEM_INTELLIGENCE_IPC_VERSION,
      raw: text,
      parsed: false as const,
      reason: "empty" as const,
    };
  }
  if (!/Item Class:/i.test(text)) {
    return {
      schemaVersion: ITEM_INTELLIGENCE_IPC_VERSION,
      raw: text,
      parsed: false as const,
      reason: "not-item-text" as const,
    };
  }
  const quotes = JSON.parse(readFileSync(quotesFile(), "utf8")) as Record<
    string,
    Array<{ listingId: string; priceAmount: number; priceCurrency: string }>
  >;
  const item = enrichItemSize(parseItemText(text), loadItemSizeDatabase(sizeDatabaseFile()));
  const quote = await new FixtureMarketProvider(quotes).quote(item, { league: "Standard", currency: "exalted" });
  const valuation = valueItem(item, quote);
  const { desirability } = scoreBuildAwareDesirability(
    item,
    valuation,
    localPersistence?.buildProfiles.list() ?? [],
  );
  let tier: ParsedItemEvaluation["tier"];
  try {
    tier = itemIntelligenceService?.evaluateTier(text);
  } catch {
    // Tier config problems must never block a plain evaluation.
  }
  const payload: ParsedItemEvaluation = {
    schemaVersion: ITEM_INTELLIGENCE_IPC_VERSION,
    raw: text,
    parsed: true,
    item,
    valuation,
    desirability,
    ...(tier ? { tier } : {}),
  };
  itemIntelligenceService?.recordEvaluation(payload, source);
  if (publishEvaluation) {
    sendRendererEvent(mainWindow, "item:evaluated", payload);
  }
  return payload;
}

function syncRuntimeScanSession(session: ScanSession): void {
  if (!localPersistence) return;
  const profileId = localPersistence.buildProfiles.get(
    session.context.source.profileId,
  )
    ? session.context.source.profileId
    : undefined;
  localPersistence.transaction(() => {
    localPersistence!.scanSessions.upsert({
      id: session.id,
      ...(profileId ? { profileId } : {}),
      source: `authorized-qa:${session.context.grid.kind}`,
      status: session.status,
      startedAt: session.startedAt,
      ...(session.endedAt ? { endedAt: session.endedAt } : {}),
      summary: {
        context: session.context,
        terminalReason: session.terminalReason,
        terminalError: session.terminalError,
        summary: session.summary,
      },
    });
    for (const slot of session.slots) {
      localPersistence!.scanSlots.upsert({
        id: slot.id,
        sessionId: session.id,
        slotKey: `${slot.cell.row},${slot.cell.col}:attempt:${slot.attempt}`,
        ordinal: slot.sequence,
        status: slot.status,
        ...(slot.itemFingerprint
          ? { itemFingerprint: slot.itemFingerprint }
          : {}),
        scannedAt: slot.observedAt,
        payload: slot,
      });
    }
  });
}

/**
 * The sort-gear script runs out of process and cannot read the app database,
 * so the user's tiers + price table are mirrored to a JSON file the script
 * loads at startup (artifacts/tab-admin/triage.json).
 */
function exportTriageSnapshot(): void {
  if (!itemIntelligenceService) return;
  try {
    const dir = path.join(app.isPackaged ? app.getPath("userData") : process.cwd(), "artifacts", "tab-admin");
    mkdirSync(dir, { recursive: true });
    const config = itemIntelligenceService.getValueTierConfig();
    const snapshot = {
      exportedAt: new Date().toISOString(),
      rules: config.rules,
      thresholds: config.thresholds,
      routing: config.routing,
      minDetourConfidence: config.minDetourConfidence,
      priceTable: itemIntelligenceService.getPriceTable(),
    };
    writeFileSync(path.join(dir, "triage.json"), JSON.stringify(snapshot, null, 2));
  } catch {
    // The snapshot is a convenience mirror; failing to write it must not
    // break the app. The script falls back to starter tiers.
  }
}

async function evaluateClipboard() {
  if (backgroundSmoke) return null;
  const text = await clipboard.readText();
  if (!text || text === lastClipboard) return null;
  lastClipboard = text;
  return evaluateItemText(text, "clipboard");
}

async function listPoeProcesses(): Promise<Array<{ name: string; title: string }>> {
  if (backgroundSmoke) return [];
  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Get-Process | Where-Object { $_.ProcessName -match 'Exile' } | Select-Object ProcessName, MainWindowTitle | ConvertTo-Json -Compress",
    ]);
    const parsed = stdout.trim() ? JSON.parse(stdout) : [];
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows
      .filter((row: { ProcessName?: string }) => row.ProcessName)
      .map((row: { ProcessName: string; MainWindowTitle?: string }) => ({
        name: `${row.ProcessName}.exe`,
        title: row.MainWindowTitle ?? "",
      }));
  } catch {
    return [];
  }
}

function voiceStatus(): VoiceTransferStatus {
  return {
    ...(voiceService?.status ?? {
      phase: "idle" as const,
      updatedAt: new Date().toISOString(),
    }),
    config: {
      ...voiceConfig,
      allowlist: [...voiceConfig.allowlist],
    },
    hotkeyRegistered: Boolean(registeredVoiceHotkey),
    ...(voiceHotkeyError ? { hotkeyError: voiceHotkeyError } : {}),
  };
}

function sendVoiceStatus(): void {
  sendRendererEvent(mainWindow, "voice:state", voiceStatus());
}

function appendVoiceAudit(artifactDir: string, state: VoiceTransferState): void {
  if (state.phase === "idle") return;
  mkdirSync(artifactDir, { recursive: true });
  const entry = {
    timestamp: state.updatedAt,
    type: "voice-transfer",
    scenarioId: "assistive-fill",
    module: "stash",
    mode: buildMode,
    phase: state.phase,
    source: state.source,
    transcript: state.transcript,
    confidence: state.confidence,
    decisionRule: "one-shot-local-speech-stash-fill",
    commandMode: state.commandMode,
    wantedClasses: state.wantedClasses,
    searchQuery: state.searchQuery,
    reason: state.error ?? state.transferReason ?? state.phase,
  };
  appendFileSync(
    path.join(artifactDir, "qa-action-trace.jsonl"),
    `${JSON.stringify(entry)}\n`,
    "utf8",
  );
}

function installVoiceHotkey(next: VoiceTransferConfig): void {
  if (backgroundSmoke) return;
  const previous = registeredVoiceHotkey;
  if (previous) {
    globalShortcut.unregister(previous);
    registeredVoiceHotkey = undefined;
  }
  if (!next.enabled) {
    voiceHotkeyError = "";
    return;
  }
  if (
    globalShortcut.register(next.hotkey, () => {
      void voiceService?.trigger("hotkey");
    })
  ) {
    registeredVoiceHotkey = next.hotkey;
    voiceHotkeyError = "";
    return;
  }
  voiceHotkeyError = `voice-hotkey-registration-failed:${next.hotkey}`;
  if (
    previous &&
    globalShortcut.register(previous, () => {
      void voiceService?.trigger("hotkey");
    })
  ) {
    registeredVoiceHotkey = previous;
  }
  throw new Error(voiceHotkeyError);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 860,
    show: false,
    ...(backgroundSmoke ? { focusable: false, skipTaskbar: true } : {}),
    alwaysOnTop: false,
    backgroundColor: "#090a0c",
    title: "PoE2 Trade Companion",
    webPreferences: {
      preload: path.join(path.dirname(fileURLToPath(import.meta.url)), "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      ...(backgroundSmoke ? { backgroundThrottling: false } : {}),
    },
  });
  const window = mainWindow;
  if (!backgroundSmoke) activateMainWindow = installWindowActivation(window);
  window.once("closed", () => {
    if (mainWindow === window) {
      mainWindow = undefined;
      activateMainWindow = undefined;
    }
  });
  const startHash = process.env.POE2_START_ROUTE ? `#${process.env.POE2_START_ROUTE}` : "";
  if (process.env.VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}${startHash}`);
  } else {
    void mainWindow.loadFile(path.join(app.getAppPath(), "dist", "index.html"), {
      hash: startHash.replace(/^#/, ""),
    });
  }
}

// A second shortcut launch should reveal the current dashboard, not open a
// competing database/input runtime behind the game. Separate test profiles
// retain separate Electron instance locks.
const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
app.on("second-instance", () => activateMainWindow?.());
app.on("activate", () => activateMainWindow?.());

if (ownsInstance) void app.whenReady().then(() => {
  const memoryRoot = app.getPath("userData");
  const artifactDir = path.join(memoryRoot, "assistive-artifacts");
  localPersistence = openLocalPersistence(
    path.join(memoryRoot, "item-intelligence.sqlite"),
  );
  itemIntelligenceService = new ItemIntelligenceService({
    persistence: localPersistence,
    publish: (channel, payload) => {
      sendRendererEvent(mainWindow, channel, payload);
      if (channel === "tiers:changed" || channel === "prices:changed") {
        exportTriageSnapshot();
      }
    },
  });
  priceFeedService = new PriceFeedService({
    configDir: memoryRoot,
    getPriceTable: () => itemIntelligenceService!.getPriceTable(),
    savePriceTable: (table) => itemIntelligenceService!.savePriceTable(table),
  });
  registerItemIntelligenceIpc(ipcMain, itemIntelligenceService);
  exportTriageSnapshot();
  scannerService = new ScannerRuntimeService({
    mode: buildMode,
    qaOptIn: true,
    killSwitch,
    sessions: new ScanSessionStore(
      new JsonlScanSessionStorage(
        path.join(memoryRoot, "scan-sessions.jsonl"),
      ),
    ),
    clipboard: {
      readText: () => clipboard.readText(),
      writeText: (text) => clipboard.writeText(text),
    },
    profile: readMergedProfile,
    itemSizeDatabase: () => loadItemSizeDatabase(sizeDatabaseFile()),
    rules: (ruleSetId) => {
      const selected = ruleSetId
        ? localPersistence?.ruleSets.get(ruleSetId)
        : localPersistence?.ruleSets.list().find((entry) => entry.active);
      return compileRules(
        Array.isArray(selected?.rules)
          ? (selected.rules as ScanHistoryItem[])
          : [],
      );
    },
    buildProfile: (profileId) =>
      profileId
        ? localPersistence?.buildProfiles.get(profileId)
        : localPersistence?.buildProfiles
            .list()
            .find((profile) => profile.active),
    evaluateItemText: (text) => evaluateItemText(text, "scan", false),
    persistSession: syncRuntimeScanSession,
    onEvent: (event) => { deckRuntime?.observe("scan", event); sendRendererEvent(mainWindow, "scanner:event", event); },
    onTrace: (trace) => {
      mkdirSync(artifactDir, { recursive: true });
      appendFileSync(
        path.join(artifactDir, "qa-action-trace.jsonl"),
        `${JSON.stringify(trace)}\n`,
        "utf8",
      );
    },
  });
  registerScanIpc(ipcMain, scannerService, () => assertBagIdle());
  voiceConfig = loadVoiceTransferConfig(memoryRoot);
  dryRunOverlay = new DryRunOverlayWindow();
  const baselineDir = path.join(memoryRoot, "perception-templates");
  assistiveService = new AssistiveRunService({
    mode: buildMode,
    qaOptIn: true,
    killSwitch,
    memoryRoot,
    artifactDir,
    baselineDir,
    profile: readMergedProfile,
    onEvent: (event) => { deckRuntime?.observe("transfer", event); sendRendererEvent(mainWindow, "assistive:event", event); },
    onDryRunOverlay: (plan) => {
      if (plan) dryRunOverlay?.show(plan);
      else dryRunOverlay?.hide();
    },
  });
  stashSortService = new StashSortService({
    mode: buildMode,
    qaOptIn: true,
    killSwitch,
    artifactDir,
    baselineDir,
    profile: readMergedProfile,
    sizeDatabase: () => loadItemSizeDatabase(sizeDatabaseFile()),
    onEvent: (event) => { deckRuntime?.observe("sort", event); sendRendererEvent(mainWindow, "stash-sort:event", event); },
  });
  stashTabAdminService = new StashTabAdminService({
    root: app.isPackaged ? memoryRoot : process.cwd(),
    marketConfigDir: memoryRoot,
    templateDir: baselineDir,
    ...(app.isPackaged ? { valuationWorker: {
      executable: process.execPath,
      file: path.join(app.getAppPath().replace(/app\.asar$/, "app.asar.unpacked"), "dist-electron", "value-dump.cjs"),
      dataRoot: memoryRoot,
    } } : {}),
    emit: (event) => { if (event.kind === "log" || event.kind === "error") deckRuntime?.observe("script", event); sendRendererEvent(mainWindow, "stash-tabs:event", event); },
    canRun: () => !killSwitch.isLatched() && !voiceActive() && !bagTriageService?.status.running && !assistiveService?.status.running && !stashSortService?.status.running && !scannerService?.status.running && !combatService?.status.running && !followerService?.driving(),
    onScriptStopped: (_kind, reason) => stashValuationService?.markStopped(reason),
  });
  stashValuationService = new StashValuationService(app.isPackaged ? memoryRoot : process.cwd());
  bagTriageService = new BagTriageService({
    root: app.getAppPath(), dataRoot: app.isPackaged ? memoryRoot : process.cwd(), templateDir: baselineDir,
    perceptionFile: process.env.POE2_BAG_PERCEPTION_FILE, clientLog: process.env.POE2_CLIENT_LOG,
    ...(app.isPackaged ? { workerFile: path.join(app.getAppPath().replace(/app\.asar$/, "app.asar.unpacked"), "dist-electron", "map-triage.cjs") } : {}),
    emit: status => {
      if (!backgroundSmoke) prepareBagCountdownWindow(mainWindow, status.phase);
      sendRendererEvent(mainWindow, "bag-triage:status-changed", status);
    },
    blocked: () => backgroundSmoke ? "Game actions are disabled during background UI smoke checks."
      : killSwitch.isLatched() ? "Rearm the emergency stop before starting a bag stage."
      : voiceActive() || assistiveService?.status.running || stashSortService?.status.running || scannerService?.status.running || stashTabAdminService?.status.running || combatService?.status.running || followerService?.driving()
        ? "Stop the current game action before starting a bag stage." : undefined,
  });
  ipcMain.handle("bag-triage:status", () => bagTriageService!.refresh());
  ipcMain.handle("bag-triage:select", (_event, journal: string) => bagTriageService!.select(journal));
  ipcMain.handle("bag-triage:start", (_event, stage) => bagTriageService!.start(stage));
  ipcMain.handle("bag-triage:stop", () => bagTriageService!.stop());
  if (!backgroundSmoke) bagTriageService.setCleanupHotkey(globalShortcut.register("CommandOrControl+Alt+V", () => {
    bagTriageService?.startCleanupFromHotkey();
  }));
  voiceService = new VoiceTransferService({
    mode: buildMode,
    recognizer: new WindowsSpeechRecognizer(),
    config: () => voiceConfig,
    assistiveStatus: () => assistiveService!.status,
    startTransfer: (request) => { assertBagIdle(true); return assistiveService!.start(request); },
    blocked: () => { try { assertBagIdle(true); return undefined; } catch (error) { return String(error); } },
    stopTransfer: (reason) => assistiveService!.stop(reason),
    onState: (state) => {
      try {
        appendVoiceAudit(artifactDir, state);
      } catch {
        // AssistiveRunService still owns the mandatory per-input action trace.
      }
      try {
        sendVoiceStatus();
      } catch {
        // A closed renderer must not disrupt recognition or audited input.
      }
    },
  });
  followerService = installFollower(() => mainWindow, () => backgroundSmoke ? "Peer connections and game capture are disabled during background UI smoke checks." : killSwitch.isLatched() ? "Emergency stop is latched. Rearm before connecting or capturing." : undefined, {
    killSwitch, mode: buildMode, globalDryRun: () => combatGlobalDryRun,
    blocked: () => (!emergencyStopRegistered && !emergencyStopMonitor?.ready) ? "The emergency stop is starting or unavailable. Wait a moment, or close conflicting apps and restart the companion."
      : voiceActive() || assistiveService?.status.running || stashSortService?.status.running || scannerService?.status.running || stashTabAdminService?.status.running || bagTriageService?.status.running || combatService?.status.running
        ? "Paused while another game action is running" : undefined,
  });
  const stopAllInput = () => {
    followerService?.stop("Emergency stop — rearm before connecting.");
    killSwitch.trip();
    bagTriageService?.stop("Emergency stop");
    stashTabAdminService?.stopScript("Emergency stop");
    combatService?.stop("Emergency stop — rearm in the app");
    void voiceService?.cancel("emergency-stop");
    assistiveService?.stop("emergency-stop");
    stashSortService?.stop("emergency-stop");
    scannerService?.stop("emergency-stop");
    try { priceHelperService?.stop(); } catch { /* Never let an overlay delay the input kill switch. */ }
    sendRendererEvent(mainWindow, "qa:killed");
  };
  const emergencyStopRegistered = !backgroundSmoke && globalShortcut.register("CommandOrControl+Shift+Escape", stopAllInput);
  if (!backgroundSmoke) globalShortcut.register("CommandOrControl+Shift+F12", stopAllInput);
  if (!backgroundSmoke && !emergencyStopRegistered) {
    try { emergencyStopMonitor = startEmergencyStopMonitor(stopAllInput, stopAllInput); }
    catch { /* Combat stays disarmed until a working stop mechanism exists. */ }
  }
  const combatFiles = combatStorage(path.join(memoryRoot, "combat"));
  let combatConfig = defaultCombatConfig();
  let combatLoadError = "";
  try { combatConfig = combatFiles.load(); }
  catch (error) { combatLoadError = `Combat settings could not be loaded: ${String(error)}`; }
  let combatHotkeyRegistered = false;
  combatService = new CombatAssistService({
    killSwitch, mode: buildMode, config: combatConfig,
    save: combatFiles.save, audit: combatFiles.audit,
    blocked: () => {
      if ((!emergencyStopRegistered && !emergencyStopMonitor?.ready) || !combatHotkeyRegistered) return "Combat hotkeys are starting or unavailable. Wait a moment, or close conflicting apps and restart the companion.";
      if (combatGlobalDryRun && !combatService?.status.config.dryRun) return "Global Dry-run is on. Use Preview only or turn off global Dry-run for live combat.";
      if (voiceActive() || assistiveService?.status.running || stashSortService?.status.running || scannerService?.status.running || stashTabAdminService?.status.running || bagTriageService?.status.running || followerService?.driving()) return "Paused while another game action is running";
      return undefined;
    },
  });
  if (combatLoadError) combatService.stop(combatLoadError);
  combatHotkeyRegistered = !backgroundSmoke && globalShortcut.register("F8", () => {
    if (combatService?.status.running) combatService.stop("Paused with F8");
    else void combatService?.start().catch((error) => combatService?.stop(String(error)));
  });
  ipcMain.handle("combat:status", () => combatService!.status);
  ipcMain.handle("combat:global-dry-run", (_event, enabled: unknown) => {
    if (typeof enabled !== "boolean") throw new Error("Invalid dry-run setting");
    combatGlobalDryRun = enabled;
    if (enabled && !combatService!.status.config.dryRun) combatService!.stop("Global Dry-run enabled");
  });
  ipcMain.handle("combat:configure", (_event, config: unknown) => combatService!.configure(config));
  ipcMain.handle("combat:start", () => combatService!.start());
  ipcMain.handle("combat:stop", () => combatService!.stop());
  ipcMain.handle("combat:preview", () => { if (backgroundSmoke) throw new Error("Game capture is disabled during background UI smoke checks."); return combatService!.preview(); });
  if (!backgroundSmoke) globalShortcut.register("CommandOrControl+D", () => {
    lastClipboard = "";
    void evaluateClipboard();
  });
  try {
    installVoiceHotkey(voiceConfig);
  } catch {
    // The UI exposes the registration error and permits a different accelerator.
  }
  ipcMain.handle("qa:kill-latched", () => killSwitch.isLatched());
  ipcMain.handle("qa:rearm", () => {
    if (backgroundSmoke) return true;
    killSwitch.rearm();
    return killSwitch.isLatched();
  });
  // Numpad hotkey bindings shared with the standalone action daemon
  // (scripts/action-daemon.ts): the daemon re-reads the file on every
  // keypress, so a save here applies live.
  ipcMain.handle("hotkeys:get", () => {
    const loaded = loadHotkeyBindings(process.cwd());
    return {
      actions: HOTKEY_ACTIONS,
      reserved: RESERVED_CONTROL_KEYS,
      bindings: loaded.bindings,
      issues: loaded.issues,
      source: loaded.source,
    };
  });
  ipcMain.handle("hotkeys:save", (_event, raw: unknown) =>
    saveHotkeyBindings(process.cwd(), raw),
  );
  ipcMain.handle("hotkeys:daemon-status", () => {
    const logFile = path.join(process.cwd(), "artifacts", "action-daemon.log");
    try {
      if (!existsSync(logFile)) return { exists: false };
      const stat = statSync(logFile);
      const lines = readFileSync(logFile, "utf8").trimEnd().split(/\r?\n/);
      return {
        exists: true,
        lastEventAt: stat.mtime.toISOString(),
        lastLine: lines[lines.length - 1] ?? "",
      };
    } catch {
      return { exists: false };
    }
  });
  ipcMain.handle("assistive:status", () => ({
    ...assistiveService?.status,
    mode: buildMode,
    qaOptIn: true,
  }));
  ipcMain.handle("assistive:start", (_event, request: AssistiveRunRequest) => { assertBagIdle(); return assistiveService?.start(request); });
  ipcMain.handle("assistive:stop", () => {
    void voiceService?.cancel("operator-stop");
    assistiveService?.stop("operator-stop");
    return assistiveService?.status;
  });
  ipcMain.handle("assistive:hide-overlay", () => {
    assistiveService?.hideOverlay();
    return assistiveService?.status;
  });
  ipcMain.handle("assistive:overlay-select", (_event, x: number, y: number, additive?: boolean) => {
    const cell = dryRunOverlay?.cellAtLocalPoint(Number(x), Number(y));
    return assistiveService?.selectOverlayCell(cell, { additive: Boolean(additive) });
  });
  ipcMain.handle("assistive:overlay-label", (_event, label: "right" | "wrong") =>
    assistiveService?.labelOverlayCell(label === "wrong" ? "wrong" : "right"),
  );
  ipcMain.handle("assistive:send-to-cursor", async () => {
    if (!assistiveService) {
      return {
        ok: false,
        opened: false,
        copied: false,
        truncated: false,
        findings: false,
        method: "none" as const,
        message: "Fix in Cursor needs the Electron app.",
      };
    }
    const workspace = findCompanionRepoRoot([
      process.env.POE2_REPO_ROOT ?? "",
      process.cwd(),
      app.getAppPath(),
    ]);
    const evidence = gatherCursorHandoffEvidence({
      memoryRoot,
      artifactDir,
      profile: readMergedProfile(),
      snapshot: assistiveService.cursorHandoffSnapshot(),
      ...(workspace ? { workspace } : {}),
    });
    return launchCursorWithPrompt(evidence, { artifactDir }, {
      writeText: (text) => clipboard.writeText(text),
      openExternal: (url) => shell.openExternal(url),
      spawnCursor: spawnCursorCli,
    });
  });
  ipcMain.handle(
    "assistive:memory-status",
    (_event, payload: { stashTab: "normal" | "quad"; query: string }) =>
      assistiveService?.memoryStatus(payload.stashTab, payload.query),
  );
  ipcMain.handle(
    "assistive:memory-reset",
    (_event, payload: { stashTab: "normal" | "quad"; query: string }) =>
      assistiveService?.resetMemory(payload.stashTab, payload.query),
  );
  ipcMain.handle("stash-sort:status", () => stashSortService?.status);
  ipcMain.handle("stash-sort:start", (_event, request: SortStashRequest) => { assertBagIdle(); return stashSortService?.start(request); });
  ipcMain.handle("stash-sort:stop", () => {
    stashSortService?.stop("operator-stop");
    return stashSortService?.status;
  });
  ipcMain.handle("price-feed:status", () => priceFeedService?.status());
  ipcMain.handle("price-feed:refresh", () => priceFeedService?.refresh());
  ipcMain.handle("price-feed:configure", (_event, partial: Partial<PriceFeedConfig>) =>
    priceFeedService?.configure(partial ?? {}),
  );
  ipcMain.handle("price-feed:comps", (_event, itemText: string) =>
    priceFeedService?.fetchComps(String(itemText ?? "")),
  );
  ipcMain.handle("stash-tabs:status", () => stashTabAdminService?.status);
  ipcMain.handle("stash-valuation:overview", () => stashValuationService?.overview());
  ipcMain.handle("stash-valuation:import-knowledge", (_event, snapshot: unknown) => {
    if (stashTabAdminService?.status.running) throw new Error("Wait for the current stash operation.");
    return stashValuationService?.importKnowledge(snapshot);
  });
  ipcMain.handle("stash-valuation:reassess", () => {
    if (stashTabAdminService?.status.running) throw new Error("Wait for the current stash operation.");
    return stashValuationService?.reassess();
  });
  ipcMain.handle("stash-valuation:save-settings", (_event, settings: unknown) => {
    if (stashTabAdminService?.status.running) throw new Error("Wait for the current stash operation before changing valuation settings.");
    return stashValuationService?.saveSettings(settings);
  });
  ipcMain.handle("stash-tabs:survey", (_event, folderName?: string) =>
    stashTabAdminService?.survey(folderName),
  );
  ipcMain.handle(
    "stash-tabs:plan",
    (_event, payload: { tabs: SurveyedStashTab[]; requireQuad?: boolean; allowPricedTabs?: boolean }) =>
      stashTabAdminService?.plan(payload.tabs, payload.requireQuad, payload.allowPricedTabs),
  );
  ipcMain.handle(
    "stash-tabs:apply",
    (_event, payload: { plan: StashTabPlan; dryRun?: boolean; allowPricedTabs?: boolean }) =>
      stashTabAdminService?.apply(payload.plan, {
      dryRun: payload.dryRun,
      allowPricedTabs: payload.allowPricedTabs,
    }),
  );
  ipcMain.handle("stash-tabs:run-script", (_event, kind: string) =>
    stashTabAdminService?.runScript(kind as never),
  );
  ipcMain.handle("stash-tabs:stop-script", () => stashTabAdminService?.stopScript());
  ipcMain.handle("stash-tabs:finds", () => {
    try {
      const file = path.join(app.isPackaged ? memoryRoot : process.cwd(), "artifacts", "tab-admin", "finds.jsonl");
      if (!existsSync(file)) return [];
      return parseFindRecords(readFileSync(file, "utf8")).reverse().slice(0, 100);
    } catch {
      return [];
    }
  });
  // Shop listings (docs/HANDOFF-shop-listings.md): the CLI owns the game
  // driving; the app reads/edits the same artifacts the script does —
  // shop.json (config), listings.jsonl (ledger), shop-scan/plan.json.
  ipcMain.handle("shop:overview", () => {
    try {
      const dir = path.join(app.isPackaged ? memoryRoot : process.cwd(), "artifacts", "tab-admin");
      const read = (name: string): string | undefined => {
        const file = path.join(dir, name);
        return existsSync(file) ? readFileSync(file, "utf8") : undefined;
      };
      const configRaw = read("shop.json");
      const { config, issues } = parseShopConfig(
        configRaw ? (JSON.parse(configRaw) as unknown) : undefined,
      );
      const events = parseListingEvents(read("listings.jsonl") ?? "");
      const scanRaw = read("shop-scan.json");
      const planRaw = read("shop-plan.json");
      return {
        config,
        issues,
        state: deriveShopState(events),
        stats: salesStats(events),
        eventCount: events.length,
        recentEvents: events.slice(-25).reverse(),
        scan: scanRaw ? (JSON.parse(scanRaw) as unknown) : null,
        plan: planRaw ? (JSON.parse(planRaw) as unknown) : null,
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle("shop:save-config", (_event, raw: unknown) => {
    const { config, issues } = parseShopConfig(raw);
    const dir = path.join(app.isPackaged ? memoryRoot : process.cwd(), "artifacts", "tab-admin");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "shop.json"), JSON.stringify(config, null, 2));
    return { config, issues };
  });
  ipcMain.handle("voice:status", () => voiceStatus());
  ipcMain.handle("voice:trigger", () => { if (backgroundSmoke) throw new Error("Voice is disabled during background UI smoke checks."); return voiceService?.trigger("ui"); });
  ipcMain.handle("voice:cancel", () => voiceService?.cancel("voice-operator-cancel"));
  ipcMain.handle(
    "voice:configure",
    (_event, payload: Partial<VoiceTransferConfig>) => {
      const previous = voiceConfig;
      const next = normalizeVoiceTransferConfig(payload, previous);
      installVoiceHotkey(next);
      try {
        saveVoiceTransferConfig(memoryRoot, next);
        voiceConfig = next;
      } catch (reason) {
        try {
          installVoiceHotkey(previous);
        } catch {
          // Preserve the original persistence error.
        }
        throw reason;
      }
      sendVoiceStatus();
      return voiceStatus();
    },
  );
  ipcMain.handle("item:from-clipboard", () => {
    lastClipboard = "";
    return evaluateClipboard();
  });
  ipcMain.handle("item:evaluate-text", (_event, text: string) => {
    lastClipboard = "";
    return evaluateItemText(String(text ?? ""), "paste");
  });
  ipcMain.handle("poe:windows", () => listPoeProcesses());
  ipcMain.handle("filter:generate", (_event, options) => generateLootFilter(options));
  ipcMain.handle("runtime:mode", () => buildMode);
  if (backgroundSmoke) {
    ipcMain.handle("cal:profile", () => readMergedProfile());
    ipcMain.handle("cal:target", () => { throw new Error("Game detection is disabled during background UI smoke checks."); });
  } else registerCalibrationIpc();
  createWindow();
  if (!backgroundSmoke) {
    priceHelperService = installPriceHelper(() => mainWindow, (identity, league, canRun) => priceFeedService!.fetchHelperReward(identity, league, canRun));
    const stopWorkflows = () => {
      bagTriageService?.stop(); stashTabAdminService?.stopScript(); combatService?.stop(); followerService?.stop();
      void voiceService?.cancel("operator-stop"); assistiveService?.stop("operator-stop"); stashSortService?.stop("operator-stop"); scannerService?.stop("operator-stop");
    };
    const setDryRun = (enabled: boolean) => {
      deckPreferences = { ...deckPreferences, dryRun: enabled }; combatGlobalDryRun = enabled;
      voiceConfig = { ...voiceConfig, dryRun: enabled };
      if (enabled && !combatService!.status.config.dryRun) combatService!.stop("Global Dry-run enabled");
      mainWindow?.webContents.send("deck:dry-run", enabled);
    };
    ipcMain.handle("deck:preferences", (event, value: unknown) => {
      if (event.sender !== mainWindow?.webContents) throw new Error("Untrusted preferences sender");
      const p = value as typeof deckPreferences;
      if (!p || typeof p.dryRun !== "boolean" || !Array.isArray(p.allowlist) || !p.allowlist.length || p.allowlist.some(x => typeof x !== "string" || !x.trim()) || !Number.isInteger(p.transferActionsPerMinute) || p.transferActionsPerMinute < 1 || p.transferActionsPerMinute > 600 || !Number.isInteger(p.sortActionsPerMinute) || p.sortActionsPerMinute < 1 || p.sortActionsPerMinute > 1200) throw new Error("Invalid action preferences");
      deckPreferences = structuredClone(p); combatGlobalDryRun = p.dryRun;
      voiceConfig = { ...voiceConfig, dryRun: p.dryRun };
    });
    void Promise.all([import("./deckRuntime.js"), import("./deckServer.js")]).then(async ([{ DeckRuntime }, { DeckServer }]) => {
      const runtime = deckRuntime = new DeckRuntime({ bag: bagTriageService!, transfer: assistiveService!, sort: stashSortService!, scripts: stashTabAdminService!, combat: combatService!, voice: voiceService!, helper: priceHelperService!, scanner: scannerService!, kill: killSwitch,
        preferences: () => deckPreferences, dryRun: setDryRun, stop: stopWorkflows, emergencyStop: stopAllInput,
        rearm: () => { killSwitch.rearm(); },
        navigate: route => { activateMainWindow?.(); mainWindow?.webContents.send("deck:navigate", route); },
        evaluate: () => { lastClipboard = ""; return evaluateClipboard(); }, refreshFeed: () => priceFeedService!.refresh(), reassess: () => stashValuationService!.reassess(),
      });
      deckServer = new DeckServer(runtime, (ack, action) => {
        mkdirSync(artifactDir, { recursive: true }); appendFileSync(path.join(artifactDir, "stream-deck-actions.jsonl"), JSON.stringify({ at: new Date().toISOString(), action, ...ack }) + "\n");
      });
      await deckServer.listen(path.join(memoryRoot, "stream-deck"));
    }).catch(error => { console.error("Stream Deck connection unavailable:", error); });
    setInterval(() => { void evaluateClipboard(); }, 750);
  }
});

app.on("window-all-closed", () => {
  followerService?.stop("App closed");
  bagTriageService?.stop("App closed");
  stashTabAdminService?.stopScript("App closed");
  emergencyStopMonitor?.close();
  combatService?.stop("App closed");
  void voiceService?.cancel("app-closed");
  assistiveService?.stop("app-closed");
  stashSortService?.stop("app-closed");
  scannerService?.stop("app-closed");
  priceFeedService?.dispose();
  priceFeedService = undefined;
  dryRunOverlay?.dispose();
  dryRunOverlay = undefined;
  localPersistence?.close();
  localPersistence = undefined;
  globalShortcut.unregisterAll();
  app.quit();
});
app.on("before-quit", () => {
  followerService?.stop("App exiting");
  deckServer?.close();
  bagTriageService?.stop("App exiting");
  stashTabAdminService?.stopScript("App exiting");
  combatService?.stop("App exiting");
  emergencyStopMonitor?.close();
});
