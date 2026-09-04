import type {
  BuildProfile,
  CreateBuildProfileInput,
  ImportedGearSearch,
} from "../core/buildProfiles.js";
import type {
  LegacyImportWarning,
} from "../core/legacyImports.js";
import type {
  ScanGridCell,
  ScanGridKind,
} from "../core/scanContracts.js";
import type {
  RuleValidationResult,
  ScanHistoryItem,
} from "../core/scanRules.js";
import type {
  SearchRegexRequest,
  SearchRegexResult,
} from "../core/searchRegex.js";
import type {
  TradeQueryImportResult,
} from "../core/tradeQueryImport.js";
import type {
  DesirabilityResult,
  NormalizedItem,
  RuntimeMode,
  ValuationResult,
} from "../core/types.js";
import type { TriageRouting } from "../core/bagTriage.js";
import type { PriceTable } from "../core/priceTable.js";
import type {
  TierVerdict,
  ValueTierRules,
  ValueTierThresholds,
} from "../core/valueTiers.js";

export const ITEM_INTELLIGENCE_IPC_VERSION = 1 as const;
export const SCANNER_IPC_VERSION = 1 as const;

export interface ParsedItemEvaluation {
  schemaVersion: typeof ITEM_INTELLIGENCE_IPC_VERSION;
  parsed: true;
  raw: string;
  item: NormalizedItem;
  valuation: ValuationResult;
  desirability: DesirabilityResult;
  /** Value-tier verdict from the user's tier rules and price table. */
  tier?: TierVerdict;
}

export interface ValueTierConfigView {
  schemaVersion: 1;
  rules: ValueTierRules;
  thresholds: ValueTierThresholds;
  routing: TriageRouting;
  /** Appraisal confidence an item needs before the sorter detours it. */
  minDetourConfidence: number;
  updatedAt?: string;
}

export interface SaveValueTierConfigRequest {
  rules: ValueTierRules;
  thresholds?: ValueTierThresholds;
  routing?: TriageRouting;
  minDetourConfidence?: number;
}

export interface RejectedItemEvaluation {
  schemaVersion: typeof ITEM_INTELLIGENCE_IPC_VERSION;
  parsed: false;
  raw: string;
  reason: "empty" | "not-item-text";
}

export type ItemEvaluation = ParsedItemEvaluation | RejectedItemEvaluation;

export interface CatalogItemView {
  id: string;
  fingerprint: string;
  name: string;
  baseType: string;
  itemClass: string;
  currentLocation: string;
  recommendation?: string;
  fairValue?: number;
  item?: NormalizedItem;
  valuation?: ValuationResult;
  desirability?: DesirabilityResult;
  createdAt: string;
  updatedAt: string;
}

export interface RuleSetView {
  id: string;
  kind: "stash-scan";
  name: string;
  schemaVersion: number;
  rules: ScanHistoryItem[];
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SaveRuleSetRequest {
  id?: string;
  name: string;
  rules: ScanHistoryItem[];
  active?: boolean;
}

export interface ImportBuildTargetsRequest {
  profileId?: string;
  profile?: CreateBuildProfileInput;
  sourceText: string;
  defaultSlot?: string;
}

export interface ImportBuildTargetsResult {
  profile?: BuildProfile;
  tradeImport: TradeQueryImportResult;
  addedTargetIds: string[];
  updatedTargetIds: string[];
  warnings: string[];
}

export interface SaveBuildProfileRequest {
  profile: BuildProfile;
}

export type LegacyImportKind =
  | "scan-history"
  | "regex-history"
  | "trade-presets"
  | "scan-jsonl";

export interface LegacyImportRequest {
  kind: LegacyImportKind;
  input: string;
  sourceKey: string;
  sourceUri?: string;
}

export interface LegacyImportResult {
  kind: LegacyImportKind;
  parsedRecords: number;
  persistedEntities: number;
  entityIds: string[];
  warnings: LegacyImportWarning[];
}

export type IntelligenceExportKind =
  | "regex-history"
  | "trade-presets"
  | "scan-jsonl"
  | "bundle";

export interface IntelligenceExportRequest {
  kind: IntelligenceExportKind;
  scanSessionId?: string;
}

export interface IntelligenceExportResult {
  kind: IntelligenceExportKind;
  schemaVersion: number;
  fileName: string;
  mimeType: "application/json" | "application/x-ndjson";
  content: string;
  recordCount: number;
  exportedAt: string;
}

export interface ScanSessionView {
  id: string;
  profileId?: string;
  source: string;
  status: string;
  startedAt: string;
  endedAt?: string;
  summary: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface ScanSlotView {
  id: string;
  sessionId: string;
  slotKey: string;
  ordinal: number;
  status: string;
  itemFingerprint?: string;
  scannedAt?: string;
  payload: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface ScanSessionDetail {
  session: ScanSessionView;
  slots: ScanSlotView[];
}

export interface IpcCall<Args extends readonly unknown[], Result> {
  args: Args;
  result: Result;
}

export interface ItemIntelligenceIpcContract {
  "runtime:mode": IpcCall<[], RuntimeMode>;
  "item:from-clipboard": IpcCall<[], ItemEvaluation | null>;
  "item:evaluate-text": IpcCall<[text: string], ItemEvaluation>;
  "catalog:list": IpcCall<[], CatalogItemView[]>;
  "catalog:remove": IpcCall<[id: string], boolean>;
  "rules:list": IpcCall<[], RuleSetView[]>;
  "rules:save": IpcCall<[request: SaveRuleSetRequest], RuleSetView>;
  "rules:remove": IpcCall<[id: string], boolean>;
  "rules:validate": IpcCall<[ruleText: string], RuleValidationResult>;
  "rules:generate-search": IpcCall<[request: SearchRegexRequest], SearchRegexResult>;
  "builds:list": IpcCall<[], BuildProfile[]>;
  "builds:save": IpcCall<[request: SaveBuildProfileRequest], BuildProfile>;
  "builds:remove": IpcCall<[id: string], boolean>;
  "builds:activate": IpcCall<[id?: string], BuildProfile[]>;
  "builds:import-targets": IpcCall<
    [request: ImportBuildTargetsRequest],
    ImportBuildTargetsResult
  >;
  "imports:legacy": IpcCall<[request: LegacyImportRequest], LegacyImportResult>;
  "exports:data": IpcCall<
    [request: IntelligenceExportRequest],
    IntelligenceExportResult
  >;
  "scans:list": IpcCall<[], ScanSessionView[]>;
  "scans:get": IpcCall<[id: string], ScanSessionDetail | null>;
  "tiers:get": IpcCall<[], ValueTierConfigView>;
  "tiers:save": IpcCall<[request: SaveValueTierConfigRequest], ValueTierConfigView>;
  "tiers:evaluate": IpcCall<[itemText: string], TierVerdict>;
  "prices:get": IpcCall<[], PriceTable>;
  "prices:save": IpcCall<[table: PriceTable], PriceTable>;
}

export interface ItemIntelligenceEventContract {
  "item:evaluated": ItemEvaluation;
  "catalog:changed": CatalogItemView[];
  "builds:changed": BuildProfile[];
  "rules:changed": RuleSetView[];
  "tiers:changed": ValueTierConfigView;
  "prices:changed": PriceTable;
}

export const ITEM_INTELLIGENCE_CHANNELS = [
  "runtime:mode",
  "item:from-clipboard",
  "item:evaluate-text",
  "catalog:list",
  "catalog:remove",
  "rules:list",
  "rules:save",
  "rules:remove",
  "rules:validate",
  "rules:generate-search",
  "builds:list",
  "builds:save",
  "builds:remove",
  "builds:activate",
  "builds:import-targets",
  "imports:legacy",
  "exports:data",
  "scans:list",
  "scans:get",
  "tiers:get",
  "tiers:save",
  "tiers:evaluate",
  "prices:get",
  "prices:save",
] as const satisfies readonly (keyof ItemIntelligenceIpcContract)[];

export const ITEM_INTELLIGENCE_EVENT_CHANNELS = [
  "item:evaluated",
  "catalog:changed",
  "builds:changed",
  "rules:changed",
  "tiers:changed",
  "prices:changed",
] as const satisfies readonly (keyof ItemIntelligenceEventContract)[];

export type IpcChannel = keyof ItemIntelligenceIpcContract;
export type IpcEventChannel = keyof ItemIntelligenceEventContract;
export type IpcArgs<C extends IpcChannel> =
  ItemIntelligenceIpcContract[C]["args"];
export type IpcResult<C extends IpcChannel> =
  ItemIntelligenceIpcContract[C]["result"];

export type IpcInvoker = <C extends IpcChannel>(
  channel: C,
  ...args: IpcArgs<C>
) => Promise<IpcResult<C>>;

export type IpcSubscriber = <C extends IpcEventChannel>(
  channel: C,
  callback: (payload: ItemIntelligenceEventContract[C]) => void,
) => () => void;

export interface ItemIntelligenceBridge {
  catalog: {
    list: () => Promise<CatalogItemView[]>;
    remove: (id: string) => Promise<boolean>;
    onChanged: (
      callback: (items: CatalogItemView[]) => void,
    ) => () => void;
  };
  rules: {
    list: () => Promise<RuleSetView[]>;
    save: (request: SaveRuleSetRequest) => Promise<RuleSetView>;
    remove: (id: string) => Promise<boolean>;
    validate: (ruleText: string) => Promise<RuleValidationResult>;
    generateSearch: (request: SearchRegexRequest) => Promise<SearchRegexResult>;
    onChanged: (
      callback: (ruleSets: RuleSetView[]) => void,
    ) => () => void;
  };
  builds: {
    list: () => Promise<BuildProfile[]>;
    save: (request: SaveBuildProfileRequest) => Promise<BuildProfile>;
    remove: (id: string) => Promise<boolean>;
    activate: (id?: string) => Promise<BuildProfile[]>;
    importTargets: (
      request: ImportBuildTargetsRequest,
    ) => Promise<ImportBuildTargetsResult>;
    onChanged: (
      callback: (profiles: BuildProfile[]) => void,
    ) => () => void;
  };
  imports: {
    legacy: (request: LegacyImportRequest) => Promise<LegacyImportResult>;
  };
  exports: {
    data: (
      request: IntelligenceExportRequest,
    ) => Promise<IntelligenceExportResult>;
  };
  scans: {
    list: () => Promise<ScanSessionView[]>;
    get: (id: string) => Promise<ScanSessionDetail | null>;
  };
  tiers: {
    get: () => Promise<ValueTierConfigView>;
    save: (request: SaveValueTierConfigRequest) => Promise<ValueTierConfigView>;
    evaluate: (itemText: string) => Promise<TierVerdict>;
    onChanged: (
      callback: (config: ValueTierConfigView) => void,
    ) => () => void;
  };
  prices: {
    get: () => Promise<PriceTable>;
    save: (table: PriceTable) => Promise<PriceTable>;
    onChanged: (callback: (table: PriceTable) => void) => () => void;
  };
}

export interface ScannerStartRequest {
  gridKind: ScanGridKind;
  dryRun: boolean;
  qaAcknowledged: boolean;
  allowlist: string[];
  actionsPerMinute?: number;
  ruleSetId?: string;
  profileId?: string;
  timing?: Partial<{
    profile: string;
    hoverMs: number;
    copyTimeoutMs: number;
    pollIntervalMs: number;
    afterCopyMs: number;
  }>;
}

export interface ScannerRunSummary {
  schemaVersion: typeof SCANNER_IPC_VERSION;
  status: "finished" | "aborted" | "failed";
  reason: string;
  sessionId: string;
  sessionStatus: "active" | "finished" | "aborted" | "failed";
  startedAt: string;
  endedAt?: string;
  recordCount: number;
  statusCounts: Record<string, number>;
}

export interface ScannerRuntimeStatus {
  schemaVersion: typeof SCANNER_IPC_VERSION;
  running: boolean;
  mode: RuntimeMode;
  qaOptIn: boolean;
  killLatched: boolean;
  activeSessionId?: string;
  lastResult?: {
    status: ScannerRunSummary["status"];
    reason: string;
    sessionId: string;
    records: number;
  };
}

export interface ScannerRuntimeEvent {
  schemaVersion: typeof SCANNER_IPC_VERSION;
  at: string;
  phase: "start" | "decision" | "trace" | "complete" | "error" | "stop";
  message: string;
  sessionId?: string;
  cell?: ScanGridCell;
  result?: string;
}

export const SCANNER_INVOKE_CHANNELS = [
  "scanner:status",
  "scanner:start",
  "scanner:stop",
] as const;

export const SCANNER_EVENT_CHANNELS = ["scanner:event"] as const;

export interface ScannerBridge {
  status: () => Promise<ScannerRuntimeStatus>;
  start: (request: ScannerStartRequest) => Promise<ScannerRunSummary>;
  stop: () => Promise<ScannerRuntimeStatus>;
  onEvent: (
    callback: (event: ScannerRuntimeEvent) => void,
  ) => () => void;
}

export interface HotkeysStatePayload {
  actions: ReadonlyArray<{
    id: string;
    label: string;
    detail: string;
    context: "hideout" | "map";
    defaultKey: number | null;
  }>;
  reserved: ReadonlyArray<{ key: number; label: string }>;
  bindings: Record<string, number | null>;
  issues: string[];
  source: "file" | "defaults";
}

export interface HotkeysBridge {
  get: () => Promise<HotkeysStatePayload>;
  save: (
    bindings: Record<string, number | null>,
  ) => Promise<{ bindings: Record<string, number | null>; issues: string[] }>;
  daemonStatus: () => Promise<{ exists: boolean; lastEventAt?: string; lastLine?: string }>;
}

export interface Poe2Bridge {
  mode: () => Promise<RuntimeMode>;
  fromClipboard: () => Promise<ItemEvaluation | null>;
  evaluateText: (text: string) => Promise<ItemEvaluation>;
  windows: () => Promise<Array<{ name: string; title: string }>>;
  killLatched: () => Promise<boolean>;
  rearm: () => Promise<boolean>;
  generateFilter: (options: {
    hideBelowScore: number;
    highlightUniques: boolean;
    name: string;
  }) => Promise<string>;
  onItem: (
    callback: (payload: ItemEvaluation) => void,
  ) => () => void;
  intelligence: ItemIntelligenceBridge;
  scanner: ScannerBridge;
  stashSort: Record<string, (...args: never[]) => unknown>;
  stashTabs: Record<string, (...args: never[]) => unknown>;
  shop: Record<string, (...args: never[]) => unknown>;
  priceFeed: Record<string, (...args: never[]) => unknown>;
  assistive: Record<string, unknown>;
  calibration: Record<string, (...args: never[]) => unknown>;
  hotkeys?: HotkeysBridge;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function importedType(query: unknown): string | undefined {
  const document = recordValue(query);
  const body = recordValue(document?.query);
  const type = body?.type;
  if (typeof type === "string" && type.trim()) return type.trim();
  const option = recordValue(type)?.option;
  return typeof option === "string" && option.trim() ? option.trim() : undefined;
}

function importedCategory(query: unknown): string | undefined {
  const document = recordValue(query);
  const body = recordValue(document?.query);
  const filters = recordValue(body?.filters);
  const typeFilters = recordValue(filters?.type_filters);
  const values = recordValue(typeFilters?.filters);
  const category = recordValue(values?.category)?.option;
  return typeof category === "string" && category.trim()
    ? category.trim().toLowerCase()
    : undefined;
}

function inferGearAssociation(query: unknown): {
  slot: string;
  itemClass?: string;
} {
  const category = importedCategory(query) ?? "";
  const type = importedType(query)?.toLowerCase() ?? "";
  const value = `${category} ${type}`;
  const choices: Array<[RegExp, string, string]> = [
    [/\b(helmet|helmets)\b/, "helmet", "Helmets"],
    [/\b(glove|gloves|gauntlets|mitts)\b/, "gloves", "Gloves"],
    [/\b(boot|boots|greaves|shoes)\b/, "boots", "Boots"],
    [/\b(body|chest|body armour|body armours)\b/, "body-armour", "Body Armours"],
    [/\b(ring|rings)\b/, "ring", "Rings"],
    [/\b(amulet|amulets)\b/, "amulet", "Amulets"],
    [/\b(belt|belts)\b/, "belt", "Belts"],
    [/\b(quiver|quivers)\b/, "offhand", "Quivers"],
    [/\b(shield|shields|focus|foci)\b/, "offhand", "Shields"],
    [/\b(bow|bows|staff|staves|wand|wands|sceptre|sceptres|mace|maces|sword|swords|axe|axes|spear|spears|crossbow|crossbows)\b/, "weapon", "Weapons"],
  ];
  for (const [pattern, slot, itemClass] of choices) {
    if (pattern.test(value)) return { slot, itemClass };
  }
  return { slot: "unspecified" };
}

export function tradeQueriesToGearSearches(
  result: TradeQueryImportResult,
  defaultSlot = "unspecified",
): ImportedGearSearch[] {
  return result.queries.map((query, index) => {
    const inferred = inferGearAssociation(query.query);
    const type = importedType(query.query);
    const slot =
      defaultSlot.trim() && defaultSlot !== "unspecified"
        ? defaultSlot.trim()
        : inferred.slot;
    return {
      searchKey: query.searchKey,
      name: type ? `${type} target` : `Imported target ${index + 1}`,
      slot,
      ...(inferred.itemClass ? { itemClass: inferred.itemClass } : {}),
      ...(query.league ? { league: query.league } : {}),
      ...(query.sourceUrl ? { sourceUrl: query.sourceUrl } : {}),
      ...(query.query !== undefined ? { importedQuery: query.query } : {}),
      provenance: {
        kind: query.sourceKind === "opaque-id" ? "opaque-id" : "trade-query",
        sourceKey: query.searchKey,
        ...(query.query !== undefined ? { raw: query.query } : {}),
        unsupported: query.provenance.unsupported,
        warnings: query.unsupportedFilters.map(
          (filter) => `${filter.path}: ${filter.reason}`,
        ),
      },
    };
  });
}
