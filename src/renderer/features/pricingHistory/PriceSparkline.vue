<script setup lang="ts">
/**
 * Seven-ish days of daily prices as one inline polyline. Geometry comes from
 * the pure core helper so it is unit-tested without a DOM.
 */
import { computed } from "vue";
import { formatPriceNumber, sparklinePath } from "@core/pricingHistory";

const props = withDefaults(
  defineProps<{
    values: number[];
    width?: number;
    height?: number;
    tone?: "rising" | "falling" | "stable";
  }>(),
  { width: 96, height: 24, tone: "stable" },
);

const geometry = computed(() => sparklinePath(props.values, props.width, props.height));

const label = computed(() => {
  if (props.values.length === 0) return "No price history";
  const first = props.values[0]!;
  const last = props.values.at(-1)!;
  return `${props.values.length} daily bars, ${formatPriceNumber(first, 2)} to ${formatPriceNumber(last, 2)} exalted`;
});
</script>

<template>
  <svg
    v-if="geometry.path"
    class="sparkline"
    :class="tone"
    :width="width"
    :height="height"
    :viewBox="`0 0 ${width} ${height}`"
    role="img"
    :aria-label="label"
  >
    <path :d="geometry.path" fill="none" stroke="currentColor" stroke-width="1.4" />
    <circle v-if="geometry.last" :cx="geometry.last.x" :cy="geometry.last.y" r="1.8" fill="currentColor" />
  </svg>
  <span v-else class="muted sparkline-empty">—</span>
</template>

<style scoped>
.sparkline {
  display: block;
  color: var(--text-muted);
  overflow: visible;
}
.sparkline.rising {
  color: #3aa76d;
}
.sparkline.falling {
  color: #d9534f;
}
.sparkline-empty {
  font-variant-numeric: tabular-nums;
}
</style>
