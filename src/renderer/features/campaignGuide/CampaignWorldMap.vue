<script setup lang="ts">
/**
 * The schematic world map: one lane per act, the main path on the spine,
 * side areas hanging below. There are no vendor area previews to show, so
 * this is a graph, not a picture — the geometry comes from the pure
 * `layoutCampaignMap()` and this component only draws it.
 */
import { computed } from "vue";
import { mapNodeClass, type MapLayout, type MapNode } from "@core/campaignGuideMap";

const props = withDefaults(
  defineProps<{
    layout: MapLayout;
    currentId?: string;
    selectedId?: string;
    visited?: string[];
  }>(),
  { visited: () => [] },
);

const emit = defineEmits<{ select: [id: string] }>();

const visitedSet = computed(() => new Set(props.visited));
const nodeById = computed(() => new Map(props.layout.nodes.map((node) => [node.id, node])));

const edges = computed(() =>
  props.layout.edges
    .map((edge) => {
      const from = nodeById.value.get(edge.from);
      const to = nodeById.value.get(edge.to);
      if (!from || !to) return undefined;
      return { key: `${edge.from}>${edge.to}`, x1: from.x, y1: from.y, x2: to.x, y2: to.y, crossAct: edge.crossAct };
    })
    .filter((edge): edge is NonNullable<typeof edge> => Boolean(edge)),
);

function classOf(node: MapNode): string {
  return mapNodeClass(node, {
    currentId: props.currentId,
    visited: visitedSet.value,
    selectedId: props.selectedId,
  });
}
</script>

<template>
  <div class="map-scroll">
    <p v-if="!layout.nodes.length" class="empty-copy">The route has no areas to draw yet.</p>
    <svg
      v-else
      class="campaign-map"
      :viewBox="`0 0 ${layout.viewBox.width} ${layout.viewBox.height}`"
      :width="layout.viewBox.width"
      :height="layout.viewBox.height"
      role="group"
      aria-label="Campaign route map"
    >
      <g class="lanes">
        <text v-for="lane in layout.lanes" :key="lane.key" :x="6" :y="lane.y - 18" class="lane-label">
          {{ lane.label }}
        </text>
      </g>
      <g class="edges">
        <line
          v-for="edge in edges"
          :key="edge.key"
          :x1="edge.x1"
          :y1="edge.y1"
          :x2="edge.x2"
          :y2="edge.y2"
          :class="{ edge: true, 'cross-act': edge.crossAct }"
        />
      </g>
      <g
        v-for="node in layout.nodes"
        :key="node.id"
        :class="classOf(node)"
        role="button"
        tabindex="0"
        :aria-label="`${node.name} (level ${node.level})`"
        :data-node-id="node.id"
        @click="emit('select', node.id)"
        @keydown.enter.prevent="emit('select', node.id)"
      >
        <rect v-if="node.town" :x="node.x - 7" :y="node.y - 7" width="14" height="14" rx="2" />
        <circle v-else :cx="node.x" :cy="node.y" :r="5" />
        <circle v-if="node.waypoint && !node.town" class="ring" :cx="node.x" :cy="node.y" :r="9" />
        <text :x="node.x" :y="node.y + 22" class="node-label">{{ node.name }}</text>
      </g>
    </svg>
  </div>
</template>

<style scoped>
.map-scroll {
  overflow-x: auto;
  overflow-y: hidden;
  padding-bottom: 0.4rem;
}
.campaign-map {
  min-width: 100%;
}
.lane-label {
  fill: var(--text-muted, #888b8e);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.edge {
  stroke: var(--line-strong, #3b424d);
  stroke-width: 1.5;
}
.edge.cross-act {
  stroke-dasharray: 5 4;
}
.node circle,
.node rect {
  fill: var(--panel-raised, #1c2026);
  stroke: var(--line-strong, #3b424d);
  stroke-width: 1.5;
  cursor: pointer;
}
.node.visited circle,
.node.visited rect {
  fill: var(--blue, #79afc7);
}
.node.town rect {
  stroke: var(--gold, #c8a66a);
}
.node.current circle,
.node.current rect {
  stroke: var(--gold-bright, #e4c587);
  stroke-width: 3;
}
.node.selected circle,
.node.selected rect {
  stroke: var(--text, #ebe6dc);
}
.node .ring {
  fill: none;
  stroke: var(--gold-soft, rgba(200, 166, 106, 0.35));
}
.node-label {
  fill: var(--text-soft, #b9b4aa);
  font-size: 10px;
  text-anchor: middle;
}
.node:focus-visible {
  outline: 2px solid var(--gold-bright, #e4c587);
}
</style>
