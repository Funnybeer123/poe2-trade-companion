import { computed, ref } from "vue";
import type { BuildProfile } from "@core/buildProfiles";
import {
  ITEM_INTELLIGENCE_IPC_VERSION,
  type CatalogItemView,
  type ImportBuildTargetsRequest,
  type ItemEvaluation,
  type ParsedItemEvaluation,
  type RuleSetView,
  type SaveRuleSetRequest,
} from "../../shared/ipc.js";
import { rendererApi } from "../services/rendererApi";

type LoadState = "idle" | "loading" | "ready" | "error";

const currentEvaluation = ref<ParsedItemEvaluation | null>(null);
const currentCatalogItem = ref<CatalogItemView | null>(null);
const itemError = ref("");
const evaluating = ref(false);
const externalEvaluationVersion = ref(0);

const catalog = ref<CatalogItemView[]>([]);
const catalogState = ref<LoadState>("idle");
const catalogError = ref("");

const ruleSets = ref<RuleSetView[]>([]);
const rulesState = ref<LoadState>("idle");
const rulesError = ref("");

const buildProfiles = ref<BuildProfile[]>([]);
const buildsState = ref<LoadState>("idle");
const buildsError = ref("");

let initialized = false;
const unsubscribers: Array<() => void> = [];

function message(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}

function applyEvaluation(
  evaluation: ItemEvaluation,
  source: "local" | "external",
): boolean {
  if (!evaluation.parsed) {
    itemError.value =
      evaluation.reason === "empty"
        ? "Paste an item before evaluating."
        : "This does not look like copied Path of Exile item text. Include the Item Class or Rarity header.";
    return false;
  }
  currentEvaluation.value = evaluation;
  currentCatalogItem.value = null;
  itemError.value = "";
  if (source === "external") externalEvaluationVersion.value += 1;
  return true;
}

async function refreshCatalog(): Promise<void> {
  catalogState.value = "loading";
  catalogError.value = "";
  try {
    catalog.value = await rendererApi.intelligence.catalog.list();
    if (currentCatalogItem.value) {
      currentCatalogItem.value =
        catalog.value.find(
          (entry) => entry.id === currentCatalogItem.value?.id,
        ) ?? null;
    }
    catalogState.value = "ready";
  } catch (reason) {
    catalogState.value = "error";
    catalogError.value = message(reason, "The local item catalog could not be loaded.");
  }
}

async function refreshRuleSets(): Promise<void> {
  rulesState.value = "loading";
  rulesError.value = "";
  try {
    ruleSets.value = await rendererApi.intelligence.rules.list();
    rulesState.value = "ready";
  } catch (reason) {
    rulesState.value = "error";
    rulesError.value = message(reason, "Saved rules could not be loaded.");
  }
}

async function refreshBuildProfiles(): Promise<void> {
  buildsState.value = "loading";
  buildsError.value = "";
  try {
    buildProfiles.value = await rendererApi.intelligence.builds.list();
    buildsState.value = "ready";
  } catch (reason) {
    buildsState.value = "error";
    buildsError.value = message(reason, "Build profiles could not be loaded.");
  }
}

async function initializeIntelligence(): Promise<void> {
  if (initialized) return;
  initialized = true;
  unsubscribers.push(
    rendererApi.onItem((evaluation) => {
      applyEvaluation(evaluation, "external");
    }),
    rendererApi.intelligence.catalog.onChanged((items) => {
      catalog.value = items;
      catalogState.value = "ready";
    }),
    rendererApi.intelligence.rules.onChanged((items) => {
      ruleSets.value = items;
      rulesState.value = "ready";
    }),
    rendererApi.intelligence.builds.onChanged((profiles) => {
      buildProfiles.value = profiles;
      buildsState.value = "ready";
    }),
  );
  await Promise.all([
    refreshCatalog(),
    refreshRuleSets(),
    refreshBuildProfiles(),
  ]);
}

async function evaluateText(text: string): Promise<boolean> {
  evaluating.value = true;
  itemError.value = "";
  try {
    const evaluation = await rendererApi.evaluateText(text);
    const applied = applyEvaluation(evaluation, "local");
    await refreshCatalog();
    return applied;
  } catch (reason) {
    itemError.value = message(reason, "Item evaluation failed.");
    return false;
  } finally {
    evaluating.value = false;
  }
}

async function evaluateClipboard(): Promise<boolean> {
  evaluating.value = true;
  itemError.value = "";
  try {
    const evaluation = await rendererApi.fromClipboard();
    if (!evaluation) {
      itemError.value = "The clipboard is empty.";
      return false;
    }
    const applied = applyEvaluation(evaluation, "local");
    await refreshCatalog();
    return applied;
  } catch (reason) {
    itemError.value = message(reason, "Clipboard access failed.");
    return false;
  } finally {
    evaluating.value = false;
  }
}

function selectCatalogItem(entry: CatalogItemView): void {
  currentCatalogItem.value = entry;
  itemError.value = "";
  if (entry.item && entry.valuation && entry.desirability) {
    currentEvaluation.value = {
      schemaVersion: ITEM_INTELLIGENCE_IPC_VERSION,
      parsed: true,
      raw: entry.item.rawText ?? "",
      item: entry.item,
      valuation: entry.valuation,
      desirability: entry.desirability,
    };
  } else {
    currentEvaluation.value = null;
  }
}

async function removeCatalogItem(entry: CatalogItemView): Promise<void> {
  catalogError.value = "";
  try {
    await rendererApi.intelligence.catalog.remove(entry.id);
    if (currentCatalogItem.value?.id === entry.id) {
      currentCatalogItem.value = null;
      currentEvaluation.value = null;
    }
    await refreshCatalog();
  } catch (reason) {
    catalogError.value = message(reason, "The catalog item could not be deleted.");
  }
}

async function saveRuleSet(request: SaveRuleSetRequest): Promise<RuleSetView> {
  rulesError.value = "";
  try {
    const saved = await rendererApi.intelligence.rules.save(request);
    await refreshRuleSets();
    return saved;
  } catch (reason) {
    rulesError.value = message(reason, "The rule set could not be saved.");
    throw reason;
  }
}

async function removeRuleSet(ruleSetId: string): Promise<void> {
  rulesError.value = "";
  try {
    await rendererApi.intelligence.rules.remove(ruleSetId);
    await refreshRuleSets();
  } catch (reason) {
    rulesError.value = message(reason, "The rule set could not be deleted.");
  }
}

async function saveBuildProfile(profile: BuildProfile): Promise<BuildProfile> {
  buildsError.value = "";
  try {
    const saved = await rendererApi.intelligence.builds.save({ profile });
    await refreshBuildProfiles();
    return saved;
  } catch (reason) {
    buildsError.value = message(reason, "The build profile could not be saved.");
    throw reason;
  }
}

async function removeBuildProfile(profileId: string): Promise<void> {
  buildsError.value = "";
  try {
    await rendererApi.intelligence.builds.remove(profileId);
    await refreshBuildProfiles();
  } catch (reason) {
    buildsError.value = message(reason, "The build profile could not be deleted.");
  }
}

async function activateBuildProfile(profileId?: string): Promise<void> {
  buildsError.value = "";
  try {
    buildProfiles.value =
      await rendererApi.intelligence.builds.activate(profileId);
  } catch (reason) {
    buildsError.value = message(reason, "The active build could not be changed.");
  }
}

async function importBuildTargets(
  request: ImportBuildTargetsRequest,
) {
  buildsError.value = "";
  try {
    const result =
      await rendererApi.intelligence.builds.importTargets(request);
    await refreshBuildProfiles();
    return result;
  } catch (reason) {
    buildsError.value = message(reason, "Targets could not be imported.");
    throw reason;
  }
}

export function useIntelligenceStore() {
  return {
    currentEvaluation,
    currentCatalogItem,
    currentItem: computed(
      () => currentEvaluation.value?.item ?? currentCatalogItem.value?.item ?? null,
    ),
    itemError,
    evaluating,
    externalEvaluationVersion,
    catalog,
    catalogState,
    catalogError,
    ruleSets,
    rulesState,
    rulesError,
    buildProfiles,
    buildsState,
    buildsError,
    initializeIntelligence,
    refreshCatalog,
    refreshRuleSets,
    refreshBuildProfiles,
    evaluateText,
    evaluateClipboard,
    selectCatalogItem,
    removeCatalogItem,
    saveRuleSet,
    removeRuleSet,
    saveBuildProfile,
    removeBuildProfile,
    activateBuildProfile,
    importBuildTargets,
  };
}

export function disposeIntelligenceStore(): void {
  for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
  initialized = false;
}
