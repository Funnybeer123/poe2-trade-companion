<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { RouterLink } from "vue-router";
import type { CombatStatus } from "../../core/combatAssist.js";
const state = ref<CombatStatus>();
let timer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
async function refresh() {
  try { state.value = await window.poe2?.combat?.status(); } catch { /* Panel displays connection errors. */ }
  if (!disposed) timer = setTimeout(() => void refresh(), 1000);
}
onMounted(() => { if (window.poe2?.combat) void refresh(); });
onUnmounted(() => { disposed = true; clearTimeout(timer); });
async function stop() { state.value = await window.poe2?.combat?.stop(); }
</script>
<template>
  <div v-if="state?.running" class="combat-indicator">
    <RouterLink to="/tools/combat">{{ state.config.dryRun ? 'Combat preview' : 'Combat running' }} · F8</RouterLink>
    <button class="button compact danger" @click="stop">Stop combat</button>
  </div>
</template>
<style scoped>
.combat-indicator { display: flex; align-items: center; gap: 8px; font-size: 12px; }
</style>
