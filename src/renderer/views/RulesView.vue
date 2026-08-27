<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import {
  SCAN_RULE_SCHEMA_VERSION,
  validateRuleRegex,
  type RuleValidationResult,
  type ScanHistoryItem,
} from "@core/scanRules";
import type {
  LegacyImportKind,
  LegacyImportResult,
  RuleSetView,
} from "../../shared/ipc.js";
import { useIntelligenceStore } from "../composables/useIntelligenceStore";
import { rendererApi } from "../services/rendererApi";
import { formatDate } from "../utils/intelligence";

interface RuleDraft {
  id?: string;
  name: string;
  regex: string;
  tagsText: string;
}

interface RuleSetDraft {
  id?: string;
  name: string;
  active: boolean;
  rules: RuleDraft[];
}

const store = useIntelligenceStore();
const selectedSetId = ref("");
const selectedRuleIndex = ref(0);
const draft = ref<RuleSetDraft>(newDraft());
const validations = ref<RuleValidationResult[]>([]);
const saving = ref(false);
const savedMessage = ref("");
const pendingDelete = ref(false);
const legacyKind = ref<Extract<LegacyImportKind, "scan-history" | "regex-history">>("scan-history");
const legacySourceKey = ref("manual-legacy-import");
const legacyInput = ref("");
const legacyResult = ref<LegacyImportResult | null>(null);
const importError = ref("");
let validationTimer: number | undefined;

function newRule(): RuleDraft {
  return {
    name: "New matcher",
    regex: '"maximum life" "fire resistance"',
    tagsText: "",
  };
}

function newDraft(): RuleSetDraft {
  return {
    name: "New rule set",
    active: true,
    rules: [newRule()],
  };
}

function fromView(view: RuleSetView): RuleSetDraft {
  return {
    id: view.id,
    name: view.name,
    active: view.active,
    rules: view.rules.map((rule) => ({
      ...(rule.id ? { id: rule.id } : {}),
      name: rule.name ?? "Unnamed rule",
      regex: rule.regex,
      tagsText: rule.tags?.join(", ") ?? "",
    })),
  };
}

const selectedSet = computed(() =>
  store.ruleSets.value.find((entry) => entry.id === selectedSetId.value),
);
const activeRule = computed(() => draft.value.rules[selectedRuleIndex.value]);
const activeValidation = computed(
  () =>
    validations.value[selectedRuleIndex.value] ??
    validateRuleRegex(activeRule.value?.regex ?? ""),
);

function selectSet(view: RuleSetView): void {
  selectedSetId.value = view.id;
  selectedRuleIndex.value = 0;
  draft.value = fromView(view);
  savedMessage.value = "";
  pendingDelete.value = false;
  scheduleValidation();
}

function createSet(): void {
  selectedSetId.value = "";
  selectedRuleIndex.value = 0;
  draft.value = newDraft();
  savedMessage.value = "";
  pendingDelete.value = false;
  scheduleValidation();
}

function addRule(): void {
  draft.value.rules.push(newRule());
  selectedRuleIndex.value = draft.value.rules.length - 1;
  scheduleValidation();
}

function removeRule(index: number): void {
  if (draft.value.rules.length === 1) {
    draft.value.rules = [newRule()];
  } else {
    draft.value.rules.splice(index, 1);
  }
  selectedRuleIndex.value = Math.min(
    selectedRuleIndex.value,
    draft.value.rules.length - 1,
  );
  scheduleValidation();
}

function insertAnd(): void {
  const rule = activeRule.value;
  if (!rule) return;
  rule.regex = `${rule.regex.trim()} "new term"`.trim();
  scheduleValidation();
}

function insertOr(): void {
  const rule = activeRule.value;
  if (!rule) return;
  rule.regex = `${rule.regex.trim()}|"new term"`.replace(/^\|/, "");
  scheduleValidation();
}

function scheduleValidation(): void {
  if (validationTimer !== undefined) window.clearTimeout(validationTimer);
  validations.value = draft.value.rules.map((rule) =>
    validateRuleRegex(rule.regex),
  );
  validationTimer = window.setTimeout(() => {
    void validateThroughBridge();
  }, 220);
}

async function validateThroughBridge(): Promise<void> {
  validations.value = await Promise.all(
    draft.value.rules.map((rule) =>
      rendererApi.intelligence.rules.validate(rule.regex),
    ),
  );
}

function toRule(rule: RuleDraft): ScanHistoryItem {
  return {
    ...(rule.id ? { id: rule.id } : {}),
    name: rule.name.trim() || "Unnamed rule",
    regex: rule.regex,
    tags: rule.tagsText
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean),
    schemaVersion: SCAN_RULE_SCHEMA_VERSION,
  };
}

async function saveSet(): Promise<void> {
  saving.value = true;
  savedMessage.value = "";
  await validateThroughBridge();
  if (validations.value.some((validation) => !validation.valid)) {
    saving.value = false;
    return;
  }
  try {
    const saved = await store.saveRuleSet({
      ...(draft.value.id ? { id: draft.value.id } : {}),
      name: draft.value.name,
      active: draft.value.active,
      rules: draft.value.rules.map(toRule),
    });
    selectedSetId.value = saved.id;
    draft.value = fromView(saved);
    savedMessage.value = `Saved ${formatDate(saved.updatedAt)}.`;
  } catch {
    // The shared store exposes the bridge error next to the form.
  } finally {
    saving.value = false;
  }
}

async function deleteSet(): Promise<void> {
  if (!draft.value.id) {
    createSet();
    return;
  }
  if (!pendingDelete.value) {
    pendingDelete.value = true;
    return;
  }
  await store.removeRuleSet(draft.value.id);
  const next = store.ruleSets.value[0];
  if (next) selectSet(next);
  else createSet();
}

async function importLegacy(): Promise<void> {
  importError.value = "";
  legacyResult.value = null;
  try {
    legacyResult.value = await rendererApi.intelligence.imports.legacy({
      kind: legacyKind.value,
      input: legacyInput.value,
      sourceKey: legacySourceKey.value.trim() || "manual-legacy-import",
    });
    await store.refreshRuleSets();
  } catch (reason) {
    importError.value =
      reason instanceof Error ? reason.message : "Legacy import failed.";
  }
}

watch(
  store.ruleSets,
  (sets) => {
    if (draft.value.id && !sets.some((entry) => entry.id === draft.value.id)) {
      const first = sets[0];
      if (first) selectSet(first);
      return;
    }
    if (!draft.value.id && selectedSetId.value === "" && sets.length > 0) {
      selectSet(sets.find((entry) => entry.active) ?? sets[0]!);
    }
  },
  { immediate: true },
);

watch(
  draft,
  () => {
    savedMessage.value = "";
    scheduleValidation();
  },
  { deep: true },
);

onUnmounted(() => {
  if (validationTimer !== undefined) window.clearTimeout(validationTimer);
});
</script>

<template>
  <div class="rules-workspace">
    <aside class="card collection-panel" aria-labelledby="saved-rules-title">
      <div class="section-heading">
        <div>
          <span class="eyebrow">Library</span>
          <h2 id="saved-rules-title">Saved rule sets</h2>
        </div>
        <span class="count-badge">{{ store.ruleSets.value.length }}</span>
      </div>
      <button type="button" class="button primary full-button" @click="createSet">
        + New rule set
      </button>
      <p v-if="store.rulesError.value" class="inline-notice danger" role="alert">
        {{ store.rulesError.value }}
      </p>
      <div v-if="store.rulesState.value === 'loading'" class="state-panel compact-state">
        <span class="spinner" aria-hidden="true" />
        <p>Loading rules…</p>
      </div>
      <div v-else-if="!store.ruleSets.value.length" class="state-panel compact-state">
        <span class="state-icon" aria-hidden="true">⌘</span>
        <strong>No saved logic</strong>
        <p>Create a set or import legacy regex history.</p>
      </div>
      <ul v-else class="collection-list">
        <li v-for="set in store.ruleSets.value" :key="set.id">
          <button
            type="button"
            :class="{ selected: selectedSet?.id === set.id }"
            @click="selectSet(set)"
          >
            <span>
              <strong>{{ set.name }}</strong>
              <small>{{ set.rules.length }} rule{{ set.rules.length === 1 ? "" : "s" }} · {{ formatDate(set.updatedAt) }}</small>
            </span>
            <span v-if="set.active" class="tag success">active</span>
          </button>
        </li>
      </ul>
    </aside>

    <section class="card rule-editor" aria-labelledby="rule-editor-title">
      <div class="section-heading">
        <div>
          <span class="eyebrow">OR-of-AND DSL</span>
          <h2 id="rule-editor-title">{{ draft.id ? "Edit rule set" : "Create rule set" }}</h2>
        </div>
        <label class="inline-toggle">
          <input v-model="draft.active" type="checkbox" />
          Active
        </label>
      </div>

      <label class="field-stack">
        Rule-set name
        <input v-model="draft.name" autocomplete="off" />
      </label>

      <div class="rule-tabs" role="tablist" aria-label="Rules in this set">
        <button
          v-for="(rule, index) in draft.rules"
          :key="rule.id ?? index"
          type="button"
          role="tab"
          :aria-selected="selectedRuleIndex === index"
          :class="{ selected: selectedRuleIndex === index }"
          @click="selectedRuleIndex = index"
        >
          {{ rule.name || `Rule ${index + 1}` }}
          <span :class="validations[index]?.valid ? 'valid-dot' : 'invalid-dot'" aria-hidden="true" />
        </button>
        <button type="button" class="add-tab" @click="addRule">+ Add</button>
      </div>

      <template v-if="activeRule">
        <div class="form-grid">
          <label>
            Rule name
            <input v-model="activeRule.name" autocomplete="off" />
          </label>
          <label>
            Tags
            <input v-model="activeRule.tagsText" placeholder="life, resistance" />
          </label>
        </div>

        <label class="field-stack">
          Match expression
          <textarea
            v-model="activeRule.regex"
            rows="7"
            spellcheck="false"
            aria-describedby="dsl-help"
          />
        </label>
        <div class="button-row editor-actions">
          <button type="button" class="button compact secondary" @click="insertAnd">
            + AND term
          </button>
          <button type="button" class="button compact secondary" @click="insertOr">
            + OR branch
          </button>
          <button
            type="button"
            class="button compact ghost danger-text"
            @click="removeRule(selectedRuleIndex)"
          >
            Remove rule
          </button>
        </div>
        <p id="dsl-help" class="muted">
          Quoted terms on one branch are AND requirements. A pipe or an <code>OR</code> line starts an alternative branch.
          Numeric ranges use <code>"maximum life [80..120]"</code>. Special totals such as
          <code>TOTAL_ELE_RES&gt;=90</code> are supported.
        </p>

        <div
          class="validation-summary"
          :class="activeValidation.valid ? 'valid' : 'invalid'"
          aria-live="polite"
        >
          <span aria-hidden="true">{{ activeValidation.valid ? "✓" : "!" }}</span>
          <div>
            <strong>{{ activeValidation.valid ? "Valid and safe" : "Needs attention" }}</strong>
            <p v-if="activeValidation.valid">
              {{ activeValidation.ast.segments.length }} OR branch{{ activeValidation.ast.segments.length === 1 ? "" : "es" }};
              every branch requires all of its terms.
            </p>
            <ul v-else>
              <li v-for="issue in activeValidation.issues" :key="`${issue.code}-${issue.term ?? ''}`">
                {{ issue.message }}<span v-if="issue.term"> · {{ issue.term }}</span>
              </li>
            </ul>
          </div>
        </div>

        <section class="ast-preview" aria-labelledby="ast-title">
          <div class="section-heading">
            <h3 id="ast-title">AST preview</h3>
            <code>{{ activeValidation.normalized || "empty" }}</code>
          </div>
          <ol v-if="activeValidation.ast.segments.length">
            <li
              v-for="(branch, branchIndex) in activeValidation.ast.segments"
              :key="branchIndex"
            >
              <span class="ast-operator">OR {{ branchIndex + 1 }}</span>
              <ul>
                <li v-for="term in branch.terms" :key="term.value">
                  <span class="ast-operator and">AND</span>
                  <code>{{ term.value }}</code>
                </li>
              </ul>
            </li>
          </ol>
          <p v-else class="empty-copy">The AST will appear as you type.</p>
        </section>
      </template>

      <footer class="sticky-actions">
        <span v-if="savedMessage" class="success-text" role="status">{{ savedMessage }}</span>
        <span v-else-if="store.rulesError.value" class="danger-text" role="alert">{{ store.rulesError.value }}</span>
        <span v-else class="muted">Unsafe or invalid expressions cannot be saved.</span>
        <div class="button-row">
          <button
            type="button"
            class="button danger ghost"
            :disabled="!draft.id"
            @click="deleteSet"
          >
            {{ pendingDelete ? "Confirm delete" : "Delete set" }}
          </button>
          <button
            type="button"
            class="button primary"
            :disabled="saving || validations.some((validation) => !validation.valid)"
            @click="saveSet"
          >
            {{ saving ? "Saving…" : "Save rule set" }}
          </button>
        </div>
      </footer>
    </section>

    <aside class="card semantics-panel" aria-labelledby="semantics-title">
      <div class="section-heading">
        <div>
          <span class="eyebrow">Reference</span>
          <h2 id="semantics-title">Matcher semantics</h2>
        </div>
      </div>
      <ol class="semantics-list">
        <li><span>1</span><p><strong>OR chooses a branch.</strong> One complete branch is enough to match.</p></li>
        <li><span>2</span><p><strong>AND requires every term.</strong> A missing term makes that branch a near miss or miss.</p></li>
        <li><span>3</span><p><strong>Text is case-insensitive.</strong> Safe regex is supported; hazardous patterns are rejected.</p></li>
        <li><span>4</span><p><strong>Ranges inspect rolls.</strong> Independent and average semantics are explicit in validation.</p></li>
      </ol>

      <details class="import-panel">
        <summary>Import legacy rules</summary>
        <p class="muted">
          Paste old scan-history or regex-history JSON. Import is local and routed through the typed intelligence bridge.
        </p>
        <label class="field-stack">
          Import format
          <select v-model="legacyKind">
            <option value="scan-history">Scan history JSON</option>
            <option value="regex-history">Regex history JSON</option>
          </select>
        </label>
        <label class="field-stack">
          Source key
          <input v-model="legacySourceKey" />
        </label>
        <label class="field-stack">
          Legacy JSON
          <textarea v-model="legacyInput" rows="7" spellcheck="false" />
        </label>
        <button
          type="button"
          class="button secondary full-button"
          :disabled="!legacyInput.trim()"
          @click="importLegacy"
        >
          Import safely
        </button>
        <p v-if="importError" class="inline-notice danger" role="alert">{{ importError }}</p>
        <div v-if="legacyResult" class="import-result" role="status">
          <strong>{{ legacyResult.persistedEntities }} entities persisted</strong>
          <p>{{ legacyResult.parsedRecords }} records parsed.</p>
          <ul v-if="legacyResult.warnings.length">
            <li v-for="warning in legacyResult.warnings" :key="`${warning.code}-${warning.recordIndex ?? ''}`">
              {{ warning.message }}
            </li>
          </ul>
        </div>
      </details>
    </aside>
  </div>
</template>
