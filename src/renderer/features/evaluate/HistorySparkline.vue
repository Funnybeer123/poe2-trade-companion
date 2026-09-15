<script setup lang="ts">
/**
 * Seven daily bars from the market-trends cache — a file read, never a
 * poe2scout fetch of its own. The link hands the user to Market trends,
 * which owns refreshing that data.
 */
import { computed } from "vue";
import { formatPercent } from "@core/priceTrends";
import type { EvaluateHistory } from "../../../shared/evaluate.js";
import { formatAmount, formatDate } from "../../utils/intelligence";

const props = defineProps<{ history: EvaluateHistory }>();
defineEmits<{ open: [] }>();

const WIDTH = 120;
const HEIGHT = 28;

const points = computed(() => props.history.points);

const path = computed(() => {
  const values = points.value.map((point) => point.price);
  if (values.length === 0) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = values.length > 1 ? WIDTH / (values.length - 1) : WIDTH;
  return values
    .map((value, index) => {
      const x = Math.round(index * step);
      const y = Math.round(HEIGHT - ((value - min) / span) * (HEIGHT - 4) - 2);
      return `${x},${y}`;
    })
    .join(" ");
});

const label = computed(() => {
  const first = points.value[0]?.price;
  const last = points.value[points.value.length - 1]?.price;
  if (first === undefined || last === undefined) return "No price history";
  return `7-day price history: ${formatAmount(first)} to ${formatAmount(last)} exalted`;
});
</script>

<template>
  <section class="history card" aria-labelledby="evaluate-history-title">
    <div class="section-heading">
      <h3 id="evaluate-history-title">Price history</h3>
      <button type="button" class="text-link" @click="$emit('open')">Open in Market trends</button>
    </div>
    <div class="history-row">
      <svg class="sparkline" :viewBox="`0 0 ${WIDTH} ${HEIGHT}`" role="img" :aria-label="label">
        <polyline :points="path" fill="none" stroke="currentColor" stroke-width="1.5" />
      </svg>
      <p class="muted">
        <span v-if="history.current !== undefined">{{ formatAmount(history.current) }} ex now</span>
        <span v-if="history.change3d !== undefined"> · 3d {{ formatPercent(history.change3d) }}</span>
        <span v-if="history.change7d !== undefined"> · 7d {{ formatPercent(history.change7d) }}</span>
        <span> · volume {{ history.volume7d }}</span>
      </p>
    </div>
    <p class="muted">
      As of {{ formatDate(history.fetchedAt) }}
      <span v-if="history.stale"> · cache is older than the refresh interval — treat it as indicative</span>
    </p>
  </section>
</template>

<style scoped>
.history {
  display: grid;
  gap: 0.3rem;
  padding: 0.7rem 0.8rem;
}
.history-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}
.sparkline {
  width: 120px;
  height: 28px;
  color: var(--gold, #c8a66a);
}
.muted {
  margin: 0;
  font-variant-numeric: tabular-nums;
}
</style>
