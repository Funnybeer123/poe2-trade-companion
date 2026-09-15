<script setup lang="ts">
/**
 * Overlay panel "evaluate". The payload carries only the session id — the
 * session itself comes over the `evaluate:session` event, so a long result
 * set never travels as a panel payload and a re-show cannot deliver a stale
 * copy.
 *
 * The panel DOES ask for keyboard focus (the builder has inputs); the
 * foundation's blur handling then closes it on a click outside, and Escape
 * closes it from the panel host.
 */
import { computed, onMounted, watch } from "vue";
import EvaluateWorkbench from "./EvaluateWorkbench.vue";
import { useEvaluateSession } from "./useEvaluateSession";

const props = defineProps<{
  panelId: string;
  payload: unknown;
  visible: boolean;
}>();

const emit = defineEmits<{ close: [] }>();

const store = useEvaluateSession();

const wantedId = computed(() => {
  const payload = (typeof props.payload === "object" && props.payload !== null ? props.payload : {}) as {
    sessionId?: unknown;
  };
  return typeof payload.sessionId === "string" ? payload.sessionId : "";
});

const session = computed(() => {
  const current = store.session.value;
  if (!current) return undefined;
  if (wantedId.value && current.id !== wantedId.value) return undefined;
  return current;
});

async function sync(): Promise<void> {
  if (!store.available) return;
  if (store.session.value?.id === wantedId.value) return;
  await store.refresh();
}

onMounted(() => {
  void sync();
});

watch(wantedId, () => {
  void sync();
});

async function close(): Promise<void> {
  await store.close();
  emit("close");
}
</script>

<template>
  <div class="evaluate-panel">
    <EvaluateWorkbench v-if="session" :session="session" compact @close="close" />
    <p v-else-if="!store.available" class="state-panel compact-state">
      <span class="state-icon" aria-hidden="true">◇</span>
      Evaluate needs the desktop app.
    </p>
    <p v-else class="empty-copy" aria-live="polite">
      Nothing to price yet — hover an item and press the Evaluate hotkey.
    </p>
  </div>
</template>

<style scoped>
.evaluate-panel {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  font-size: 0.8rem;
  max-height: 520px;
  overflow-y: auto;
}
</style>
