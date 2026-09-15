<script setup lang="ts">
/**
 * Home: who is playing, what this session did, what the stash and the market
 * look like, and what is still worth setting up.
 *
 * Everything shown here is read from Client.txt and from files other parts
 * of the app already wrote. Home sends no game input and makes no network
 * request; the refresh links point at the paced tools that do.
 */
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import ViewTabs from "../../../components/ViewTabs.vue";
import type { HomeOverview, SessionOverview } from "../../../../shared/session";
import { getSessionApi } from "../api";
import { describeError } from "../format";
import DeathsPanel from "../components/DeathsPanel.vue";
import HomeDashboard from "../components/HomeDashboard.vue";
import MappingPanel from "../components/MappingPanel.vue";
import SessionHistoryPanel from "../components/SessionHistoryPanel.vue";

const TABS = [
  { id: "overview", label: "Overview", hint: "Character & session" },
  { id: "maps", label: "Maps", hint: "Runs & rates" },
  { id: "history", label: "History", hint: "Past sessions" },
  { id: "deaths", label: "Deaths", hint: "Screenshots" },
] as const;
const HOME_POLL_MS = 30_000;

const route = useRoute();
const api = getSessionApi();
const tab = ref<string>(
  route.hash === "#maps" || route.hash === "#history" || route.hash === "#deaths"
    ? route.hash.slice(1)
    : "overview",
);
const home = ref<HomeOverview | null>(null);
const loading = ref(true);
const busy = ref(false);
const error = ref("");
const notice = ref("");
let pollTimer: ReturnType<typeof setInterval> | undefined;
let stopChanged: (() => void) | undefined;
let disposed = false;
let requestSeq = 0;

watch(
  () => route.hash,
  (hash) => {
    if (hash === "#maps") tab.value = "maps";
    else if (hash === "#history") tab.value = "history";
    else if (hash === "#deaths") tab.value = "deaths";
    else if (hash === "" || hash === "#overview") tab.value = "overview";
  },
);

async function load(): Promise<void> {
  if (!api) return;
  const seq = ++requestSeq;
  try {
    const next = await api.invoke("session:home");
    if (disposed || seq !== requestSeq) return;
    home.value = next;
    error.value = "";
  } catch (reason) {
    if (disposed || seq !== requestSeq) return;
    error.value = describeError(reason, "Home could not be loaded.");
  }
}

async function retryLoad(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  loading.value = true;
  try {
    await load();
  } finally {
    if (!disposed) {
      loading.value = false;
      busy.value = false;
    }
  }
}

async function endSession(): Promise<void> {
  if (!api || busy.value) return;
  busy.value = true;
  notice.value = "";
  try {
    await api.invoke("session:end");
    if (disposed) return;
    notice.value = "Session ended — the next log line starts a new one.";
    await load();
  } catch (reason) {
    if (disposed) return;
    error.value = describeError(reason, "The session could not be ended.");
  } finally {
    busy.value = false;
  }
}

async function showRecap(): Promise<void> {
  if (!api || busy.value) return;
  busy.value = true;
  notice.value = "";
  try {
    const shown = await api.invoke("session:recap-show", "full");
    if (disposed) return;
    notice.value = shown ? "Recap opened in the overlay." : "The overlay window is not available.";
  } catch (reason) {
    if (disposed) return;
    error.value = describeError(reason, "The recap could not be opened.");
  } finally {
    busy.value = false;
  }
}

onMounted(async () => {
  if (api) {
    stopChanged = api.on("session:changed", (overview: SessionOverview) => {
      if (disposed || !home.value) return;
      home.value = { ...home.value, session: overview };
    });
  }
  await load();
  if (disposed) return;
  loading.value = false;
  if (api) pollTimer = setInterval(() => void load(), HOME_POLL_MS);
});

onBeforeUnmount(() => {
  disposed = true;
  requestSeq += 1;
  if (pollTimer) clearInterval(pollTimer);
  stopChanged?.();
});
</script>

<template>
  <div class="merged-view home-view">
    <ViewTabs v-model="tab" :tabs="TABS" label="Home sections" />

    <div v-if="!api" class="state-panel compact-state">
      <span class="state-icon" aria-hidden="true">◇</span>
      <strong>Home needs the desktop app</strong>
      <p>This preview has no bridge to the game log, so there is nothing to show.</p>
    </div>
    <div v-else-if="loading" class="state-panel compact-state" aria-live="polite">
      <span class="spinner" aria-hidden="true" />
      <p>Loading Home…</p>
    </div>
    <div v-else-if="!home" class="state-panel compact-state">
      <span class="state-icon" aria-hidden="true">!</span>
      <strong>Home could not be loaded</strong>
      <p role="alert">{{ error || "The desktop app did not answer." }}</p>
      <button type="button" class="button secondary compact" :disabled="busy" @click="retryLoad">
        Retry
      </button>
    </div>
    <template v-else>
      <p v-if="notice" class="inline-notice" role="status">{{ notice }}</p>
      <p v-if="error" class="inline-notice danger" role="alert">{{ error }}</p>
      <p v-else-if="home.session.lastError" class="inline-notice warning">{{ home.session.lastError }}</p>

      <HomeDashboard
        v-if="tab === 'overview'"
        :home="home"
        :busy="busy"
        @end-session="endSession"
        @show-recap="showRecap"
      />
      <MappingPanel v-else-if="tab === 'maps'" :home="home" />
      <SessionHistoryPanel v-else-if="tab === 'history'" />
      <DeathsPanel v-else />
    </template>
  </div>
</template>

<style scoped>
.home-view { display: flex; flex-direction: column; gap: 1rem; }
</style>
