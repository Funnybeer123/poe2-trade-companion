import { BagTriageService } from "./bagTriageService.js";
import { prepareBagCountdownWindow } from "./bagCountdownWindow.js";
let bagTriageService: BagTriageService | undefined;
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Notification,
  shell,
} from "electron";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WindowsSpeechRecognizer } from "../adapters/windowsSpeechRecognizer.js";
import { KillSwitch } from "../core/killSwitch.js";
import { startEmergencyStopMonitor } from "../adapters/emergencyStopMonitor.js";
import { defaultCombatConfig } from "../core/combatAssist.js";
import { CombatAssistService, combatStorage } from "./combatAssistService.js";
import { chatHostBusyReason } from "./chatCommandService.js";
import { memoizeAsync } from "../core/memoizeAsync.js";
import { looksLikePoeItemText, parseItemText } from "../core/parseItem.js";
import { enrichItemSize, itemSizeDatabasePath, loadItemSizeDatabase } from "../core/itemSizeStore.js";
import { FixtureMarketProvider } from "../core/market.js";
import { valueItem } from "../core/valuation.js";
import { valueItemLocally } from "../core/localValuation.js";
import { starterPriceTable, type PriceTable } from "../core/priceTable.js";
import type { CompsSummary } from "../core/tradeComps.js";
import type { ParsedItem, ValuationResult } from "../core/types.js";
import { scoreBuildAwareDesirability } from "../core/gearTargetMatcher.js";
import { compileRules, type ScanHistoryItem } from "../core/scanRules.js";
import { resolveBuildMode } from "../core/capabilities.js";
import { loadHotkeyBindings, saveHotkeyBindings } from "../core/hotkeyBindings.js";
import { HOTKEY_ACTIONS, RESERVED_CONTROL_KEYS } from "../shared/hotkeyActions.js";
import { parseFindRecords } from "../core/sortTriage.js";
import {
  latestObservations,
  locationStaleness,
  netWorth,
  parseInventoryRecords,
  sellCandidates,
} from "../core/inventoryLedger.js";
import {
  deriveShopState,
  parseListingEvents,
  parseShopConfig,
} from "../core/shopListings.js";
import { salesStats } from "../core/shopPricing.js";
import { generateLootFilter, type LootFilterRequest } from "../core/lootFilter.js";
import {
  normalizeVoiceTransferConfig,
  type VoiceTransferConfig,
  type VoiceTransferState,
  type VoiceTransferStatus,
} from "../core/voiceTransfer.js";
import { readMergedProfile, registerCalibrationIpc } from "./calibrationIpc.js";
import { registerFlaskGuardIpc } from "./flaskGuardIpc.js";
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
import {
  ITEM_INTELLIGENCE_IPC_VERSION,
  type InventoryOverviewQuery,
  type InventoryOverviewView,
  type ParsedItemEvaluation,
} from "../shared/ipc.js";
import { openLocalPersistence, type LocalPersistenceDatabase } from "./persistence/index.js";
import { ItemIntelligenceService } from "./itemIntelligenceService.js";
import { PriceFeedService, type PriceFeedConfig } from "./priceFeedService.js";
import { loadPriceTrainingContext } from "../adapters/priceTrainingStore.js";
import { registerItemIntelligenceIpc } from "./itemIntelligenceIpc.js";
import { registerScanIpc } from "./scanIpc.js";
import { StashTabAdminService } from "./stashTabAdminService.js";
import type { StashTabPlan, SurveyedStashTab } from "../core/stashTabAdmin.js";
import {
  JsonlScanSessionStorage,
  ScanSessionStore,
  type ScanSession,
} from "./scanSessionStore.js";
import { ScannerRuntimeService } from "./scanRuntimeService.js";
import { MarketTrendsService, type MarketTrendsQuery } from "./marketTrendsService.js";
import { WatchlistService } from "./watchlistService.js";
import { createFeatureRuntime, type FeatureRuntime } from "./features/context.js";
import { FEATURE_MODULES } from "./features/registry.js";
import { SettingsStore, settingsFilePath } from "./settingsStore.js";
import type { WatchlistSaveRequest } from "../shared/ipc.js";

const execFileAsync = promisify(execFile);
const buildMode = resolveBuildMode(
  typeof __POE2_BUILD_MODE__ === "undefined" ? process.env.POE2_BUILD_MODE : __POE2_BUILD_MODE__,
);
const killSwitch = new KillSwitch();
function assertBagIdle() {
  if (bagTriageService?.status.running) throw new Error("Stop the bag workflow before starting another game action.");
  if (combatService?.status.running) throw new Error("Pause combat assistance before starting another game action.");
}

let mainWindow: BrowserWindow | undefined;
let assistiveService: AssistiveRunService | undefined;
let dryRunOverlay: DryRunOverlayWindow | undefined;
let stashSortService: StashSortService | undefined;
let stashTabAdminService: StashTabAdminService | undefined;
let voiceService: VoiceTransferService | undefined;
let voiceConfig = normalizeVoiceTransferConfig(undefined);
let registeredVoiceHotkey: string | undefined;
let voiceHotkeyError = "";
let lastClipboard = "";
let localPersistence: LocalPersistenceDatabase | undefined;
let itemIntelligenceService: ItemIntelligenceService | undefined;
let priceFeedService: PriceFeedService | undefined;
let scannerService: ScannerRuntimeService | undefined;
let marketTrendsService: MarketTrendsService | undefined;
let watchlistService: WatchlistService | undefined;
let featureRuntime: FeatureRuntime | undefined;
let combatService: CombatAssistService | undefined;
let combatGlobalDryRun = true;
let emergencyStopMonitor: ReturnType<typeof startEmergencyStopMonitor> | undefined;

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

/**
 * Fixture quotes are test/replay data only. They drive a valuation solely
 * when POE2_FIXTURE_MARKET=1 (deterministic e2e/replay runs); a normal
 * session never sees them.
 */
function useFixtureMarket(): boolean {
  return process.env.POE2_FIXTURE_MARKET === "1";
}

async function fixtureValuation(parsed: ParsedItem): Promise<ValuationResult> {
  const quotes = JSON.parse(readFileSync(quotesFile(), "utf8")) as Record<
    string,
    Array<{ listingId: string; priceAmount: number; priceCurrency: string }>
  >;
  const quote = await new FixtureMarketProvider(quotes).quote(parsed, {
    league: "Standard",
    currency: "exalted",
  });
  return valueItem(parsed, quote);
}

/**
 * Fingerprint of the evaluation the renderer currently shows. A background
 * comps fetch only republishes when its item is still the one on screen.
 */
let latestPublishedFingerprint = "";

async function evaluateItemText(
  text: string,
  source: "clipboard" | "paste" | "scan" = "clipboard",
  publishEvaluation = true,
  options: {
    /**
     * Fetch trade2 comps in the background when none are cached. Only set by
     * user-initiated checks (Ctrl+D, Read clipboard, Evaluate text); the
     * passive clipboard poller and scans never touch the network.
     */
    fetchComps?: boolean;
  } = {},
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
  const parsed = parseItemText(text);
  const item = enrichItemSize(parsed, loadItemSizeDatabase(sizeDatabaseFile()));
  let tier: ParsedItemEvaluation["tier"];
  try {
    tier = itemIntelligenceService?.evaluateTier(text);
  } catch {
    // Tier config problems must never block a plain evaluation.
  }
  let priceTable: PriceTable | undefined;
  try {
    priceTable = itemIntelligenceService?.getPriceTable();
  } catch {
    // A corrupt table just means no price-table evidence this time.
  }
  const fixture = useFixtureMarket();
  // Cached comps only here: a price check must never block on the network.
  const cachedComps = fixture ? undefined : priceFeedService?.peekComps(text);
  const valueWith = async (comps: CompsSummary | undefined): Promise<ValuationResult> =>
    fixture
      ? fixtureValuation(parsed)
      : valueItemLocally({
          parsed,
          ...(priceTable ? { priceTable } : {}),
          ...(tier ? { verdict: tier } : {}),
          ...(comps ? { comps } : {}),
          now: new Date(),
        });
  const assemble = (valuation: ValuationResult): ParsedItemEvaluation => {
    const { desirability } = scoreBuildAwareDesirability(
      item,
      valuation,
      localPersistence?.buildProfiles.list() ?? [],
      tier,
    );
    return {
      schemaVersion: ITEM_INTELLIGENCE_IPC_VERSION,
      raw: text,
      parsed: true,
      item,
      valuation,
      desirability,
      ...(tier ? { tier } : {}),
    };
  };
  const payload = assemble(await valueWith(cachedComps));
  itemIntelligenceService?.recordEvaluation(payload, source);
  if (publishEvaluation) {
    latestPublishedFingerprint = item.fingerprint;
    mainWindow?.webContents.send("item:evaluated", payload);
  }

  const userInitiated = source === "clipboard" || source === "paste";
  if (
    options.fetchComps &&
    userInitiated &&
    !fixture &&
    !cachedComps &&
    !tier?.training?.lessonIds.length &&
    priceFeedService &&
    looksLikePoeItemText(text)
  ) {
    const feed = priceFeedService;
    void feed
      .fetchComps(text)
      .then(async (result) => {
        if (!result.ok || !result.summary || result.summary.sampleSize < 1) return;
        // Only re-publish while the same item is still on screen.
        if (publishEvaluation && latestPublishedFingerprint !== item.fingerprint) return;
        const refreshed = assemble(await valueWith(result.summary));
        itemIntelligenceService?.recordEvaluation(refreshed, source);
        if (publishEvaluation) mainWindow?.webContents.send("item:evaluated", refreshed);
      })
      .catch(() => undefined);
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
    const dir = path.join(process.cwd(), "artifacts", "tab-admin");
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

/**
 * Stash net worth (docs/USER_GUIDE.md "Wealth"): the sorter's inventory
 * ledger reduced to current whereabouts and priced with the app's table.
 * `persist` mirrors the observations into the SQLite catalog so the Item log
 * shows where everything is — inside try/catch, because a missing native
 * module must never take the Wealth page down with it.
 */
function inventoryOverview(
  query: InventoryOverviewQuery | undefined,
  persist: boolean,
): InventoryOverviewView {
  const generatedAt = new Date().toISOString();
  const file = path.join(process.cwd(), "artifacts", "tab-admin", "inventory.jsonl");
  try {
    const records = existsSync(file) ? parseInventoryRecords(readFileSync(file, "utf8")) : [];
    const observations = latestObservations(records);
    const priceTable = itemIntelligenceService?.getPriceTable() ?? starterPriceTable();
    const worth = netWorth(observations, priceTable);
    const candidates = sellCandidates(observations, {
      priceTable,
      minExalted: query?.minExalted ?? 1,
      maxExalted: query?.maxExalted ?? 5,
      excludeLocations: query?.excludeLocations ?? [],
    });
    const topItems = [...worth.valued]
      .filter((entry) => entry.valueExalted !== undefined)
      .sort((a, b) => (b.valueExalted ?? 0) - (a.valueExalted ?? 0))
      .slice(0, 25);
    const view: InventoryOverviewView = {
      generatedAt,
      file,
      recordCount: records.length,
      observationCount: observations.length,
      worth,
      topItems,
      sellCandidates: candidates,
      staleness: locationStaleness(records, generatedAt),
    };
    if (persist && localPersistence) {
      try {
        const persistence = localPersistence;
        let upserts = 0;
        persistence.transaction(() => {
          for (const entry of worth.valued) {
            const { observation } = entry;
            const existing = persistence.catalogItems.getByFingerprint(observation.fingerprint);
            const previous =
              existing && typeof existing.payload === "object" && existing.payload !== null
                ? (existing.payload as Record<string, unknown>)
                : {};
            persistence.catalogItems.upsert({
              fingerprint: observation.fingerprint,
              name: observation.name,
              baseType: observation.baseType || observation.name,
              itemClass: observation.itemClass,
              currentLocation: observation.location,
              ...(observation.tier ? { recommendation: observation.tier } : {}),
              ...(entry.valueExalted !== undefined ? { fairValue: entry.valueExalted } : {}),
              payload: {
                ...previous,
                inventory: {
                  at: observation.at,
                  runId: observation.runId,
                  location: observation.location,
                  cells: observation.cells,
                  count: observation.count ?? 1,
                  ...(observation.stackCount !== undefined
                    ? { stackCount: observation.stackCount }
                    : {}),
                  ...(observation.estimate ? { estimate: observation.estimate } : {}),
                  ...(entry.valueExalted !== undefined
                    ? { valueExalted: entry.valueExalted, valueSource: entry.source }
                    : {}),
                },
              },
            });
            upserts += 1;
          }
        });
        view.catalogUpserts = upserts;
        if (itemIntelligenceService) {
          mainWindow?.webContents.send("catalog:changed", itemIntelligenceService.listCatalog());
        }
      } catch (error) {
        view.catalogError = error instanceof Error ? error.message : String(error);
      }
    }
    return view;
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      generatedAt,
      file,
      recordCount: 0,
      observationCount: 0,
      topItems: [],
      sellCandidates: [],
      staleness: [],
    };
  }
}

/**
 * `explicit` marks a deliberate price check (Ctrl+D, Items → Read clipboard)
 * that may spend a trade2 lookup; the 750ms poller passes false so copying
 * items for any other reason (sorting, listing) stays offline.
 */
async function evaluateClipboard(explicit = false) {
  const text = clipboard.readText();
  if (!text || text === lastClipboard) return null;
  lastClipboard = text;
  return evaluateItemText(text, "clipboard", true, { fetchComps: explicit });
}

// Clipboard polling is gated on relevance: every 750 ms while the app window
// is focused or a Path of Exile window was seen in the last 60 s (recorded
// whenever listPoeProcesses returns a row), every 3 s otherwise, and skipped
// entirely while the window is minimized or hidden. Ctrl+D and the IPC paths
// call evaluateClipboard directly and stay immediate.
const CLIPBOARD_POLL_ACTIVE_MS = 750;
const CLIPBOARD_POLL_IDLE_MS = 3_000;
const POE_WINDOW_RECENT_MS = 60_000;
let lastPoeWindowSeenAt = 0;

function clipboardPollPlan(): { read: boolean; nextMs: number } {
  const window = mainWindow;
  if (!window || window.isDestroyed() || window.isMinimized() || !window.isVisible()) {
    return { read: false, nextMs: CLIPBOARD_POLL_IDLE_MS };
  }
  const poeRecent = Date.now() - lastPoeWindowSeenAt < POE_WINDOW_RECENT_MS;
  return {
    read: true,
    nextMs: window.isFocused() || poeRecent ? CLIPBOARD_POLL_ACTIVE_MS : CLIPBOARD_POLL_IDLE_MS,
  };
}

function clipboardPollTick(): void {
  const { read, nextMs } = clipboardPollPlan();
  if (read) void evaluateClipboard();
  setTimeout(clipboardPollTick, nextMs);
}

// Enumerating processes costs a PowerShell launch, and the renderer asks every
// 2.5–5 s for the app's lifetime, so answers are memoized for 4 s and
// concurrent asks share one in-flight query. The seen-stamp above is still
// written only when a query really observed a Path of Exile row.
const POE_WINDOW_LIST_TTL_MS = 4_000;
const listPoeProcessesMemoized = memoizeAsync(
  async () => {
    const rows = await listPoeProcessesUncached();
    if (rows.length > 0) lastPoeWindowSeenAt = Date.now();
    return rows;
  },
  { ttlMs: POE_WINDOW_LIST_TTL_MS },
);

function listPoeProcesses(): Promise<Array<{ name: string; title: string }>> {
  return listPoeProcessesMemoized();
}

async function listPoeProcessesUncached(): Promise<Array<{ name: string; title: string }>> {
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

app.whenReady().then(async () => {
  const memoryRoot = app.getPath("userData");
  const artifactDir = path.join(memoryRoot, "assistive-artifacts");
  localPersistence = openLocalPersistence(
    path.join(memoryRoot, "item-intelligence.sqlite"),
  );
  itemIntelligenceService = new ItemIntelligenceService({
    persistence: localPersistence,
    priceTraining: () => loadPriceTrainingContext(
      path.join(process.cwd(), "artifacts", "tab-admin"), priceFeedService?.status().resolvedLeague),
    publish: (channel, payload) => {
      mainWindow?.webContents.send(channel, payload);
      if (channel === "tiers:changed" || channel === "prices:changed") {
        exportTriageSnapshot();
      }
    },
  });
  // One market-data config dir for the app AND the CLIs (artifacts/tab-admin,
  // where the triage export already lives): the trade2 pacing log, the comps
  // cache, the league config and the feed snapshot are shared, so the two
  // never double-spend the rate budget or disagree on the league. Files the
  // app used to keep under userData move over once, never overwriting.
  const feedConfigDir = path.join(process.cwd(), "artifacts", "tab-admin");
  for (const name of ["price-feed.json", "comps-cache.json", "trade-pacing.json"]) {
    try {
      const from = path.join(memoryRoot, name);
      const to = path.join(feedConfigDir, name);
      if (existsSync(from) && !existsSync(to)) {
        mkdirSync(feedConfigDir, { recursive: true });
        writeFileSync(to, readFileSync(from));
      }
    } catch {
      // A failed migration only means a cold cache in the new home.
    }
  }
  priceFeedService = new PriceFeedService({
    configDir: feedConfigDir,
    getPriceTable: () => itemIntelligenceService!.getPriceTable(),
    savePriceTable: (table) => itemIntelligenceService!.savePriceTable(table),
  });
  // Reads the feed's league from the same directory; writes only its own cache.
  // Same directory as the price feed so the league choice is shared with the CLIs.
  marketTrendsService = new MarketTrendsService({ configDir: feedConfigDir });
  // Deals watchlist: shares the feed's trade2 budget and league; its own
  // two files live next to the pacing log. Alerts notify, never whisper.
  watchlistService = new WatchlistService({
    configDir: feedConfigDir,
    feed: priceFeedService,
    getPriceTable: () => itemIntelligenceService!.getPriceTable(),
    writeClipboard: (text) => clipboard.writeText(text),
    notify: ({ title, body }) => {
      if (!Notification.isSupported()) return;
      new Notification({ title, body }).show();
    },
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
  registerScanIpc(ipcMain, scannerService, assertBagIdle);
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
    onEvent: (event) => mainWindow?.webContents.send("assistive:event", event),
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
    onEvent: (event) => mainWindow?.webContents.send("stash-sort:event", event),
  });
  stashTabAdminService = new StashTabAdminService({
    root: process.cwd(),
    emit: (event) => mainWindow?.webContents.send("stash-tabs:event", event),
    canRun: () => !killSwitch.isLatched() && !bagTriageService?.status.running && !combatService?.status.running,
  });
  bagTriageService = new BagTriageService({
    root: app.getAppPath(), dataRoot: app.isPackaged ? memoryRoot : process.cwd(), templateDir: baselineDir,
    perceptionFile: process.env.POE2_BAG_PERCEPTION_FILE, clientLog: process.env.POE2_CLIENT_LOG,
    ...(app.isPackaged ? { workerFile: path.join(app.getAppPath().replace(/app\.asar$/, "app.asar.unpacked"), "dist-electron", "map-triage.cjs") } : {}),
    emit: status => {
      prepareBagCountdownWindow(mainWindow, status.phase);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("bag-triage:status-changed", status);
    },
    blocked: () => killSwitch.isLatched() ? "Rearm the emergency stop before starting a bag stage."
      : assistiveService?.status.running || stashSortService?.status.running || scannerService?.status.running || stashTabAdminService?.status.running || combatService?.status.running
        ? "Stop the current game action before starting a bag stage." : undefined,
  });
  ipcMain.handle("bag-triage:status", () => bagTriageService!.refresh());
  ipcMain.handle("bag-triage:select", (_event, journal: string) => bagTriageService!.select(journal));
  ipcMain.handle("bag-triage:start", (_event, stage) => bagTriageService!.start(stage));
  ipcMain.handle("bag-triage:stop", () => bagTriageService!.stop());
  bagTriageService.setCleanupHotkey(globalShortcut.register("CommandOrControl+Alt+V", () => {
    bagTriageService?.startCleanupFromHotkey();
  }));
  voiceService = new VoiceTransferService({
    mode: buildMode,
    recognizer: new WindowsSpeechRecognizer(),
    config: () => voiceConfig,
    assistiveStatus: () => assistiveService!.status,
    startTransfer: (request) => { assertBagIdle(); return assistiveService!.start(request); },
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
  const stopAllInput = () => {
    killSwitch.trip();
    bagTriageService?.stop("Emergency stop");
    stashTabAdminService?.stopScript();
    combatService?.stop("Emergency stop — rearm in the app");
    void voiceService?.cancel("emergency-stop");
    assistiveService?.stop("emergency-stop");
    stashSortService?.stop("emergency-stop");
    scannerService?.stop("emergency-stop");
    mainWindow?.webContents.send("qa:killed");
  };
  const emergencyStopRegistered = globalShortcut.register("CommandOrControl+Shift+Escape", stopAllInput);
  globalShortcut.register("CommandOrControl+Shift+F12", stopAllInput);
  if (!emergencyStopRegistered) {
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
      const chatBusy = chatHostBusyReason(featureRuntime?.ctx.get("chatCommands"));
      if (chatBusy) return chatBusy;
      if (assistiveService?.status.running || stashSortService?.status.running || scannerService?.status.running || stashTabAdminService?.status.running || bagTriageService?.status.running) return "Paused while another game action is running";
      return undefined;
    },
  });
  if (combatLoadError) combatService.stop(combatLoadError);
  combatHotkeyRegistered = globalShortcut.register("F8", () => {
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
  ipcMain.handle("combat:preview", () => combatService!.preview());
  globalShortcut.register("CommandOrControl+D", () => {
    lastClipboard = "";
    void evaluateClipboard(true);
    // The classic price check spends the one comps lookup; the Evaluate panel
    // opens with autoSearch off and spends nothing until the user searches.
    void featureRuntime?.ctx.get("hotkeys")?.trigger("evaluate.clipboard");
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
  ipcMain.handle("stash-sort:start", (_event, request: SortStashRequest) =>
    { assertBagIdle(); return stashSortService?.start(request); },
  );
  ipcMain.handle("stash-sort:stop", () => {
    stashSortService?.stop("operator-stop");
    return stashSortService?.status;
  });
  ipcMain.handle("price-feed:status", () => priceFeedService?.status());
  ipcMain.handle("price-feed:leagues", () => priceFeedService?.leagues());
  ipcMain.handle("price-feed:refresh", () => priceFeedService?.refresh());
  ipcMain.handle("price-feed:configure", (_event, partial: Partial<PriceFeedConfig>) =>
    priceFeedService?.configure(partial ?? {}),
  );
  ipcMain.handle("price-feed:comps", (_event, itemText: string) =>
    priceFeedService?.fetchComps(String(itemText ?? "")),
  );
  ipcMain.handle("stash-tabs:status", () => stashTabAdminService?.status);
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
    { assertBagIdle(); return stashTabAdminService?.runScript(kind as never); },
  );
  ipcMain.handle("stash-tabs:stop-script", () => stashTabAdminService?.stopScript());
  ipcMain.handle("stash-tabs:finds", () => {
    try {
      const file = path.join(process.cwd(), "artifacts", "tab-admin", "finds.jsonl");
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
      const dir = path.join(process.cwd(), "artifacts", "tab-admin");
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
    const dir = path.join(process.cwd(), "artifacts", "tab-admin");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "shop.json"), JSON.stringify(config, null, 2));
    return { config, issues };
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
    return evaluateClipboard(true);
  });
  ipcMain.handle("item:evaluate-text", (_event, text: string) => {
    lastClipboard = "";
    return evaluateItemText(String(text ?? ""), "paste", true, { fetchComps: true });
  });
  ipcMain.handle("poe:windows", () => listPoeProcesses());
  // Loot filter: the main process supplies the live price table and league;
  // the renderer only chooses thresholds. Saving goes through the OS save
  // dialog to a path the user picks — the app never writes game files silently.
  ipcMain.handle("filter:generate", (_event, request: LootFilterRequest) => {
    const status = priceFeedService?.status();
    const league =
      status?.resolvedLeague ??
      (status && status.config.league !== "auto" ? status.config.league : undefined);
    return generateLootFilter({
      ...(request ?? {}),
      priceTable: itemIntelligenceService?.getPriceTable() ?? starterPriceTable(),
      ...(league ? { league } : {}),
    });
  });
  ipcMain.handle(
    "filter:save",
    async (_event, payload: { text: string; name?: string }) => {
      const text = String(payload?.text ?? "");
      if (!text.trim()) return { saved: false as const, reason: "empty" };
      const fileName = `${(payload?.name ?? "poe2-companion").replace(/[^\w.-]+/g, "-") || "poe2-companion"}.filter`;
      const documents = app.getPath("documents");
      const gameDir = path.join(documents, "My Games", "Path of Exile 2");
      const defaultDir = existsSync(gameDir) ? gameDir : documents;
      const result = await dialog.showSaveDialog({
        title: "Save loot filter",
        defaultPath: path.join(defaultDir, fileName),
        filters: [{ name: "Path of Exile item filter", extensions: ["filter"] }],
      });
      if (result.canceled || !result.filePath) return { saved: false as const, reason: "canceled" };
      writeFileSync(result.filePath, text, "utf8");
      return { saved: true as const, path: result.filePath };
    },
  );
  ipcMain.handle("runtime:mode", () => buildMode);
  // Stash net worth: the sorter's inventory ledger, priced and reduced.
  ipcMain.handle("inventory:overview", (_event, query?: InventoryOverviewQuery) =>
    inventoryOverview(query, false),
  );
  ipcMain.handle("inventory:refresh", (_event, query?: InventoryOverviewQuery) =>
    inventoryOverview(query, true),
  );
  ipcMain.handle("market:trends", (_event, query?: MarketTrendsQuery) =>
    marketTrendsService?.getTrends(query ?? {}),
  );
  ipcMain.handle("market:trends-refresh", () => marketTrendsService?.getTrends({ refresh: true }));
  ipcMain.handle("watchlist:overview", () => watchlistService?.overview());
  ipcMain.handle("watchlist:save", (_event, request: WatchlistSaveRequest) =>
    watchlistService?.save(request ?? {}),
  );
  ipcMain.handle("watchlist:scan-now", (_event, watchId?: string) =>
    watchlistService?.scanNow(typeof watchId === "string" && watchId ? watchId : undefined),
  );
  ipcMain.handle("watchlist:copy-whisper", (_event, alertId: string) =>
    watchlistService?.copyWhisper(String(alertId ?? "")) ?? { ok: false, error: "Watchlist unavailable." },
  );
  ipcMain.handle("watchlist:dismiss", (_event, alertId: string) =>
    watchlistService?.dismiss(String(alertId ?? "")),
  );
  registerCalibrationIpc();
  // Auto-flask guard config + click calibration; same root as the hotkey bindings.
  registerFlaskGuardIpc(process.cwd());
  // Feature modules (docs/HANDOFF-overlay-port.md): the ported overlay
  // features register their channels here; no shared file changes per feature.
  const companionSettings = new SettingsStore({ file: settingsFilePath(memoryRoot) });
  featureRuntime = createFeatureRuntime({
    ipcMain,
    configDir: feedConfigDir,
    userDataDir: memoryRoot,
    repoRoot: process.cwd(),
    appPath: app.getAppPath(),
    buildMode,
    core: {
      priceFeed: priceFeedService!,
      itemIntelligence: itemIntelligenceService!,
      marketTrends: marketTrendsService!,
      watchlist: watchlistService!,
    },
    settings: companionSettings,
    mainWindow: () => mainWindow,
    poeWindows: () => listPoeProcesses(),
    killSwitchLatched: () => killSwitch.isLatched(),
    notify: (title, body) => {
      if (!Notification.isSupported()) return;
      new Notification({ title, body }).show();
    },
    clipboard: {
      readText: () => clipboard.readText(),
      writeText: (text) => clipboard.writeText(text),
    },
    openExternal: (url) => shell.openExternal(url),
    openPath: (target) => shell.openPath(target),
  });
  const registration = await featureRuntime.register(FEATURE_MODULES);
  for (const failure of registration.failed) {
    console.error(`[features] ${failure.id} failed to register: ${failure.error}`);
  }
  createWindow();
  setTimeout(clipboardPollTick, CLIPBOARD_POLL_ACTIVE_MS);
});

app.on("window-all-closed", () => {
  bagTriageService?.stop("App closed");
  stashTabAdminService?.stopScript();
  combatService?.stop("App closed");
  emergencyStopMonitor?.close();
  void voiceService?.cancel("app-closed");
  assistiveService?.stop("app-closed");
  stashSortService?.stop("app-closed");
  scannerService?.stop("app-closed");
  watchlistService?.dispose();
  watchlistService = undefined;
  priceFeedService?.dispose();
  priceFeedService = undefined;
  marketTrendsService = undefined;
  dryRunOverlay?.dispose();
  dryRunOverlay = undefined;
  void featureRuntime?.dispose();
  featureRuntime = undefined;
  localPersistence?.close();
  localPersistence = undefined;
  globalShortcut.unregisterAll();
  app.quit();
});
app.on("before-quit", () => {
  bagTriageService?.stop("App exiting");
  stashTabAdminService?.stopScript();
  combatService?.stop("App exiting");
  emergencyStopMonitor?.close();
});
