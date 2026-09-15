<script setup lang="ts">
/**
 * The objectives of one area: tick, hide/restore, edit and reorder. Every
 * mutation leaves as a `customise` patch — the component never talks to main
 * itself, so the same list works inside the overlay panel (editable = false).
 */
import { computed } from "vue";
import type {
  CampaignCustomisePatch,
  MergedArea,
  MergedObjective,
} from "@core/campaignGuide";

const props = withDefaults(
  defineProps<{
    area: MergedArea;
    objectives: MergedObjective[];
    editable?: boolean;
    busy?: boolean;
  }>(),
  { editable: false, busy: false },
);

const emit = defineEmits<{
  customise: [patch: CampaignCustomisePatch];
  edit: [objective: MergedObjective];
}>();

/** The complete merged order — reordering must not silently drop hidden rows. */
const fullOrder = computed(() => props.area.objectives.map((objective) => objective.id));

/**
 * The row Up/Down should swap WITH: the previous/next VISIBLE objective. Using
 * the merged order directly would swap with a filtered-out row, which persists
 * a new order and leaves the visible list looking unchanged — the button then
 * reads as broken.
 */
function neighbour(objective: MergedObjective, delta: number): MergedObjective | undefined {
  const index = props.objectives.findIndex((entry) => entry.id === objective.id);
  if (index < 0) return undefined;
  return props.objectives[index + delta];
}

function isDone(objective: MergedObjective): boolean {
  return objective.done || objective.auto;
}

function toggleDone(objective: MergedObjective, done: boolean): void {
  emit("customise", { op: "set-done", id: objective.id, done, at: new Date().toISOString() });
}

function move(objective: MergedObjective, delta: number): void {
  const other = neighbour(objective, delta);
  if (!other) return;
  const order = [...fullOrder.value];
  const from = order.indexOf(objective.id);
  const to = order.indexOf(other.id);
  if (from < 0 || to < 0) return;
  [order[from], order[to]] = [order[to], order[from]];
  emit("customise", { op: "move-objective", areaId: props.area.id, orderedIds: order });
}

function moveDisabled(objective: MergedObjective, delta: number): boolean {
  return !neighbour(objective, delta);
}

function hide(objective: MergedObjective): void {
  emit("customise", { op: objective.hidden ? "restore-objective" : "hide-objective", id: objective.id });
}

function remove(objective: MergedObjective): void {
  emit("customise", { op: "delete-objective", id: objective.id });
}
</script>

<template>
  <ul v-if="objectives.length" class="objective-list">
    <li v-for="objective in objectives" :key="objective.id" :data-objective-id="objective.id" :class="{ hidden: objective.hidden }">
      <label class="objective-check">
        <input
          type="checkbox"
          :checked="isDone(objective)"
          :disabled="busy"
          :aria-label="`Done: ${objective.title}`"
          @change="toggleDone(objective, ($event.target as HTMLInputElement).checked)"
        />
        <span class="objective-copy">
          <strong>{{ objective.title }}</strong>
          <small v-if="objective.detail" class="muted">{{ objective.detail }}</small>
        </span>
      </label>
      <span class="objective-tags">
        <span class="tag neutral">{{ objective.kind }}</span>
        <span v-for="reward in objective.rewards" :key="reward" class="tag">{{ reward }}</span>
        <span v-if="objective.optional" class="tag neutral">optional</span>
        <span v-if="objective.auto" class="tag success">auto</span>
        <span v-if="objective.custom" class="tag neutral">yours</span>
        <span v-else-if="objective.edited" class="tag neutral">edited</span>
      </span>
      <span v-if="editable" class="objective-actions">
        <button
          type="button"
          class="button compact ghost"
          :disabled="busy || moveDisabled(objective, -1)"
          :title="moveDisabled(objective, -1) ? 'Nothing shown above it' : 'Move up'"
          @click="move(objective, -1)"
        >
          Up
        </button>
        <button
          type="button"
          class="button compact ghost"
          :disabled="busy || moveDisabled(objective, 1)"
          :title="moveDisabled(objective, 1) ? 'Nothing shown below it' : 'Move down'"
          @click="move(objective, 1)"
        >
          Down
        </button>
        <button type="button" class="button compact ghost" :disabled="busy" @click="emit('edit', objective)">
          Edit
        </button>
        <button type="button" class="button compact ghost" :disabled="busy" @click="hide(objective)">
          {{ objective.hidden ? "Restore" : "Hide" }}
        </button>
        <button
          v-if="objective.custom"
          type="button"
          class="button compact danger"
          :disabled="busy"
          @click="remove(objective)"
        >
          Delete
        </button>
      </span>
    </li>
  </ul>
  <p v-else class="empty-copy">No objectives match the current filters.</p>
</template>

<style scoped>
.objective-list {
  list-style: none;
  margin: 0.3rem 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.objective-list li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0.4rem 0.6rem;
  align-items: start;
  padding-bottom: 0.35rem;
  border-bottom: 1px solid rgba(140, 140, 160, 0.15);
}
.objective-list li.hidden {
  opacity: 0.55;
}
.objective-check {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 0.45rem;
  align-items: start;
  font-weight: 400;
  font-size: 0.84rem;
}
.objective-copy {
  display: grid;
  gap: 0.15rem;
}
.objective-tags,
.objective-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  align-items: center;
  justify-self: end;
}
</style>
