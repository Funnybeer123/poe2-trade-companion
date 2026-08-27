<template>
  <QaBanner />
  <div class="shell" data-testid="overlay-root">
    <nav class="nav">
      <h1 data-testid="app-title">PoE2 QA Trade Companion</h1>
      <RouterLink to="/price-check">Price check</RouterLink>
      <RouterLink to="/catalog">Catalog</RouterLink>
      <RouterLink to="/automation">Automation</RouterLink>
      <RouterLink to="/perception">Perception</RouterLink>
      <RouterLink to="/replay">Trace replay</RouterLink>
      <RouterLink to="/scenarios">Scenarios</RouterLink>
      <RouterLink to="/filters">Filter builder</RouterLink>
      <RouterLink to="/settings">Settings</RouterLink>
      <RouterLink to="/disclaimer">Disclaimer</RouterLink>
    </nav>
    <main class="content">
      <ErrorPanel />
      <RouterView />
    </main>
  </div>
  <DisclaimerBar />
</template>

<script setup lang="ts">
import { onMounted } from "vue";
import DisclaimerBar from "./components/DisclaimerBar.vue";
import ErrorPanel from "./components/ErrorPanel.vue";
import QaBanner from "./components/QaBanner.vue";
import { bootstrapOperator } from "./operatorState.js";

onMounted(() => {
  void bootstrapOperator();
});
</script>
