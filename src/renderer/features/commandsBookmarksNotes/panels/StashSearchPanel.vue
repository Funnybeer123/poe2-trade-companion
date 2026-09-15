<script setup lang="ts">
/**
 * Overlay panel "stash-search" (Alt+F): a focused field plus the saved
 * searches. Enter fills the game's stash search box exactly once — main hands
 * keyboard focus back to the game first, then the chat service fronts Path of
 * Exile and verifies before typing. Nothing is retried.
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type {
  CommandsView,
  RunOutcome,
  StashSearchPanelPayload,
} from "../../../../shared/commandsBookmarksNotes.js";
import { getCommandsApi } from "../api";

const props = defineProps<{
  panelId: string;
  payload: unknown;
  visible: boolean;
}>();

const emit = defineEmits<{ close: [] }>();

const api = getCommandsApi();
const view = ref<CommandsView | null>(null);
const text = ref("");
const outcome = ref<RunOutcome | null>(null);
const busy = ref(false);
const error = ref("");
let closeTimer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;

const searches = computed(() => (view.value?.searches ?? []).filter((item) => item.enabled));

const outcomeLine = computed(() => {
  const value = outcome.value;
  if (!value) return "";
  if (value.dryRun) return `Dry-run · would type: ${value.resolved}`;
  if (value.ok) return `Typed: ${value.sent ?? value.resolved}`;
  return `Blocked: ${value.blockedBy ?? "unknown"}${value.error ? ` — ${value.error}` : ""}`;
});

/** The field is inserted when the panel opens, so `autofocus` would not fire. */
const vFocus = {
  mounted: (element: HTMLElement) => element.focus(),
};

function armClose(value: RunOutcome): void {
  // Give the game the pointer back after a real fill; a dry-run stays open.
  if (!value.ok || value.dryRun) return;
  if (closeTimer) clearTimeout(closeTimer);
  closeTimer = setTimeout(() => {
    closeTimer = undefined;
    if (!disposed) emit("close");
  }, 600);
}

async function submit(): Promise<void> {
  if (!api || busy.value || !text.value.trim()) return;
  busy.value = true;
  try {
    const next = await api.invoke("commands:search-text", text.value, { fromPanel: true });
    if (disposed) return;
    outcome.value = next;
    armClose(next);
  } catch (reason) {
    if (disposed) return;
    error.value = reason instanceof Error ? reason.message : "The search could not be typed.";
  } finally {
    busy.value = false;
  }
}

async function runSaved(id: string): Promise<void> {
  if (!api || busy.value) return;
  busy.value = true;
  try {
    const next = await api.invoke("commands:run-search", id, { fromPanel: true });
    if (disposed) return;
    outcome.value = next;
    armClose(next);
  } catch (reason) {
    if (disposed) return;
    error.value = reason instanceof Error ? reason.message : "The search could not be typed.";
  } finally {
    busy.value = false;
  }
}

onMounted(async () => {
  const source = typeof props.payload === "object" && props.payload !== null ? props.payload : {};
  const prefill = (source as StashSearchPanelPayload).prefill;
  if (typeof prefill === "string") text.value = prefill;
  if (!api) return;
  try {
    view.value = await api.invoke("commands:list");
  } catch (reason) {
    if (disposed) return;
    error.value = reason instanceof Error ? reason.message : "The saved searches could not be loaded.";
  }
});

onBeforeUnmount(() => {
  disposed = true;
  if (closeTimer) clearTimeout(closeTimer);
});
</script>

<template>
  <form class="stash-search-panel" @submit.prevent="submit">
    <input
      v-model="text"
      v-focus
      class="search-field"
      type="text"
      maxlength="250"
      aria-label="Stash search text"
      placeholder="Type, then press Enter"
    />
    <div v-if="searches.length" class="pill-row">
      <button
        v-for="item in searches"
        :key="item.id"
        type="button"
        class="pill"
        :title="item.text"
        :disabled="busy"
        @click="runSaved(item.id)"
      >
        {{ item.label }}
      </button>
    </div>
    <p v-if="error" class="danger-text" role="alert">{{ error }}</p>
    <p v-else-if="outcomeLine" class="search-outcome" :class="{ 'danger-text': outcome && !outcome.ok }" role="status">
      {{ outcomeLine }}
    </p>
    <p class="muted">Enter types the text into the stash search box once. Esc closes.</p>
  </form>
</template>

<style scoped>
.stash-search-panel {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.pill-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
}
.search-outcome {
  margin: 0;
  font-size: 0.76rem;
  color: var(--text-soft, #b9b4aa);
}
.danger-text {
  color: #e5a49f;
  font-size: 0.76rem;
}
</style>
