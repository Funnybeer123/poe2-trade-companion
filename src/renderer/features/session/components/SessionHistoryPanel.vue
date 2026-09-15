<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import type { SessionRecordView, SessionSummary } from "../../../../shared/session";
import { getSessionApi } from "../api";
import { describeError, formatDuration, rate, when } from "../format";

const api = getSessionApi();
const summaries = ref<SessionSummary[] | null>(null);
const detail = ref<SessionRecordView | null>(null);
const selectedId = ref("");
const loading = ref(true);
const busy = ref(false);
const error = ref("");
const pendingDeleteId = ref("");
let disposed = false;

async function load(): Promise<void> {
  if (!api) return;
  try {
    const next = await api.invoke("session:history", 50);
    if (disposed) return;
    summaries.value = next;
  } catch (reason) {
    if (disposed) return;
    error.value = describeError(reason, "Session history could not be read.");
  }
}

async function select(id: string): Promise<void> {
  if (!api || busy.value) return;
  busy.value = true;
  selectedId.value = id;
  try {
    const next = await api.invoke("session:history-get", id);
    if (disposed) return;
    detail.value = next ?? null;
  } catch (reason) {
    if (disposed) return;
    error.value = describeError(reason, "That session could not be opened.");
  } finally {
    busy.value = false;
  }
}

async function remove(id: string): Promise<void> {
  if (!api || busy.value) return;
  if (pendingDeleteId.value !== id) {
    pendingDeleteId.value = id;
    return;
  }
  busy.value = true;
  pendingDeleteId.value = "";
  try {
    const next = await api.invoke("session:history-delete", id);
    if (disposed) return;
    summaries.value = next;
    if (selectedId.value === id) detail.value = null;
  } catch (reason) {
    if (disposed) return;
    error.value = describeError(reason, "That session could not be deleted.");
  } finally {
    busy.value = false;
  }
}

onMounted(async () => {
  await load();
  if (!disposed) loading.value = false;
});
onBeforeUnmount(() => {
  disposed = true;
});
</script>

<template>
  <section class="card tool-panel history-panel" aria-labelledby="history-title">
    <div class="section-heading">
      <div>
        <span class="eyebrow">History</span>
        <h2 id="history-title">Past sessions</h2>
      </div>
      <span class="count-badge">{{ summaries?.length ?? 0 }}</span>
    </div>

    <div v-if="!api" class="state-panel compact-state">
      <span class="state-icon" aria-hidden="true">◇</span>
      <strong>Session history needs the desktop app</strong>
      <p>This preview has no bridge.</p>
    </div>
    <div v-else-if="loading" class="state-panel compact-state" aria-live="polite">
      <span class="spinner" aria-hidden="true" />
      <p>Loading sessions…</p>
    </div>
    <template v-else>
      <p v-if="error" class="inline-notice danger" role="alert">{{ error }}</p>
      <p v-if="!summaries?.length" class="empty-copy">
        No finished sessions yet — one is written when the game closes or you end it by hand.
      </p>
      <ul v-else class="history-list" aria-label="Past sessions">
        <li v-for="entry in summaries" :key="entry.id" :class="{ selected: entry.id === selectedId }">
          <button type="button" class="history-copy" @click="select(entry.id)">
            <strong>{{ when(entry.startedAt) }}</strong>
            <small class="muted">
              {{ entry.character?.name ?? "Unknown" }} ·
              {{ entry.mapsCompleted }} maps · {{ rate(entry.mapsPerHour) }} ·
              {{ entry.deaths }} deaths · {{ formatDuration(entry.wallMs) }}
            </small>
          </button>
          <button
            type="button"
            class="button danger compact"
            :disabled="busy"
            :aria-label="pendingDeleteId === entry.id ? `Confirm delete ${entry.id}` : `Delete ${entry.id}`"
            @click="remove(entry.id)"
          >
            {{ pendingDeleteId === entry.id ? "Confirm" : "Delete" }}
          </button>
        </li>
      </ul>

      <template v-if="detail">
        <h3>Session detail</h3>
        <dl class="metric-grid">
          <div>
            <dt>Ended</dt>
            <dd>{{ when(detail.state.endedAt) }}</dd>
          </div>
          <div>
            <dt>Reason</dt>
            <dd>{{ detail.state.endReason ?? "—" }}</dd>
          </div>
          <div>
            <dt>Active</dt>
            <dd>{{ formatDuration(detail.metrics.activeMs) }}</dd>
          </div>
          <div>
            <dt>Maps completed</dt>
            <dd>{{ detail.metrics.mapsCompleted }}</dd>
          </div>
          <div>
            <dt>Deaths</dt>
            <dd>{{ detail.metrics.deaths }}</dd>
          </div>
          <div>
            <dt>Levels gained</dt>
            <dd>{{ detail.metrics.levelsGained }}</dd>
          </div>
        </dl>
        <p v-if="detail.state.campaign" class="muted">
          Campaign: {{ detail.state.campaign.name }} (act {{ detail.state.campaign.act }})
        </p>
      </template>
    </template>

    <p class="disclaimer">Sessions are kept on this PC only; the newest 200 are retained.</p>
  </section>
</template>

<style scoped>
.history-panel { display: flex; flex-direction: column; gap: 0.7rem; }
.history-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem; }
.history-list li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0.6rem; align-items: center; border-bottom: 1px solid rgba(140, 140, 160, 0.15); padding-bottom: 0.4rem; }
.history-list li.selected { outline: 1px solid var(--gold-soft, rgba(200, 166, 106, 0.14)); }
.history-copy { display: flex; flex-direction: column; align-items: flex-start; min-width: 0; background: none; border: none; color: inherit; text-align: left; cursor: pointer; padding: 0; }
.history-copy small { opacity: 0.7; }
.metric-grid { margin: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: 0.6rem; }
.metric-grid dt { font-size: 0.72rem; text-transform: uppercase; opacity: 0.7; }
.metric-grid dd { margin: 0; font-variant-numeric: tabular-nums; font-weight: 600; }
</style>
