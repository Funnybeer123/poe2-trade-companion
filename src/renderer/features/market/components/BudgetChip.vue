<script setup lang="ts">
/**
 * The trade2 request budget, as a chip. Market gates every search, page and
 * exchange on it (compliance R2), so the number the user can see is the
 * number the buttons obey.
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { MarketBudgetView } from "../../../../shared/market.js";

const props = defineProps<{ budget: MarketBudgetView }>();

const clock = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;

onMounted(() => {
  timer = setInterval(() => {
    clock.value = Date.now();
  }, 1000);
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});

const penaltySeconds = computed(() => {
  if (!props.budget.restrictedUntilIso) return 0;
  const until = Date.parse(props.budget.restrictedUntilIso);
  if (!Number.isFinite(until)) return 0;
  return Math.max(0, Math.ceil((until - clock.value) / 1000));
});

const tone = computed(() => {
  if (penaltySeconds.value > 0) return "danger";
  if (props.budget.searchesSpare < 1 || props.budget.fetchesSpare < 1) return "warning";
  return "safe";
});

const label = computed(() => {
  if (penaltySeconds.value > 0) return `trade2 paused · ${penaltySeconds.value}s`;
  return `${props.budget.searchesSpare} search / ${props.budget.fetchesSpare} fetch spare`;
});
</script>

<template>
  <span
    class="status-chip"
    :class="tone"
    role="status"
    title="trade2 request budget shared with Evaluate, Deals and the shop CLI. One Market search spends one search plus one fetch."
    >{{ label }}</span
  >
</template>
