<template>
  <section>
    <h2>Loot filter builder</h2>
    <p class="muted">
      Local generation and export only. Official OAuth filter sync is
      <strong>BLOCKED: oauth-registration</strong> until GGG accepts applications or supplies a test
      client.
    </p>
    <div class="panel">
      <label for="filter-name">Profile name</label>
      <input id="filter-name" data-testid="filter-name" v-model="profile.name" />
      <button class="primary" data-testid="export-filter" type="button" @click="exportLocal">Export filter</button>
    </div>
    <pre v-if="exported" class="panel" data-testid="filter-export">{{ exported }}</pre>
  </section>
</template>

<script setup lang="ts">
import { reactive, ref } from "vue";
import { DEFAULT_FILTER_PROFILE, type FilterProfileDto } from "@poe2tc/core/operator";
import { operatorState } from "../operatorState.js";

const profile = reactive<FilterProfileDto>({
  ...DEFAULT_FILTER_PROFILE,
  rules: [...DEFAULT_FILTER_PROFILE.rules],
});
const exported = ref("");

async function exportLocal(): Promise<void> {
  try {
    const result = await operatorState.api.exportFilter({ ...profile, rules: [...profile.rules] });
    exported.value = result.body;
  } catch (error) {
    operatorState.ipcError = {
      code: "ipc-failure",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
</script>
