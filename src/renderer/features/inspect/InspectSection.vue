<script setup lang="ts">
/**
 * The Item log's Inspect card: the same report as the overlay panel, for
 * the item currently in the log, with a button that opens it over the game.
 *
 * Reads only the text already in the log — no clipboard, no game input, no
 * network.
 */
import { onBeforeUnmount, ref, watch } from "vue";
import type { InspectReport } from "../../../shared/inspect.js";
import { analyzeInspect, getInspectApi } from "./inspectApi";
import InspectCard from "./InspectCard.vue";

const props = defineProps<{ raw: string }>();

const api = getInspectApi();
const report = ref<InspectReport | null>(null);
const loading = ref(true);
const busy = ref(false);
const error = ref("");
const notice = ref("");
let requestSeq = 0;
let debounce: ReturnType<typeof setTimeout> | undefined;
let disposed = false;

function describe(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

async function load(): Promise<void> {
  const seq = ++requestSeq;
  const text = props.raw ?? "";
  if (!text.trim()) {
    report.value = null;
    loading.value = false;
    return;
  }
  loading.value = true;
  try {
    const next = await analyzeInspect(text);
    if (disposed || seq !== requestSeq) return;
    report.value = next;
    error.value = "";
  } catch (reason) {
    if (disposed || seq !== requestSeq) return;
    report.value = null;
    error.value = describe(reason, "This item could not be inspected.");
  } finally {
    if (!disposed && seq === requestSeq) loading.value = false;
  }
}

function schedule(): void {
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => void load(), 150);
}

async function openInOverlay(): Promise<void> {
  if (!api || busy.value) return;
  busy.value = true;
  notice.value = "";
  try {
    const outcome = await api.invoke("inspect:show", props.raw);
    if (disposed) return;
    notice.value = outcome.shown
      ? "Opened over the game."
      : outcome.hidden
        ? "The panel was already showing this item, so it closed."
        : "The overlay could not show this item.";
    error.value = "";
  } catch (reason) {
    if (disposed) return;
    error.value = describe(reason, "The overlay panel could not be opened.");
  } finally {
    busy.value = false;
  }
}

/**
 * Same reason as the overlay panel: a link main refuses (or cannot open)
 * must say so here rather than leaving a dead button.
 */
async function onLink(url: string): Promise<void> {
  if (!api) return;
  try {
    const outcome = await api.invoke("inspect:open-link", url);
    if (disposed) return;
    if (!outcome?.ok) {
      error.value =
        outcome?.reason === "not-allowed"
          ? "That link is outside the allowed wiki hosts, so it was not opened."
          : "That link could not be opened — check your default browser.";
    }
  } catch (reason) {
    if (disposed) return;
    error.value = describe(reason, "That link could not be opened.");
  }
}

watch(() => props.raw, schedule, { immediate: true });

onBeforeUnmount(() => {
  disposed = true;
  requestSeq += 1;
  if (debounce) clearTimeout(debounce);
});
</script>

<template>
  <section class="card tool-panel inspect-section" aria-labelledby="inspect-section-title">
    <div class="section-heading">
      <div>
        <span class="eyebrow">Inspect</span>
        <h2 id="inspect-section-title">Tiers, rolls, DPS and map warnings</h2>
      </div>
      <span class="status-chip neutral">Estimates, never guarantees</span>
    </div>

    <div class="button-row">
      <button
        type="button"
        class="button primary compact"
        :disabled="!api || busy || !report"
        :title="api ? 'Show this item in the overlay panel' : 'Needs the desktop app'"
        @click="openInOverlay"
      >
        {{ busy ? "Opening…" : "Open in overlay" }}
      </button>
      <span v-if="notice" class="muted" role="status">{{ notice }}</span>
    </div>

    <p v-if="error" class="inline-notice danger" role="alert">
      {{ error }}
      <button type="button" class="button compact ghost" @click="load">Retry</button>
    </p>

    <div v-if="loading" class="state-panel compact-state" aria-live="polite">
      <span class="spinner" aria-hidden="true" />
      <p>Inspecting…</p>
    </div>
    <p v-else-if="!report" class="empty-copy">Nothing to inspect — copy an item into the log first.</p>
    <InspectCard v-else :report="report" @open-link="onLink" />

    <p v-if="!api" class="muted">
      This preview analyses locally with no learned tier data; the desktop app adds learned ranges and the overlay.
    </p>
  </section>
</template>

<style scoped>
.inspect-section {
  display: flex;
  flex-direction: column;
  gap: 0.8rem;
}
</style>
