<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import type {
  SearchRegexResult,
  SearchRegexSelection,
} from "@core/searchRegex";
import type { ScanHistoryItem } from "@core/scanRules";
import { useIntelligenceStore } from "../composables/useIntelligenceStore";
import { rendererApi } from "../services/rendererApi";
import { explainRuleMatch } from "../utils/intelligence";

interface ModifierChoice {
  id: string;
  selected: boolean;
  mode: "text" | "numeric";
  min?: number;
  max?: number;
}

const store = useIntelligenceStore();
const includeName = ref(false);
const includeBase = ref(true);
const includeClass = ref(false);
const modifierChoices = ref<ModifierChoice[]>([]);
const customTerms = ref("");
const maxLength = ref(50);
const allowBroadMatches = ref(false);
const generating = ref(false);
const result = ref<SearchRegexResult | null>(null);
const generationError = ref("");
const copiedQuery = ref("");

const selectedRuleSetId = ref("");
const selectedRuleIndex = ref(0);
const editRuleName = ref("");
const editRuleRegex = ref("");
const ruleSaved = ref("");

const selectedRuleSet = computed(() =>
  store.ruleSets.value.find((entry) => entry.id === selectedRuleSetId.value),
);
const selectedRule = computed(
  () => selectedRuleSet.value?.rules[selectedRuleIndex.value],
);
const currentItem = store.currentItem;
const ruleExplanation = computed(() => {
  if (!selectedRule.value || !currentItem.value) return null;
  return explainRuleMatch(selectedRule.value, currentItem.value);
});

watch(
  currentItem,
  (item) => {
    modifierChoices.value = (item?.mods ?? []).map((mod, index) => {
      const first = mod.rolls?.[0]?.value ?? mod.values?.[0] ?? mod.value;
      return {
        id: `mod-${index}`,
        selected: index < 3,
        mode: first === undefined ? "text" : "numeric",
        ...(first === undefined ? {} : { min: first, max: first }),
      };
    });
    result.value = null;
  },
  { immediate: true },
);

watch(
  store.ruleSets,
  (sets) => {
    if (!sets.some((entry) => entry.id === selectedRuleSetId.value)) {
      selectedRuleSetId.value =
        sets.find((entry) => entry.active)?.id ?? sets[0]?.id ?? "";
    }
  },
  { immediate: true },
);

watch(
  [selectedRuleSetId, selectedRuleIndex],
  () => {
    const rule = selectedRule.value;
    editRuleName.value = rule?.name ?? "";
    editRuleRegex.value = rule?.regex ?? "";
    ruleSaved.value = "";
  },
  { immediate: true },
);

function selectedInputs(): SearchRegexSelection[] {
  const item = currentItem.value;
  if (!item) return [];
  const selections: SearchRegexSelection[] = [];
  if (includeName.value) {
    selections.push({
      id: "item-name",
      label: "Item name",
      field: "name",
      text: item.name,
    });
  }
  if (includeBase.value) {
    selections.push({
      id: "item-base",
      label: "Base type",
      field: "base",
      text: item.baseType,
    });
  }
  if (includeClass.value) {
    selections.push({
      id: "item-class",
      label: "Item class",
      field: "class",
      text: item.itemClass,
    });
  }
  modifierChoices.value.forEach((choice, index) => {
    const mod = item.mods[index];
    if (!choice.selected || !mod) return;
    selections.push({
      id: choice.id,
      label: `Affix ${index + 1}`,
      field: "mod",
      representativeLine: mod.text,
      match: choice.mode,
      numeric:
        choice.mode === "numeric"
          ? {
              index: 0,
              ...(choice.min !== undefined ? { min: choice.min } : {}),
              ...(choice.max !== undefined ? { max: choice.max } : {}),
            }
          : false,
    });
  });
  customTerms.value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line, index) => {
      selections.push({
        id: `custom-${index}`,
        label: `Custom ${index + 1}`,
        field: "text",
        text: line,
      });
    });
  return selections;
}

async function generateQueries(): Promise<void> {
  generating.value = true;
  generationError.value = "";
  copiedQuery.value = "";
  try {
    result.value = await rendererApi.intelligence.rules.generateSearch({
      selections: selectedInputs(),
      options: {
        maxLength: Math.max(8, Math.floor(maxLength.value)),
        quoteForStash: true,
        caseInsensitive: true,
        allowBroadMatches: allowBroadMatches.value,
        label: currentItem.value
          ? `${currentItem.value.baseType} search`
          : "Stash search",
      },
    });
  } catch (reason) {
    generationError.value =
      reason instanceof Error ? reason.message : "Query generation failed.";
  } finally {
    generating.value = false;
  }
}

async function copyQuery(value: string, id: string): Promise<void> {
  try {
    if (!navigator.clipboard?.writeText) {
      throw new Error("Clipboard writing is unavailable.");
    }
    await navigator.clipboard.writeText(value);
    copiedQuery.value = id;
  } catch (reason) {
    generationError.value =
      reason instanceof Error ? reason.message : "Could not copy this query.";
  }
}

async function saveQuickRule(): Promise<void> {
  const set = selectedRuleSet.value;
  const current = selectedRule.value;
  if (!set || !current) return;
  const rules = set.rules.map((rule, index): ScanHistoryItem =>
    index === selectedRuleIndex.value
      ? {
          ...rule,
          name: editRuleName.value.trim() || "Unnamed rule",
          regex: editRuleRegex.value,
        }
      : { ...rule },
  );
  try {
    await store.saveRuleSet({
      id: set.id,
      name: set.name,
      active: set.active,
      rules,
    });
    ruleSaved.value = "Rule saved.";
  } catch {
    ruleSaved.value = "";
  }
}
</script>

<template>
  <div class="finder-workspace">
    <section class="card finder-builder" aria-labelledby="finder-builder-title">
      <div class="section-heading">
        <div>
          <span class="eyebrow">Selection</span>
          <h2 id="finder-builder-title">Build stash queries</h2>
        </div>
        <span class="count-badge">{{ selectedInputs().length }}</span>
      </div>

      <div v-if="!currentItem" class="state-panel compact-state">
        <span class="state-icon" aria-hidden="true">◇</span>
        <strong>No current item</strong>
        <p>Evaluate or select an item before choosing its searchable fields.</p>
        <RouterLink class="button secondary" to="/items">Open Items</RouterLink>
      </div>

      <template v-else>
        <div class="current-item-strip">
          <span class="rarity-line" :class="`rarity-${currentItem.rarity.toLowerCase()}`" />
          <span>
            <strong>{{ currentItem.name }}</strong>
            <small>{{ currentItem.baseType }} · {{ currentItem.itemClass }}</small>
          </span>
        </div>

        <fieldset class="choice-group">
          <legend>Identity fields</legend>
          <label class="check-row">
            <input v-model="includeName" type="checkbox" />
            <span><strong>Name</strong><small>{{ currentItem.name }}</small></span>
          </label>
          <label class="check-row">
            <input v-model="includeBase" type="checkbox" />
            <span><strong>Base type</strong><small>{{ currentItem.baseType }}</small></span>
          </label>
          <label class="check-row">
            <input v-model="includeClass" type="checkbox" />
            <span><strong>Item class</strong><small>{{ currentItem.itemClass }}</small></span>
          </label>
        </fieldset>

        <fieldset class="choice-group">
          <legend>Modifier alternatives</legend>
          <p v-if="!modifierChoices.length" class="empty-copy">
            This item has no parsed modifiers.
          </p>
          <div
            v-for="(choice, index) in modifierChoices"
            :key="choice.id"
            class="modifier-choice"
          >
            <label class="check-row">
              <input v-model="choice.selected" type="checkbox" />
              <span><strong>Affix {{ index + 1 }}</strong><small>{{ currentItem.mods[index]?.text }}</small></span>
            </label>
            <div v-if="choice.selected" class="modifier-options">
              <label>
                Match
                <select v-model="choice.mode">
                  <option value="text">Exact text</option>
                  <option
                    value="numeric"
                    :disabled="!currentItem.mods[index]?.rolls?.length"
                  >
                    Numeric range
                  </option>
                </select>
              </label>
              <template v-if="choice.mode === 'numeric'">
                <label>
                  Minimum
                  <input v-model.number="choice.min" type="number" step="1" />
                </label>
                <label>
                  Maximum
                  <input v-model.number="choice.max" type="number" step="1" />
                </label>
              </template>
            </div>
          </div>
        </fieldset>
      </template>

      <label class="field-stack">
        Custom text alternatives <span class="optional">(one per line)</span>
        <textarea
          v-model="customTerms"
          rows="3"
          spellcheck="false"
          placeholder="Item Class: Rings"
        />
      </label>
      <div class="form-grid compact-grid">
        <label>
          Maximum stash query length
          <input v-model.number="maxLength" type="number" min="8" max="512" />
        </label>
        <label class="toggle-field">
          <input v-model="allowBroadMatches" type="checkbox" />
          <span>Allow broader fragment fallback</span>
        </label>
      </div>
      <p class="muted">
        Over-limit alternatives are split into multiple labeled queries. Expressions are never silently truncated.
      </p>
      <button
        type="button"
        class="button primary full-button"
        :disabled="generating"
        @click="generateQueries"
      >
        {{ generating ? "Generating…" : "Generate validated queries" }}
      </button>
    </section>

    <div class="finder-results">
      <section class="card" aria-labelledby="query-results-title">
        <div class="section-heading">
          <div>
            <span class="eyebrow">Output</span>
            <h2 id="query-results-title">Copy-ready queries</h2>
          </div>
          <span v-if="result" class="count-badge">{{ result.queries.length }}</span>
        </div>
        <p v-if="generationError" class="inline-notice danger" role="alert">
          {{ generationError }}
        </p>
        <div v-if="!result" class="state-panel compact-state">
          <span class="state-icon" aria-hidden="true">⌁</span>
          <strong>No query generated</strong>
          <p>Select fields or modifiers, then generate a safe stash expression.</p>
        </div>
        <template v-else>
          <ul v-if="result.conflicts.length" class="notice-list danger" role="alert">
            <li v-for="conflict in result.conflicts" :key="conflict">{{ conflict }}</li>
          </ul>
          <ul v-if="result.warnings.length" class="notice-list warning">
            <li v-for="warning in result.warnings" :key="warning">{{ warning }}</li>
          </ul>
          <div v-if="result.queries.length" class="query-list">
            <article v-for="query in result.queries" :key="query.label" class="query-card">
              <header>
                <span>
                  <strong>{{ query.label }}</strong>
                  <small>{{ query.length }} / {{ result.maxLength }} characters · /{{ query.flags }}</small>
                </span>
                <button
                  type="button"
                  class="button compact secondary"
                  @click="copyQuery(query.stashQuery, query.label)"
                >
                  {{ copiedQuery === query.label ? "Copied" : "Copy" }}
                </button>
              </header>
              <code>{{ query.stashQuery }}</code>
              <details>
                <summary>Representative lines</summary>
                <ul>
                  <li v-for="line in query.representativeLines" :key="line">{{ line }}</li>
                </ul>
              </details>
            </article>
          </div>
          <div v-else-if="!result.conflicts.length" class="state-panel compact-state">
            <strong>No expression could be produced</strong>
            <p>Add a searchable field or modifier.</p>
          </div>
        </template>
      </section>

      <section class="card rule-checker" aria-labelledby="rule-checker-title">
        <div class="section-heading">
          <div>
            <span class="eyebrow">Saved logic</span>
            <h2 id="rule-checker-title">Evaluate a saved rule</h2>
          </div>
          <RouterLink class="text-link" to="/rules">Full rule studio</RouterLink>
        </div>

        <div v-if="!store.ruleSets.value.length" class="state-panel compact-state">
          <span class="state-icon" aria-hidden="true">∅</span>
          <strong>No saved rule sets</strong>
          <p>Create an OR-of-AND matcher in the Rule studio.</p>
        </div>
        <template v-else>
          <div class="form-grid">
            <label>
              Rule set
              <select v-model="selectedRuleSetId">
                <option
                  v-for="set in store.ruleSets.value"
                  :key="set.id"
                  :value="set.id"
                >
                  {{ set.name }}{{ set.active ? " · active" : "" }}
                </option>
              </select>
            </label>
            <label>
              Rule
              <select v-model.number="selectedRuleIndex">
                <option
                  v-for="(rule, index) in selectedRuleSet?.rules ?? []"
                  :key="rule.id ?? `${rule.name}-${index}`"
                  :value="index"
                >
                  {{ rule.name || `Rule ${index + 1}` }}
                </option>
              </select>
            </label>
          </div>

          <label class="field-stack">
            Rule name
            <input v-model="editRuleName" />
          </label>
          <label class="field-stack">
            OR-of-AND expression
            <textarea v-model="editRuleRegex" rows="4" spellcheck="false" />
          </label>
          <div class="button-row">
            <button type="button" class="button secondary" @click="saveQuickRule">
              Save rule
            </button>
            <span v-if="ruleSaved" class="success-text" role="status">{{ ruleSaved }}</span>
            <span v-if="store.rulesError.value" class="danger-text" role="alert">
              {{ store.rulesError.value }}
            </span>
          </div>

          <div
            v-if="ruleExplanation"
            class="match-result"
            :class="ruleExplanation.status"
          >
            <span class="status-icon" aria-hidden="true">
              {{ ruleExplanation.status === "match" ? "✓" : ruleExplanation.status === "near-match" ? "~" : "×" }}
            </span>
            <div>
              <strong>{{ ruleExplanation.status.replace("-", " ") }}</strong>
              <p>{{ ruleExplanation.summary }}</p>
              <ul v-if="ruleExplanation.bestBranch">
                <li
                  v-for="term in ruleExplanation.bestBranch.terms"
                  :key="term.term"
                  :class="{ matched: term.matched }"
                >
                  {{ term.matched ? "Matched" : "Missed" }} “{{ term.term }}” — {{ term.reason }}
                </li>
              </ul>
            </div>
          </div>
          <p v-else class="muted">Select a current item and saved rule to see exact or near-miss reasons.</p>
        </template>
      </section>
    </div>
  </div>
</template>
