import type { RuntimeCapabilities, QaArmingState } from "../capabilities/createCapabilities.js";
import type { FilterProfile } from "../filter/lootFilter.js";
import type { MarketQuote, NormalizedItem, ValuationResult } from "../items/types.js";
import type { AutomationScenario } from "../scheduler/types.js";
import type { QaActionTrace } from "../trace/types.js";
import type { AutomationStateId, RuntimeMode, WorldState } from "../world-state/types.js";
import type { OperatorSettings } from "./settings.js";
import type { PriceEstimateDisplay } from "./priceFormat.js";

/** Renderer-safe copy of RuntimeCapabilities. */
export interface CapabilitiesDto {
  mode: RuntimeMode;
  canEmitNativeInput: boolean;
  qaBannerRequired: boolean;
  modules: RuntimeCapabilities["modules"];
}

export interface ArmingDto {
  acknowledged: boolean;
  armed: boolean;
  emergencyStopLatched: boolean;
  dryRunDefault: boolean;
  allowlistedProcessNames: string[];
  allowlistedWindowTitleIncludes: string[];
  realmAllowlist?: string[];
  accountAliasAllowlist?: string[];
  characterAliasAllowlist?: string[];
  scenarioAllowlist?: string[];
}

export type WorldStateDto = WorldState;
export type QaActionTraceDto = QaActionTrace;
export type OperatorSettingsDto = OperatorSettings;
export type FilterProfileDto = FilterProfile;
export type AutomationScenarioDto = AutomationScenario;

export interface ArmResultDto {
  ok: boolean;
  armed: boolean;
  reasons: string[];
  arming: ArmingDto;
}

export interface StopResultDto {
  latched: boolean;
  armed: boolean;
  arming: ArmingDto;
}

export interface ReplayRunDto {
  id: string;
  result: "end-of-stream";
  sinkKind: "noop";
  selectedStates: AutomationStateId[];
  traces: QaActionTraceDto[];
}

export interface ParseClipboardResultDto {
  ok: boolean;
  rawText: string;
  item?: NormalizedItem;
  quote?: MarketQuote;
  valuation?: ValuationResult;
  estimate?: PriceEstimateDisplay;
  error?: string;
  generatedGameActions: false;
}

export interface ExportFilterResultDto {
  body: string;
  fileName: string;
  oauthSync: false;
}

export interface BuildFlagsDto {
  compileTimeMode: RuntimeMode;
  qaBuildEnabled: boolean;
}

export interface FirstRunSubmissionDto {
  selectedMode: RuntimeMode;
  confirmationText?: string;
  acknowledged: boolean;
}

export interface FirstRunResultDto {
  ok: boolean;
  reasons: string[];
  settings: OperatorSettingsDto;
}

export interface IpcErrorDto {
  code: string;
  message: string;
}

export interface CatalogItemDto {
  fingerprint: string;
  item: NormalizedItem;
  lastSeenMs: number;
}

/**
 * Typed preload API. Renderer must use these DTO copies — never Electron APIs.
 * Extra settings/catalog methods support operator views beyond the Phase 14 minimum list.
 */
export interface Poe2tcPreloadApi {
  getCapabilities(): Promise<CapabilitiesDto>;
  getWorldState(): Promise<WorldStateDto>;
  getTraces(): Promise<QaActionTraceDto[]>;
  armQa(): Promise<ArmResultDto>;
  disarmQa(): Promise<ArmResultDto>;
  tripStop(): Promise<StopResultDto>;
  rearmStop(): Promise<StopResultDto>;
  runReplay(id: string): Promise<ReplayRunDto>;
  parseClipboard(text?: string): Promise<ParseClipboardResultDto>;
  exportFilter(profile?: FilterProfileDto): Promise<ExportFilterResultDto>;
  getSettings(): Promise<OperatorSettingsDto>;
  saveSettings(settings: OperatorSettingsDto): Promise<OperatorSettingsDto>;
  getCatalog(): Promise<CatalogItemDto[]>;
  getScenarios(): Promise<AutomationScenarioDto[]>;
  saveScenario(scenario: AutomationScenarioDto): Promise<AutomationScenarioDto>;
  getBuildFlags(): Promise<BuildFlagsDto>;
  completeFirstRun(submission: FirstRunSubmissionDto): Promise<FirstRunResultDto>;
}

export type { QaArmingState };
