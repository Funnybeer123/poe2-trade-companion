<template>
  <section>
    <h2>Scenario editor</h2>
    <div class="panel">
      <label for="scenario-id">Id</label>
      <input id="scenario-id" data-testid="scenario-id" v-model="draft.id" />
      <label for="scenario-title">Title</label>
      <input id="scenario-title" data-testid="scenario-title" v-model="draft.title" />
      <label for="scenario-mode">Execution mode</label>
      <select id="scenario-mode" data-testid="scenario-mode" v-model="draft.executionMode">
        <option value="dry-run">dry-run</option>
        <option value="live">live</option>
      </select>
      <label for="scenario-apm">Actions per minute</label>
      <input id="scenario-apm" data-testid="scenario-apm" type="number" v-model.number="draft.actionsPerMinute" />
      <div class="row">
        <button class="primary" data-testid="save-scenario" type="button" @click="save">Save scenario</button>
      </div>
      <p v-if="saved" class="muted" data-testid="scenario-saved">Saved {{ saved }}</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { reactive, ref } from "vue";
import type { AutomationScenarioDto } from "@poe2tc/core/operator";
import { operatorState } from "../operatorState.js";

const draft = reactive<AutomationScenarioDto>({
  id: "operator-draft",
  title: "Operator draft",
  enabled: true,
  executionMode: "dry-run",
  enabledModules: ["follow", "loot", "recovery"],
  actionsPerMinute: 20,
  confidenceThreshold: 0.6,
  lowConfidencePolicy: "skip",
  timingProfileId: "default",
  retryLimits: {},
  interruptRules: [],
  marketProviderId: "fixture",
});

const saved = ref("");

async function save(): Promise<void> {
  try {
    const result = await operatorState.api.saveScenario({ ...draft });
    saved.value = result.id;
  } catch (error) {
    operatorState.ipcError = {
      code: "ipc-failure",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
</script>
