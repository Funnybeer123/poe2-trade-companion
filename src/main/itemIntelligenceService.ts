import {
  activateBuildProfile,
  createBuildProfile,
  importGearTargets,
  validateBuildProfile,
  type BuildProfile,
} from "../core/buildProfiles.js";
import { validateRuleRegex, type ScanHistoryItem } from "../core/scanRules.js";
import {
  buildSearchRegex,
  type SearchRegexRequest,
  type SearchRegexResult,
} from "../core/searchRegex.js";
import { importTradeQueries } from "../core/tradeQueryImport.js";
import { DEFAULT_TRIAGE_ROUTING, type TriageRouting } from "../core/bagTriage.js";
import {
  starterPriceTable,
  validatePriceTable,
  type PriceTable,
} from "../core/priceTable.js";
import { evaluateWithAppraisal } from "../core/appraisal.js";
import { DEFAULT_MIN_DETOUR_CONFIDENCE } from "../core/sortTriage.js";
import {
  DEFAULT_TIER_THRESHOLDS,
  starterValueTierRules,
  validateValueTierRules,
  type TierVerdict,
  type ValueTierRules,
  type ValueTierThresholds,
} from "../core/valueTiers.js";
import type {
  DesirabilityResult,
  NormalizedItem,
  ValuationResult,
} from "../core/types.js";
import {
  ITEM_INTELLIGENCE_IPC_VERSION,
  tradeQueriesToGearSearches,
  type CatalogItemView,
  type ImportBuildTargetsRequest,
  type ImportBuildTargetsResult,
  type IntelligenceExportRequest,
  type IntelligenceExportResult,
  type ItemIntelligenceEventContract,
  type LegacyImportRequest,
  type LegacyImportResult,
  type ParsedItemEvaluation,
  type RuleSetView,
  type SaveRuleSetRequest,
  type SaveValueTierConfigRequest,
  type ScanSessionDetail,
  type ScanSessionView,
  type ValueTierConfigView,
} from "../shared/ipc.js";
import {
  exportIntelligenceData,
  importLegacyData,
  type LocalPersistenceDatabase,
} from "./persistence/index.js";

const MAX_RULES_PER_SET = 1_000;

export type IntelligenceEventPublisher = <
  C extends keyof ItemIntelligenceEventContract,
>(
  channel: C,
  payload: ItemIntelligenceEventContract[C],
) => void;

export interface ItemIntelligenceServiceOptions {
  persistence: LocalPersistenceDatabase;
  publish?: IntelligenceEventPublisher;
  now?: () => Date | string | number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNormalizedItem(value: unknown): value is NormalizedItem {
  return (
    isRecord(value) &&
    typeof value.fingerprint === "string" &&
    typeof value.name === "string" &&
    typeof value.baseType === "string" &&
    typeof value.itemClass === "string" &&
    Array.isArray(value.mods)
  );
}

function isValuation(value: unknown): value is ValuationResult {
  return (
    isRecord(value) &&
    typeof value.providerName === "string" &&
    typeof value.marketTimestamp === "string" &&
    typeof value.fair === "number" &&
    typeof value.low === "number" &&
    typeof value.high === "number"
  );
}

function isDesirability(value: unknown): value is DesirabilityResult {
  return (
    isRecord(value) &&
    typeof value.score === "number" &&
    typeof value.category === "string" &&
    Array.isArray(value.reasons)
  );
}

function evaluationPayload(value: unknown): {
  item?: NormalizedItem;
  valuation?: ValuationResult;
  desirability?: DesirabilityResult;
} {
  if (isNormalizedItem(value)) return { item: value };
  if (!isRecord(value)) return {};
  return {
    ...(isNormalizedItem(value.item) ? { item: value.item } : {}),
    ...(isValuation(value.valuation) ? { valuation: value.valuation } : {}),
    ...(isDesirability(value.desirability)
      ? { desirability: value.desirability }
      : {}),
  };
}

function scanHistoryItems(value: unknown): ScanHistoryItem[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is ScanHistoryItem =>
      isRecord(entry) &&
      typeof entry.name === "string" &&
      typeof entry.regex === "string",
  );
}

function viewRuleSet(
  record: ReturnType<LocalPersistenceDatabase["ruleSets"]["upsert"]>,
): RuleSetView {
  return {
    id: record.id,
    kind: "stash-scan",
    name: record.name,
    schemaVersion: record.schemaVersion,
    rules: scanHistoryItems(record.rules),
    active: record.active,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export class ItemIntelligenceService {
  private readonly now: () => string;

  constructor(private readonly options: ItemIntelligenceServiceOptions) {
    const clock = options.now ?? (() => new Date());
    this.now = () => {
      const value = clock();
      const date = value instanceof Date ? value : new Date(value);
      if (!Number.isFinite(date.getTime())) {
        throw new Error("item-intelligence-clock-invalid");
      }
      return date.toISOString();
    };
  }

  recordEvaluation(
    evaluation: ParsedItemEvaluation,
    source: "clipboard" | "paste" | "scan" = "clipboard",
  ): CatalogItemView {
    const { item, valuation, desirability } = evaluation;
    const location = `${source}:latest`;
    const catalog = this.options.persistence.catalogItems.upsert({
      fingerprint: item.fingerprint,
      name: item.name || item.baseType,
      baseType: item.baseType,
      itemClass: item.itemClass,
      currentLocation: location,
      recommendation: desirability.category,
      fairValue: valuation.fair,
      payload: {
        schemaVersion: ITEM_INTELLIGENCE_IPC_VERSION,
        item,
        valuation,
        desirability,
      },
    });
    this.options.persistence.itemObservations.upsert({
      catalogItemId: catalog.id,
      observedAt: this.now(),
      source,
      location,
      confidence: 1,
      payload: { raw: evaluation.raw },
    });
    this.options.persistence.valuations.upsert({
      catalogItemId: catalog.id,
      providerName: valuation.providerName,
      marketTimestamp: valuation.marketTimestamp,
      currency: valuation.currency,
      low: valuation.low,
      fair: valuation.fair,
      high: valuation.high,
      confidence: valuation.confidence,
      sampleSize: valuation.comparablesUsed,
      payload: valuation,
    });
    const view = this.catalogItem(catalog.id)!;
    this.publishCatalog();
    return view;
  }

  catalogItem(id: string): CatalogItemView | undefined {
    const record = this.options.persistence.catalogItems.get(id);
    if (!record) return undefined;
    const payload = evaluationPayload(record.payload);
    return {
      id: record.id,
      fingerprint: record.fingerprint,
      name: record.name,
      baseType: record.baseType,
      itemClass: record.itemClass,
      currentLocation: record.currentLocation,
      ...(record.recommendation
        ? { recommendation: record.recommendation }
        : {}),
      ...(record.fairValue !== undefined ? { fairValue: record.fairValue } : {}),
      ...payload,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  listCatalog(): CatalogItemView[] {
    return this.options.persistence.catalogItems
      .list()
      .map((record) => this.catalogItem(record.id)!)
      .filter(Boolean);
  }

  removeCatalogItem(id: string): boolean {
    const removed = this.options.persistence.catalogItems.delete(id);
    if (removed) this.publishCatalog();
    return removed;
  }

  listRuleSets(): RuleSetView[] {
    return this.options.persistence.ruleSets
      .list("stash-scan")
      .map(viewRuleSet);
  }

  saveRuleSet(request: SaveRuleSetRequest): RuleSetView {
    if (typeof request.name !== "string") {
      throw new Error("rule-set-name-required");
    }
    const name = request.name.trim();
    if (!name) throw new Error("rule-set-name-required");
    if (!Array.isArray(request.rules)) {
      throw new Error("rule-set-rules-array-required");
    }
    if (request.rules.length > MAX_RULES_PER_SET) {
      throw new Error(`rule-set-cap-exceeded:${MAX_RULES_PER_SET}`);
    }
    if (
      request.rules.some(
        (rule) =>
          !isRecord(rule) ||
          typeof rule.regex !== "string" ||
          (rule.name !== undefined && typeof rule.name !== "string"),
      )
    ) {
      throw new Error("rule-set-rule-contract-invalid");
    }
    const invalid = request.rules
      .map((rule, index) => ({
        index,
        rule,
        validation: validateRuleRegex(rule.regex),
      }))
      .filter((entry) => !entry.validation.valid);
    if (invalid.length > 0) {
      const first = invalid[0]!;
      throw new Error(
        `invalid-rule:${first.index}:${first.validation.issues[0]?.message ?? "validation failed"}`,
      );
    }
    const saved = this.options.persistence.ruleSets.upsert({
      ...(request.id ? { id: request.id } : {}),
      kind: "stash-scan",
      name,
      schemaVersion: 1,
      rules: request.rules,
      active: request.active ?? true,
    });
    this.publishRules();
    return viewRuleSet(saved);
  }

  removeRuleSet(id: string): boolean {
    const removed = this.options.persistence.ruleSets.delete(id);
    if (removed) this.publishRules();
    return removed;
  }

  validateRule(ruleText: string) {
    return validateRuleRegex(ruleText);
  }

  generateSearch(request: SearchRegexRequest): SearchRegexResult {
    return buildSearchRegex(request);
  }

  listBuildProfiles(): BuildProfile[] {
    return this.options.persistence.buildProfiles.list();
  }

  saveBuildProfile(profile: BuildProfile): BuildProfile {
    const validation = validateBuildProfile(profile);
    if (!validation.valid) {
      throw new Error(
        `invalid-build-profile:${validation.issues
          .map((issue) => `${issue.path}:${issue.code}`)
          .join(",")}`,
      );
    }
    const saved = this.options.persistence.buildProfiles.upsert(profile);
    this.publishBuilds();
    return saved;
  }

  removeBuildProfile(id: string): boolean {
    const removed = this.options.persistence.buildProfiles.delete(id);
    if (removed) this.publishBuilds();
    return removed;
  }

  activateBuildProfile(id?: string): BuildProfile[] {
    const profiles = activateBuildProfile(
      this.listBuildProfiles(),
      id?.trim() || undefined,
      { now: this.now() },
    );
    for (const profile of profiles) {
      this.options.persistence.buildProfiles.upsert(profile);
    }
    this.publishBuilds();
    return this.listBuildProfiles();
  }

  importBuildTargets(
    request: ImportBuildTargetsRequest,
  ): ImportBuildTargetsResult {
    if (typeof request.sourceText !== "string") {
      throw new Error("build-import-source-text-required");
    }
    if (
      request.defaultSlot !== undefined &&
      typeof request.defaultSlot !== "string"
    ) {
      throw new Error("build-import-default-slot-invalid");
    }
    if (request.profileId && request.profile) {
      throw new Error("build-import-profile-source-conflict");
    }
    const tradeImport = importTradeQueries(request.sourceText);
    const existing = request.profileId
      ? this.options.persistence.buildProfiles.get(request.profileId)
      : undefined;
    if (request.profileId && !existing) {
      throw new Error("build-profile-not-found");
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
      createBuildProfile(
        request.profile ?? { name: "Imported build" },
        { now: this.now() },
      );
    const imported = importGearTargets(
      profile,
      tradeQueriesToGearSearches(
        tradeImport,
        request.defaultSlot?.trim() || "unspecified",
      ),
      { now: this.now() },
    );
    const saved = this.options.persistence.buildProfiles.upsert(imported.profile);
    this.publishBuilds();
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

  importLegacy(request: LegacyImportRequest): LegacyImportResult {
    if (
      !["scan-history", "regex-history", "trade-presets", "scan-jsonl"].includes(
        request.kind,
      )
    ) {
      throw new Error("legacy-import-kind-invalid");
    }
    if (typeof request.input !== "string") {
      throw new Error("legacy-import-input-required");
    }
    if (typeof request.sourceKey !== "string" || !request.sourceKey.trim()) {
      throw new Error("legacy-import-source-key-required");
    }
    const result = importLegacyData(
      this.options.persistence,
      request.kind,
      request.input,
      {
        sourceKey: request.sourceKey,
        ...(request.sourceUri ? { sourceUri: request.sourceUri } : {}),
        importedAt: this.now(),
      },
    );
    if (request.kind === "scan-history" || request.kind === "regex-history") {
      for (const presetId of result.entityIds) {
        const preset = this.options.persistence.presets.get(presetId);
        if (!preset || !isRecord(preset.payload)) continue;
        const regex = preset.payload.regex;
        if (typeof regex !== "string" || !validateRuleRegex(regex).valid) continue;
        this.options.persistence.ruleSets.upsert({
          kind: "stash-scan",
          name: preset.name,
          schemaVersion: 1,
          active: false,
          rules: [
            {
              id: preset.id,
              name: preset.name,
              regex,
              sourceUrl: request.sourceUri,
              createdAt:
                typeof preset.payload.legacyCreatedAt === "string"
                  ? preset.payload.legacyCreatedAt
                  : preset.createdAt,
              schemaVersion: 1,
            },
          ],
        });
      }
    }
    this.publishCatalog();
    this.publishRules();
    return result;
  }

  exportData(request: IntelligenceExportRequest): IntelligenceExportResult {
    if (
      !["regex-history", "trade-presets", "scan-jsonl", "bundle"].includes(
        request.kind,
      )
    ) {
      throw new Error("intelligence-export-kind-invalid");
    }
    return exportIntelligenceData(
      this.options.persistence,
      request,
      this.now(),
    );
  }

  private static readonly TIER_SETTING_KEY = "value-tiers";
  private static readonly PRICE_TABLE_SETTING_KEY = "price-table";

  private sanitizeTierRules(value: unknown): ValueTierRules | undefined {
    if (!isRecord(value)) return undefined;
    const buckets = ["keep", "sell", "dump"] as const;
    const rules = {} as ValueTierRules;
    for (const bucket of buckets) {
      const raw = value[bucket];
      if (!Array.isArray(raw)) return undefined;
      const entries: ScanHistoryItem[] = [];
      for (const entry of raw) {
        if (
          !isRecord(entry) ||
          typeof entry.regex !== "string" ||
          (entry.name !== undefined && typeof entry.name !== "string")
        ) {
          return undefined;
        }
        entries.push({
          regex: entry.regex,
          ...(typeof entry.name === "string" && entry.name.trim()
            ? { name: entry.name.trim() }
            : {}),
          ...(typeof entry.id === "string" ? { id: entry.id } : {}),
        });
      }
      rules[bucket] = entries;
    }
    return rules;
  }

  private sanitizeThresholds(value: unknown): ValueTierThresholds {
    if (
      isRecord(value) &&
      typeof value.keepAtOrAbove === "number" &&
      typeof value.sellAtOrAbove === "number" &&
      Number.isFinite(value.keepAtOrAbove) &&
      Number.isFinite(value.sellAtOrAbove) &&
      value.keepAtOrAbove >= value.sellAtOrAbove
    ) {
      return {
        keepAtOrAbove: value.keepAtOrAbove,
        sellAtOrAbove: value.sellAtOrAbove,
      };
    }
    return { ...DEFAULT_TIER_THRESHOLDS };
  }

  private sanitizeRouting(value: unknown): TriageRouting {
    if (
      isRecord(value) &&
      typeof value.reviewTab === "string" &&
      value.reviewTab.trim() &&
      typeof value.dumpTab === "string" &&
      value.dumpTab.trim()
    ) {
      return {
        reviewTab: value.reviewTab.trim(),
        dumpTab: value.dumpTab.trim(),
        ...(typeof value.sellTab === "string" && value.sellTab.trim()
          ? { sellTab: value.sellTab.trim() }
          : {}),
      };
    }
    return { ...DEFAULT_TRIAGE_ROUTING };
  }

  private sanitizeDetourConfidence(value: unknown): number {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.max(0, Math.min(100, Math.round(value)));
    }
    return DEFAULT_MIN_DETOUR_CONFIDENCE;
  }

  getValueTierConfig(): ValueTierConfigView {
    const stored = this.options.persistence.settings.get(
      ItemIntelligenceService.TIER_SETTING_KEY,
    );
    const value = stored?.value;
    const rules = isRecord(value) ? this.sanitizeTierRules(value.rules) : undefined;
    if (!rules) {
      const seeded: ValueTierConfigView = {
        schemaVersion: 1,
        rules: starterValueTierRules(),
        thresholds: { ...DEFAULT_TIER_THRESHOLDS },
        routing: { ...DEFAULT_TRIAGE_ROUTING },
        minDetourConfidence: DEFAULT_MIN_DETOUR_CONFIDENCE,
        updatedAt: this.now(),
      };
      this.options.persistence.settings.set({
        key: ItemIntelligenceService.TIER_SETTING_KEY,
        value: seeded,
      });
      return seeded;
    }
    const record = value as Record<string, unknown>;
    return {
      schemaVersion: 1,
      rules,
      thresholds: this.sanitizeThresholds(record.thresholds),
      routing: this.sanitizeRouting(record.routing),
      minDetourConfidence: this.sanitizeDetourConfidence(record.minDetourConfidence),
      ...(typeof record.updatedAt === "string" ? { updatedAt: record.updatedAt } : {}),
    };
  }

  saveValueTierConfig(request: SaveValueTierConfigRequest): ValueTierConfigView {
    const rules = this.sanitizeTierRules(request.rules);
    if (!rules) throw new Error("value-tier-rules-invalid-shape");
    const issues = validateValueTierRules(rules);
    if (issues.length > 0) {
      const first = issues[0]!;
      throw new Error(`invalid-tier-rule:${first.tier}:${first.index}:${first.message}`);
    }
    const config: ValueTierConfigView = {
      schemaVersion: 1,
      rules,
      thresholds: this.sanitizeThresholds(request.thresholds),
      routing: this.sanitizeRouting(request.routing),
      minDetourConfidence: this.sanitizeDetourConfidence(request.minDetourConfidence),
      updatedAt: this.now(),
    };
    this.options.persistence.settings.set({
      key: ItemIntelligenceService.TIER_SETTING_KEY,
      value: config,
    });
    this.options.publish?.("tiers:changed", config);
    return config;
  }

  getPriceTable(): PriceTable {
    const stored = this.options.persistence.settings.get(
      ItemIntelligenceService.PRICE_TABLE_SETTING_KEY,
    );
    if (stored) {
      const validation = validatePriceTable(stored.value);
      if (validation.valid && validation.table) return validation.table;
    }
    const seeded: PriceTable = { ...starterPriceTable(), updatedAt: this.now() };
    this.options.persistence.settings.set({
      key: ItemIntelligenceService.PRICE_TABLE_SETTING_KEY,
      value: seeded,
    });
    return seeded;
  }

  savePriceTable(table: PriceTable): PriceTable {
    const validation = validatePriceTable(table);
    if (!validation.valid || !validation.table) {
      const first = validation.issues[0];
      throw new Error(
        `invalid-price-table:${first ? `${first.path}:${first.message}` : "unknown"}`,
      );
    }
    const saved: PriceTable = { ...validation.table, updatedAt: this.now() };
    this.options.persistence.settings.set({
      key: ItemIntelligenceService.PRICE_TABLE_SETTING_KEY,
      value: saved,
    });
    this.options.publish?.("prices:changed", saved);
    return saved;
  }

  evaluateTier(itemText: string): TierVerdict {
    const config = this.getValueTierConfig();
    return evaluateWithAppraisal(typeof itemText === "string" ? itemText : "", {
      rules: config.rules,
      priceTable: this.getPriceTable(),
      thresholds: config.thresholds,
    });
  }

  listScans(): ScanSessionView[] {
    return this.options.persistence.scanSessions.list();
  }

  getScan(id: string): ScanSessionDetail | null {
    const session = this.options.persistence.scanSessions.get(id);
    if (!session) return null;
    return {
      session,
      slots: this.options.persistence.scanSlots.listForSession(id),
    };
  }

  private publishCatalog(): void {
    this.options.publish?.("catalog:changed", this.listCatalog());
  }

  private publishBuilds(): void {
    this.options.publish?.("builds:changed", this.listBuildProfiles());
  }

  private publishRules(): void {
    this.options.publish?.("rules:changed", this.listRuleSets());
  }
}
