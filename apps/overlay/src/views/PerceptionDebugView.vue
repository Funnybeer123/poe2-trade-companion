<template>
  <section>
    <h2>Perception debug</h2>
    <button type="button" data-testid="refresh-world" @click="refreshWorld">Refresh world</button>
    <div v-if="world" class="panel" data-testid="perception-debug">
      <p>Tick {{ world.tickId }} · state {{ world.selectedState }} · scenario {{ world.activeScenarioId || "—" }}</p>
      <p>Process: {{ world.process.value.name ?? "—" }} ({{ world.process.freshness }}, {{ world.process.confidence }})</p>
      <p>Target: {{ world.target.value?.identity ?? "none" }} ({{ world.target.freshness }})</p>
      <p>Loot: {{ world.loot.value.length }} visible</p>
      <p>Inventory: {{ world.inventory.value.occupied }}/{{ world.inventory.value.capacity }} full={{ world.inventory.value.full }}</p>
      <p>UI: {{ world.ui.value.kind }}</p>
      <p>Stuck: {{ world.stuck.value.isStuck ? world.stuck.value.reason ?? "yes" : "no" }}</p>
    </div>
    <pre class="panel">{{ JSON.stringify(world, null, 2) }}</pre>
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { operatorState, refreshWorld } from "../operatorState.js";

const world = computed(() => operatorState.world);
</script>
