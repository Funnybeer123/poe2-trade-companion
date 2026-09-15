<script setup lang="ts">
/**
 * Tools → Campaign guide: the route (acts → areas → objectives), the area you
 * are in right now with an under/over-levelled estimate, a schematic map and
 * an in-app editor for everything the community route gets wrong.
 *
 * Reads Client.txt through the clientLog foundation and nothing else: no game
 * input, no network, so the Dry-run switch does not apply here.
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import {
  actProgress,
  defaultCampaignGuideSettings,
  REWARD_TAGS,
  type CampaignCustomisePatch,
  type MergedArea,
  type MergedObjective,
  type RewardTag,
} from "@core/campaignGuide";
import { layoutCampaignMap } from "@core/campaignGuideMap";
import ViewTabs from "../../components/ViewTabs.vue";
import { getAppFeatureApi } from "../../services/featureApi";
import CampaignAreaCard from "./CampaignAreaCard.vue";
import CampaignAreaEditor, { type CampaignEditorTarget } from "./CampaignAreaEditor.vue";
import CampaignGuideSettingsSection from "./CampaignGuideSettingsSection.vue";
import CampaignWorldMap from "./CampaignWorldMap.vue";
import CampaignXpHelper from "./CampaignXpHelper.vue";
import { disposeCampaignGuide, useCampaignGuide } from "./useCampaignGuide";

const store = useCampaignGuide();
const appApi = getAppFeatureApi();

const tab = ref<string>("route");
const editorTarget = ref<CampaignEditorTarget | null>(null);
const importText = ref("");
const pendingReset = ref("");
let stopSubscription: (() => void) | undefined;
let disposed = false;

const TABS = [
  { id: "route", label: "Route", hint: "Acts and objectives" },
  { id: "map", label: "Map", hint: "Schematic world map" },
  { id: "edit", label: "Edit", hint: "Add, import, export" },
];

const settings = store.settings;
/** Fallbacks keep the template free of non-null assertions (vue-tsc-friendly). */
const activeSettings = computed(() => store.route.value?.settings ?? defaultCampaignGuideSettings());
const acts = computed(() => store.route.value?.merged.acts ?? []);
const bundled = computed(() => store.route.value?.bundled);
/** A hand-edited route.json can parse smaller than it looks — say so. */
const bundledIssues = computed(() => store.route.value?.bundled.issues ?? []);
const importIssues = computed(() => store.route.value?.importIssues ?? []);
const current = computed(() => store.state.value?.current);
const currentArea = store.currentArea;
const mapLayout = computed(() =>
  store.route.value ? layoutCampaignMap(store.route.value.merged) : undefined,
);
const visitedIds = computed(() =>
  Object.keys(store.route.value?.settings.progress.visited ?? {}),
);
const hiddenEntries = computed(() => {
  const merged = store.route.value?.merged;
  if (!merged) return { areas: [] as MergedArea[], objectives: [] as MergedObjective[] };
  const areas: MergedArea[] = [];
  const objectives: MergedObjective[] = [];
  for (const act of merged.acts) {
    for (const area of act.areas) {
      if (area.hidden) areas.push(area);
      for (const objective of area.objectives) if (objective.hidden) objectives.push(objective);
    }
  }
  return { areas, objectives };
});

const nextStepText = computed(() => {
  const next = store.state.value?.next;
  if (!next) return "";
  switch (next.kind) {
    case "objective":
      return `Next (suggested): ${next.objective.title}`;
    case "exit":
      return `Next (suggested): ${next.area.name}${next.area.waypoint ? " (waypoint)" : ""}`;
    case "act-complete":
      return next.town ? `Act complete — head to ${next.town.name}` : "Act complete";
    default:
      return "";
  }
});

function actOpen(actKey: string): boolean {
  return currentArea.value?.key === actKey;
}

async function customise(patch: CampaignCustomisePatch, message = ""): Promise<void> {
  await store.customise(patch, message);
  if (!disposed) editorTarget.value = null;
}

async function saveFilters(patch: { rewardFilters?: Record<RewardTag, boolean>; showOptional?: boolean }): Promise<void> {
  if (!appApi) return;
  try {
    await appApi.invoke("settings:set", "campaign-guide", patch);
    await store.load("route");
  } catch (reason) {
    store.error.value = reason instanceof Error ? reason.message : "The filter could not be saved.";
  }
}

function toggleReward(tag: RewardTag, on: boolean): void {
  const current0 = settings.value?.rewardFilters;
  if (!current0) return;
  void saveFilters({ rewardFilters: { ...current0, [tag]: on } });
}

async function showOverlay(): Promise<void> {
  if (!store.api) return;
  try {
    store.state.value = await store.api.invoke("campaign:show-overlay");
  } catch (reason) {
    store.error.value = reason instanceof Error ? reason.message : "The panel could not be shown.";
  }
}

async function hideOverlay(): Promise<void> {
  if (!store.api) return;
  try {
    store.state.value = await store.api.invoke("campaign:hide-overlay");
  } catch (reason) {
    store.error.value = reason instanceof Error ? reason.message : "The panel could not be hidden.";
  }
}

async function setLevel(level: number | null): Promise<void> {
  if (!store.api) return;
  store.state.value = await store.api.invoke("campaign:set-character-level", level);
}

async function rescan(): Promise<void> {
  if (!store.api || store.busy.value) return;
  store.busy.value = true;
  try {
    store.state.value = await store.api.invoke("campaign:rescan-level");
    store.notice.value = "Rescanned the last 16 MB of Client.txt.";
  } catch (reason) {
    store.error.value = reason instanceof Error ? reason.message : "The log could not be rescanned.";
  } finally {
    store.busy.value = false;
  }
}

async function openWiki(areaId: string): Promise<void> {
  if (!store.api) return;
  const result = await store.api.invoke("campaign:open-wiki", areaId);
  if (!result.opened) store.notice.value = "That area has no usable wiki page.";
}

async function exportRoute(): Promise<void> {
  if (!store.api) return;
  const result = await store.api.invoke("campaign:export");
  importText.value = result.json;
  store.notice.value = result.copied
    ? "Route JSON copied to the clipboard."
    : "Route JSON is in the box below (the clipboard refused it).";
}

async function importRoute(mode: "replace-customisations" | "merge"): Promise<void> {
  if (!store.api || store.busy.value) return;
  store.busy.value = true;
  try {
    const view = await store.api.invoke("campaign:import", importText.value, mode);
    store.route.value = view;
    const issues = view.importIssues?.length ?? 0;
    store.notice.value = `Imported${issues ? ` with ${issues} issue(s)` : ""}.`;
    store.error.value = "";
  } catch (reason) {
    store.error.value = reason instanceof Error ? reason.message : "The route could not be imported.";
  } finally {
    store.busy.value = false;
  }
}

function askReset(what: "progress" | "customisations"): void {
  if (pendingReset.value === what) {
    void customise({ op: "reset", what }, what === "progress" ? "Progress reset." : "Customisations reset.");
    pendingReset.value = "";
    return;
  }
  pendingReset.value = what;
}

function addUnknownArea(): void {
  const guess = current.value?.guess;
  editorTarget.value = {
    mode: "add-area",
    prefill: {
      id: current.value?.normalizedId,
      name: guess?.name,
      part: guess?.part,
      act: guess?.act,
      level: current.value?.observedLevel ?? guess?.level,
    },
  };
  tab.value = "edit";
}

function editArea(area: MergedArea): void {
  editorTarget.value = { mode: "edit-area", area };
  tab.value = "edit";
}

function addObjective(area: MergedArea): void {
  editorTarget.value = { mode: "add-objective", area };
  tab.value = "edit";
}

function editObjective(objective: MergedObjective): void {
  const area = store.route.value?.merged.areaIndex[objective.areaId];
  editorTarget.value = { mode: "edit-objective", area, objective };
  tab.value = "edit";
}

onMounted(async () => {
  // One-way hash -> tab, like ItemLogView; clicking a tab does not write it.
  const hash = globalThis.location?.hash ?? "";
  if (hash === "#map") tab.value = "map";
  if (hash === "#edit") tab.value = "edit";
  stopSubscription = store.subscribe();
  await store.load();
  if (!disposed) store.loading.value = false;
});

onBeforeUnmount(() => {
  disposed = true;
  stopSubscription?.();
  disposeCampaignGuide();
});
</script>

<template>
  <section class="card tool-panel campaign-tool" aria-labelledby="campaign-title">
    <div class="section-heading">
      <div>
        <span class="eyebrow">Levelling</span>
        <h2 id="campaign-title">Campaign guide</h2>
      </div>
      <span class="status-chip warning">Community-maintained · verify in game</span>
    </div>
    <p class="muted">
      Reads the "Generating level N area" and level-up lines of Client.txt. It never sends input to the
      game and never fetches anything.
    </p>

    <div v-if="!store.api" class="state-panel compact-state">
      <span class="state-icon" aria-hidden="true">◇</span>
      <strong>Campaign guide needs the desktop app</strong>
      <p>This preview has no bridge to the game log.</p>
    </div>
    <div v-else-if="store.loading.value" class="state-panel compact-state" aria-live="polite">
      <span class="spinner" aria-hidden="true" />
      <p>Loading route…</p>
    </div>
    <div v-else-if="!store.route.value" class="state-panel compact-state">
      <span class="state-icon" aria-hidden="true">!</span>
      <strong>Campaign guide could not be loaded</strong>
      <p role="alert">{{ store.error.value || "The desktop app did not answer." }}</p>
      <button type="button" class="button secondary compact" :disabled="store.busy.value" @click="store.retry">
        Retry
      </button>
    </div>

    <template v-else>
      <p v-if="bundled && bundled.source === 'missing'" class="inline-notice warning">
        Bundled route not found at {{ bundled.path }} — the guide is empty until it is
        restored; your own areas still work.
      </p>
      <details v-else-if="bundledIssues.length" class="advanced-options">
        <summary>
          The bundled route parsed with {{ bundledIssues.length }} issue(s) — parts of it were dropped
        </summary>
        <ul class="issues">
          <li v-for="issue in bundledIssues" :key="issue">{{ issue }}</li>
        </ul>
      </details>
      <p v-if="store.notice.value" class="inline-notice" role="status">{{ store.notice.value }}</p>
      <p v-if="store.error.value" class="inline-notice danger" role="alert">{{ store.error.value }}</p>

      <section class="card campaign-current" aria-label="Current area">
        <template v-if="current && current.kind === 'known' && currentArea">
          <CampaignAreaCard
            :area="currentArea"
            :settings="activeSettings"
            :current="true"
            :experience="store.state.value?.experience"
            :editable="true"
            :busy="store.busy.value"
            @select="store.selectArea"
            @customise="customise"
            @open-wiki="openWiki"
            @edit-area="editArea"
            @add-objective="addObjective"
            @edit="editObjective"
          />
          <p v-if="nextStepText" class="next-step">{{ nextStepText }}</p>
          <span v-if="current.isCruel" class="tag neutral">Cruel</span>
          <CampaignXpHelper
            v-if="store.state.value"
            :state="store.state.value"
            :busy="store.busy.value"
            @set-level="setLevel"
            @rescan="rescan"
          />
          <div class="button-row">
            <button
              v-if="!store.state.value?.overlay.visible"
              type="button"
              class="button compact secondary"
              @click="showOverlay"
            >
              Show overlay
            </button>
            <button v-else type="button" class="button compact ghost" @click="hideOverlay">Hide overlay</button>
          </div>
        </template>
        <template v-else-if="current && current.kind === 'unknown-campaign'">
          <p class="inline-notice warning">
            Unknown area {{ current.areaId }} (Act {{ current.guess?.act }}, level
            {{ current.observedLevel }}) — not in the route yet.
          </p>
          <button type="button" class="button compact secondary" @click="addUnknownArea">Add this area</button>
        </template>
        <template v-else-if="current">
          <p class="muted">
            You are in {{ current.areaId }} (hideout, map or endgame town) — the guide resumes when you enter
            a campaign area.
          </p>
        </template>
        <template v-else>
          <p class="empty-copy">
            No area seen yet. Client.txt: {{ store.state.value?.clientLog.error ?? "watching" }}. Set the path
            under Tools → Settings if it never appears.
          </p>
        </template>
      </section>

      <ViewTabs v-model="tab" :tabs="TABS" label="Campaign guide sections" />

      <template v-if="tab === 'route'">
        <div class="check-row" role="group" aria-label="Reward filters">
          <label v-for="tag in REWARD_TAGS" :key="tag" class="toggle-field">
            <input
              type="checkbox"
              :checked="activeSettings.rewardFilters[tag] !== false"
              @change="toggleReward(tag, ($event.target as HTMLInputElement).checked)"
            />
            <span>{{ tag }}</span>
          </label>
          <label class="toggle-field">
            <input
              type="checkbox"
              :checked="activeSettings.showOptional"
              @change="saveFilters({ showOptional: ($event.target as HTMLInputElement).checked })"
            />
            <span>optional</span>
          </label>
        </div>

        <p v-if="!acts.length" class="empty-copy">
          The route is empty. Add your own areas under Edit.
        </p>
        <details
          v-for="act in acts"
          :key="act.key"
          class="campaign-act"
          :open="actOpen(act.key)"
        >
          <summary>
            {{ act.label }}
            <span class="count-badge">
              {{ actProgress(act).visited }}/{{ actProgress(act).areas }} areas
            </span>
            <span class="count-badge">
              {{ actProgress(act).done }}/{{ actProgress(act).objectives }} objectives
            </span>
          </summary>
          <ul class="campaign-area-list">
            <li v-for="area in act.areas.filter((entry) => !entry.hidden)" :key="area.id">
              <CampaignAreaCard
                :area="area"
                :settings="activeSettings"
                :current="area.id === current?.normalizedId"
                :selected="area.id === store.selectedAreaId.value"
                :editable="true"
                :busy="store.busy.value"
                @select="store.selectArea"
                @customise="customise"
                @open-wiki="openWiki"
                @edit-area="editArea"
                @add-objective="addObjective"
                @edit="editObjective"
              />
            </li>
          </ul>
        </details>

        <details class="advanced-options">
          <summary>
            Hidden areas and objectives ({{ hiddenEntries.areas.length + hiddenEntries.objectives.length }})
          </summary>
          <ul class="hidden-list">
            <li v-for="area in hiddenEntries.areas" :key="`a-${area.id}`">
              <span>{{ area.name }}</span>
              <button
                type="button"
                class="button compact ghost"
                @click="customise({ op: 'restore-area', id: area.id })"
              >
                Restore
              </button>
            </li>
            <li v-for="objective in hiddenEntries.objectives" :key="`o-${objective.id}`">
              <span>{{ objective.title }}</span>
              <button
                type="button"
                class="button compact ghost"
                @click="customise({ op: 'restore-objective', id: objective.id })"
              >
                Restore
              </button>
            </li>
          </ul>
          <p v-if="!hiddenEntries.areas.length && !hiddenEntries.objectives.length" class="empty-copy">
            Nothing hidden.
          </p>
        </details>
      </template>

      <template v-else-if="tab === 'map'">
        <div class="result-grid">
          <CampaignWorldMap
            v-if="mapLayout"
            :layout="mapLayout"
            :current-id="current?.normalizedId"
            :selected-id="store.selectedAreaId.value"
            :visited="visitedIds"
            @select="store.selectArea"
          />
          <aside>
            <CampaignAreaCard
              v-if="store.selectedArea.value"
              :area="store.selectedArea.value"
              :settings="activeSettings"
              :current="store.selectedArea.value.id === current?.normalizedId"
              :editable="true"
              :busy="store.busy.value"
              @select="store.selectArea"
              @customise="customise"
              @open-wiki="openWiki"
              @edit-area="editArea"
              @add-objective="addObjective"
              @edit="editObjective"
            />
            <p v-else class="empty-copy">Pick an area on the map.</p>
          </aside>
        </div>
      </template>

      <template v-else>
        <CampaignAreaEditor
          v-if="editorTarget"
          :route="store.route.value"
          :target="editorTarget"
          :busy="store.busy.value"
          @customise="customise"
          @cancel="editorTarget = null"
        />
        <div v-else class="button-row">
          <button type="button" class="button secondary compact" @click="editorTarget = { mode: 'add-area' }">
            Add an area
          </button>
          <span class="muted">Pick "Edit area" or "Add objective" on any area card to change it.</span>
        </div>

        <section class="card import-panel" aria-label="Export and import">
          <h3>Share your corrections</h3>
          <p class="muted">
            Export writes the merged route as JSON (your edits folded in). Import folds someone else's JSON
            back in as your own corrections — it never overwrites the bundled file. Up to 2 MB.
          </p>
          <textarea v-model="importText" rows="6" aria-label="Route JSON"></textarea>
          <div class="button-row">
            <button type="button" class="button secondary compact" :disabled="store.busy.value" @click="exportRoute">
              Copy route JSON
            </button>
            <button
              type="button"
              class="button compact"
              :disabled="store.busy.value || !importText"
              @click="importRoute('replace-customisations')"
            >
              Import (replace my edits)
            </button>
            <button
              type="button"
              class="button compact"
              :disabled="store.busy.value || !importText"
              @click="importRoute('merge')"
            >
              Import (merge)
            </button>
          </div>
          <ul v-if="importIssues.length" class="issues">
            <li v-for="issue in importIssues" :key="issue">{{ issue }}</li>
          </ul>
        </section>
      </template>

      <CampaignGuideSettingsSection
        :settings="activeSettings"
        @changed="store.load('route')"
      />

      <details class="advanced-options">
        <summary>Reset</summary>
        <div class="button-row">
          <button type="button" class="button compact danger" @click="askReset('progress')">
            {{ pendingReset === "progress" ? "Confirm reset" : "Reset progress" }}
          </button>
          <button type="button" class="button compact danger" @click="askReset('customisations')">
            {{ pendingReset === "customisations" ? "Confirm reset" : "Reset customisations" }}
          </button>
        </div>
        <p class="muted">
          Progress = visited areas and ticked objectives. Customisations = your notes, edits, hidden entries
          and added areas. The two are independent.
        </p>
      </details>

      <p class="disclaimer">
        Route data is community-maintained and unverified; area levels are the game's own instance levels;
        XP percentages are estimates from the community formula, never a guarantee.
      </p>
    </template>
  </section>
</template>

<style scoped>
.campaign-tool {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}
.campaign-current {
  display: grid;
  gap: 0.55rem;
}
.next-step {
  margin: 0;
  font-size: 0.85rem;
  color: var(--gold-bright, #e4c587);
}
.campaign-act > summary {
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.35rem 0;
  font-weight: 650;
}
.campaign-area-list,
.hidden-list {
  list-style: none;
  margin: 0.3rem 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}
.hidden-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.issues {
  margin: 0.4rem 0 0;
  padding-left: 1.1rem;
  font-size: 0.75rem;
  color: var(--amber, #d0a45f);
}
</style>
