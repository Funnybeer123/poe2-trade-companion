<template>
  <section v-if="estimate" class="panel" data-testid="price-estimate">
    <p class="estimate-label" data-testid="price-estimate-label">{{ estimate.label }}</p>
    <p data-testid="price-estimate-summary">{{ estimate.summary }}</p>
    <dl class="grid-2">
      <div>
        <dt>Provider</dt>
        <dd>{{ estimate.providerId }}</dd>
      </div>
      <div>
        <dt>Quoted at</dt>
        <dd>{{ new Date(estimate.quotedAtMs).toISOString() }}</dd>
      </div>
      <div>
        <dt>Low / fair / high</dt>
        <dd>{{ estimate.low ?? "—" }} / {{ estimate.fair ?? "—" }} / {{ estimate.high ?? "—" }} {{ estimate.currency }}</dd>
      </div>
      <div>
        <dt>Recommended listing</dt>
        <dd>{{ estimate.recommendedListing ?? "—" }} {{ estimate.currency }}</dd>
      </div>
      <div>
        <dt>Confidence</dt>
        <dd>{{ estimate.confidence }} ({{ estimate.comparableCount }} comparables / {{ estimate.candidateCount }} candidates)</dd>
      </div>
      <div>
        <dt>Guaranteed sale?</dt>
        <dd data-testid="price-not-guaranteed">No — estimate only</dd>
      </div>
    </dl>
    <p v-if="estimate.lowConfidenceReason" class="muted">{{ estimate.lowConfidenceReason }}</p>
  </section>
</template>

<script setup lang="ts">
import type { PriceEstimateDisplay } from "@poe2tc/core/operator";

defineProps<{ estimate?: PriceEstimateDisplay }>();
</script>
