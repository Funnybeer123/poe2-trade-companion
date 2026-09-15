<script setup lang="ts">
/**
 * The estimated band: low · fair · high with the confidence bucket, how many
 * listings were comparable, which provider produced the number, and the same
 * disclaimer sentence the Item log prints. Never a guaranteed price.
 */
import { computed } from "vue";
import { VALUATION_PROVIDER_LABELS, type LocalValuationProvider } from "@core/localValuation";
import { EVALUATE_DISCLAIMER, type EvaluateEstimate } from "../../../shared/evaluate.js";
import { formatAmount } from "../../utils/intelligence";

const props = defineProps<{ estimate: EvaluateEstimate }>();

const valuation = computed(() => props.estimate.valuation);

const providerLabel = computed(() => {
  const provider = valuation.value.providerName as LocalValuationProvider;
  return VALUATION_PROVIDER_LABELS[provider] ?? valuation.value.providerName;
});

const fairPercent = computed(() => {
  const { low, high, fair } = valuation.value;
  if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) return 50;
  return Math.min(100, Math.max(0, ((fair - low) / (high - low)) * 100));
});

const basisLabel = computed(() => {
  switch (props.estimate.basis) {
    case "stat-filtered":
      return "matched on the ticked mods";
    case "unique-name":
      return "matched by unique name";
    default:
      return "matched by base type";
  }
});
</script>

<template>
  <section class="estimate-band card" aria-labelledby="evaluate-estimate-title">
    <div class="section-heading">
      <h3 id="evaluate-estimate-title">Estimated price</h3>
      <span class="confidence-badge" :class="estimate.confidence">{{ estimate.confidence }} confidence</span>
    </div>
    <p class="currency-line">
      <strong>{{ formatAmount(valuation.low) }}</strong>
      –
      <strong>{{ formatAmount(valuation.high) }}</strong>
      {{ valuation.currency }}
      <span class="muted">· fair {{ formatAmount(valuation.fair) }}</span>
    </p>
    <div class="range-track" aria-hidden="true">
      <span class="fair" :style="{ left: `${fairPercent}%` }"></span>
    </div>
    <p v-if="valuation.providerName === 'price-training'" class="muted">
      {{ valuation.normalizedKeyStats.trainedExampleCount }} saved price examples · {{ providerLabel }}
    </p>
    <p v-else class="muted">
      {{ estimate.sampleSize }} of {{ estimate.candidateCount }} listing{{
        estimate.candidateCount === 1 ? "" : "s"
      }}
      comparable · {{ basisLabel }} ·
      <span class="pill" :class="valuation.providerName === 'none' ? 'warning' : 'safe'">{{ providerLabel }}</span>
    </p>
    <p v-if="estimate.caution" class="inline-notice warning" role="note">{{ estimate.caution }}</p>
    <p v-if="valuation.lowConfidenceReason" class="inline-notice warning" role="note">
      {{ valuation.lowConfidenceReason }}
    </p>
    <p class="disclaimer">{{ EVALUATE_DISCLAIMER }}</p>
  </section>
</template>

<style scoped>
.estimate-band {
  display: grid;
  gap: 0.35rem;
  padding: 0.7rem 0.8rem;
}
.currency-line {
  margin: 0;
  font-size: 0.95rem;
  font-variant-numeric: tabular-nums;
}
.range-track {
  position: relative;
  height: 6px;
  border-radius: 3px;
  background: rgba(140, 140, 160, 0.22);
}
.range-track .fair {
  position: absolute;
  top: -2px;
  width: 2px;
  height: 10px;
  background: var(--gold-bright, #e4c587);
}
.muted {
  margin: 0;
}
</style>
