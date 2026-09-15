<script setup lang="ts">
/**
 * Home renders the setup checklist; it does NOT compute it. The list is
 * owned by the app-settings package and reached over `app:setup-checklist`
 * with a structural contract, so Home never imports another feature.
 *
 * When that package is not registered (or the call fails) the card falls
 * back to the ONE fact Home already has: whether Client.txt is being read.
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import {
  CHECKLIST_ACTION_ROUTES,
  type HomeChecklistStep,
  type HomeOverview,
} from "../../../../shared/session";
import { getHomeChecklistApi } from "../api";

const props = defineProps<{ home: HomeOverview }>();

const api = getHomeChecklistApi();
const steps = ref<HomeChecklistStep[] | null>(null);
const loading = ref(true);
let disposed = false;

const fallback = computed<HomeChecklistStep[]>(() => [
  {
    id: "client-log",
    label: "Client.txt",
    state: props.home.clientLog.watching ? "ok" : "todo",
    detail: props.home.clientLog.watching
      ? `Reading ${props.home.clientLog.file ?? props.home.clientLog.source}`
      : (props.home.clientLog.error ?? "Not being read yet — point the app at the game's log file."),
    optional: false,
    action: "browse-log",
  },
]);

const shown = computed<HomeChecklistStep[]>(() => steps.value ?? fallback.value);
const done = computed(() => shown.value.filter((step) => step.state === "ok").length);

function routeFor(step: HomeChecklistStep): string {
  return (step.action && CHECKLIST_ACTION_ROUTES[step.action]) || "/tools/settings";
}

onMounted(async () => {
  if (!api) {
    loading.value = false;
    return;
  }
  try {
    const view = await api.invoke("app:setup-checklist");
    if (disposed) return;
    if (view && Array.isArray(view.steps) && view.steps.length > 0) steps.value = view.steps;
  } catch {
    // The app-settings package may not be registered in this build; the
    // fallback row still tells the user whether Client.txt is being read.
  } finally {
    if (!disposed) loading.value = false;
  }
});

onBeforeUnmount(() => {
  disposed = true;
});
</script>

<template>
  <aside class="card setup-card" aria-labelledby="home-checklist-title">
    <div class="section-heading">
      <div>
        <span class="eyebrow">Setup</span>
        <h2 id="home-checklist-title">What is set up</h2>
      </div>
      <span class="count-badge">{{ done }}/{{ shown.length }}</span>
    </div>

    <ul class="setup-checklist" aria-label="Setup checklist">
      <li v-for="step in shown" :key="step.id" :class="{ ok: step.state === 'ok' }">
        <span class="readiness-dot" aria-hidden="true" />
        <RouterLink class="step-copy" :to="routeFor(step)">
          <strong>{{ step.label }}</strong>
          <small class="muted">{{ step.detail }}</small>
        </RouterLink>
        <span v-if="step.optional" class="optional">optional</span>
      </li>
    </ul>
    <p v-if="!steps && !loading" class="muted">
      The full checklist lives in Tools → Settings; Home shows what it can reach.
    </p>
  </aside>
</template>

<style scoped>
.setup-card { display: flex; flex-direction: column; gap: 0.55rem; }
.setup-checklist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.45rem; }
.setup-checklist li { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 0.55rem; align-items: start; }
.readiness-dot { width: 9px; height: 9px; margin-top: 0.35rem; border-radius: 50%; background: var(--amber, #d0a45f); flex: none; }
.setup-checklist li.ok .readiness-dot { background: var(--green, #80b886); }
.step-copy { display: flex; flex-direction: column; min-width: 0; text-decoration: none; color: inherit; }
.step-copy small { opacity: 0.7; }
.optional { font-size: 0.7rem; opacity: 0.6; }
</style>
