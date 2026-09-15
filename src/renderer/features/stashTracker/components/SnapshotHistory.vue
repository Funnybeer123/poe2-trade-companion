<script setup lang="ts">
/**
 * The snapshot list, newest first. Rename is inline; delete is two-click
 * (never a browser confirm), matching the repo's destructive-action rule.
 */
import { computed, ref } from "vue";
import { formatExalted } from "@core/stashTrackerTimeline";
import type { SnapshotMeta } from "../../../../shared/stashTracker.js";

const props = defineProps<{ snapshots: readonly SnapshotMeta[]; busy: boolean }>();

const emit = defineEmits<{
  rename: [id: string, label: string];
  remove: [id: string];
  compare: [id: string];
}>();

const editingId = ref("");
const draft = ref("");
const pendingDeleteId = ref("");

const KIND_LABEL: Record<SnapshotMeta["kind"], string> = {
  manual: "named",
  auto: "auto",
  "session-start": "session start",
};

/** Oldest → newest deltas so each row can show "vs previous". */
const deltas = computed(() => {
  const ordered = [...props.snapshots].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const map = new Map<string, number>();
  let previous: number | undefined;
  for (const snapshot of ordered) {
    if (previous !== undefined) {
      map.set(snapshot.id, Math.round((snapshot.effectiveExalted - previous) * 100) / 100);
    }
    previous = snapshot.effectiveExalted;
  }
  return map;
});

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

function signed(value: number): string {
  return `${value > 0 ? "+" : ""}${formatExalted(value)} ex`;
}

function startEdit(snapshot: SnapshotMeta): void {
  editingId.value = snapshot.id;
  draft.value = snapshot.label ?? "";
  pendingDeleteId.value = "";
}

function cancelEdit(): void {
  editingId.value = "";
  draft.value = "";
}

function saveEdit(id: string): void {
  const label = draft.value.trim();
  if (!label) return;
  emit("rename", id, label);
  cancelEdit();
}

function askDelete(id: string): void {
  if (pendingDeleteId.value === id) {
    emit("remove", id);
    pendingDeleteId.value = "";
    return;
  }
  pendingDeleteId.value = id;
}
</script>

<template>
  <div class="history">
    <p v-if="!snapshots.length" class="empty-copy">
      No snapshots yet — take one above; auto-snapshots start once the ledger changes and settles.
    </p>
    <ol v-else class="tracker-list">
      <li v-for="snapshot in snapshots" :key="snapshot.id">
        <div class="entry-copy">
          <strong>{{ snapshot.label || when(snapshot.at) }}</strong>
          <small>
            {{ KIND_LABEL[snapshot.kind] }} · {{ snapshot.itemCount }} items ·
            {{ formatExalted(snapshot.effectiveExalted) }} ex
            <span v-if="deltas.get(snapshot.id) !== undefined">
              · {{ signed(deltas.get(snapshot.id) as number) }} vs previous
            </span>
            <span v-if="snapshot.itemsTrimmed"> · item detail trimmed</span>
          </small>
        </div>
        <div v-if="editingId === snapshot.id" class="edit-row">
          <label class="sr-only" :for="`rename-${snapshot.id}`">New name</label>
          <input
            :id="`rename-${snapshot.id}`"
            v-model="draft"
            type="text"
            maxlength="60"
            @keydown.enter.prevent="saveEdit(snapshot.id)"
          />
          <button
            type="button"
            class="button compact primary"
            :disabled="busy || !draft.trim()"
            @click="saveEdit(snapshot.id)"
          >
            Save
          </button>
          <button type="button" class="button compact ghost" @click="cancelEdit">Cancel</button>
        </div>
        <div v-else class="entry-actions">
          <button
            type="button"
            class="button compact ghost"
            :disabled="busy"
            :aria-label="`Rename ${snapshot.label || when(snapshot.at)}`"
            @click="startEdit(snapshot)"
          >
            Rename
          </button>
          <button
            type="button"
            class="button compact secondary"
            :disabled="busy"
            @click="emit('compare', snapshot.id)"
          >
            Compare
          </button>
          <button
            type="button"
            class="button compact danger"
            :disabled="busy"
            :aria-label="
              pendingDeleteId === snapshot.id
                ? `Confirm delete ${snapshot.label || when(snapshot.at)}`
                : `Delete ${snapshot.label || when(snapshot.at)}`
            "
            @click="askDelete(snapshot.id)"
          >
            {{ pendingDeleteId === snapshot.id ? "Confirm" : "Delete" }}
          </button>
        </div>
      </li>
    </ol>
  </div>
</template>

<style scoped>
.tracker-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.tracker-list li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0.7rem;
  align-items: center;
  padding: 0.5rem 0;
  border-bottom: 1px solid rgba(140, 140, 160, 0.2);
}
.entry-copy {
  display: grid;
  gap: 0.2rem;
  min-width: 0;
}
.entry-copy small {
  color: var(--text-muted, #888b8e);
  font-size: 0.74rem;
}
.entry-actions,
.edit-row {
  display: flex;
  gap: 0.4rem;
  align-items: center;
}
.edit-row input {
  min-width: 12rem;
}
</style>
