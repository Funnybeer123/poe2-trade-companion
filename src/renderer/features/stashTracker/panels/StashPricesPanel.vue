<script setup lang="ts">
/**
 * The `stash-prices` legend: which tab the label layer is drawing, how old
 * that scan is, and the controls to change it. The labels themselves live
 * in a separate click-through window owned by main — this panel is the only
 * clickable part, and it never takes keyboard focus from the game.
 */
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { describeAge } from "@core/inventoryLedger";
import { formatExalted } from "@core/stashTrackerTimeline";
import { getStashTrackerApi } from "../api";
import type { PriceOverlayStatus } from "../../../../shared/stashTracker.js";

const props = defineProps<{
  panelId: string;
  payload: unknown;
  visible: boolean;
}>();

defineEmits<{ close: [] }>();

const api = getStashTrackerApi();
const live = ref<PriceOverlayStatus | null>(null);
let unsubscribe: (() => void) | undefined;

/** Anything can arrive in `payload`; render a safe default instead of throwing. */
const status = computed<PriceOverlayStatus>(() => {
  const source = (live.value ??
    (typeof props.payload === "object" && props.payload !== null
      ? (props.payload as Partial<PriceOverlayStatus>)
      : {})) as Partial<PriceOverlayStatus>;
  return {
    visible: source.visible === true,
    legendVisible: source.legendVisible === true,
    ...(typeof source.tab === "string" ? { tab: source.tab } : {}),
    topLevel: source.topLevel === true,
    tabs: Array.isArray(source.tabs) ? source.tabs.filter((entry) => typeof entry === "string") : [],
    ...(typeof source.lastScanAt === "string" ? { lastScanAt: source.lastScanAt } : {}),
    ...(typeof source.ageMs === "number" ? { ageMs: source.ageMs } : {}),
    ...(typeof source.totalExalted === "number" ? { totalExalted: source.totalExalted } : {}),
    priced: typeof source.priced === "number" ? source.priced : 0,
    unpriced: typeof source.unpriced === "number" ? source.unpriced : 0,
    items: typeof source.items === "number" ? source.items : 0,
    ...(typeof source.geometrySource === "string"
      ? { geometrySource: source.geometrySource }
      : {}),
    ...(typeof source.error === "string" ? { error: source.error } : {}),
    poeRunning: source.poeRunning === true,
  };
});

const age = computed(() =>
  status.value.ageMs === undefined ? "age unknown" : describeAge(status.value.ageMs),
);

function cycle(direction: 1 | -1): void {
  void api?.invoke("stash-tracker:overlay-next", direction);
}

function toggleTopLevel(): void {
  const tab = status.value.tab;
  if (!tab) return;
  void api?.invoke("stash-tracker:overlay-top-level", tab, !status.value.topLevel);
}

function refresh(): void {
  void api?.invoke("stash-tracker:overlay-show", status.value.tab);
}

function stopListening(): void {
  unsubscribe?.();
  unsubscribe = undefined;
}

// Follow the status only while the panel is actually on screen; the host may
// keep a hidden panel mounted, and a hidden legend has nothing to re-render.
watch(
  () => props.visible,
  (visible) => {
    if (!visible) {
      stopListening();
      return;
    }
    if (unsubscribe) return;
    unsubscribe = api?.on("stash-tracker:overlay", (next) => {
      live.value = next;
    });
  },
  { immediate: true },
);

onBeforeUnmount(stopListening);
</script>

<template>
  <div class="stash-prices">
    <div class="head">
      <strong>{{ status.tab || "No tab" }}</strong>
      <small class="muted">{{ age }}</small>
    </div>
    <p class="totals">
      {{ formatExalted(status.totalExalted) }} ex · {{ status.priced }} priced ·
      {{ status.unpriced }} unpriced
    </p>
    <p v-if="status.error" class="overlay-error" role="alert">{{ status.error }}</p>
    <div class="button-row compact">
      <button
        type="button"
        class="icon-button"
        aria-label="Previous tab"
        title="Previous tab"
        @click="cycle(-1)"
      >
        ◀
      </button>
      <button
        type="button"
        class="icon-button"
        aria-label="Next tab"
        title="Next tab"
        @click="cycle(1)"
      >
        ▶
      </button>
      <button
        type="button"
        class="icon-button"
        :aria-pressed="status.topLevel"
        aria-label="Top-level tab"
        title="Top-level tab: shift the grid one strip row up"
        @click="toggleTopLevel"
      >
        ▲
      </button>
      <button
        type="button"
        class="icon-button"
        aria-label="Refresh"
        title="Re-read the game window and redraw"
        @click="refresh"
      >
        ↻
      </button>
    </div>
    <small class="muted">Estimates from your price table — not guaranteed prices.</small>
  </div>
</template>

<style scoped>
.stash-prices {
  display: grid;
  gap: 0.35rem;
  font-size: 0.8rem;
}
.head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 0.5rem;
}
.totals {
  margin: 0;
  color: var(--text-soft, #b9b4aa);
  font-variant-numeric: tabular-nums;
}
.overlay-error {
  margin: 0;
  color: var(--red, #d57b76);
}
.button-row.compact {
  display: flex;
  gap: 0.3rem;
}
</style>
