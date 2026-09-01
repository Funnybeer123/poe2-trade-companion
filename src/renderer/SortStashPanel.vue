<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { SortPlacement } from "@core/stashSort";
import { useGameActions } from "./composables/useGameActions";

const {
  sortStatus: status,
  lastSortResult: result,
  sortEvents: events,
  actionError: error,
  busy,
  initializeGameActions,
  refreshGameActions,
  startSort,
  stopGameActions,
  rearmKillSwitch,
} = useGameActions();

const writableConfirmed = ref(true);

const canPreview = computed(
  () =>
    !busy.value &&
    status.value.calibrated &&
    !status.value.killLatched &&
    writableConfirmed.value,
);
const canExecute = computed(
  () =>
    canPreview.value &&
    result.value?.action === "preview" &&
    result.value.plan.executable &&
    result.value.schedule.ok &&
    result.value.plan.id === status.value.previewPlanId,
);
const plan = computed(() => result.value?.plan);
const cols = computed(() => plan.value?.tab.cols ?? (status.value.stashTab === "quad" ? 24 : 12));
const rows = computed(() => plan.value?.tab.rows ?? (status.value.stashTab === "quad" ? 24 : 12));
const gridStyle = computed(() => ({
  aspectRatio: `${cols.value} / ${rows.value}`,
  backgroundSize: `${100 / cols.value}% ${100 / rows.value}%`,
}));

function placementStyle(item: SortPlacement, planned: boolean) {
  const point = planned ? item.target : item.source;
  const group = plan.value?.groups.find((entry) => entry.key === item.groupKey);
  const hue = ((group?.colorIndex ?? 0) * 67 + 28) % 360;
  return {
    left: `${(point.col / cols.value) * 100}%`,
    top: `${(point.row / rows.value) * 100}%`,
    width: `${(item.w / cols.value) * 100}%`,
    height: `${(item.h / rows.value) * 100}%`,
    "--sort-hue": String(hue),
  };
}

function requestBase() {
  return {
    tabSafety: writableConfirmed.value ? "writable-grid" as const : "unknown" as const,
  };
}

async function refresh() {
  await refreshGameActions();
}

async function preview() {
  if (!canPreview.value) return;
  await startSort({ ...requestBase(), action: "preview" });
}

async function execute() {
  const previewPlan = result.value?.plan;
  if (!canExecute.value || !previewPlan) return;
  await startSort({
    ...requestBase(),
    action: "execute",
    planId: previewPlan.id,
  });
}

async function stop() {
  await stopGameActions();
}

async function rearm() {
  await rearmKillSwitch();
}

onMounted(() => {
  void initializeGameActions();
  void refresh();
});
</script>

<template>
  <section class="sort-stash-layout">
    <div class="card sort-controls">
      <h2>Sort current stash tab</h2>
      <p>
        Groups identical exact base types in stable class/base order. Preview is the default and never
        moves an item; its audited scan only hovers and copies item metadata.
      </p>
      <p>
        Mode <strong>{{ status.mode }}</strong> ·
        calibrated <strong>{{ status.calibrated }}</strong> ·
        active {{ status.stashTab === "quad" ? "quad 24×24" : "normal 12×12" }}
      </p>
      <p v-if="error" class="warning">{{ error }}</p>
      <label>
        <input v-model="writableConfirmed" type="checkbox" />
        The currently open tab is an ordinary writable grid tab (not special or remove-only)
      </label>
      <div class="btn-row sort-actions">
        <button type="button" class="primary" :disabled="!canPreview" @click="preview">
          Scan &amp; preview
        </button>
        <button type="button" class="danger" :disabled="!canExecute" @click="execute">
          Execute this preview
        </button>
        <button type="button" :disabled="!status.running" @click="stop">Stop</button>
        <button v-if="status.killLatched" type="button" @click="rearm">Re-arm kill switch</button>
      </div>
      <p class="memory-status">
        Execution rescans the tab and bag, rejects stale plans, then reconciles after every move.
        Ctrl+Shift+Esc aborts and latches input.
      </p>

      <template v-if="plan">
        <h3>Diagnostics</h3>
        <ul class="sort-diagnostics">
          <li>{{ plan.placements.length }} identified item(s) in {{ plan.groups.length }} base group(s)</li>
          <li>{{ plan.diagnostics.itemCells }} / {{ plan.diagnostics.capacityCells }} stash cells used</li>
          <li>{{ plan.diagnostics.moveCount }} planned relocation(s); {{ result?.schedule.steps.length }} safe move step(s)</li>
          <li>Compactness {{ Math.round(plan.diagnostics.compactness * 100) }}% · quality {{ plan.diagnostics.qualityScore }}/100</li>
          <li>Peak staging {{ result?.schedule.peakStagedItems }} item(s), {{ result?.schedule.peakStagedCells }} bag cell(s)</li>
        </ul>
        <div v-if="plan.blockers.length" class="sort-issues warning">
          <strong>Execution blocked</strong>
          <ul>
            <li v-for="issue in plan.blockers" :key="`${issue.code}-${issue.itemId ?? ''}`">
              {{ issue.code }} — {{ issue.message }}
            </li>
          </ul>
        </div>
        <div v-if="plan.warnings.length" class="sort-issues">
          <strong>Skipped / warnings</strong>
          <ul>
            <li v-for="issue in plan.warnings" :key="`${issue.code}-${issue.itemId ?? ''}`">
              {{ issue.code }} — {{ issue.message }}
            </li>
          </ul>
        </div>
      </template>
    </div>

    <div class="sort-preview-column">
      <div v-if="plan" class="card">
        <h2>Current vs planned</h2>
        <div class="sort-grid-pair">
          <figure>
            <figcaption>Current</figcaption>
            <div class="sort-grid-preview" :style="gridStyle">
              <div
                v-for="entry in plan.placements"
                :key="`current-${entry.id}`"
                class="sort-grid-item"
                :style="placementStyle(entry, false)"
                :title="`${entry.itemClass} · ${entry.baseType} · ${entry.w}×${entry.h}`"
              >
                <span>{{ entry.baseType }}</span>
              </div>
            </div>
          </figure>
          <figure>
            <figcaption>Planned</figcaption>
            <div class="sort-grid-preview" :style="gridStyle">
              <div
                v-for="entry in plan.placements"
                :key="`planned-${entry.id}`"
                class="sort-grid-item"
                :class="{ stationary: !entry.moved }"
                :style="placementStyle(entry, true)"
                :title="`${entry.itemClass} · ${entry.baseType} · ${entry.w}×${entry.h}`"
              >
                <span>{{ entry.baseType }}</span>
              </div>
            </div>
          </figure>
        </div>
        <ul class="sort-legend">
          <li v-for="group in plan.groups" :key="group.key">
            <span
              class="sort-swatch"
              :style="{ '--sort-hue': String((group.colorIndex * 67 + 28) % 360) }"
            />
            {{ group.itemClass }} · {{ group.baseType }} ({{ group.itemIds.length }})
          </li>
        </ul>
      </div>
      <div class="card">
        <h2>Sorter activity</h2>
        <p v-if="!events.length">No sort scan has run in this app session.</p>
        <ol class="event-log">
          <li v-for="event in events" :key="`${event.at}-${event.phase}-${event.message}`">
            {{ event.phase }} — {{ event.message }}
            <span v-if="event.completedMoves !== undefined">
              · {{ event.completedMoves }}/{{ event.totalMoves }}
            </span>
          </li>
        </ol>
      </div>
    </div>
  </section>
</template>
