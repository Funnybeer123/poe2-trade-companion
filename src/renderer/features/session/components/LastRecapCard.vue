<script setup lang="ts">
import type { SessionRecapPayload } from "../../../../shared/session";
import { formatDuration, rate, when } from "../format";

defineProps<{ recap: SessionRecapPayload }>();
</script>

<template>
  <section class="card last-recap" aria-labelledby="home-recap-title">
    <div class="section-heading">
      <div>
        <span class="eyebrow">Last session</span>
        <h2 id="home-recap-title">Post-game recap</h2>
      </div>
      <span class="status-chip neutral">{{ when(recap.at) }}</span>
    </div>

    <p class="muted">
      {{ recap.summary.character?.name ?? "Unknown character" }} ·
      {{ formatDuration(recap.metrics.wallMs) }} wall, {{ formatDuration(recap.metrics.activeMs) }} active
    </p>
    <dl class="metric-grid">
      <div>
        <dt>Maps</dt>
        <dd>{{ recap.metrics.mapsCompleted }}</dd>
      </div>
      <div>
        <dt>Maps per hour</dt>
        <dd>{{ rate(recap.metrics.mapsPerHour) }}</dd>
      </div>
      <div>
        <dt>Deaths</dt>
        <dd>{{ recap.metrics.deaths }}</dd>
      </div>
      <div>
        <dt>Levels gained</dt>
        <dd>{{ recap.metrics.levelsGained }}</dd>
      </div>
      <div>
        <dt>Trades</dt>
        <dd>{{ recap.trades.accepted }} accepted / {{ recap.trades.cancelled }} cancelled</dd>
      </div>
      <div>
        <dt>Whispers</dt>
        <dd>{{ recap.whispers.in }} in / {{ recap.whispers.out }} out</dd>
      </div>
    </dl>
    <p class="disclaimer">Estimates from Client.txt; experience and gold need an account link the app does not have.</p>
  </section>
</template>

<style scoped>
.last-recap { display: flex; flex-direction: column; gap: 0.55rem; }
.metric-grid { margin: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: 0.6rem; }
.metric-grid dt { font-size: 0.72rem; text-transform: uppercase; opacity: 0.7; }
.metric-grid dd { margin: 0; font-variant-numeric: tabular-nums; font-weight: 600; }
</style>
