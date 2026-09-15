<script setup lang="ts">
/**
 * Tools → Stash tracker. Snapshots of the sorter's ledger, history and
 * compare, session gains, per-tab totals, exclusions, a worth timeline, and
 * the switch for the in-stash price overlay.
 *
 * Reads `artifacts/tab-admin/inventory.jsonl` (written by the sorter) and
 * writes only this package's own files. Nothing here sends game input or
 * touches the network; the overlay reads the game window position only.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { describeAge } from "@core/inventoryLedger";
import { formatExalted, timelinePoints } from "@core/stashTrackerTimeline";
import ViewTabs from "../../components/ViewTabs.vue";
import SnapshotCompare from "./components/SnapshotCompare.vue";
import SnapshotHistory from "./components/SnapshotHistory.vue";
import TabTotals from "./components/TabTotals.vue";
import WealthTimeline from "./components/WealthTimeline.vue";
import { getStashTrackerApi } from "./api";
import type {
  StashTrackerOverview,
  StashTrackerSettingsPatch,
  WealthSnapshot,
} from "../../../shared/stashTracker.js";

const api = getStashTrackerApi();
const route = useRoute();

const view = ref<StashTrackerOverview | null>(null);
const current = ref<WealthSnapshot | null>(null);
const loading = ref(true);
const busy = ref(false);
const error = ref("");
const notice = ref("");
const snapshotName = ref("");
const overlayTab = ref("");
const compareFrom = ref("");
const clock = ref(Date.now());

const TABS = [
  { id: "history", label: "History", hint: "Snapshots" },
  { id: "compare", label: "Compare", hint: "What changed" },
  { id: "tabs", label: "Per tab", hint: "Totals & exclusions" },
  { id: "timeline", label: "Timeline", hint: "Worth over time" },
] as const;
const tab = ref<string>("history");

const draft = ref({
  autoSnapshot: true,
  maxAutoSnapshots: 100,
  fadeByValue: true,
  showUnpriced: true,
  minLabelExalted: 0,
  showLegend: true,
  topLevelTabs: "",
});

let disposed = false;
let requestSeq = 0;
let unsubscribe: (() => void) | undefined;
let unsubscribeOverlay: (() => void) | undefined;
let clockTimer: ReturnType<typeof setInterval> | undefined;

const excluded = computed(() => new Set(view.value?.settings.excludedFingerprints ?? []));

const sessionDelta = computed(() => view.value?.session.deltaExalted ?? 0);
const sessionTone = computed(() =>
  sessionDelta.value > 0 ? "safe" : sessionDelta.value < 0 ? "danger" : "neutral",
);

const points = computed(() => {
  // The timeline needs snapshots; the overview only carries metadata, so each
  // row becomes a totals-only snapshot whose total is already the effective
  // (post-exclusion) one — hence the empty exclusion set below.
  const snapshots: WealthSnapshot[] = (view.value?.snapshots ?? []).map((meta) => ({
    version: 1,
    id: meta.id,
    at: meta.at,
    kind: meta.kind,
    ...(meta.label ? { label: meta.label } : {}),
    sessionId: meta.sessionId,
    ledgerAt: meta.ledgerAt,
    recordCount: meta.recordCount,
    divineRate: meta.divineRate,
    totalExalted: meta.effectiveExalted,
    totalDivine: meta.effectiveDivine,
    items: [],
    locations: [],
    itemsTrimmed: true,
  }));
  return timelinePoints(snapshots, new Set<string>(), clock.value);
});

const optionsDirty = computed(() => {
  const settings = view.value?.settings;
  if (!settings) return false;
  return (
    draft.value.autoSnapshot !== settings.autoSnapshot ||
    draft.value.maxAutoSnapshots !== settings.maxAutoSnapshots ||
    draft.value.fadeByValue !== settings.overlay.fadeByValue ||
    draft.value.showUnpriced !== settings.overlay.showUnpriced ||
    draft.value.minLabelExalted !== settings.overlay.minLabelExalted ||
    draft.value.showLegend !== settings.overlay.showLegend ||
    draft.value.topLevelTabs !== settings.overlay.topLevelTabs.join(", ")
  );
});

const optionIssues = computed(() => {
  const issues: string[] = [];
  if (draft.value.maxAutoSnapshots < 20 || draft.value.maxAutoSnapshots > 500) {
    issues.push("Keep at most: 20–500 auto snapshots.");
  }
  if (draft.value.minLabelExalted < 0) issues.push("Minimum label value cannot be negative.");
  return issues;
});

function resetDraft(): void {
  const settings = view.value?.settings;
  if (!settings) return;
  draft.value = {
    autoSnapshot: settings.autoSnapshot,
    maxAutoSnapshots: settings.maxAutoSnapshots,
    fadeByValue: settings.overlay.fadeByValue,
    showUnpriced: settings.overlay.showUnpriced,
    minLabelExalted: settings.overlay.minLabelExalted,
    showLegend: settings.overlay.showLegend,
    topLevelTabs: settings.overlay.topLevelTabs.join(", "),
  };
}

function adopt(next: StashTrackerOverview | undefined): void {
  if (!next) return;
  view.value = next;
  if (!overlayTab.value) overlayTab.value = next.overlay.tab ?? next.ledger.locations[0] ?? "";
  if (!optionsDirty.value) resetDraft();
}

function describeError(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

async function loadCurrent(): Promise<void> {
  if (!api) return;
  try {
    const next = await api.invoke("stash-tracker:current");
    if (disposed) return;
    current.value = next ?? null;
  } catch {
    if (!disposed) current.value = null;
  }
}

async function load(): Promise<void> {
  if (!api) return;
  const token = ++requestSeq;
  try {
    const next = await api.invoke("stash-tracker:overview");
    if (disposed || token !== requestSeq) return;
    adopt(next);
    resetDraft();
    await loadCurrent();
  } catch (reason) {
    if (disposed || token !== requestSeq) return;
    error.value = describeError(reason, "The stash tracker could not be loaded.");
  }
}

async function apply(
  action: () => Promise<StashTrackerOverview | undefined>,
  success = "",
): Promise<void> {
  if (!api || busy.value) return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    const next = await action();
    if (disposed) return;
    adopt(next);
    await loadCurrent();
    if (success) notice.value = success;
  } catch (reason) {
    if (disposed) return;
    error.value = describeError(reason, "That did not work.");
  } finally {
    busy.value = false;
  }
}

async function takeSnapshot(): Promise<void> {
  const label = snapshotName.value.trim();
  await apply(
    () => api!.invoke("stash-tracker:snapshot", label || undefined),
    label ? `Saved "${label}".` : "Snapshot saved.",
  );
  if (!error.value) snapshotName.value = "";
}

async function startSession(): Promise<void> {
  await apply(() => api!.invoke("stash-tracker:session-start"), "Session started.");
}

async function toggleOverlay(): Promise<void> {
  if (!api || busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await api.invoke("stash-tracker:overlay-toggle", overlayTab.value || undefined);
    const next = await api.invoke("stash-tracker:overview");
    if (disposed) return;
    adopt(next);
  } catch (reason) {
    if (disposed) return;
    error.value = describeError(reason, "The price overlay could not be toggled.");
  } finally {
    busy.value = false;
  }
}

/**
 * Picking a tab while the labels are already up switches them, instead of
 * making the user hide and show again — the button stays a plain toggle.
 */
function onOverlayTabChange(): void {
  const overlay = view.value?.overlay;
  if (!api || busy.value || !overlay?.visible) return;
  if (!overlayTab.value || overlayTab.value === overlay.tab) return;
  busy.value = true;
  error.value = "";
  void api
    .invoke("stash-tracker:overlay-show", overlayTab.value)
    .then(() => api.invoke("stash-tracker:overview"))
    .then((next) => {
      if (!disposed) adopt(next);
    })
    .catch((reason: unknown) => {
      if (!disposed) error.value = describeError(reason, "The price overlay could not be switched.");
    })
    .finally(() => {
      busy.value = false;
    });
}

async function saveOptions(): Promise<void> {
  if (!api || busy.value || optionIssues.value.length) return;
  const patch: StashTrackerSettingsPatch = {
    autoSnapshot: draft.value.autoSnapshot,
    maxAutoSnapshots: draft.value.maxAutoSnapshots,
    overlay: {
      fadeByValue: draft.value.fadeByValue,
      showUnpriced: draft.value.showUnpriced,
      minLabelExalted: draft.value.minLabelExalted,
      showLegend: draft.value.showLegend,
      topLevelTabs: draft.value.topLevelTabs
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    },
  };
  busy.value = true;
  error.value = "";
  try {
    await api.invoke("stash-tracker:configure", patch);
    const next = await api.invoke("stash-tracker:overview");
    if (disposed) return;
    adopt(next);
    resetDraft();
    notice.value = "Options saved.";
  } catch (reason) {
    if (disposed) return;
    error.value = describeError(reason, "The options could not be saved.");
  } finally {
    busy.value = false;
  }
}

function onRename(id: string, label: string): void {
  void apply(() => api!.invoke("stash-tracker:rename", id, label), "Renamed.");
}

function onRemove(id: string): void {
  void apply(() => api!.invoke("stash-tracker:delete", id), "Snapshot deleted.");
}

function onCompare(id: string): void {
  compareFrom.value = id;
  tab.value = "compare";
}

function onExclude(fingerprint: string, isExcluded: boolean): void {
  if (!api || busy.value) return;
  busy.value = true;
  void api
    .invoke("stash-tracker:exclude", fingerprint, isExcluded)
    .then(() => api.invoke("stash-tracker:overview"))
    .then((next) => {
      if (!disposed) adopt(next);
    })
    .catch((reason: unknown) => {
      if (!disposed) error.value = describeError(reason, "The exclusion could not be saved.");
    })
    .finally(() => {
      busy.value = false;
    });
}

async function retryLoad(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  loading.value = true;
  try {
    await load();
  } finally {
    loading.value = false;
    busy.value = false;
  }
}

watch(
  () => route.hash,
  (hash) => {
    const id = hash.replace(/^#/, "");
    if (TABS.some((entry) => entry.id === id)) tab.value = id;
  },
  { immediate: true },
);

onMounted(async () => {
  if (!api) {
    loading.value = false;
    return;
  }
  unsubscribe = api.on("stash-tracker:changed", (next) => {
    if (disposed) return;
    const previousLedgerAt = view.value?.ledger.newestAt;
    adopt(next);
    if (next.ledger.newestAt !== previousLedgerAt) void loadCurrent();
  });
  // Overlay status moves on its own (the game starting or closing, the legend
  // hidden from main): without this the Show-overlay button would keep the
  // state it had when the overview was last fetched.
  unsubscribeOverlay = api.on("stash-tracker:overlay", (next) => {
    if (disposed || !view.value || !next) return;
    view.value = { ...view.value, overlay: next };
  });
  await load();
  loading.value = false;
  clockTimer = setInterval(() => {
    clock.value = Date.now();
  }, 30_000);
});

onBeforeUnmount(() => {
  disposed = true;
  requestSeq += 1;
  unsubscribe?.();
  unsubscribeOverlay?.();
  if (clockTimer) clearInterval(clockTimer);
});
</script>

<template>
  <section class="card tool-panel stash-tracker-tool" aria-labelledby="stash-tracker-title">
    <div class="section-heading">
      <div>
        <span class="eyebrow">Ledger history</span>
        <h2 id="stash-tracker-title">Stash tracker</h2>
      </div>
      <span class="status-chip neutral">Estimates, never guarantees</span>
    </div>
    <p class="muted">
      Reads the sorter's Ctrl+C ledger (<code>inventory.jsonl</code>) and freezes it into snapshots
      you can name, compare and chart. It never sends input to the game and never touches the
      network.
    </p>
    <p class="privacy-note">Snapshots stay on this machine, under your app data folder.</p>

    <div v-if="!api" class="state-panel compact-state">
      <span class="state-icon" aria-hidden="true">◇</span>
      <strong>Stash tracker needs the desktop app</strong>
      <p>This preview has no bridge to the ledger.</p>
    </div>
    <div v-else-if="loading" class="state-panel compact-state" aria-live="polite">
      <span class="spinner" aria-hidden="true" />
      <p>Reading snapshots…</p>
    </div>
    <div v-else-if="!view" class="state-panel compact-state">
      <span class="state-icon" aria-hidden="true">!</span>
      <strong>Stash tracker could not be loaded</strong>
      <p role="alert">{{ error || "The desktop app did not answer." }}</p>
      <button type="button" class="button secondary compact" :disabled="busy" @click="retryLoad">
        Retry
      </button>
    </div>
    <template v-else>
      <dl class="metric-grid tracker-metrics">
        <div>
          <dt>Current worth</dt>
          <dd>
            {{ formatExalted(view.current?.effectiveExalted) }} ex
            <small class="muted">{{ formatExalted(view.current?.effectiveDivine) }} div</small>
          </dd>
        </div>
        <div>
          <dt>Session gain</dt>
          <dd :class="`tone-${sessionTone}`">
            {{ sessionDelta > 0 ? "+" : "" }}{{ formatExalted(sessionDelta) }} ex
            <small class="muted">
              {{ view.session.start ? "since session start" : "start a session to track gains" }}
            </small>
          </dd>
        </div>
        <div>
          <dt>Snapshots</dt>
          <dd>{{ view.snapshots.length }}</dd>
        </div>
        <div>
          <dt>Ledger</dt>
          <dd>
            {{ view.ledger.recordCount }} records
            <small class="muted">
              {{ view.ledger.ageMs === undefined ? "never scanned" : describeAge(view.ledger.ageMs) }}
            </small>
          </dd>
        </div>
      </dl>

      <div class="button-row">
        <label class="sr-only" for="snapshot-name">Snapshot name</label>
        <input
          id="snapshot-name"
          v-model="snapshotName"
          type="text"
          maxlength="60"
          placeholder="Snapshot name (optional)"
          @keydown.enter.prevent="takeSnapshot"
        />
        <button
          type="button"
          class="button primary"
          :disabled="busy || !view.ledger.recordCount"
          :title="view.ledger.recordCount ? '' : 'Run a sort first — the ledger is empty.'"
          @click="takeSnapshot"
        >
          {{ busy ? "Saving…" : "Take snapshot" }}
        </button>
        <button type="button" class="button secondary" :disabled="busy" @click="startSession">
          Start session
        </button>
        <label class="sr-only" for="overlay-tab">Overlay tab</label>
        <select
          id="overlay-tab"
          v-model="overlayTab"
          :disabled="busy || !view.ledger.locations.length"
          @change="onOverlayTabChange"
        >
          <option v-for="location in view.ledger.locations" :key="location" :value="location">
            {{ location }}
          </option>
        </select>
        <button
          type="button"
          class="button ghost"
          :disabled="busy || !view.overlay.poeRunning"
          :title="
            view.overlay.poeRunning
              ? 'Alt+P — reads the game window position only; sends no input'
              : 'Path of Exile is not running'
          "
          @click="toggleOverlay"
        >
          {{ view.overlay.visible ? "Hide overlay" : "Show overlay" }}
        </button>
      </div>

      <p v-if="notice" class="inline-notice" role="status">{{ notice }}</p>
      <p v-if="error" class="inline-notice danger" role="alert">{{ error }}</p>
      <p v-else-if="view.lastError" class="inline-notice warning">{{ view.lastError }}</p>
      <p v-else-if="view.overlay.error" class="inline-notice warning">{{ view.overlay.error }}</p>
      <p v-if="!view.ledger.recordCount" class="empty-copy">
        Nothing in the ledger yet — run a sort, then come back.
      </p>

      <ViewTabs v-model="tab" :tabs="TABS" label="Stash tracker sections" />

      <SnapshotHistory
        v-if="tab === 'history'"
        :snapshots="view.snapshots"
        :busy="busy"
        @rename="onRename"
        @remove="onRemove"
        @compare="onCompare"
      />
      <SnapshotCompare
        v-else-if="tab === 'compare'"
        :snapshots="view.snapshots"
        :initial-from="compareFrom"
        :api="api"
        :has-current="Boolean(view.current)"
      />
      <TabTotals
        v-else-if="tab === 'tabs'"
        :current="current"
        :excluded="excluded"
        :busy="busy"
        :now="clock"
        @exclude="onExclude"
      />
      <WealthTimeline v-else :points="points" />

      <details class="advanced-options">
        <summary>Expert options</summary>
        <div class="form-grid">
          <label class="inline-toggle">
            <input v-model="draft.autoSnapshot" type="checkbox" />
            Auto-snapshot when the ledger settles
          </label>
          <label>
            Keep at most (auto snapshots)
            <input v-model.number="draft.maxAutoSnapshots" type="number" min="20" max="500" />
          </label>
          <label class="inline-toggle">
            <input v-model="draft.fadeByValue" type="checkbox" />
            Overlay: fade labels by value
          </label>
          <label class="inline-toggle">
            <input v-model="draft.showUnpriced" type="checkbox" />
            Overlay: show unpriced items as “?”
          </label>
          <label>
            Overlay: minimum value to label (ex)
            <input v-model.number="draft.minLabelExalted" type="number" min="0" step="0.5" />
          </label>
          <label class="inline-toggle">
            <input v-model="draft.showLegend" type="checkbox" />
            Overlay: show the legend panel
          </label>
          <label>
            Top-level tabs (comma separated; T1–T99 are detected automatically)
            <input v-model="draft.topLevelTabs" type="text" placeholder="Dump, Review" />
          </label>
        </div>
        <ul v-if="optionIssues.length" class="notice-list">
          <li v-for="issue in optionIssues" :key="issue">{{ issue }}</li>
        </ul>
        <div class="button-row">
          <button
            type="button"
            class="button secondary compact"
            :disabled="busy || !optionsDirty || optionIssues.length > 0"
            @click="saveOptions"
          >
            {{ busy ? "Saving…" : "Save options" }}
          </button>
          <button
            type="button"
            class="button ghost compact"
            :disabled="busy || !optionsDirty"
            @click="resetDraft"
          >
            Revert
          </button>
        </div>
      </details>

      <p class="disclaimer">
        Snapshot values come from your price table and the sorter's estimates — estimates, never
        guaranteed sale prices.
      </p>
    </template>
  </section>
</template>

<style scoped>
.stash-tracker-tool {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}
.tracker-metrics dd {
  font-size: 1.05rem;
  display: flex;
  gap: 0.4rem;
  align-items: baseline;
}
.tracker-metrics .tone-safe {
  color: var(--green, #80b886);
}
.tracker-metrics .tone-danger {
  color: var(--red, #d57b76);
}
.button-row input[type="text"] {
  max-width: 16rem;
}
.button-row select {
  max-width: 12rem;
}
</style>
