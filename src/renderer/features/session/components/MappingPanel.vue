<script setup lang="ts">
import { computed, ref } from "vue";
import type { RunKind } from "@core/sessionTracker";
import type { HomeOverview } from "../../../../shared/session";
import { formatDuration, rate } from "../format";
import RecentMapsTable from "./RecentMapsTable.vue";

const props = defineProps<{ home: HomeOverview }>();

const KINDS: Array<{ id: RunKind | "all"; label: string }> = [
  { id: "all", label: "All" },
  { id: "map", label: "Maps" },
  { id: "trial", label: "Trials" },
  { id: "league", label: "League" },
];
const filter = ref<RunKind | "all">("all");
const metrics = computed(() => props.home.session.metrics);
const runs = computed(() =>
  filter.value === "all"
    ? props.home.recentMaps
    : props.home.recentMaps.filter((run) => run.kind === filter.value),
);
</script>

<template>
  <section class="card tool-panel mapping-panel" aria-labelledby="mapping-title">
    <div class="section-heading">
      <div>
        <span class="eyebrow">Mapping</span>
        <h2 id="mapping-title">Maps this session</h2>
      </div>
      <span class="status-chip neutral">Completion by hideout return</span>
    </div>

    <dl class="metric-grid">
      <div>
        <dt>Started</dt>
        <dd>{{ metrics?.mapsStarted ?? 0 }}</dd>
      </div>
      <div>
        <dt>Completed</dt>
        <dd>{{ metrics?.mapsCompleted ?? 0 }}</dd>
      </div>
      <div>
        <dt>Abandoned</dt>
        <dd>{{ metrics?.mapsAbandoned ?? 0 }}</dd>
      </div>
      <div>
        <dt>Maps per hour</dt>
        <dd>{{ rate(metrics?.mapsPerHour) }}</dd>
      </div>
      <div>
        <dt>Average map</dt>
        <dd>{{ formatDuration(metrics?.avgMapMs) }}</dd>
      </div>
      <div>
        <dt>Median map</dt>
        <dd>{{ formatDuration(metrics?.medianMapMs) }}</dd>
      </div>
      <div>
        <dt>Deaths per map</dt>
        <dd>{{ metrics?.deathsPerMap ?? "—" }}</dd>
      </div>
      <div>
        <dt>Trials completed</dt>
        <dd>{{ metrics?.trialsCompleted ?? 0 }}</dd>
      </div>
    </dl>

    <dl class="property-list">
      <div>
        <dt>Experience per map</dt>
        <dd><span class="status-chip neutral">Needs account link (not available)</span></dd>
      </div>
      <div>
        <dt>Gold per map</dt>
        <dd><span class="status-chip neutral">Needs account link (not available)</span></dd>
      </div>
    </dl>

    <div class="kind-filter" role="radiogroup" aria-label="Run kind">
      <button
        v-for="kind in KINDS"
        :key="kind.id"
        type="button"
        class="pill"
        :class="{ selected: filter === kind.id }"
        :aria-pressed="filter === kind.id"
        @click="filter = kind.id"
      >
        {{ kind.label }}
      </button>
    </div>

    <RecentMapsTable :runs="runs" heading="Runs" />

    <p class="disclaimer">
      Map tier is the area level minus 64; levels 81 and 82 (irradiated and corrupted) are shown as
      T16+. Maps per hour excludes AFK time.
    </p>
  </section>
</template>

<style scoped>
.mapping-panel { display: flex; flex-direction: column; gap: 0.8rem; }
.metric-grid { margin: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: 0.6rem; }
.metric-grid dt { font-size: 0.72rem; text-transform: uppercase; opacity: 0.7; }
.metric-grid dd { margin: 0; font-variant-numeric: tabular-nums; font-weight: 600; }
.property-list { margin: 0; display: grid; gap: 0.35rem; }
.property-list div { display: grid; grid-template-columns: minmax(0, 11rem) minmax(0, 1fr); gap: 0.6rem; }
.property-list dt { font-size: 0.78rem; opacity: 0.75; }
.property-list dd { margin: 0; }
.kind-filter { display: flex; gap: 0.4rem; flex-wrap: wrap; }
.kind-filter .selected { outline: 1px solid var(--gold-bright, #e4c587); }
</style>
