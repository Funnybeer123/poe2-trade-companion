<template>
  <section>
    <h2>Price check</h2>
    <p class="muted">
      User-invoked clipboard parse only. This hotkey does not generate additional game actions.
    </p>
    <div class="panel">
      <label for="item-text">Item text</label>
      <textarea id="item-text" data-testid="price-check-input" rows="10" v-model="rawText" />
      <div class="row">
        <button class="primary" data-testid="price-check-parse" type="button" @click="parse">Parse clipboard</button>
      </div>
    </div>
    <p v-if="operatorState.priceCheck && !operatorState.priceCheck.ok" class="muted">
      {{ operatorState.priceCheck.error }}
    </p>
    <PriceEstimateCard :estimate="operatorState.priceCheck?.estimate" />
    <pre v-if="operatorState.priceCheck?.item" class="panel">{{ JSON.stringify(operatorState.priceCheck.item, null, 2) }}</pre>
  </section>
</template>

<script setup lang="ts">
import { ref } from "vue";
import PriceEstimateCard from "../components/PriceEstimateCard.vue";
import { operatorState, refreshCatalog } from "../operatorState.js";

const rawText = ref("");

async function parse(): Promise<void> {
  try {
    operatorState.priceCheck = await operatorState.api.parseClipboard(rawText.value);
    await refreshCatalog();
  } catch (error) {
    operatorState.ipcError = {
      code: "ipc-failure",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
</script>
