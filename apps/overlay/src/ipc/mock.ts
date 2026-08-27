import {
  createCapabilities,
  createEmptyWorldState,
  DEFAULT_FILTER_PROFILE,
  defaultFilterFileName,
  defaultOperatorSettings,
  formatPriceEstimate,
  generateLootFilter,
  type AutomationScenarioDto,
  type CatalogItemDto,
  type FilterProfileDto,
  type OperatorSettingsDto,
  type Poe2tcPreloadApi,
  type QaActionTraceDto,
  type RuntimeMode,
  type WorldState,
} from "@poe2tc/core/operator";

const SETTINGS_STORAGE_KEY = "poe2tc.overlay.settings";

function readQueryRuntime(): RuntimeMode {
  const params = new URLSearchParams(window.location.search);
  return params.get("runtime") === "authorized-qa" ? "authorized-qa" : "public-companion";
}

function loadSettings(): OperatorSettingsDto {
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (raw === null) {
      return defaultOperatorSettings();
    }
    return { ...defaultOperatorSettings(), ...(JSON.parse(raw) as OperatorSettingsDto) };
  } catch {
    return defaultOperatorSettings();
  }
}

const FULL_LOOP_STATES = [
  "Follow",
  "LootPickup",
  "InventoryFull",
  "StashSort",
  "StashSort",
  "Listing",
  "TradeSession",
] as const;

function mockTrace(tickId: number, selectedState: (typeof FULL_LOOP_STATES)[number]): QaActionTraceDto {
  return {
    id: `mock:${String(tickId)}`,
    timestamp: "2026-08-27T00:00:00.000Z",
    clockMs: tickId * 100,
    tickId,
    scenarioId: "full-loop",
    runtimeMode: "authorized-qa",
    module: "orchestrator",
    selectedState,
    previousState: tickId === 1 ? "Idle" : (FULL_LOOP_STATES[tickId - 2] ?? "Idle"),
    observedSummary: `mock ${selectedState}`,
    confidence: 0.9,
    decisionReason: `replay:${selectedState}`,
    intendedActions: [{ type: "noop", reason: "mock-replay" }],
    interlockCode: "dry-run",
    executed: false,
    dryRun: true,
    result: "dry-run",
  };
}

export function installBrowserMock(mode: RuntimeMode = readQueryRuntime()): Poe2tcPreloadApi {
  const capabilities = createCapabilities(mode);
  let settings = loadSettings();
  let armed = false;
  let latched = false;
  let world: WorldState = createEmptyWorldState({ runtimeMode: mode });
  let traces: QaActionTraceDto[] = [];
  let catalog: CatalogItemDto[] = [];
  let scenarios: AutomationScenarioDto[] = [];
  let filterProfile: FilterProfileDto = { ...DEFAULT_FILTER_PROFILE };

  const api: Poe2tcPreloadApi = {
    async getCapabilities() {
      return {
        mode: capabilities.mode,
        canEmitNativeInput: capabilities.canEmitNativeInput,
        qaBannerRequired: capabilities.qaBannerRequired,
        modules: { ...capabilities.modules },
      };
    },
    async getWorldState() {
      return world;
    },
    async getTraces() {
      return traces;
    },
    async armQa() {
      if (mode !== "authorized-qa") {
        armed = false;
        return {
          ok: false,
          armed: false,
          reasons: ["public-mode"],
          arming: {
            acknowledged: settings.qaAcknowledged,
            armed: false,
            emergencyStopLatched: latched,
            dryRunDefault: true,
            allowlistedProcessNames: [],
            allowlistedWindowTitleIncludes: [],
          },
        };
      }
      armed = !latched && settings.qaAcknowledged;
      return {
        ok: armed,
        armed,
        reasons: armed ? [] : settings.qaAcknowledged ? ["emergency-stop"] : ["qa-not-acknowledged"],
        arming: {
          acknowledged: settings.qaAcknowledged,
          armed,
          emergencyStopLatched: latched,
          dryRunDefault: true,
          allowlistedProcessNames: ["PathOfExile.exe"],
          allowlistedWindowTitleIncludes: ["Path of Exile 2"],
        },
      };
    },
    async disarmQa() {
      armed = false;
      return {
        ok: true,
        armed: false,
        reasons: [],
        arming: {
          acknowledged: settings.qaAcknowledged,
          armed: false,
          emergencyStopLatched: latched,
          dryRunDefault: true,
          allowlistedProcessNames: [],
          allowlistedWindowTitleIncludes: [],
        },
      };
    },
    async tripStop() {
      latched = true;
      armed = false;
      return {
        latched: true,
        armed: false,
        arming: {
          acknowledged: settings.qaAcknowledged,
          armed: false,
          emergencyStopLatched: true,
          dryRunDefault: true,
          allowlistedProcessNames: [],
          allowlistedWindowTitleIncludes: [],
        },
      };
    },
    async rearmStop() {
      latched = false;
      return {
        latched: false,
        armed,
        arming: {
          acknowledged: settings.qaAcknowledged,
          armed,
          emergencyStopLatched: false,
          dryRunDefault: true,
          allowlistedProcessNames: [],
          allowlistedWindowTitleIncludes: [],
        },
      };
    },
    async runReplay(id: string) {
      traces = FULL_LOOP_STATES.map((state, index) => mockTrace(index + 1, state));
      world = {
        ...world,
        selectedState: traces[traces.length - 1]?.selectedState ?? "Idle",
        activeScenarioId: id,
      };
      return {
        id,
        result: "end-of-stream",
        sinkKind: "noop",
        selectedStates: traces.map((trace) => trace.selectedState),
        traces,
      };
    },
    async parseClipboard(text?: string) {
      const rawText = text ?? "";
      if (rawText.trim().length === 0) {
        return { ok: false, rawText, error: "clipboard-empty", generatedGameActions: false as const };
      }
      const name = rawText.split(/\r?\n/).find((line) => line.length > 0 && !line.startsWith("Item Class")) ?? "Item";
      const item = {
        fingerprint: `mock:${name}`,
        name,
        rarity: "Rare",
        class: "Rings",
        modifiers: [],
        pseudos: {},
      };
      const quote = {
        providerId: "fixture",
        quotedAtMs: Date.now(),
        currency: "exalted",
        low: 0.02,
        fair: 0.05,
        high: 0.08,
        recommendedListing: 0.05,
        candidateCount: 6,
        comparableCount: 5,
        confidence: "medium" as const,
        comparables: [],
      };
      catalog = [
        ...catalog.filter((entry) => entry.fingerprint !== item.fingerprint),
        { fingerprint: item.fingerprint, item, lastSeenMs: Date.now() },
      ];
      return {
        ok: true,
        rawText,
        item,
        quote,
        valuation: { item, quote, outlierMethod: "tukey-1.5-iqr" as const, isGuaranteedSalePrice: false as const },
        estimate: formatPriceEstimate(quote),
        generatedGameActions: false as const,
      };
    },
    async exportFilter(profile?: FilterProfileDto) {
      filterProfile = profile ?? filterProfile;
      return {
        body: generateLootFilter(filterProfile),
        fileName: defaultFilterFileName(filterProfile),
        oauthSync: false as const,
      };
    },
    async getSettings() {
      return settings;
    },
    async saveSettings(next: OperatorSettingsDto) {
      settings = { ...settings, ...next };
      window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
      return settings;
    },
    async getCatalog() {
      return catalog;
    },
    async getScenarios() {
      return scenarios;
    },
    async saveScenario(scenario: AutomationScenarioDto) {
      scenarios = [...scenarios.filter((entry) => entry.id !== scenario.id), scenario];
      return scenario;
    },
  };

  window.poe2tc = api;
  return api;
}
