<script setup lang="ts">
/**
 * Per-tab worth plus the item list of the selected tab, with the exclusion
 * checkbox. Excluded items keep their row (struck through) so the user can
 * see what they took out and put it back.
 */
import { computed, ref } from "vue";
import { describeAge } from "@core/inventoryLedger";
import { filterSnapshotItems, locationTotals } from "@core/stashTrackerSnapshot";
import { formatExalted } from "@core/stashTrackerTimeline";
import type { SnapshotItem, WealthSnapshot } from "../../../../shared/stashTracker.js";

const props = defineProps<{
  current: WealthSnapshot | null;
  excluded: ReadonlySet<string>;
  busy: boolean;
  now: number;
}>();

const emit = defineEmits<{ exclude: [fingerprint: string, excluded: boolean] }>();

const selected = ref("");
const minUnit = ref(0);
const minTotal = ref(0);
const query = ref("");
const showExcluded = ref(true);

const rows = computed(() =>
  props.current ? locationTotals(props.current.items, props.excluded) : [],
);

const items = computed<SnapshotItem[]>(() => {
  if (!props.current) return [];
  return filterSnapshotItems(
    props.current.items,
    {
      ...(selected.value ? { location: selected.value } : {}),
      ...(minUnit.value > 0 ? { minUnitExalted: minUnit.value } : {}),
      ...(minTotal.value > 0 ? { minTotalExalted: minTotal.value } : {}),
      ...(query.value.trim() ? { query: query.value.trim() } : {}),
      includeExcluded: showExcluded.value,
    },
    props.excluded,
  ).sort((a, b) => (b.valueExalted ?? 0) - (a.valueExalted ?? 0));
});

function age(at: string): string {
  const parsed = Date.parse(at);
  if (!Number.isFinite(parsed)) return "unknown";
  return describeAge(Math.max(0, props.now - parsed));
}
</script>

<template>
  <div class="tab-totals">
    <p v-if="!current" class="empty-copy">
      Nothing in the ledger yet — run a sort, then come back.
    </p>
    <template v-else>
      <div class="table-scroll">
        <table class="tracker-table">
          <thead>
            <tr>
              <th scope="col">Location</th>
              <th scope="col" class="num">Items</th>
              <th scope="col" class="num">Excluded</th>
              <th scope="col" class="num">Unpriced</th>
              <th scope="col" class="num">Value (ex)</th>
              <th scope="col">Last scan</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in rows"
              :key="row.location"
              :class="{ selected: selected === row.location }"
            >
              <td>
                <button
                  type="button"
                  class="button compact ghost"
                  @click="selected = selected === row.location ? '' : row.location"
                >
                  {{ row.location }}
                </button>
              </td>
              <td class="num">{{ row.items }}</td>
              <td class="num">{{ row.excludedItems }}</td>
              <td class="num">{{ row.unpriced }}</td>
              <td class="num">{{ formatExalted(row.valueExalted) }}</td>
              <td>{{ age(row.lastScanAt) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <h4>{{ selected ? `Items in ${selected}` : "All items" }}</h4>
      <div class="form-grid compact-grid">
        <label>
          Min ex each
          <input v-model.number="minUnit" type="number" min="0" step="0.5" />
        </label>
        <label>
          Min ex total
          <input v-model.number="minTotal" type="number" min="0" step="0.5" />
        </label>
        <label>
          Search
          <input v-model="query" type="search" placeholder="Name, class, base" />
        </label>
        <label class="inline-toggle">
          <input v-model="showExcluded" type="checkbox" /> Show excluded
        </label>
      </div>
      <p v-if="!items.length" class="empty-copy">No items match these filters.</p>
      <div v-else class="table-scroll">
        <table class="tracker-table">
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Tab</th>
              <th scope="col" class="num">Units</th>
              <th scope="col" class="num">Value (ex)</th>
              <th scope="col">Exclude</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="item in items"
              :key="`${item.fingerprint}-${item.location}`"
              :class="{ excluded: excluded.has(item.fingerprint) }"
            >
              <td>
                <strong>{{ item.name }}</strong>
                <small class="muted"> {{ item.itemClass }}</small>
              </td>
              <td>{{ item.location }}</td>
              <td class="num">{{ item.units }}</td>
              <td class="num">{{ formatExalted(item.valueExalted) }}</td>
              <td>
                <label class="inline-toggle">
                  <input
                    type="checkbox"
                    :checked="excluded.has(item.fingerprint)"
                    :disabled="busy"
                    :aria-label="`Exclude ${item.name} from totals`"
                    @change="
                      emit(
                        'exclude',
                        item.fingerprint,
                        ($event.target as HTMLInputElement).checked,
                      )
                    "
                  />
                  <span class="sr-only">Exclude {{ item.name }}</span>
                </label>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<style scoped>
.tab-totals {
  display: grid;
  gap: 0.7rem;
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
.tracker-table tr.selected {
  background: var(--gold-soft, rgba(200, 166, 106, 0.14));
}
.tracker-table tr.excluded strong {
  text-decoration: line-through;
}
.tracker-table tr.excluded td {
  color: var(--text-muted, #888b8e);
}
</style>
