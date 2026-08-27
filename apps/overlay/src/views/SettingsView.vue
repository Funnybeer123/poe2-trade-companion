<template>
  <section>
    <h2>Settings</h2>
    <div class="panel">
      <label for="setting-league">League</label>
      <input id="setting-league" data-testid="setting-league" v-model="draft.league" />
      <label class="row">
        <input data-testid="setting-redact" type="checkbox" v-model="draft.redactIdentifiers" />
        Redact identifiers
      </label>
      <label class="row">
        <input data-testid="setting-qa-ack" type="checkbox" v-model="draft.qaAcknowledged" />
        QA acknowledged
      </label>
      <label for="setting-hotkey">Price-check hotkey</label>
      <input id="setting-hotkey" data-testid="setting-hotkey" v-model="draft.priceCheckHotkey" />
      <div class="row">
        <button class="primary" data-testid="save-settings" type="button" @click="save">Save settings</button>
      </div>
      <p v-if="saved" class="muted" data-testid="settings-saved">Settings saved</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import type { OperatorSettingsDto } from "@poe2tc/core/operator";
import { operatorState, refreshSettings } from "../operatorState.js";

const draft = reactive<OperatorSettingsDto>({ ...operatorState.settings });
const saved = ref(false);

onMounted(async () => {
  await refreshSettings();
  Object.assign(draft, operatorState.settings);
});

async function save(): Promise<void> {
  try {
    operatorState.settings = await operatorState.api.saveSettings({ ...draft });
    saved.value = true;
  } catch (error) {
    operatorState.ipcError = {
      code: "ipc-failure",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
</script>
