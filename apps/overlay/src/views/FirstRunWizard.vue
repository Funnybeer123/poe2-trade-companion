<template>
  <div class="first-run" data-testid="first-run-wizard">
    <section class="panel">
      <h2>First-run setup</h2>
      <p data-testid="first-run-disclaimer">{{ disclaimer }}</p>
      <fieldset>
        <legend>Operating mode</legend>
        <label class="row">
          <input
            data-testid="first-run-mode-public"
            type="radio"
            name="first-run-mode"
            value="public-companion"
            v-model="selectedMode"
          />
          Public companion
        </label>
        <label class="row">
          <input
            data-testid="first-run-mode-qa"
            type="radio"
            name="first-run-mode"
            value="authorized-qa"
            :disabled="!qaBuildEnabled"
            v-model="selectedMode"
          />
          Authorized QA
        </label>
        <p v-if="!qaBuildEnabled" class="muted" data-testid="first-run-qa-disabled">
          This public build cannot enable authorized-qa. A compile-time QA flag is required.
        </p>
      </fieldset>
      <template v-if="selectedMode === 'authorized-qa'">
        <label for="qa-phrase">Type AUTHORIZED QA to confirm</label>
        <input
          id="qa-phrase"
          data-testid="first-run-qa-phrase"
          v-model="confirmationText"
          autocomplete="off"
        />
        <label class="row">
          <input data-testid="first-run-qa-ack" type="checkbox" v-model="acknowledged" />
          I acknowledge this is authorized QA automation, not a public-player utility.
        </label>
      </template>
      <div class="row">
        <button class="primary" data-testid="first-run-continue" type="button" @click="submit">
          Continue
        </button>
      </div>
      <p v-if="error" class="muted" data-testid="first-run-error">{{ error }}</p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { GGG_DISCLAIMER, QA_FIRST_RUN_PHRASE, type RuntimeMode } from "@poe2tc/core/operator";
import { operatorState } from "../operatorState.js";

const disclaimer = GGG_DISCLAIMER;
const selectedMode = ref<RuntimeMode>("public-companion");
const confirmationText = ref("");
const acknowledged = ref(false);
const error = ref("");

const qaBuildEnabled = computed(
  () =>
    operatorState.buildFlags.qaBuildEnabled ||
    import.meta.env.POE2TC_MODE === "authorized-qa",
);

async function submit(): Promise<void> {
  error.value = "";
  if (selectedMode.value === "authorized-qa") {
    if (!qaBuildEnabled.value) {
      error.value = "Public compile-time build cannot select authorized-qa.";
      return;
    }
    if (confirmationText.value.trim() !== QA_FIRST_RUN_PHRASE) {
      error.value = `Type ${QA_FIRST_RUN_PHRASE} exactly.`;
      return;
    }
    if (!acknowledged.value) {
      error.value = "Acknowledgement is required for authorized QA.";
      return;
    }
  }
  try {
    const result = await operatorState.api.completeFirstRun({
      selectedMode: selectedMode.value,
      confirmationText: confirmationText.value,
      acknowledged: acknowledged.value,
    });
    if (!result.ok) {
      error.value = result.reasons.join(", ");
      return;
    }
    operatorState.settings = result.settings;
  } catch (caught) {
    operatorState.ipcError = {
      code: "ipc-failure",
      message: caught instanceof Error ? caught.message : String(caught),
    };
  }
}
</script>
