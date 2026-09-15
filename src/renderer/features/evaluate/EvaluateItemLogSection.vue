<script setup lang="ts">
/**
 * Item log → "Evaluate — trade listings & price band".
 *
 * The desktop half of Evaluate. It opens a session for the item currently in
 * the log WITHOUT searching (`autoSearch: false`): the first trade2 lookup is
 * always a deliberate press of Search, because Item log already spent a
 * comps lookup on this item.
 */
import { computed, ref, watch } from "vue";
import type { ParsedItemEvaluation } from "../../../shared/ipc.js";
import EvaluateWorkbench from "./EvaluateWorkbench.vue";
import { useEvaluateSession } from "./useEvaluateSession";

const props = defineProps<{ evaluation: ParsedItemEvaluation }>();

const store = useEvaluateSession();

const session = computed(() => {
  const current = store.session.value;
  if (!current) return undefined;
  return current.item.fingerprint === props.evaluation.item.fingerprint ? current : undefined;
});

/** True once the user has opened Evaluate here at least once. */
const opened = ref(false);
const trainingUrl = computed(() => `#/tools/price-training?item=${encodeURIComponent(props.evaluation.raw)}`);

async function evaluateItem(): Promise<void> {
  opened.value = true;
  await store.open({
    text: props.evaluation.raw,
    source: "item-log",
    autoSearch: false,
    showOverlay: false,
  });
}

// A new item in the log rebuilds the query for it — still WITHOUT a lookup.
// The guard is `opened`, not `session`: by the time this runs the session no
// longer matches the new item's fingerprint, so testing the session here
// would never re-open (the user would silently lose the section).
watch(
  () => props.evaluation.raw,
  () => {
    if (opened.value) void evaluateItem();
  },
);
</script>

<template>
  <details class="advanced-options evaluate-section" open>
    <summary>Evaluate — trade listings &amp; price band</summary>
    <p v-if="!store.available" class="state-panel compact-state">
      <span class="state-icon" aria-hidden="true">◇</span>
      Evaluate needs the desktop app.
    </p>
    <template v-else>
      <a :href="trainingUrl" class="training-link">Teach this price</a>
      <div v-if="!session" class="button-row">
        <button type="button" class="button secondary compact" :disabled="store.loading.value" @click="evaluateItem">
          Evaluate this item
        </button>
        <span class="muted">Builds the editable trade2 query. No lookup is spent until you press Search.</span>
      </div>
      <p v-if="store.error.value" class="inline-notice danger" role="alert">{{ store.error.value }}</p>
      <EvaluateWorkbench v-if="session" :session="session" embedded />
    </template>
  </details>
</template>

<style scoped>
.evaluate-section {
  display: grid;
  gap: 0.5rem;
}
.button-row {
  align-items: center;
  gap: 0.5rem;
}
.training-link { justify-self: start; }
</style>
