<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  associateGearTarget,
  createBuildProfile,
  updateBuildProfile,
  validateBuildProfile,
  type BuildProfile,
  type GearTarget,
  type GearTargetStatOperator,
} from "@core/buildProfiles";
import { useIntelligenceStore } from "../composables/useIntelligenceStore";
import {
  catalogBuildCoverage,
  formatDate,
} from "../utils/intelligence";

const store = useIntelligenceStore();
const selectedProfileId = ref("");
const draft = ref<BuildProfile | null>(null);
const saving = ref(false);
const savedMessage = ref("");
const editorError = ref("");
const pendingDelete = ref(false);

const importText = ref("");
const importSlot = ref("unspecified");
const importProfileName = ref("Imported build");
const importing = ref(false);
const importResult = ref<Awaited<ReturnType<typeof store.importBuildTargets>> | null>(null);

const operators: GearTargetStatOperator[] = [
  "exists",
  "eq",
  "gte",
  "lte",
  "between",
  "contains",
];

function cloneProfile(profile: BuildProfile): BuildProfile {
  return JSON.parse(JSON.stringify(profile)) as BuildProfile;
}

function splitTags(value: string): string[] {
  return [...new Set(value.split(",").map((tag) => tag.trim()).filter(Boolean))];
}

function selectProfile(profile: BuildProfile): void {
  selectedProfileId.value = profile.id;
  draft.value = cloneProfile(profile);
  savedMessage.value = "";
  editorError.value = "";
  pendingDelete.value = false;
}

function newProfile(): void {
  const created = createBuildProfile({
    name: "New build profile",
    active: false,
    preferences: {
      exactMatchBoost: 20,
      nearMatchBoost: 8,
    },
  });
  selectedProfileId.value = "";
  draft.value = created;
  savedMessage.value = "";
  editorError.value = "";
  pendingDelete.value = false;
}

const persistedDraft = computed(() =>
  draft.value
    ? store.buildProfiles.value.some((profile) => profile.id === draft.value?.id)
    : false,
);
const validation = computed(() =>
  draft.value
    ? validateBuildProfile(draft.value)
    : { valid: false, issues: [] },
);
const coverage = computed(() =>
  draft.value
    ? catalogBuildCoverage(draft.value, store.catalog.value)
    : null,
);

function updateProfileTags(event: Event): void {
  if (!draft.value) return;
  draft.value.tags = splitTags((event.target as HTMLInputElement).value);
}

function updateTargetTags(target: GearTarget, event: Event): void {
  target.tags = splitTags((event.target as HTMLInputElement).value);
}

function addTarget(): void {
  if (!draft.value) return;
  try {
    const next = updateBuildProfile(draft.value, {
      gearTargets: [
        ...draft.value.gearTargets,
        {
          searchKey: `manual:${Date.now().toString(36)}`,
          name: "New gear target",
          slot: "unspecified",
          itemClass: "",
          tags: [],
          statRules: [],
          provenance: {
            kind: "manual",
            sourceKey: `manual:${Date.now().toString(36)}`,
          },
        },
      ],
    });
    draft.value = next;
  } catch (reason) {
    editorError.value =
      reason instanceof Error ? reason.message : "Could not add a target.";
  }
}

function removeTarget(targetId: string): void {
  if (!draft.value) return;
  draft.value = {
    ...draft.value,
    gearTargets: draft.value.gearTargets.filter(
      (target) => target.id !== targetId,
    ),
    updatedAt: new Date().toISOString(),
  };
}

function addStatRule(target: GearTarget): void {
  if (!draft.value) return;
  try {
    draft.value = associateGearTarget(draft.value, target.id, {
      statRules: [
        ...target.statRules,
        {
          stat: "maximum-life",
          operator: "gte",
          value: 80,
          required: true,
          weight: 1,
        },
      ],
    });
  } catch (reason) {
    editorError.value =
      reason instanceof Error ? reason.message : "Could not add a stat rule.";
  }
}

function removeStatRule(target: GearTarget, ruleId: string): void {
  target.statRules = target.statRules.filter((rule) => rule.id !== ruleId);
}

async function saveProfile(): Promise<void> {
  if (!draft.value) return;
  saving.value = true;
  savedMessage.value = "";
  editorError.value = "";
  try {
    const normalized = updateBuildProfile(draft.value, {
      name: draft.value.name,
      league: draft.value.league ?? "",
      sourceUrl: draft.value.sourceUrl ?? "",
      tags: draft.value.tags,
      preferences: draft.value.preferences,
      gearTargets: draft.value.gearTargets,
    });
    const saved = await store.saveBuildProfile(normalized);
    selectProfile(saved);
    savedMessage.value = `Saved ${formatDate(saved.updatedAt)}.`;
  } catch (reason) {
    editorError.value =
      reason instanceof Error ? reason.message : "Build profile could not be saved.";
  } finally {
    saving.value = false;
  }
}

async function activateProfile(): Promise<void> {
  if (!draft.value || !persistedDraft.value) return;
  await store.activateBuildProfile(draft.value.id);
  const refreshed = store.buildProfiles.value.find(
    (profile) => profile.id === draft.value?.id,
  );
  if (refreshed) selectProfile(refreshed);
}

async function deleteProfile(): Promise<void> {
  if (!draft.value || !persistedDraft.value) {
    newProfile();
    return;
  }
  if (!pendingDelete.value) {
    pendingDelete.value = true;
    return;
  }
  const profileId = draft.value.id;
  await store.removeBuildProfile(profileId);
  const next = store.buildProfiles.value[0];
  if (next) selectProfile(next);
  else newProfile();
}

async function importTargets(): Promise<void> {
  importing.value = true;
  editorError.value = "";
  importResult.value = null;
  try {
    importResult.value = await store.importBuildTargets(
      persistedDraft.value && draft.value
        ? {
            profileId: draft.value.id,
            sourceText: importText.value,
            defaultSlot: importSlot.value,
          }
        : {
            profile: {
              name: importProfileName.value.trim() || "Imported build",
              active: false,
            },
            sourceText: importText.value,
            defaultSlot: importSlot.value,
          },
    );
    if (importResult.value.profile) {
      selectProfile(importResult.value.profile);
    }
  } catch (reason) {
    editorError.value =
      reason instanceof Error ? reason.message : "Targets could not be imported.";
  } finally {
    importing.value = false;
  }
}

function candidateName(candidateId: string | undefined): string {
  if (!candidateId) return "No candidate";
  return (
    store.catalog.value.find((entry) => entry.id === candidateId)?.name ??
    candidateId
  );
}

watch(
  store.buildProfiles,
  (profiles) => {
    if (
      draft.value &&
      selectedProfileId.value &&
      !profiles.some((profile) => profile.id === selectedProfileId.value)
    ) {
      const first = profiles[0];
      if (first) selectProfile(first);
      else newProfile();
      return;
    }
    if (!draft.value) {
      const selected =
        profiles.find((profile) => profile.active) ?? profiles[0];
      if (selected) selectProfile(selected);
      else newProfile();
    }
  },
  { immediate: true },
);
</script>

<template>
  <div class="builds-workspace">
    <aside class="card collection-panel" aria-labelledby="profiles-title">
      <div class="section-heading">
        <div>
          <span class="eyebrow">Loadout library</span>
          <h2 id="profiles-title">Build profiles</h2>
        </div>
        <span class="count-badge">{{ store.buildProfiles.value.length }}</span>
      </div>
      <button type="button" class="button primary full-button" @click="newProfile">
        + Create profile
      </button>
      <p v-if="store.buildsError.value" class="inline-notice danger" role="alert">
        {{ store.buildsError.value }}
      </p>
      <div v-if="store.buildsState.value === 'loading'" class="state-panel compact-state">
        <span class="spinner" aria-hidden="true" />
        <p>Loading build profiles…</p>
      </div>
      <div v-else-if="!store.buildProfiles.value.length" class="state-panel compact-state">
        <span class="state-icon" aria-hidden="true">△</span>
        <strong>No saved profiles</strong>
        <p>Create a profile or import official trade links and local query JSON.</p>
      </div>
      <ul v-else class="collection-list profile-list">
        <li v-for="profile in store.buildProfiles.value" :key="profile.id">
          <button
            type="button"
            :class="{ selected: selectedProfileId === profile.id }"
            @click="selectProfile(profile)"
          >
            <span>
              <strong>{{ profile.name }}</strong>
              <small>{{ profile.gearTargets.length }} targets · {{ profile.league || "Any league" }}</small>
            </span>
            <span v-if="profile.active" class="tag success">active</span>
          </button>
        </li>
      </ul>
    </aside>

    <section v-if="draft" class="card build-editor" aria-labelledby="build-editor-title">
      <div class="section-heading">
        <div>
          <span class="eyebrow">Profile editor</span>
          <h2 id="build-editor-title">{{ draft.name }}</h2>
        </div>
        <span v-if="draft.active" class="status-chip safe">Active build</span>
      </div>

      <div class="form-grid three-up">
        <label>
          Profile name
          <input v-model="draft.name" autocomplete="off" />
        </label>
        <label>
          League
          <input v-model="draft.league" placeholder="Any league" />
        </label>
        <label>
          Tags
          <input :value="draft.tags.join(', ')" placeholder="mapping, lightning" @input="updateProfileTags" />
        </label>
      </div>
      <label class="field-stack">
        Source URL <span class="optional">(reference only; never fetched)</span>
        <input v-model="draft.sourceUrl" type="url" placeholder="https://…" />
      </label>
      <div class="form-grid preference-grid">
        <label>
          Exact-match desirability boost
          <input v-model.number="draft.preferences.exactMatchBoost" type="number" min="0" max="100" />
        </label>
        <label>
          Near-match desirability boost
          <input v-model.number="draft.preferences.nearMatchBoost" type="number" min="0" max="100" />
        </label>
        <label>
          Preferred slots
          <input
            :value="draft.preferences.preferredSlots.join(', ')"
            @input="draft!.preferences.preferredSlots = splitTags(($event.target as HTMLInputElement).value)"
          />
        </label>
        <label>
          Preferred item classes
          <input
            :value="draft.preferences.preferredItemClasses.join(', ')"
            @input="draft!.preferences.preferredItemClasses = splitTags(($event.target as HTMLInputElement).value)"
          />
        </label>
      </div>

      <div class="section-heading target-heading">
        <div>
          <span class="eyebrow">Upgrade intent</span>
          <h3>Gear targets</h3>
        </div>
        <button type="button" class="button compact secondary" @click="addTarget">
          + Add target
        </button>
      </div>

      <div v-if="!draft.gearTargets.length" class="state-panel compact-state">
        <span class="state-icon" aria-hidden="true">＋</span>
        <strong>No target slots yet</strong>
        <p>Add one manually or import local trade-query data below.</p>
      </div>
      <div v-else class="target-list">
        <details
          v-for="(target, targetIndex) in draft.gearTargets"
          :key="target.id"
          class="target-card"
          :open="targetIndex === 0"
        >
          <summary>
            <span>
              <strong>{{ target.name }}</strong>
              <small>{{ target.slot }} · {{ target.itemClass || "Any class" }} · {{ target.statRules.length }} stat rules</small>
            </span>
            <span v-if="target.provenance" class="tag">{{ target.provenance.kind }}</span>
          </summary>
          <div class="target-body">
            <div class="form-grid three-up">
              <label>
                Target name
                <input v-model="target.name" />
              </label>
              <label>
                Equipment slot
                <input v-model="target.slot" placeholder="ring-1" />
              </label>
              <label>
                Item class
                <input v-model="target.itemClass" placeholder="Rings" />
              </label>
            </div>
            <label class="field-stack">
              Tags
              <input :value="target.tags.join(', ')" @input="updateTargetTags(target, $event)" />
            </label>

            <div class="subheading-row">
              <h4>Stat rules</h4>
              <button type="button" class="button compact ghost" @click="addStatRule(target)">
                + Stat rule
              </button>
            </div>
            <p v-if="!target.statRules.length" class="empty-copy">
              Class match alone covers this target.
            </p>
            <div v-else class="stat-rule-list">
              <div v-for="rule in target.statRules" :key="rule.id" class="stat-rule-row">
                <label>
                  Stat
                  <input v-model="rule.stat" placeholder="fire-resistance" />
                </label>
                <label>
                  Operator
                  <select v-model="rule.operator">
                    <option v-for="operator in operators" :key="operator" :value="operator">{{ operator }}</option>
                  </select>
                </label>
                <label v-if="rule.operator !== 'exists' && rule.operator !== 'between'">
                  Value
                  <input
                    v-if="rule.operator === 'contains'"
                    v-model="rule.value"
                    placeholder="expected text"
                  />
                  <input v-else v-model.number="rule.value" type="number" />
                </label>
                <template v-if="rule.operator === 'between'">
                  <label>Min <input v-model.number="rule.min" type="number" /></label>
                  <label>Max <input v-model.number="rule.max" type="number" /></label>
                </template>
                <label>
                  Weight
                  <input v-model.number="rule.weight" type="number" min="0" max="100" />
                </label>
                <label class="inline-toggle">
                  <input v-model="rule.required" type="checkbox" />
                  Required
                </label>
                <button
                  type="button"
                  class="icon-button"
                  aria-label="Remove stat rule"
                  @click="removeStatRule(target, rule.id)"
                >
                  ×
                </button>
              </div>
            </div>

            <div class="target-footer">
              <span class="muted">{{ target.searchKey }}</span>
              <button
                type="button"
                class="button compact ghost danger-text"
                @click="removeTarget(target.id)"
              >
                Remove target
              </button>
            </div>
          </div>
        </details>
      </div>

      <div v-if="!validation.valid" class="validation-summary invalid" role="alert">
        <span aria-hidden="true">!</span>
        <div>
          <strong>Profile needs attention</strong>
          <ul>
            <li v-for="issue in validation.issues" :key="`${issue.path}-${issue.code}`">
              {{ issue.path }} — {{ issue.message }}
            </li>
          </ul>
        </div>
      </div>
      <p v-if="editorError" class="inline-notice danger" role="alert">{{ editorError }}</p>

      <footer class="sticky-actions">
        <span v-if="savedMessage" class="success-text" role="status">{{ savedMessage }}</span>
        <span v-else class="muted">Profiles influence desirability only; they cannot arm automation.</span>
        <div class="button-row">
          <button
            type="button"
            class="button ghost danger"
            :disabled="!persistedDraft"
            @click="deleteProfile"
          >
            {{ pendingDelete ? "Confirm delete" : "Remove profile" }}
          </button>
          <button
            type="button"
            class="button secondary"
            :disabled="!persistedDraft || draft.active"
            @click="activateProfile"
          >
            {{ draft.active ? "Active" : "Make active" }}
          </button>
          <button
            type="button"
            class="button primary"
            :disabled="saving || !validation.valid"
            @click="saveProfile"
          >
            {{ saving ? "Saving…" : "Save profile" }}
          </button>
        </div>
      </footer>
    </section>

    <aside class="build-side">
      <section class="card coverage-card" aria-labelledby="coverage-title">
        <div class="section-heading">
          <div>
            <span class="eyebrow">Catalog fit</span>
            <h2 id="coverage-title">Target coverage</h2>
          </div>
          <span v-if="coverage" class="score-orb small">
            {{ Math.round(coverage.ratio * 100) }}%
          </span>
        </div>
        <template v-if="coverage">
          <div class="coverage-summary">
            <span class="covered"><strong>{{ coverage.covered }}</strong> exact</span>
            <span class="near-match"><strong>{{ coverage.nearMatches }}</strong> near</span>
            <span class="missing"><strong>{{ coverage.missing }}</strong> missing</span>
          </div>
          <p v-if="!coverage.total" class="empty-copy">Add targets to calculate coverage.</p>
          <ul v-else class="coverage-list">
            <li v-for="target in coverage.targets" :key="target.targetId" :class="target.status">
              <span class="coverage-state" aria-hidden="true">
                {{ target.status === "covered" ? "✓" : target.status === "near-match" ? "~" : "×" }}
              </span>
              <span>
                <strong>{{ target.targetName }}</strong>
                <small>{{ candidateName(target.candidateId) }} · {{ Math.round(target.score * 100) }}%</small>
                <span v-for="reason in target.reasons.slice(0, 2)" :key="reason">{{ reason }}</span>
              </span>
            </li>
          </ul>
        </template>
      </section>

      <section class="card import-card" aria-labelledby="build-import-title">
        <div class="section-heading">
          <div>
            <span class="eyebrow">Local import</span>
            <h2 id="build-import-title">Trade targets</h2>
          </div>
        </div>
        <p class="muted">
          Paste official trade links or exported query JSON. Opaque links are retained as provenance; no network request is made.
        </p>
        <label v-if="!persistedDraft" class="field-stack">
          New profile name
          <input v-model="importProfileName" />
        </label>
        <label class="field-stack">
          Default slot
          <input v-model="importSlot" placeholder="unspecified" />
        </label>
        <label class="field-stack">
          Links or query JSON
          <textarea
            v-model="importText"
            rows="8"
            spellcheck="false"
            placeholder="https://www.pathofexile.com/trade2/search/poe2/…&#10;or { &quot;query&quot;: { … } }"
          />
        </label>
        <button
          type="button"
          class="button secondary full-button"
          :disabled="importing || !importText.trim()"
          @click="importTargets"
        >
          {{ importing ? "Importing…" : persistedDraft ? "Import into selected profile" : "Import as new profile" }}
        </button>
        <div v-if="importResult" class="import-result" role="status">
          <strong>
            {{ importResult.addedTargetIds.length }} added ·
            {{ importResult.updatedTargetIds.length }} updated
          </strong>
          <ul v-if="importResult.tradeImport.errors.length || importResult.warnings.length">
            <li v-for="error in importResult.tradeImport.errors" :key="`${error.code}-${error.sourceIndex ?? ''}`">
              {{ error.message }}
            </li>
            <li v-for="warning in importResult.warnings" :key="warning">{{ warning }}</li>
          </ul>
        </div>
      </section>
    </aside>
  </div>
</template>
