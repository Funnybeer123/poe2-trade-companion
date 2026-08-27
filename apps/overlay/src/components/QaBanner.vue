<template>
  <div
    v-if="required"
    class="qa-banner"
    data-testid="qa-banner"
    role="status"
    aria-live="polite"
  >
    <strong data-testid="qa-banner-label">AUTHORIZED QA AUTOMATION</strong>
    <span class="muted">Persistent banner — cannot be dismissed</span>
    <button class="danger" data-testid="qa-stop" type="button" @click="stop">STOP</button>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { isQaBannerRequired } from "@poe2tc/core/operator";
import { operatorState } from "../operatorState.js";

const props = defineProps<{
  trip?: () => Promise<void> | void;
}>();

const required = computed(() => isQaBannerRequired(operatorState.capabilities));

async function stop(): Promise<void> {
  if (props.trip !== undefined) {
    await props.trip();
    return;
  }
  try {
    const result = await operatorState.api.tripStop();
    operatorState.arming = result.arming;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    operatorState.ipcError = { code: "ipc-failure", message };
  }
}
</script>
