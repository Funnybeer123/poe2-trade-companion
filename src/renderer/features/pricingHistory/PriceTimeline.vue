<script setup lang="ts">
/**
 * The selected item's timeline: a price line over quantity bars. Both axes
 * are poe2scout's daily readings — estimates, never guaranteed sale prices,
 * and the newest bar can still move until that day closes.
 */
import { computed, ref } from "vue";
import { barLabel, timelineGeometry, type PricingDisplayCurrency } from "@core/pricingHistory";
import type { TrendPoint } from "@core/priceTrends";

const props = withDefaults(
  defineProps<{
    points: TrendPoint[];
    rate: number;
    mode: PricingDisplayCurrency;
    name: string;
    width?: number;
    height?: number;
  }>(),
  { width: 640, height: 220 },
);

const hoverIndex = ref(-1);

const geometry = computed(() =>
  timelineGeometry(props.points, { width: props.width, height: props.height }, props.rate, props.mode),
);

const hovered = computed(() => geometry.value.bars[hoverIndex.value]);

const summary = computed(() => {
  const bars = geometry.value.bars;
  if (bars.length === 0) return `${props.name}: no price history yet`;
  return `${props.name}: ${bars.length} daily bars from ${barLabel(bars[0]!.time)} to ${barLabel(
    bars.at(-1)!.time,
  )}, ${bars[0]!.priceText} to ${bars.at(-1)!.priceText}`;
});
</script>

<template>
  <figure class="price-timeline">
    <svg
      :viewBox="`0 0 ${width} ${height}`"
      :width="width"
      :height="height"
      role="img"
      :aria-label="summary"
      class="timeline-svg"
      @mouseleave="hoverIndex = -1"
    >
      <title>{{ summary }}</title>
      <g class="price-ticks">
        <g v-for="tick in geometry.priceTicks" :key="`p-${tick.y}-${tick.label}`">
          <line :x1="46" :y1="tick.y" :x2="width - 16" :y2="tick.y" />
          <text :x="42" :y="tick.y + 3" text-anchor="end">{{ tick.label }}</text>
        </g>
      </g>
      <g class="quantity-bars">
        <rect
          v-for="(bar, index) in geometry.bars"
          :key="`q-${bar.time}`"
          :x="bar.x"
          :y="bar.y"
          :width="bar.width"
          :height="bar.height"
          :class="{ hovered: index === hoverIndex }"
          @mouseenter="hoverIndex = index"
        >
          <!-- Per-bar title: the only path to one day's numbers without a mouse. -->
          <title>{{ barLabel(bar.time) }} · {{ bar.priceText }} · {{ bar.quantity }} traded</title>
        </rect>
      </g>
      <path class="price-line" :d="geometry.pricePath" fill="none" stroke-width="1.8" />
      <g class="time-ticks">
        <text
          v-for="(tick, index) in geometry.ticks"
          :key="`t-${index}`"
          :x="tick.x"
          :y="height - 10"
          text-anchor="middle"
        >
          {{ tick.label }}
        </text>
      </g>
      <text v-if="hovered" class="hover-note" :x="46" :y="12">
        {{ barLabel(hovered.time) }} · {{ hovered.priceText }} · {{ hovered.quantity }} traded
      </text>
    </svg>
    <figcaption class="muted">
      Line: daily median price ({{ geometry.unit }}). Bars: units traded that day. Estimates from
      poe2scout — the newest bar can still change until the day closes.
    </figcaption>
  </figure>
</template>

<style scoped>
.price-timeline {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  overflow-x: auto;
}
.timeline-svg {
  max-width: 100%;
  font-size: 0.62rem;
  font-variant-numeric: tabular-nums;
}
.price-ticks line {
  stroke: rgba(140, 140, 160, 0.25);
  stroke-width: 1;
}
.price-ticks text,
.time-ticks text {
  fill: var(--text-muted);
}
.quantity-bars rect {
  fill: rgba(121, 175, 199, 0.35);
}
.quantity-bars rect.hovered {
  fill: rgba(121, 175, 199, 0.7);
}
.price-line {
  stroke: var(--gold-bright);
}
.hover-note {
  fill: var(--text);
}
</style>
