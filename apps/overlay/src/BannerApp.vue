<template>
  <QaBanner :trip="trip" />
  <p v-if="error" class="error-panel" data-testid="ipc-error">{{ error }}</p>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import QaBanner from "./components/QaBanner.vue";
import { operatorState } from "./operatorState.js";

const error = ref<string | undefined>();

onMounted(async () => {
  try {
    const api = window.poe2tcBanner;
    if (api === undefined) {
      return;
    }
    operatorState.capabilities = await api.getCapabilities();
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  }
});

async function trip(): Promise<void> {
  try {
    const api = window.poe2tcBanner ?? operatorState.api;
    const result = await api.tripStop();
    operatorState.arming = result.arming;
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  }
}
</script>
