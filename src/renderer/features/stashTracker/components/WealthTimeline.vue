<script setup lang="ts">
/**
 * Stash worth over time. The last 24 h is plotted snapshot by snapshot;
 * older history is one point per day (that day's last snapshot), which the
 * hollow markers show. Only the axis labels are abbreviated — every point's
 * exact value is in its tooltip.
 */
import { computed } from "vue";
import { timelineChart, formatExalted, type TimelinePoint } from "@core/stashTrackerTimeline";

const props = defineProps<{ points: readonly TimelinePoint[] }>();

const WIDTH = 720;
const HEIGHT = 220;

const chart = computed(() => timelineChart(props.points, { width: WIDTH, height: HEIGHT }));

function when(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  return date.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function title(point: TimelinePoint): string {
  const parts = [when(point.at), `${formatExalted(point.totalExalted)} ex`];
  if (point.label) parts.push(point.label);
  if (point.grouped) parts.push("day summary");
  return parts.join(" · ");
}

function markerClass(point: TimelinePoint): string {
  if (point.grouped) return "point grouped";
  if (point.kind === "manual") return "point manual";
  if (point.kind === "session-start") return "point session";
  return "point";
}
</script>

<template>
  <div class="timeline">
    <p v-if="!chart.points.length" class="empty-copy">
      No snapshots yet — the timeline fills in as soon as one is saved.
    </p>
    <template v-else>
      <svg
        role="img"
        aria-label="Stash worth over time"
        :viewBox="`0 0 ${WIDTH} ${HEIGHT}`"
        class="timeline-svg"
      >
        <g class="axis">
          <line
            v-for="tick in chart.yTicks"
            :key="`y-${tick.y}`"
            :x1="24"
            :x2="WIDTH - 12"
            :y1="tick.y"
            :y2="tick.y"
          />
          <text v-for="tick in chart.yTicks" :key="`yl-${tick.y}`" :x="4" :y="tick.y - 3">
            {{ tick.label }}
          </text>
          <text
            v-for="tick in chart.xTicks"
            :key="`xl-${tick.x}`"
            :x="tick.x"
            :y="HEIGHT - 6"
            text-anchor="middle"
          >
            {{ tick.label }}
          </text>
        </g>
        <path class="series" :d="chart.path" />
        <circle
          v-for="point in chart.points"
          :key="point.id"
          :class="markerClass(point)"
          :cx="point.x"
          :cy="point.y"
          r="4"
        >
          <title>{{ title(point) }}</title>
        </circle>
      </svg>
      <p class="muted">
        Last 24 h detailed; older days show that day's last snapshot. Gold = named snapshot, blue =
        session start, hollow = a whole day.
      </p>
    </template>
  </div>
</template>

<style scoped>
.timeline {
  display: grid;
  gap: 0.5rem;
}
.timeline-svg {
  width: 100%;
  height: auto;
  max-height: 240px;
}
.axis line {
  stroke: rgba(140, 140, 160, 0.18);
  stroke-width: 1;
}
.axis text {
  fill: var(--text-muted, #888b8e);
  font-size: 10px;
}
.series {
  fill: none;
  stroke: var(--gold, #c8a66a);
  stroke-width: 2;
}
.point {
  fill: var(--gold, #c8a66a);
  stroke: var(--bg-0, #090a0c);
  stroke-width: 1;
}
.point.manual {
  fill: var(--gold-bright, #e4c587);
  r: 5;
}
.point.session {
  fill: var(--blue, #79afc7);
}
.point.grouped {
  fill: none;
  stroke: var(--gold, #c8a66a);
  stroke-width: 2;
}
</style>
