import { app, BrowserWindow, clipboard, globalShortcut, ipcMain } from "electron";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
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
import { generateLootFilter } from "../core/lootFilter.js";
import {
  normalizeVoiceTransferConfig,
  type VoiceTransferConfig,
  type VoiceTransferState,
  type VoiceTransferStatus,
} from "../core/voiceTransfer.js";
import { readMergedProfile, registerCalibrationIpc } from "./calibrationIpc.js";
import { AssistiveRunService, type AssistiveRunRequest } from "./assistiveRunService.js";
import { StashSortService, type SortStashRequest } from "./stashSortService.js";
import { VoiceTransferService } from "./voiceTransferService.js";
import {
  loadVoiceTransferConfig,
  saveVoiceTransferConfig,
} from "./voiceTransferSettings.js";
import { ITEM_INTELLIGENCE_IPC_VERSION, type ParsedItemEvaluation } from "../shared/ipc.js";
import { openLocalPersistence, type LocalPersistenceDatabase } from "./persistence/index.js";
import { ItemIntelligenceService } from "./itemIntelligenceService.js";
import { registerItemIntelligenceIpc } from "./itemIntelligenceIpc.js";
import { registerScanIpc } from "./scanIpc.js";
import {
  JsonlScanSessionStorage,
  ScanSessionStore,
  type ScanSession,
} from "./scanSessionStore.js";
import { ScannerRuntimeService } from "./scanRuntimeService.js";

const execFileAsync = promisify(execFile);
const buildMode = resolveBuildMode(
  typeof __POE2_BUILD_MODE__ === "undefined" ? process.env.POE2_BUILD_MODE : __POE2_BUILD_MODE__,
);
const killSwitch = new KillSwitch();

let mainWindow: BrowserWindow | undefined;
let assistiveService: AssistiveRunService | undefined;
let stashSortService: StashSortService | undefined;
let voiceService: VoiceTransferService | undefined;
let voiceConfig = normalizeVoiceTransferConfig(undefined);
let registeredVoiceHotkey: string | undefined;
let voiceHotkeyError = "";
let lastClipboard = "";
let localPersistence: LocalPersistenceDatabase | undefined;
let itemIntelligenceService: ItemIntelligenceService | undefined;
let scannerService: ScannerRuntimeService | undefined;

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
  const payload: ParsedItemEvaluation = {
    schemaVersion: ITEM_INTELLIGENCE_IPC_VERSION,
    raw: text,
    parsed: true,
    item,
    valuation,
    desirability,
  };
  itemIntelligenceService?.recordEvaluation(payload, source);
  if (publishEvaluation) {
    mainWindow?.webContents.send("item:evaluated", payload);
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

async function evaluateClipboard() {
  const text = clipboard.readText();
  if (!text || text === lastClipboard) return null;
  lastClipboard = text;
  return evaluateItemText(text, "clipboard");
}

async function listPoeProcesses(): Promise<Array<{ name: string; title: string }>> {
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
  mainWindow?.webContents.send("voice:state", voiceStatus());
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
  const previous = registeredVoiceHotkey;
  if (previous) {
    globalShortcut.unregister(previous);
    registeredVoiceHotkey = undefined;
  }
  if (buildMode !== "authorized-qa" || !next.enabled) {
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
    alwaysOnTop: true,
    title: "PoE2 Trade Companion",
    webPreferences: {
      preload: path.join(path.dirname(fileURLToPath(import.meta.url)), "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (process.env.VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(path.join(app.getAppPath(), "dist", "index.html"));
  }
}

app.whenReady().then(() => {
  const memoryRoot = app.getPath("userData");
  const artifactDir = path.join(memoryRoot, "assistive-artifacts");
  localPersistence = openLocalPersistence(
    path.join(memoryRoot, "item-intelligence.sqlite"),
  );
  itemIntelligenceService = new ItemIntelligenceService({
    persistence: localPersistence,
    publish: (channel, payload) =>
      mainWindow?.webContents.send(channel, payload),
  });
  registerItemIntelligenceIpc(ipcMain, itemIntelligenceService);
  scannerService = new ScannerRuntimeService({
    mode: buildMode,
    qaOptIn: process.env.POE2_QA_OPT_IN === "1",
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
    onEvent: (event) =>
      mainWindow?.webContents.send("scanner:event", event),
    onTrace: (trace) => {
      mkdirSync(artifactDir, { recursive: true });
      appendFileSync(
        path.join(artifactDir, "qa-action-trace.jsonl"),
        `${JSON.stringify(trace)}\n`,
        "utf8",
      );
    },
  });
  registerScanIpc(ipcMain, scannerService);
  voiceConfig = loadVoiceTransferConfig(memoryRoot);
  assistiveService = new AssistiveRunService({
    mode: buildMode,
    qaOptIn: process.env.POE2_QA_OPT_IN === "1",
    killSwitch,
    memoryRoot,
    artifactDir,
    profile: readMergedProfile,
    onEvent: (event) => mainWindow?.webContents.send("assistive:event", event),
  });
  stashSortService = new StashSortService({
    mode: buildMode,
    qaOptIn: process.env.POE2_QA_OPT_IN === "1",
    killSwitch,
    artifactDir,
    profile: readMergedProfile,
    sizeDatabase: () => loadItemSizeDatabase(sizeDatabaseFile()),
    onEvent: (event) => mainWindow?.webContents.send("stash-sort:event", event),
  });
  voiceService = new VoiceTransferService({
    mode: buildMode,
    recognizer: new WindowsSpeechRecognizer(),
    config: () => voiceConfig,
    assistiveStatus: () => assistiveService!.status,
    startTransfer: (request) => assistiveService!.start(request),
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
  globalShortcut.register("CommandOrControl+Shift+Escape", () => {
    void voiceService?.cancel("emergency-stop");
    assistiveService?.stop("emergency-stop");
    stashSortService?.stop("emergency-stop");
    scannerService?.stop("emergency-stop");
    mainWindow?.webContents.send("qa:killed");
  });
  globalShortcut.register("CommandOrControl+D", () => {
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
    killSwitch.rearm();
    return killSwitch.isLatched();
  });
  ipcMain.handle("assistive:status", () => ({
    ...assistiveService?.status,
    mode: buildMode,
    qaOptIn: process.env.POE2_QA_OPT_IN === "1",
  }));
  ipcMain.handle("assistive:start", (_event, request: AssistiveRunRequest) => assistiveService?.start(request));
  ipcMain.handle("assistive:stop", () => {
    void voiceService?.cancel("operator-stop");
    assistiveService?.stop("operator-stop");
    return assistiveService?.status;
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
  ipcMain.handle("stash-sort:start", (_event, request: SortStashRequest) =>
    stashSortService?.start(request),
  );
  ipcMain.handle("stash-sort:stop", () => {
    stashSortService?.stop("operator-stop");
    return stashSortService?.status;
  });
  ipcMain.handle("voice:status", () => voiceStatus());
  ipcMain.handle("voice:trigger", () => voiceService?.trigger("ui"));
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
  registerCalibrationIpc();
  createWindow();
  setInterval(() => {
    void evaluateClipboard();
  }, 750);
});

app.on("window-all-closed", () => {
  void voiceService?.cancel("app-closed");
  assistiveService?.stop("app-closed");
  stashSortService?.stop("app-closed");
  scannerService?.stop("app-closed");
  localPersistence?.close();
  localPersistence = undefined;
  globalShortcut.unregisterAll();
  app.quit();
});
