<script setup lang="ts">
import type { MapRun } from "@core/sessionTracker";
import { formatDuration, kindLabel, runEndLabel, tierLabel, when } from "../format";

defineProps<{ runs: MapRun[]; heading?: string }>();
</script>

<template>
  <section class="card recent-maps" aria-labelledby="home-runs-title">
    <div class="section-heading">
      <div>
        <span class="eyebrow">Mapping</span>
        <h2 id="home-runs-title">{{ heading ?? "Recent runs" }}</h2>
      </div>
      <span class="count-badge">{{ runs.length }}</span>
    </div>

    <p v-if="!runs.length" class="empty-copy">No maps this session yet.</p>
    <div v-else class="table-scroll">
      <table class="runs-table">
        <thead>
          <tr>
            <th scope="col">Kind</th>
            <th scope="col">Area</th>
            <th scope="col" class="num">Level</th>
            <th scope="col" class="num">Active</th>
            <th scope="col" class="num">Deaths</th>
            <th scope="col" class="num">Portals</th>
            <th scope="col">Ended</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="run in runs" :key="run.id">
            <td>
              {{ kindLabel(run.kind) }}
              <small v-if="tierLabel(run)" class="muted">{{ tierLabel(run) }}</small>
            </td>
            <td>
              {{ run.name }}
              <small class="muted">{{ when(run.startedAt) }}</small>
            </td>
            <td class="num">{{ run.areaLevel }}</td>
            <td class="num">{{ formatDuration(run.activeMs) }}</td>
            <td class="num">{{ run.deaths }}</td>
            <td class="num">{{ run.portals }}</td>
            <td>{{ runEndLabel(run) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p class="disclaimer">
      Durations exclude time spent in town or the hideout. Everything here is derived from the game's
      own log lines, never from an account.
    </p>
  </section>
</template>

<style scoped>
.recent-maps { display: flex; flex-direction: column; gap: 0.6rem; }
.table-scroll { overflow-x: auto; }
.runs-table { border-collapse: collapse; width: 100%; min-width: 34rem; font-size: 0.88rem; }
.runs-table th, .runs-table td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid rgba(140, 140, 160, 0.15); vertical-align: top; }
.runs-table th { font-size: 0.72rem; text-transform: uppercase; opacity: 0.7; }
.runs-table .num { text-align: right; font-variant-numeric: tabular-nums; }
.runs-table td small { display: block; }
</style>
