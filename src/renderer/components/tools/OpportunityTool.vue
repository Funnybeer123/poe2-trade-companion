<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { analyzeMarketOpportunity } from "@core/marketOpportunity";
import { useIntelligenceStore } from "../../composables/useIntelligenceStore";
import { formatAmount, formatDate } from "../../utils/intelligence";

const store = useIntelligenceStore();
const acquisitionPrice = ref(0);
const feeRatePercent = ref(0);

const opportunity = computed(() => {
  const valuation = store.currentEvaluation.value?.valuation;
  if (
    !valuation ||
    !Number.isFinite(acquisitionPrice.value) ||
    acquisitionPrice.value <= 0
  ) {
    return null;
  }
  return analyzeMarketOpportunity({
    valuation,
    acquisitionPrice: acquisitionPrice.value,
    feeRatePercent: Math.max(0, Number(feeRatePercent.value) || 0),
  });
});

watch(store.currentEvaluation, () => {
  acquisitionPrice.value = 0;
});
</script>

<template>
  <section class="card tool-panel opportunity-tool" aria-labelledby="opportunity-title">
    <div class="section-heading">
      <div>
        <span class="eyebrow">Manual decision support</span>
        <h2 id="opportunity-title">Underpriced listing analysis</h2>
      </div>
      <span class="status-chip neutral">No automatic buying</span>
    </div>
    <p class="muted">
      Compare a seller’s asking price with the current item’s suggested resale estimate.
      This calculator never buys, whispers, or lists an item.
    </p>

    <div v-if="!store.currentEvaluation.value" class="state-panel compact-state">
      <span class="state-icon" aria-hidden="true">◇</span>
      <strong>Evaluate an item first</strong>
      <p>A valuation is required before a listing can be compared.</p>
      <RouterLink class="button secondary" to="/items">Open Items</RouterLink>
    </div>
    <template v-else>
      <div class="current-item-strip">
        <span
          class="rarity-line"
          :class="`rarity-${store.currentEvaluation.value.item.rarity.toLowerCase()}`"
        />
        <span>
          <strong>{{ store.currentEvaluation.value.item.name }}</strong>
          <small>
            Estimated {{ formatAmount(store.currentEvaluation.value.valuation.low) }}–
            {{ formatAmount(store.currentEvaluation.value.valuation.high) }}
            {{ store.currentEvaluation.value.valuation.currency }}
          </small>
        </span>
      </div>
      <div class="form-grid">
        <label>
          Seller asking price ({{ store.currentEvaluation.value.valuation.currency }})
          <input v-model.number="acquisitionPrice" type="number" min="0" step="0.01" />
        </label>
        <label>
          Estimated fees / slippage (%)
          <input v-model.number="feeRatePercent" type="number" min="0" step="0.1" />
        </label>
      </div>

      <div v-if="opportunity" class="opportunity-result-card" :class="opportunity.verdict">
        <div class="section-heading">
          <div>
            <span class="eyebrow">Signal</span>
            <h3>{{ opportunity.verdict.replace("-", " ") }}</h3>
          </div>
          <strong class="profit-value">
            {{ opportunity.estimatedProfit >= 0 ? "+" : "" }}{{ formatAmount(opportunity.estimatedProfit) }}
            {{ opportunity.currency }}
          </strong>
        </div>
        <dl class="metric-grid">
          <div><dt>Estimated return</dt><dd>{{ opportunity.returnPercent }}%</dd></div>
          <div><dt>Resale estimate</dt><dd>{{ formatAmount(opportunity.resaleEstimate) }}</dd></div>
          <div><dt>Total cost</dt><dd>{{ formatAmount(opportunity.totalCost) }}</dd></div>
          <div><dt>Usable sample</dt><dd>{{ opportunity.sampleSize }} / {{ opportunity.candidateCount }}</dd></div>
        </dl>
        <ul v-if="opportunity.warnings.length" class="notice-list warning">
          <li v-for="warning in opportunity.warnings" :key="warning">{{ warning }}</li>
        </ul>
        <p class="disclaimer">
          Confidence {{ opportunity.confidence }} · market data
          {{ formatDate(opportunity.marketTimestamp) }}. Resale value is estimated, never guaranteed.
        </p>
      </div>
      <p v-else class="empty-copy">Enter a positive asking price to calculate the signal.</p>
    </template>
  </section>
</template>
