<script setup lang="ts">
/**
 * Two snapshots side by side: what arrived, what left, what changed value
 * or moved tab. "Current (unsaved)" compares against the live ledger, so a
 * mapping run can be measured without saving anything first.
 */
import { computed, ref, watch } from "vue";
import { formatExalted } from "@core/stashTrackerTimeline";
import type { SnapshotDelta, SnapshotDiff, SnapshotMeta } from "../../../../shared/stashTracker.js";
import type { StashTrackerApi } from "../api";

const props = defineProps<{
  snapshots: readonly SnapshotMeta[];
  initialFrom?: string;
  api: StashTrackerApi | null;
  hasCurrent: boolean;
}>();

const fromId = ref(props.initialFrom ?? "");
// With an empty ledger there IS no "Current (unsaved)" option, and asking for
// it would come back undefined and read as "that snapshot is gone".
const toId = ref(props.hasCurrent ? "current" : "");
const kinds = ref<Record<SnapshotDelta["kind"], boolean>>({
  added: true,
  removed: true,
  changed: true,
  moved: true,
});
const minAbs = ref(0);
const query = ref("");
const diff = ref<SnapshotDiff | null>(null);
const loading = ref(false);
const error = ref("");

let seq = 0;

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

function optionLabel(snapshot: SnapshotMeta): string {
  return `${snapshot.label || when(snapshot.at)} · ${formatExalted(snapshot.effectiveExalted)} ex`;
}

async function load(): Promise<void> {
  if (!props.api || !fromId.value || !toId.value) {
    // Nothing chosen is the empty state, not an error — and it cancels any
    // comparison still in flight.
    seq += 1;
    diff.value = null;
    error.value = "";
    loading.value = false;
    return;
  }
  const token = ++seq;
  loading.value = true;
  error.value = "";
  try {
    const next = await props.api.invoke("stash-tracker:compare", fromId.value, toId.value);
    if (token !== seq) return;
    diff.value = next ?? null;
    if (!next) error.value = "That snapshot is no longer on disk.";
  } catch (reason) {
    if (token !== seq) return;
    diff.value = null;
    error.value = reason instanceof Error ? reason.message : "The comparison could not be loaded.";
  } finally {
    if (token === seq) loading.value = false;
  }
}

watch(
  () => props.initialFrom,
  (value) => {
    if (value) fromId.value = value;
  },
);

watch(
  () => props.hasCurrent,
  (hasCurrent) => {
    if (hasCurrent) {
      if (!toId.value) toId.value = "current";
      return;
    }
    // The live ledger went away: fall back to the newest stored snapshot, or
    // to the "pick two snapshots" empty state when there is none.
    if (toId.value === "current") toId.value = props.snapshots[0]?.id ?? "";
  },
);

watch(
  () => props.snapshots.map((snapshot) => snapshot.id).join(","),
  () => {
    if (!fromId.value && props.snapshots.length) {
      fromId.value = props.snapshots[props.snapshots.length - 1]!.id;
    }
    void load();
  },
  { immediate: true },
);

watch([fromId, toId], () => void load());

const rows = computed<SnapshotDelta[]>(() => {
  const source = diff.value?.deltas ?? [];
  const terms = query.value.trim().toLowerCase();
  return source.filter((delta) => {
    if (!kinds.value[delta.kind]) return false;
    if (Math.abs(delta.valueDelta) < minAbs.value) return false;
    if (terms && !`${delta.name} ${delta.itemClass} ${delta.rarity}`.toLowerCase().includes(terms)) {
      return false;
    }
    return true;
  });
});

function signed(value: number): string {
  return `${value > 0 ? "+" : ""}${formatExalted(value)}`;
}

function sideText(side: SnapshotDelta["before"]): string {
  if (!side) return "—";
  return `${side.location} · ${side.units}u · ${formatExalted(side.valueExalted)} ex`;
}
</script>

<template>
  <div class="compare">
    <div class="form-grid">
      <label>
        From
        <select v-model="fromId" aria-label="Compare from">
          <option value="" disabled>Pick a snapshot</option>
          <option v-for="snapshot in snapshots" :key="snapshot.id" :value="snapshot.id">
            {{ optionLabel(snapshot) }}
          </option>
        </select>
      </label>
      <label>
        To
        <select v-model="toId" aria-label="Compare to">
          <option v-if="hasCurrent" value="current">Current (unsaved)</option>
          <option v-for="snapshot in snapshots" :key="snapshot.id" :value="snapshot.id">
            {{ optionLabel(snapshot) }}
          </option>
        </select>
      </label>
    </div>
    <div class="form-grid compact-grid">
      <label class="inline-toggle"><input v-model="kinds.added" type="checkbox" /> Added</label>
      <label class="inline-toggle"><input v-model="kinds.removed" type="checkbox" /> Removed</label>
      <label class="inline-toggle"><input v-model="kinds.changed" type="checkbox" /> Changed</label>
      <label class="inline-toggle"><input v-model="kinds.moved" type="checkbox" /> Moved</label>
      <label>
        Min |Δ| (ex)
        <input v-model.number="minAbs" type="number" min="0" step="0.5" />
      </label>
      <label>
        Search
        <input v-model="query" type="search" placeholder="Name, class, rarity" />
      </label>
    </div>
    <p v-if="loading" class="muted" role="status">Comparing…</p>
    <p v-else-if="error" class="inline-notice danger" role="alert">{{ error }}</p>
    <template v-else-if="diff">
      <p class="compare-summary" role="status">
        Δ {{ signed(diff.totalDelta) }} ex ({{ signed(diff.totalDeltaDivine) }} div) ·
        {{ diff.added }} added · {{ diff.removed }} removed · {{ diff.changed }} changed ·
        {{ diff.moved }} moved
      </p>
      <p v-if="diff.trimmed" class="inline-notice warning">
        One of these snapshots is old enough that its item list was trimmed — totals only.
      </p>
      <p v-else-if="!rows.length" class="empty-copy">Nothing matches these filters.</p>
      <div v-else class="table-scroll">
        <table class="tracker-table">
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Kind</th>
              <th scope="col">Before</th>
              <th scope="col">After</th>
              <th scope="col" class="num">Δ units</th>
              <th scope="col" class="num">Δ ex</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="delta in rows" :key="`${delta.kind}-${delta.key}`">
              <td>
                <strong>{{ delta.name }}</strong>
                <small class="muted"> {{ delta.itemClass }}</small>
              </td>
              <td>{{ delta.kind }}</td>
              <td>{{ sideText(delta.before) }}</td>
              <td>{{ sideText(delta.after) }}</td>
              <td class="num">{{ delta.unitsDelta }}</td>
              <td class="num">{{ signed(delta.valueDelta) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
    <p v-else class="empty-copy">Pick two snapshots to compare.</p>
  </div>
</template>

<style scoped>
.compare {
  display: grid;
  gap: 0.7rem;
}
.compare-summary {
  margin: 0;
  font-size: 0.82rem;
  color: var(--text-soft, #b9b4aa);
}
.table-scroll {
  overflow-x: auto;
}
.tracker-table {
  width: 100%;
  border-collapse: collapse;
  font-variant-numeric: tabular-nums;
}
.tracker-table th,
.tracker-table td {
  text-align: left;
  padding: 0.4rem 0.6rem;
  border-bottom: 1px solid rgba(140, 140, 160, 0.15);
}
.tracker-table th {
  text-transform: uppercase;
  font-size: 0.72rem;
  opacity: 0.7;
}
.tracker-table .num {
  text-align: right;
}
</style>
