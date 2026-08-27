import { FrozenClock, SystemClock, type Clock } from "../clock.js";
import { armQa, evaluateQaArming } from "../capabilities/armQa.js";
import { isQaBuildEnabled } from "../capabilities/buildMode.js";
import { createCapabilities, type QaArmingState, type RuntimeCapabilities } from "../capabilities/createCapabilities.js";
import { evaluateFirstRun, type FirstRunSubmission } from "./firstRun.js";
import {
  DEFAULT_ALLOWLISTED_PROCESS_NAMES,
  DEFAULT_ALLOWLISTED_WINDOW_TITLE_INCLUDES,
} from "../perception/allowlist.js";
import { EmergencyStop } from "../input/emergencyStop.js";
import type { MarketProvider, NormalizedItem, QuoteContext } from "../items/types.js";
import { parseItem } from "../items/parseItem.js";
import { failedValuation, LOCKED_OUTLIER_METHOD } from "../market/valuation.js";
import { recommendListingPrice } from "../listing/pricePolicy.js";
import { createEmptyWorldState } from "../world-state/createEmptyWorldState.js";
import type { AutomationScenario } from "../scheduler/types.js";
import type { QaActionTrace, TraceSink } from "../trace/types.js";
import type { RuntimeMode, WorldState } from "../world-state/types.js";
import {
  DEFAULT_FILTER_PROFILE,
  defaultFilterFileName,
  generateLootFilter,
  type FilterProfile,
} from "../filter/lootFilter.js";
import { formatPriceEstimate } from "./priceFormat.js";
import {
  armingDto,
  capabilitiesDto,
  cloneDto,
  tracesDto,
  worldStateDto,
} from "./dto.js";
import type {
  ArmResultDto,
  BuildFlagsDto,
  CatalogItemDto,
  ExportFilterResultDto,
  FirstRunResultDto,
  ParseClipboardResultDto,
  ReplayRunDto,
  StopResultDto,
} from "./ipcTypes.js";
import type { ReplayCatalog } from "./replayCatalog.js";
import {
  defaultOperatorSettings,
  OPERATOR_SETTINGS_KEY,
  parseOperatorSettings,
  type OperatorSettings,
  type SettingsPort,
} from "./settings.js";

export interface ClipboardReader {
  readText(): string;
}

export interface OperatorRuntimeOptions {
  mode: RuntimeMode;
  compileTimeMode?: RuntimeMode;
  clock?: Clock;
  emergencyStop?: EmergencyStop;
  settingsStore: SettingsPort;
  replayCatalog?: ReplayCatalog;
  market?: MarketProvider;
  clipboard?: ClipboardReader;
  hotkeyRegistered?: boolean;
  initialArming?: Partial<QaArmingState>;
  traceSink?: TraceSink;
}

const DEFAULT_QUOTE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CATALOG_SETTINGS_KEY = "catalog";
const SCENARIOS_SETTINGS_KEY = "scenarios";
const FILTER_SETTINGS_KEY = "filterProfile";

function defaultArming(overrides: Partial<QaArmingState> = {}): QaArmingState {
  return {
    acknowledged: false,
    armed: false,
    emergencyStopLatched: false,
    dryRunDefault: true,
    allowlistedProcessNames: [...DEFAULT_ALLOWLISTED_PROCESS_NAMES],
    allowlistedWindowTitleIncludes: [...DEFAULT_ALLOWLISTED_WINDOW_TITLE_INCLUDES],
    ...overrides,
  };
}

export class OperatorRuntime {
  readonly capabilities: RuntimeCapabilities;
  readonly emergencyStop: EmergencyStop;
  readonly settingsStore: SettingsPort;
  readonly compileTimeMode: RuntimeMode;
  readonly #clock: Clock;
  readonly #clipboard?: ClipboardReader;
  readonly #market?: MarketProvider;
  readonly #replayCatalog?: ReplayCatalog;
  readonly #traceSink?: TraceSink;
  #hotkeyRegistered: boolean;
  #arming: QaArmingState;
  #world: WorldState;
  #traces: QaActionTrace[] = [];
  #settings: OperatorSettings;
  #catalog: CatalogItemDto[] = [];
  #scenarios: AutomationScenario[] = [];
  #filterProfile: FilterProfile = cloneDto(DEFAULT_FILTER_PROFILE);

  constructor(options: OperatorRuntimeOptions) {
    this.compileTimeMode = options.compileTimeMode ?? options.mode;
    const mode =
      options.mode === "authorized-qa" && !isQaBuildEnabled(this.compileTimeMode)
        ? "public-companion"
        : options.mode;
    this.capabilities = createCapabilities(mode);
    this.emergencyStop = options.emergencyStop ?? new EmergencyStop();
    this.settingsStore = options.settingsStore;
    this.#clock = options.clock ?? new SystemClock();
    this.#clipboard = options.clipboard;
    this.#market = options.market;
    this.#replayCatalog = options.replayCatalog;
    this.#traceSink = options.traceSink;
    this.#hotkeyRegistered = options.hotkeyRegistered ?? false;
    this.#settings = this.#loadSettings();
    this.#catalog = this.#loadJson(CATALOG_SETTINGS_KEY, []);
    this.#scenarios = this.#loadJson(SCENARIOS_SETTINGS_KEY, []);
    this.#filterProfile = this.#loadJson(FILTER_SETTINGS_KEY, cloneDto(DEFAULT_FILTER_PROFILE));
    this.#arming = defaultArming({
      acknowledged: this.#settings.qaAcknowledged,
      emergencyStopLatched: this.emergencyStop.isLatched(),
      ...options.initialArming,
    });
    if (this.capabilities.mode !== "authorized-qa") {
      this.#arming.armed = false;
    }
    this.#world = createEmptyWorldState({
      clock: this.#clock instanceof FrozenClock ? this.#clock : undefined,
      runtimeMode: this.capabilities.mode,
    });
    this.#syncLatch();
  }

  setHotkeyRegistered(registered: boolean): void {
    this.#hotkeyRegistered = registered;
  }

  getCapabilities() {
    return capabilitiesDto(this.capabilities);
  }

  getBuildFlags(): BuildFlagsDto {
    return {
      compileTimeMode: this.compileTimeMode,
      qaBuildEnabled: isQaBuildEnabled(this.compileTimeMode),
    };
  }

  completeFirstRun(submission: FirstRunSubmission): FirstRunResultDto {
    const evaluation = evaluateFirstRun(submission, this.compileTimeMode, this.#settings);
    if (evaluation.ok) {
      this.saveSettings(evaluation.settings);
    }
    return {
      ok: evaluation.ok,
      reasons: evaluation.reasons,
      settings: cloneDto(this.#settings),
    };
  }

  getWorldState() {
    return worldStateDto(this.#world);
  }

  getTraces() {
    return tracesDto(this.#traces);
  }

  getSettings(): OperatorSettings {
    return cloneDto(this.#settings);
  }

  getCatalog(): CatalogItemDto[] {
    return cloneDto(this.#catalog);
  }

  getScenarios(): AutomationScenario[] {
    return cloneDto(this.#scenarios);
  }

  getArming() {
    return armingDto(this.#arming);
  }

  armQa(): ArmResultDto {
    this.#syncLatch();
    if (this.capabilities.mode !== "authorized-qa" || !this.capabilities.canEmitNativeInput) {
      this.#arming = { ...this.#arming, armed: false };
      return {
        ok: false,
        armed: false,
        reasons: ["public-mode"],
        arming: armingDto(this.#arming),
      };
    }
    const evaluation = evaluateQaArming(this.capabilities, this.#arming, {
      hotkeyRegistered: this.#hotkeyRegistered,
    });
    this.#arming = armQa(this.capabilities, this.#arming, {
      hotkeyRegistered: this.#hotkeyRegistered,
    });
    return {
      ok: evaluation.allowArm && this.#arming.armed,
      armed: this.#arming.armed,
      reasons: evaluation.reasons,
      arming: armingDto(this.#arming),
    };
  }

  disarmQa(): ArmResultDto {
    this.#arming = { ...this.#arming, armed: false };
    return {
      ok: true,
      armed: false,
      reasons: [],
      arming: armingDto(this.#arming),
    };
  }

  tripStop(): StopResultDto {
    this.emergencyStop.trip();
    this.#arming = { ...this.#arming, armed: false, emergencyStopLatched: true };
    this.#world = {
      ...this.#world,
      flags: { ...this.#world.flags, emergencyStopLatched: true },
    };
    return {
      latched: true,
      armed: false,
      arming: armingDto(this.#arming),
    };
  }

  rearmStop(): StopResultDto {
    this.emergencyStop.rearm({ explicit: true });
    this.#arming = { ...this.#arming, emergencyStopLatched: false };
    this.#world = {
      ...this.#world,
      flags: { ...this.#world.flags, emergencyStopLatched: false },
    };
    return {
      latched: false,
      armed: this.#arming.armed,
      arming: armingDto(this.#arming),
    };
  }

  async runReplay(id: string): Promise<ReplayRunDto> {
    if (this.#replayCatalog === undefined) {
      throw new Error("replay-catalog-unavailable");
    }
    const result = await this.#replayCatalog.run(id);
    this.#traces = result.traces;
    this.#persistTraces(result.traces);
    const last = result.traces[result.traces.length - 1];
    if (last !== undefined) {
      this.#world = {
        ...this.#world,
        tickId: last.tickId,
        clockMs: last.clockMs,
        capturedAtMs: last.clockMs,
        selectedState: last.selectedState,
        previousState: last.previousState,
        activeScenarioId: last.scenarioId,
        runtimeMode: last.runtimeMode,
      };
    }
    return {
      id,
      result: "end-of-stream",
      sinkKind: "noop",
      selectedStates: result.traces.map((trace) => trace.selectedState),
      traces: tracesDto(result.traces),
    };
  }

  async parseClipboard(text?: string): Promise<ParseClipboardResultDto> {
    const rawText = text ?? this.#clipboard?.readText() ?? "";
    if (rawText.trim().length === 0) {
      return {
        ok: false,
        rawText,
        error: "clipboard-empty",
        generatedGameActions: false,
      };
    }
    const parsed = parseItem({
      rawText,
      source: "clipboard",
      capturedAtMs: this.#clock.nowMs(),
    });
    if (!parsed.ok) {
      return {
        ok: false,
        rawText,
        error: parsed.error,
        generatedGameActions: false,
      };
    }
    const quoteContext: QuoteContext = {
      league: this.#settings.league,
      realm: "poe2",
      maxAgeMs: DEFAULT_QUOTE_MAX_AGE_MS,
    };
    const quote =
      this.#market === undefined
        ? failedValuation(parsed.item, "none", this.#clock.nowMs(), "market-unavailable").quote
        : await this.#market.quote(parsed.item, quoteContext);
    const recommended = recommendListingPrice(quote);
    const quoteWithListing: typeof quote = {
      ...quote,
      recommendedListing: "skip" in recommended ? quote.recommendedListing : recommended.price,
    };
    const valuation = {
      item: parsed.item,
      quote: quoteWithListing,
      outlierMethod: LOCKED_OUTLIER_METHOD,
      isGuaranteedSalePrice: false as const,
    };
    this.#upsertCatalog(parsed.item);
    return {
      ok: true,
      rawText,
      item: cloneDto(parsed.item),
      quote: cloneDto(quoteWithListing),
      valuation: cloneDto(valuation),
      estimate: formatPriceEstimate(quoteWithListing),
      generatedGameActions: false,
    };
  }

  exportFilter(profile?: FilterProfile): ExportFilterResultDto {
    const resolved = profile ?? this.#filterProfile;
    this.#filterProfile = cloneDto(resolved);
    this.#persistJson(FILTER_SETTINGS_KEY, this.#filterProfile);
    return {
      body: generateLootFilter(resolved),
      fileName: defaultFilterFileName(resolved),
      oauthSync: false,
    };
  }

  saveSettings(settings: OperatorSettings): OperatorSettings {
    this.#settings = parseOperatorSettings(settings);
    this.#persistJson(OPERATOR_SETTINGS_KEY, this.#settings);
    this.#arming = { ...this.#arming, acknowledged: this.#settings.qaAcknowledged };
    if (this.capabilities.mode !== "authorized-qa") {
      this.#arming.armed = false;
    }
    return cloneDto(this.#settings);
  }

  saveScenario(scenario: AutomationScenario): AutomationScenario {
    const next = cloneDto(scenario);
    const index = this.#scenarios.findIndex((entry) => entry.id === next.id);
    if (index === -1) {
      this.#scenarios.push(next);
    } else {
      this.#scenarios[index] = next;
    }
    this.#persistJson(SCENARIOS_SETTINGS_KEY, this.#scenarios);
    return cloneDto(next);
  }

  #upsertCatalog(item: NormalizedItem): void {
    const lastSeenMs = this.#clock.nowMs();
    const index = this.#catalog.findIndex((entry) => entry.fingerprint === item.fingerprint);
    const row: CatalogItemDto = { fingerprint: item.fingerprint, item: cloneDto(item), lastSeenMs };
    if (index === -1) {
      this.#catalog.push(row);
    } else {
      this.#catalog[index] = row;
    }
    this.#persistJson(CATALOG_SETTINGS_KEY, this.#catalog);
  }

  #syncLatch(): void {
    this.#arming = {
      ...this.#arming,
      emergencyStopLatched: this.emergencyStop.isLatched(),
    };
    if (this.#arming.emergencyStopLatched) {
      this.#arming = { ...this.#arming, armed: false };
    }
  }

  #loadSettings(): OperatorSettings {
    const raw = this.settingsStore.get(OPERATOR_SETTINGS_KEY);
    if (raw === undefined) {
      return defaultOperatorSettings();
    }
    try {
      return parseOperatorSettings(JSON.parse(raw) as unknown);
    } catch {
      return defaultOperatorSettings();
    }
  }

  #loadJson<T>(key: string, fallback: T): T {
    const raw = this.settingsStore.get(key);
    if (raw === undefined) {
      return fallback;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  #persistJson(key: string, value: unknown): void {
    this.settingsStore.set(key, JSON.stringify(value), this.#clock.nowMs());
  }

  #persistTraces(traces: readonly QaActionTrace[]): void {
    if (this.#traceSink === undefined) {
      return;
    }
    for (const trace of traces) {
      this.#traceSink.append(trace);
    }
  }
}

export function createOperatorRuntime(options: OperatorRuntimeOptions): OperatorRuntime {
  return new OperatorRuntime(options);
}
