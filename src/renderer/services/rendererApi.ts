import {
  activateBuildProfile,
  createBuildProfile,
  importGearTargets,
  validateBuildProfile,
  type BuildProfile,
  type CreateBuildProfileInput,
} from "@core/buildProfiles";
import type { CalibrationProfile } from "@core/calibrationProfile";
import { scoreDesirability } from "@core/desirability";
import { generateLootFilter } from "@core/lootFilter";
import { FixtureMarketProvider } from "@core/market";
import {
  parseLegacyRegexHistory,
  parseLegacyScanHistory,
  parseLegacyScanJsonl,
  parseLegacyTradePresets,
} from "@core/legacyImports";
import { looksLikePoeItemText, parseItemText } from "@core/parseItem";
import {
  validateRuleRegex,
  type RuleValidationResult,
  type ScanHistoryItem,
} from "@core/scanRules";
import {
  buildSearchRegex,
  type SearchRegexRequest,
  type SearchRegexResult,
} from "@core/searchRegex";
import type { ScreenRect, SelectedMonitor } from "@core/screenLayout";
import type {
  SortMoveSchedule,
  StashSortPlan,
} from "@core/stashSort";
import type {
  StashTabAdminEvent,
  StashTabAdminStatus,
  StashTabApplyOutcome,
  StashTabPlan,
  StashTabSurveyResult,
} from "@core/stashTabAdmin";
import type { FindRecord } from "@core/sortTriage";
import {
  importTradeQueries,
  type TradeQueryImportResult,
} from "@core/tradeQueryImport";
import type {
  DiagnosticCorrection,
  TransferDiagnosticReport,
} from "@core/transferDiagnostics";
import type { UiFacts } from "@core/uiPerception";
import type {
  RuntimeMode,
  NormalizedItem,
} from "@core/types";
import { valueItem } from "@core/valuation";
import type {
  VoiceTransferConfig,
  VoiceTransferState,
  VoiceTransferStatus,
} from "@core/voiceTransfer";
import { DEFAULT_TRIAGE_ROUTING } from "@core/bagTriage";
import {
  starterPriceTable,
  validatePriceTable,
  type PriceTable,
} from "@core/priceTable";
import { evaluateWithAppraisal } from "@core/appraisal";
import { DEFAULT_MIN_DETOUR_CONFIDENCE } from "@core/sortTriage";
import {
  DEFAULT_TIER_THRESHOLDS,
  starterValueTierRules,
  validateValueTierRules,
  type TierVerdict,
} from "@core/valueTiers";
import quotes from "../../../fixtures/market/quotes.json";
import {
  ITEM_INTELLIGENCE_IPC_VERSION,
  tradeQueriesToGearSearches,
  type CatalogItemView,
  type ImportBuildTargetsRequest,
  type ImportBuildTargetsResult,
  type ItemEvaluation,
  type LegacyImportRequest,
  type LegacyImportResult,
  type RuleSetView,
  type SaveBuildProfileRequest,
  type SaveRuleSetRequest,
  type SaveValueTierConfigRequest,
  type ValueTierConfigView,
  type ScannerRunSummary,
  type ScannerRuntimeEvent,
  type ScannerRuntimeStatus,
  type ScannerStartRequest,
  type HotkeysStatePayload,
  type ScanSessionDetail,
  type ScanSessionView,
  type ScanSlotView,
} from "../../shared/ipc.js";
import {
  defaultHotkeyBindings,
  HOTKEY_ACTIONS,
  normalizeHotkeyBindings,
  RESERVED_CONTROL_KEYS,
} from "../../shared/hotkeyActions.js";

const PREVIEW_STORAGE_KEY = "poe2-item-intelligence-preview-v1";
const previewMarket = new FixtureMarketProvider(quotes);

interface PreviewState {
  catalog: CatalogItemView[];
  rules: RuleSetView[];
  builds: BuildProfile[];
  scans: ScanSessionDetail[];
}

type PreviewCollection = "catalog" | "rules" | "builds";

const previewListeners: Record<
  PreviewCollection,
  Set<(entries: never[]) => void>
> = {
  catalog: new Set(),
  rules: new Set(),
  builds: new Set(),
};

function emptyPreviewState(): PreviewState {
  return { catalog: [], rules: [], builds: [], scans: [] };
}

function readPreviewState(): PreviewState {
  try {
    const raw = globalThis.localStorage?.getItem(PREVIEW_STORAGE_KEY);
    if (!raw) return emptyPreviewState();
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return emptyPreviewState();
    }
    const record = parsed as Partial<PreviewState>;
    return {
      catalog: Array.isArray(record.catalog) ? record.catalog : [],
      rules: Array.isArray(record.rules) ? record.rules : [],
      builds: Array.isArray(record.builds) ? record.builds : [],
      scans: Array.isArray(record.scans) ? record.scans : [],
    };
  } catch {
    return emptyPreviewState();
  }
}

function writePreviewState(state: PreviewState): void {
  try {
    globalThis.localStorage?.setItem(PREVIEW_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Browser preview remains usable even when storage is unavailable.
  }
}

function notifyPreview(collection: PreviewCollection, entries: unknown[]): void {
  for (const listener of previewListeners[collection]) {
    (listener as (value: unknown[]) => void)(entries);
  }
}

function previewSubscribe<T>(
  collection: PreviewCollection,
  callback: (entries: T[]) => void,
): () => void {
  const listeners = previewListeners[collection];
  const listener = callback as (entries: never[]) => void;
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function id(prefix: string, stablePart = ""): string {
  const safe = stablePart
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "")
    .slice(0, 36);
  const random =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}_${safe ? `${safe}_` : ""}${random}`;
}

function now(): string {
  return new Date().toISOString();
}

function nativeBridge() {
  return globalThis.window?.poe2;
}

async function previewEvaluateText(text: string): Promise<ItemEvaluation> {
  const raw = text.trim();
  if (!raw) {
    return {
      schemaVersion: ITEM_INTELLIGENCE_IPC_VERSION,
      parsed: false,
      raw: text,
      reason: "empty",
    };
  }
  if (!looksLikePoeItemText(raw)) {
    return {
      schemaVersion: ITEM_INTELLIGENCE_IPC_VERSION,
      parsed: false,
      raw: text,
      reason: "not-item-text",
    };
  }

  const item = parseItemText(text);
  const quote = await previewMarket.quote(item, {
    league: "Standard",
    currency: "exalted",
  });
  const valuation = valueItem(item, quote);
  const desirability = scoreDesirability(item, valuation);
  const tierConfig = previewTierConfig();
  const tier = evaluateWithAppraisal(text, {
    rules: tierConfig.rules,
    priceTable: previewPriceTable(),
    thresholds: tierConfig.thresholds,
  });
  const evaluation: ItemEvaluation = {
    schemaVersion: ITEM_INTELLIGENCE_IPC_VERSION,
    parsed: true,
    raw: text,
    item,
    valuation,
    desirability,
    tier,
  };

  const state = readPreviewState();
  const existing = state.catalog.find(
    (entry) => entry.fingerprint === item.fingerprint,
  );
  const timestamp = now();
  const view: CatalogItemView = {
    id: existing?.id ?? id("catalog", item.baseType),
    fingerprint: item.fingerprint,
    name: item.name || item.baseType,
    baseType: item.baseType,
    itemClass: item.itemClass,
    currentLocation: "browser-preview:latest",
    recommendation: desirability.category,
    fairValue: valuation.fair,
    item,
    valuation,
    desirability,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
  state.catalog = [
    view,
    ...state.catalog.filter((entry) => entry.id !== view.id),
  ];
  writePreviewState(state);
  notifyPreview("catalog", state.catalog);
  return evaluation;
}

function previewSaveRuleSet(request: SaveRuleSetRequest): RuleSetView {
  const name = request.name.trim();
  if (!name) throw new Error("A rule-set name is required.");
  for (const [index, rule] of request.rules.entries()) {
    const validation = validateRuleRegex(rule.regex);
    if (!validation.valid) {
      throw new Error(
        `Rule ${index + 1}: ${validation.issues[0]?.message ?? "validation failed"}`,
      );
    }
  }
  const state = readPreviewState();
  const existing = request.id
    ? state.rules.find((entry) => entry.id === request.id)
    : undefined;
  const timestamp = now();
  const saved: RuleSetView = {
    id: existing?.id ?? id("rules", name),
    kind: "stash-scan",
    name,
    schemaVersion: 1,
    rules: request.rules.map((rule) => ({ ...rule })),
    active: request.active ?? existing?.active ?? true,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
  state.rules = [
    saved,
    ...state.rules.filter((entry) => entry.id !== saved.id),
  ];
  writePreviewState(state);
  notifyPreview("rules", state.rules);
  return saved;
}

function previewSaveBuild(request: SaveBuildProfileRequest): BuildProfile {
  const validation = validateBuildProfile(request.profile);
  if (!validation.valid) {
    throw new Error(
      validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
    );
  }
  const state = readPreviewState();
  state.builds = [
    request.profile,
    ...state.builds.filter((entry) => entry.id !== request.profile.id),
  ];
  writePreviewState(state);
  notifyPreview("builds", state.builds);
  return request.profile;
}

function emptyTradeImport(message: string): TradeQueryImportResult {
  return {
    queries: [],
    warnings: [],
    errors: [{ code: "preview-import-error", message }],
  };
}

function previewImportBuildTargets(
  request: ImportBuildTargetsRequest,
): ImportBuildTargetsResult {
  const state = readPreviewState();
  if (request.profileId && request.profile) {
    throw new Error("Choose an existing profile or create a new one, not both.");
  }
  const tradeImport = importTradeQueries(request.sourceText);
  const existing = request.profileId
    ? state.builds.find((profile) => profile.id === request.profileId)
    : undefined;
  if (request.profileId && !existing) {
    return {
      tradeImport: emptyTradeImport("The selected build profile no longer exists."),
      addedTargetIds: [],
      updatedTargetIds: [],
      warnings: ["The selected build profile no longer exists."],
    };
  }
  if (tradeImport.queries.length === 0) {
    return {
      ...(existing ? { profile: existing } : {}),
      tradeImport,
      addedTargetIds: [],
      updatedTargetIds: [],
      warnings: tradeImport.warnings.map((warning) => warning.message),
    };
  }
  const profile =
    existing ??
    createBuildProfile(request.profile ?? { name: "Imported build" });
  const imported = importGearTargets(
    profile,
    tradeQueriesToGearSearches(
      tradeImport,
      request.defaultSlot?.trim() || "unspecified",
    ),
  );
  const saved = previewSaveBuild({ profile: imported.profile });
  return {
    profile: saved,
    tradeImport,
    addedTargetIds: imported.addedTargetIds,
    updatedTargetIds: imported.updatedTargetIds,
    warnings: [
      ...tradeImport.warnings.map((warning) => warning.message),
      ...imported.warnings,
    ],
  };
}

function previewImportLegacy(request: LegacyImportRequest): LegacyImportResult {
  const sourceKey = request.sourceKey.trim() || "browser-preview";
  const state = readPreviewState();
  const entityIds: string[] = [];
  let parsedRecords = 0;
  let warnings: LegacyImportResult["warnings"] = [];

  if (request.kind === "scan-history" || request.kind === "regex-history") {
    const parsed =
      request.kind === "scan-history"
        ? parseLegacyScanHistory(request.input)
        : parseLegacyRegexHistory(request.input);
    parsedRecords = parsed.records.length;
    warnings = parsed.warnings;
    for (const record of parsed.records) {
      const validation = validateRuleRegex(record.regex);
      if (!validation.valid) {
        warnings.push({
          code: "invalid-rule",
          message: `${record.name}: ${validation.issues[0]?.message ?? "invalid rule"}`,
        });
        continue;
      }
      const timestamp = record.createdAt ?? now();
      const ruleSet: RuleSetView = {
        id: id("rules", `${sourceKey}-${record.id}`),
        kind: "stash-scan",
        name: record.name,
        schemaVersion: 1,
        rules: [
          {
            id: record.id,
            name: record.name,
            regex: record.regex,
            ...(record.createdAt ? { createdAt: record.createdAt } : {}),
            ...(request.sourceUri ? { sourceUrl: request.sourceUri } : {}),
            schemaVersion: 1,
          },
        ],
        active: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      state.rules.unshift(ruleSet);
      entityIds.push(ruleSet.id);
    }
    writePreviewState(state);
    notifyPreview("rules", state.rules);
  } else if (request.kind === "scan-jsonl") {
    const parsed = parseLegacyScanJsonl(request.input, {
      defaultSessionId: id("legacy-session", sourceKey),
    });
    parsedRecords = parsed.records.length;
    warnings = parsed.warnings;
    const groups = new Map<string, typeof parsed.records>();
    for (const record of parsed.records) {
      const group = groups.get(record.sessionId) ?? [];
      group.push(record);
      groups.set(record.sessionId, group);
    }
    for (const [legacySessionId, records] of groups) {
      const timestamps = records
        .flatMap((record) => (record.scannedAt ? [record.scannedAt] : []))
        .sort();
      const timestamp = timestamps[0] ?? now();
      const sessionId = id("scan", `${sourceKey}-${legacySessionId}`);
      const session: ScanSessionView = {
        id: sessionId,
        source: "legacy-jsonl",
        status: "imported",
        startedAt: timestamp,
        endedAt: timestamps.at(-1) ?? timestamp,
        summary: {
          legacySessionId,
          recordCount: records.length,
          sourceKey,
        },
        createdAt: timestamp,
        updatedAt: now(),
      };
      const slots: ScanSlotView[] = records.map((record, ordinal) => ({
        id: id("scan-slot", record.id),
        sessionId,
        slotKey: record.slotKey,
        ordinal,
        status: record.status ?? "imported",
        ...(record.itemFingerprint
          ? { itemFingerprint: record.itemFingerprint }
          : {}),
        ...(record.scannedAt ? { scannedAt: record.scannedAt } : {}),
        payload: record.raw,
        createdAt: record.scannedAt ?? timestamp,
        updatedAt: record.scannedAt ?? timestamp,
      }));
      state.scans.unshift({ session, slots });
      entityIds.push(session.id, ...slots.map((slot) => slot.id));
    }
    writePreviewState(state);
  } else {
    const parsed = parseLegacyTradePresets(request.input);
    parsedRecords = parsed.records.length;
    warnings = parsed.warnings;
  }

  return {
    kind: request.kind,
    parsedRecords,
    persistedEntities: entityIds.length,
    entityIds,
    warnings,
  };
}

export const rendererApi = {
  get isNative(): boolean {
    return Boolean(nativeBridge());
  },

  async mode(): Promise<RuntimeMode> {
    return nativeBridge()?.mode() ?? Promise.resolve("authorized-qa");
  },

  async windows(): Promise<Array<{ name: string; title: string }>> {
    return nativeBridge()?.windows() ?? [];
  },

  async killLatched(): Promise<boolean> {
    return nativeBridge()?.killLatched() ?? false;
  },

  async rearm(): Promise<boolean> {
    return nativeBridge()?.rearm() ?? false;
  },

  async evaluateText(text: string): Promise<ItemEvaluation> {
    return nativeBridge()?.evaluateText(text) ?? previewEvaluateText(text);
  },

  async fromClipboard(): Promise<ItemEvaluation | null> {
    const bridge = nativeBridge();
    if (bridge) return bridge.fromClipboard();
    if (!globalThis.navigator?.clipboard?.readText) {
      throw new Error("Clipboard access is unavailable in this browser preview.");
    }
    const text = await globalThis.navigator.clipboard.readText();
    return text ? previewEvaluateText(text) : null;
  },

  onItem(callback: (payload: ItemEvaluation) => void): () => void {
    return nativeBridge()?.onItem(callback) ?? (() => undefined);
  },

  scanner: {
    async status(): Promise<ScannerRuntimeStatus> {
      return nativeBridge()?.scanner.status() ?? {
        schemaVersion: 1,
        running: false,
        mode: "authorized-qa",
        qaOptIn: true,
        killLatched: false,
      };
    },
    async start(request: ScannerStartRequest): Promise<ScannerRunSummary> {
      const bridge = nativeBridge();
      if (!bridge) {
        throw new Error(
          "Scanner execution is available only in the Electron desktop app.",
        );
      }
      return bridge.scanner.start(request);
    },
    async stop(): Promise<ScannerRuntimeStatus> {
      return nativeBridge()?.scanner.stop() ?? this.status();
    },
    onEvent(callback: (event: ScannerRuntimeEvent) => void): () => void {
      return nativeBridge()?.scanner.onEvent(callback) ?? (() => undefined);
    },
  },

  async generateFilter(options: {
    hideBelowScore: number;
    highlightUniques: boolean;
    name: string;
  }): Promise<string> {
    return nativeBridge()?.generateFilter(options) ?? generateLootFilter(options);
  },

  intelligence: {
    catalog: {
      async list(): Promise<CatalogItemView[]> {
        return nativeBridge()?.intelligence.catalog.list() ??
          readPreviewState().catalog;
      },
      async remove(itemId: string): Promise<boolean> {
        const bridge = nativeBridge();
        if (bridge) return bridge.intelligence.catalog.remove(itemId);
        const state = readPreviewState();
        const before = state.catalog.length;
        state.catalog = state.catalog.filter((entry) => entry.id !== itemId);
        writePreviewState(state);
        notifyPreview("catalog", state.catalog);
        return state.catalog.length !== before;
      },
      onChanged(callback: (items: CatalogItemView[]) => void): () => void {
        return nativeBridge()?.intelligence.catalog.onChanged(callback) ??
          previewSubscribe("catalog", callback);
      },
    },
    rules: {
      async list(): Promise<RuleSetView[]> {
        return nativeBridge()?.intelligence.rules.list() ??
          readPreviewState().rules;
      },
      async save(request: SaveRuleSetRequest): Promise<RuleSetView> {
        return nativeBridge()?.intelligence.rules.save(request) ??
          previewSaveRuleSet(request);
      },
      async remove(ruleSetId: string): Promise<boolean> {
        const bridge = nativeBridge();
        if (bridge) return bridge.intelligence.rules.remove(ruleSetId);
        const state = readPreviewState();
        const before = state.rules.length;
        state.rules = state.rules.filter((entry) => entry.id !== ruleSetId);
        writePreviewState(state);
        notifyPreview("rules", state.rules);
        return state.rules.length !== before;
      },
      async validate(ruleText: string): Promise<RuleValidationResult> {
        return nativeBridge()?.intelligence.rules.validate(ruleText) ??
          validateRuleRegex(ruleText);
      },
      async generateSearch(
        request: SearchRegexRequest,
      ): Promise<SearchRegexResult> {
        return nativeBridge()?.intelligence.rules.generateSearch(request) ??
          buildSearchRegex(request);
      },
      onChanged(callback: (ruleSets: RuleSetView[]) => void): () => void {
        return nativeBridge()?.intelligence.rules.onChanged(callback) ??
          previewSubscribe("rules", callback);
      },
    },
    builds: {
      async list(): Promise<BuildProfile[]> {
        return nativeBridge()?.intelligence.builds.list() ??
          readPreviewState().builds;
      },
      async save(request: SaveBuildProfileRequest): Promise<BuildProfile> {
        return nativeBridge()?.intelligence.builds.save(request) ??
          previewSaveBuild(request);
      },
      async remove(profileId: string): Promise<boolean> {
        const bridge = nativeBridge();
        if (bridge) return bridge.intelligence.builds.remove(profileId);
        const state = readPreviewState();
        const before = state.builds.length;
        state.builds = state.builds.filter((entry) => entry.id !== profileId);
        writePreviewState(state);
        notifyPreview("builds", state.builds);
        return state.builds.length !== before;
      },
      async activate(profileId?: string): Promise<BuildProfile[]> {
        const bridge = nativeBridge();
        if (bridge) return bridge.intelligence.builds.activate(profileId);
        const state = readPreviewState();
        state.builds = activateBuildProfile(state.builds, profileId);
        writePreviewState(state);
        notifyPreview("builds", state.builds);
        return state.builds;
      },
      async importTargets(
        request: ImportBuildTargetsRequest,
      ): Promise<ImportBuildTargetsResult> {
        return nativeBridge()?.intelligence.builds.importTargets(request) ??
          previewImportBuildTargets(request);
      },
      onChanged(callback: (profiles: BuildProfile[]) => void): () => void {
        return nativeBridge()?.intelligence.builds.onChanged(callback) ??
          previewSubscribe("builds", callback);
      },
    },
    imports: {
      async legacy(request: LegacyImportRequest): Promise<LegacyImportResult> {
        return nativeBridge()?.intelligence.imports.legacy(request) ??
          previewImportLegacy(request);
      },
    },
    scans: {
      async list(): Promise<ScanSessionView[]> {
        return nativeBridge()?.intelligence.scans.list() ??
          readPreviewState().scans.map((entry) => entry.session);
      },
      async get(sessionId: string): Promise<ScanSessionDetail | null> {
        return nativeBridge()?.intelligence.scans.get(sessionId) ??
          readPreviewState().scans.find(
            (entry) => entry.session.id === sessionId,
          ) ??
          null;
      },
    },
    tiers: {
      async get(): Promise<ValueTierConfigView> {
        return nativeBridge()?.intelligence.tiers.get() ?? previewTierConfig();
      },
      async save(
        request: SaveValueTierConfigRequest,
      ): Promise<ValueTierConfigView> {
        const bridge = nativeBridge();
        if (bridge) return bridge.intelligence.tiers.save(request);
        return previewSaveTierConfig(request);
      },
      async evaluate(itemText: string): Promise<TierVerdict> {
        const bridge = nativeBridge();
        if (bridge) return bridge.intelligence.tiers.evaluate(itemText);
        const config = previewTierConfig();
        return evaluateWithAppraisal(itemText, {
          rules: config.rules,
          priceTable: previewPriceTable(),
          thresholds: config.thresholds,
        });
      },
      onChanged(callback: (config: ValueTierConfigView) => void): () => void {
        return nativeBridge()?.intelligence.tiers.onChanged(callback) ?? (() => undefined);
      },
    },
    prices: {
      async get(): Promise<PriceTable> {
        return nativeBridge()?.intelligence.prices.get() ?? previewPriceTable();
      },
      async save(table: PriceTable): Promise<PriceTable> {
        const bridge = nativeBridge();
        if (bridge) return bridge.intelligence.prices.save(table);
        return previewSavePriceTable(table);
      },
      onChanged(callback: (table: PriceTable) => void): () => void {
        return nativeBridge()?.intelligence.prices.onChanged(callback) ?? (() => undefined);
      },
    },
  },
};

const PREVIEW_TIERS_KEY = "poe2-value-tiers-preview-v1";
const PREVIEW_PRICES_KEY = "poe2-price-table-preview-v1";

function previewTierConfig(): ValueTierConfigView {
  try {
    const raw = globalThis.localStorage?.getItem(PREVIEW_TIERS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as ValueTierConfigView;
      if (parsed && parsed.rules) {
        return {
          ...parsed,
          minDetourConfidence: parsed.minDetourConfidence ?? DEFAULT_MIN_DETOUR_CONFIDENCE,
        };
      }
    }
  } catch {
    // Fall through to the starter config.
  }
  return {
    schemaVersion: 1,
    rules: starterValueTierRules(),
    thresholds: { ...DEFAULT_TIER_THRESHOLDS },
    routing: { ...DEFAULT_TRIAGE_ROUTING },
    minDetourConfidence: DEFAULT_MIN_DETOUR_CONFIDENCE,
  };
}

function previewSaveTierConfig(
  request: SaveValueTierConfigRequest,
): ValueTierConfigView {
  const issues = validateValueTierRules(request.rules);
  if (issues.length > 0) {
    throw new Error(
      `invalid-tier-rule:${issues[0]!.tier}:${issues[0]!.index}:${issues[0]!.message}`,
    );
  }
  const config: ValueTierConfigView = {
    schemaVersion: 1,
    rules: request.rules,
    thresholds: request.thresholds ?? { ...DEFAULT_TIER_THRESHOLDS },
    routing: request.routing ?? { ...DEFAULT_TRIAGE_ROUTING },
    minDetourConfidence: request.minDetourConfidence ?? DEFAULT_MIN_DETOUR_CONFIDENCE,
    updatedAt: now(),
  };
  try {
    globalThis.localStorage?.setItem(PREVIEW_TIERS_KEY, JSON.stringify(config));
  } catch {
    // Preview persistence is best-effort.
  }
  return config;
}

function previewPriceTable(): PriceTable {
  try {
    const raw = globalThis.localStorage?.getItem(PREVIEW_PRICES_KEY);
    if (raw) {
      const validation = validatePriceTable(JSON.parse(raw));
      if (validation.valid && validation.table) return validation.table;
    }
  } catch {
    // Fall through to the starter table.
  }
  return starterPriceTable();
}

function previewSavePriceTable(table: PriceTable): PriceTable {
  const validation = validatePriceTable(table);
  if (!validation.valid || !validation.table) {
    const first = validation.issues[0];
    throw new Error(
      `invalid-price-table:${first ? `${first.path}:${first.message}` : "unknown"}`,
    );
  }
  const saved: PriceTable = { ...validation.table, updatedAt: now() };
  try {
    globalThis.localStorage?.setItem(PREVIEW_PRICES_KEY, JSON.stringify(saved));
  } catch {
    // Preview persistence is best-effort.
  }
  return saved;
}

export interface PoeTarget {
  process: string;
  title: string;
  window: ScreenRect;
  monitor: SelectedMonitor;
}

export interface CalibrationApi {
  profile: () => Promise<CalibrationProfile>;
  save: (profile: CalibrationProfile) => Promise<{ profile: CalibrationProfile }>;
  reset: () => Promise<{ profile: CalibrationProfile }>;
  target: () => Promise<PoeTarget>;
  capture: (
    profile?: CalibrationProfile,
  ) => Promise<{
    preview: string;
    screen: ScreenRect;
    bmpPath: string;
    target: PoeTarget;
  }>;
  look: (
    profile: CalibrationProfile,
  ) => Promise<{
    facts: UiFacts;
    elapsedMs: number;
    preview: string;
    target?: PoeTarget;
  }>;
  diagnose: (payload: {
    profile: CalibrationProfile;
    corrections: DiagnosticCorrection[];
    bmpPath?: string;
    screen?: ScreenRect;
  }) => Promise<{
    report: TransferDiagnosticReport;
    facts: UiFacts;
    screen: ScreenRect;
    bmpPath: string;
    preview: string;
    elapsedMs: number;
    target?: PoeTarget;
  }>;
  exportDiagnostic: (payload: {
    bmpPath: string;
    screen: ScreenRect;
    profile: CalibrationProfile;
    report: TransferDiagnosticReport;
    corrections: DiagnosticCorrection[];
    trace: unknown[];
  }) => Promise<{ dir: string; screenshot: string }>;
  stamp: (
    payload: Record<string, unknown>,
  ) => Promise<{ profile: CalibrationProfile }>;
}

export type AssistiveRunKind = "fill" | "empty" | "two-cycle";

export interface AssistiveRunEvent {
  at: string;
  phase: string;
  message: string;
  cycle?: number;
  bagCells?: number;
  stashCells?: number;
  traceCount?: number;
  artifact?: string;
}

export interface AssistiveRunResult {
  ok: boolean;
  reason: string;
  kind: AssistiveRunKind;
  dryRun: boolean;
  cycles: number;
  elapsedMs: number;
  bagCells: number;
  stashCells: number;
  traces?: Array<{
    result?: string;
    input?: { kind?: string; x?: number; y?: number } | null;
  }>;
}

export interface AssistiveApi {
  status: () => Promise<{
    running: boolean;
    killLatched: boolean;
    mode: string;
    qaOptIn: boolean;
    stashTab: "normal" | "quad";
    gridsCalibrated: boolean;
    searchCalibrated: boolean;
    overlayVisible?: boolean;
    overlaySelection?: Array<{
      area: "stash" | "bag";
      row: number;
      col: number;
      occupied: boolean;
    }>;
    overlayLabelFile?: string;
    overlayWrongCount?: number;
    last?: AssistiveRunResult;
  }>;
  start: (request: {
    kind: AssistiveRunKind;
    dryRun: boolean;
    wantedClasses: string[];
    uniqueAcrossCycles: boolean;
    qaAcknowledged: boolean;
    allowlist: string[];
    actionsPerMinute: number;
    maxItems?: number;
  }) => Promise<AssistiveRunResult>;
  stop: () => Promise<{
    running: boolean;
    killLatched: boolean;
    mode: string;
    qaOptIn: boolean;
    stashTab: "normal" | "quad";
    gridsCalibrated: boolean;
    searchCalibrated: boolean;
    overlayVisible?: boolean;
    overlaySelection?: Array<{
      area: "stash" | "bag";
      row: number;
      col: number;
      occupied: boolean;
    }>;
    overlayLabelFile?: string;
    overlayWrongCount?: number;
    last?: AssistiveRunResult;
  }>;
  hideOverlay: () => Promise<{
    running: boolean;
    overlayVisible?: boolean;
  }>;
  selectOverlayCell: (
    x: number,
    y: number,
    additive?: boolean,
  ) => Promise<{
    selected: Array<{
      area: "stash" | "bag";
      row: number;
      col: number;
      occupied: boolean;
    }>;
  }>;
  labelOverlayCell: (
    label: "right" | "wrong",
  ) => Promise<
    | {
        ok: true;
        selected: Array<{
          area: "stash" | "bag";
          row: number;
          col: number;
          occupied: boolean;
        }>;
      }
    | { ok: false; reason: string }
  >;
  sendToCursor: () => Promise<{
    ok: boolean;
    opened: boolean;
    copied: boolean;
    truncated: boolean;
    findings: boolean;
    promptPath?: string;
    method: "deeplink" | "clipboard" | "none";
    message: string;
  }>;
  rearm: () => Promise<boolean>;
  memoryStatus: (payload: {
    stashTab: "normal" | "quad";
    query: string;
  }) => Promise<{
    scenarioKey: string;
    confirmed: number;
    blockedReturns: number;
    lastWithdrawn: number;
    updatedAt: string;
  }>;
  resetMemory: (payload: {
    stashTab: "normal" | "quad";
    query: string;
  }) => Promise<{
    scenarioKey: string;
    confirmed: number;
    blockedReturns: number;
    lastWithdrawn: number;
    updatedAt: string;
  }>;
  onEvent: (callback: (event: AssistiveRunEvent) => void) => () => void;
  voice: {
    status: () => Promise<VoiceTransferStatus>;
    configure: (config: VoiceTransferConfig) => Promise<VoiceTransferStatus>;
    trigger: () => Promise<VoiceTransferState>;
    cancel: () => Promise<VoiceTransferState>;
    onState: (
      callback: (state: VoiceTransferStatus) => void,
    ) => () => void;
  };
}

export interface StashSortApi {
  status: () => Promise<{
    running: boolean;
    mode: string;
    qaOptIn: boolean;
    killLatched: boolean;
    stashTab: "normal" | "quad";
    calibrated: boolean;
    previewPlanId?: string;
  }>;
  start: (request: {
    action: "preview" | "execute";
    planId?: string;
    qaAcknowledged: boolean;
    allowlist: string[];
    actionsPerMinute: number;
    tabSafety: "writable-grid" | "unknown";
  }) => Promise<{
    ok: boolean;
    reason: string;
    action: "preview" | "execute";
    dryRun: boolean;
    plan: StashSortPlan;
    schedule: SortMoveSchedule;
  }>;
  stop: () => ReturnType<StashSortApi["status"]>;
  rearm: () => Promise<boolean>;
  onEvent: (
    callback: (event: {
      at: string;
      phase: string;
      message: string;
      itemCount?: number;
      completedMoves?: number;
      totalMoves?: number;
    }) => void,
  ) => () => void;
}

export interface StashTabAdminApi {
  status: () => Promise<StashTabAdminStatus>;
  survey: (folderName?: string) => Promise<StashTabSurveyResult>;
  /** Recent finds from the sorter's value triage (newest first). */
  finds?: () => Promise<FindRecord[]>;
  plan: (payload: {
    tabs: StashTabSurveyResult["tabs"];
    requireQuad?: boolean;
    /** Opt in to rewriting priced tabs; removes their public price. */
    allowPricedTabs?: boolean;
  }) => Promise<{ plan: StashTabPlan; errors: string[] }>;
  apply: (payload: {
    plan: StashTabPlan;
    dryRun?: boolean;
    allowPricedTabs?: boolean;
  }) => Promise<StashTabApplyOutcome[]>;
  onEvent: (callback: (payload: StashTabAdminEvent) => void) => () => void;
}

export interface PriceFeedStatusView {
  config: { league: string; autoRefreshDaily: boolean; poesessid: string };
  resolvedLeague?: string;
  lastRefreshAt?: string;
  lastError?: string;
  feedEntryCount: number;
  feedAgeHours?: number;
  refreshing: boolean;
}

export interface CompsSummaryView {
  sampleSize: number;
  candidateCount: number;
  lowest?: number;
  median?: number;
  currency: "exalted";
  basis: "unique-name" | "base-type";
  comps: Array<{ price: number; similarity: number; name: string; baseType: string }>;
  caution?: string;
}

export interface CompsResultView {
  ok: boolean;
  summary?: CompsSummaryView;
  error?: string;
  cached?: boolean;
  league?: string;
}

export interface PriceFeedApi {
  status: () => Promise<PriceFeedStatusView>;
  refresh: () => Promise<PriceFeedStatusView>;
  configure: (partial: {
    league?: string;
    autoRefreshDaily?: boolean;
    poesessid?: string;
  }) => Promise<PriceFeedStatusView>;
  comps: (itemText: string) => Promise<CompsResultView>;
}

function compatibilityApi<T>(
  section: "calibration" | "assistive" | "stashSort" | "stashTabs" | "shop" | "priceFeed",
): T | undefined {
  return nativeBridge()?.[section] as unknown as T | undefined;
}

export function getStashTabAdminApi(): StashTabAdminApi | undefined {
  return compatibilityApi<StashTabAdminApi>("stashTabs");
}

export interface ShopListingView {
  fingerprint: string;
  name: string;
  itemClass: string;
  count: number;
  price?: { amount: number; currency: string; exalted?: number };
  listedAt: string;
  pricedAt: string;
  by: "app" | "user" | "unknown";
}

export interface ShopPlanActionView {
  kind: "reprice" | "delist" | "price-unpriced";
  fingerprint: string;
  name: string;
  itemClass: string;
  from?: { amount: number; currency: string };
  to?: { amount: number; currency: string; exalted: number };
  badges: string[];
  reasons: string[];
}

export interface ShopPlanHoldView {
  fingerprint: string;
  name: string;
  badges: string[];
  reasons: string[];
}

export interface ShopSalesStatsView {
  itemClass: string;
  listed: number;
  sold: number;
  delisted: number;
  medianDaysToSale?: number;
  realizedExalted: number;
}

export interface ShopConfigView {
  schemaVersion: 1;
  shopTab: string;
  returnTab: string;
  undercutPercent: number;
  compsPercentile: number;
  staleDays: number;
  underpricedPercent: number;
  ladder: Array<{ afterDays: number; stepPercent: number }>;
  delistFloorExalted: number;
  maxAutoList: { amount: number; currency: string };
  minListConfidence: number;
  minCompsCount: number;
  maxCompsSpread: number;
  minListExalted: number;
  sources: Array<"bag" | "review">;
  maxActionsPerRun: number;
  /** Price-bucket merchant tabs ("1Ex", "5D" …) — the one-key listing flow. */
  bucketTabs: string[];
}

export interface ShopOverviewView {
  error?: string;
  config?: ShopConfigView;
  issues?: string[];
  state?: ShopListingView[];
  stats?: ShopSalesStatsView[];
  eventCount?: number;
  scan?: {
    snapshot?: { at: string; tab: string; items: unknown[]; unpricedCount: number };
    freeCells?: number;
  } | null;
  plan?: {
    at: string;
    tab: string;
    actions: ShopPlanActionView[];
    holds: ShopPlanHoldView[];
    report: string[];
  } | null;
}

export interface ShopApi {
  overview: () => Promise<ShopOverviewView>;
  saveConfig: (
    config: ShopConfigView,
  ) => Promise<{ config: ShopConfigView; issues: string[] }>;
}

export function getShopApi(): ShopApi | undefined {
  return compatibilityApi<ShopApi>("shop");
}

export function getPriceFeedApi(): PriceFeedApi | undefined {
  return compatibilityApi<PriceFeedApi>("priceFeed");
}

export function getCalibrationApi(): CalibrationApi | undefined {
  return compatibilityApi<CalibrationApi>("calibration");
}

export function getAssistiveApi(): AssistiveApi | undefined {
  return compatibilityApi<AssistiveApi>("assistive");
}

export function getStashSortApi(): StashSortApi | undefined {
  return compatibilityApi<StashSortApi>("stashSort");
}

export function createEmptyBuildProfile(
  input: CreateBuildProfileInput,
): BuildProfile {
  return createBuildProfile(input);
}

/**
 * Numpad hotkey bindings for the standalone action daemon. Without the
 * native bridge (browser preview) the catalog renders with its defaults
 * and saving only normalizes locally, clearly marked as a preview.
 */
export const hotkeysApi = {
  async load(): Promise<HotkeysStatePayload & { preview: boolean }> {
    const bridge = nativeBridge();
    if (bridge?.hotkeys) return { ...(await bridge.hotkeys.get()), preview: false };
    return {
      actions: HOTKEY_ACTIONS,
      reserved: RESERVED_CONTROL_KEYS,
      bindings: defaultHotkeyBindings(),
      issues: [],
      source: "defaults",
      preview: true,
    };
  },
  async save(
    bindings: Record<string, number | null>,
  ): Promise<{ bindings: Record<string, number | null>; issues: string[]; preview: boolean }> {
    const bridge = nativeBridge();
    if (bridge?.hotkeys) return { ...(await bridge.hotkeys.save(bindings)), preview: false };
    return { ...normalizeHotkeyBindings(bindings), preview: true };
  },
  async daemonStatus(): Promise<{ exists: boolean; lastEventAt?: string; lastLine?: string }> {
    const bridge = nativeBridge();
    if (bridge?.hotkeys) return bridge.hotkeys.daemonStatus();
    return { exists: false };
  },
};
