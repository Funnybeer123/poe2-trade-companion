<script setup lang="ts">
/**
 * Overlay panel "inspect". Main sends a finished report as the payload, so
 * the panel does no work of its own beyond guarding the payload (anything
 * can arrive there) and forwarding link clicks to main, which validates
 * the URL again before opening it.
 *
 * The panel never asks for keyboard focus: it has no inputs, so the game
 * keeps focus and every click. Escape, pinning and dragging come from the
 * panel host.
 */
import { computed, ref } from "vue";
import { isInspectReport } from "../../../shared/inspect.js";
import { getInspectApi } from "./inspectApi";
import InspectCard from "./InspectCard.vue";

const props = defineProps<{
  panelId: string;
  payload: unknown;
  visible: boolean;
}>();

defineEmits<{ close: [] }>();

const api = getInspectApi();

const report = computed(() => (isInspectReport(props.payload) ? props.payload : undefined));

/**
 * A refused or failed link used to vanish silently, so a button that did
 * nothing looked like a broken button. The reason lives in main's log; the
 * panel at least has to admit that the click went nowhere.
 */
const linkError = ref("");

async function onLink(url: string): Promise<void> {
  linkError.value = "";
  if (!api) return;
  try {
    const outcome = await api.invoke("inspect:open-link", url);
    if (!outcome?.ok) {
      linkError.value =
        outcome?.reason === "not-allowed"
          ? "That link is outside the allowed wiki hosts, so it was not opened."
          : "That link could not be opened — check your default browser.";
    }
  } catch {
    linkError.value = "That link could not be opened — check your default browser.";
  }
}
</script>

<template>
  <div class="inspect-panel">
    <InspectCard v-if="report" :report="report" compact @open-link="onLink" />
    <p v-else class="empty-copy">Nothing to inspect — hover an item, press Ctrl+C, then the Inspect hotkey.</p>
    <p v-if="linkError" class="inline-notice danger" role="alert">{{ linkError }}</p>
  </div>
</template>

<style scoped>
.inspect-panel {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  font-size: 0.82rem;
}
</style>
