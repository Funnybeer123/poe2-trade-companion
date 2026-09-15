<script setup lang="ts">
/**
 * The fetched listings. Every control here is CLIENT-SIDE — sorting,
 * currency chips, the online/age/secure toggles and grouping by seller never
 * send a request, so a user can shape the view without spending budget.
 * Columns follow the item kind (weapons show DPS, gems level, currency
 * stack), and stale rows fade the way the trade site fades them.
 */
import { computed, ref, watch } from "vue";
import {
  currencyCounts,
  filterRows,
  groupBySeller,
  sortRows,
  type RowSortKey,
} from "@core/evaluateResults";
import type { EvaluateItemSummary, EvaluateListingRow } from "../../../shared/evaluate.js";
import { describeAge } from "@core/inventoryLedger";
import { formatAmount } from "../../utils/intelligence";
import ListingPeek from "./ListingPeek.vue";

const props = defineProps<{
  rows: readonly EvaluateListingRow[];
  item: EvaluateItemSummary;
  searchId: string;
  ourMods: readonly string[];
  groupBySellerDefault?: boolean;
}>();

const emit = defineEmits<{ copy: [kind: "note" | "b/o" | "whisper", listingId: string] }>();

const sortKey = ref<RowSortKey>("price");
const sortDirection = ref<"asc" | "desc">("asc");
const currency = ref("");
const onlineOnly = ref(false);
const freshOnly = ref(false);
const secureOnly = ref(false);
const grouped = ref(props.groupBySellerDefault === true);
const peekId = ref("");

// A new search is a new view: the sort and the filters reset with it.
watch(
  () => props.searchId,
  () => {
    sortKey.value = "price";
    sortDirection.value = "asc";
    currency.value = "";
    onlineOnly.value = false;
    freshOnly.value = false;
    secureOnly.value = false;
    peekId.value = "";
  },
);

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

const chips = computed(() => currencyCounts(props.rows));

const visible = computed(() =>
  sortRows(
    filterRows(props.rows, {
      ...(currency.value ? { currency: currency.value } : {}),
      onlineOnly: onlineOnly.value,
      secureOnly: secureOnly.value,
      ...(freshOnly.value ? { maxAgeMs: THREE_DAYS_MS } : {}),
    }),
    sortKey.value,
    sortDirection.value,
  ),
);

const groups = computed(() => groupBySeller(visible.value));

const columns = computed<Array<{ key: RowSortKey; label: string }>>(() => {
  const kind = props.item.kind;
  const extra: Array<{ key: RowSortKey; label: string }> = [];
  if (props.item.dps) extra.push({ key: "dps", label: "DPS" });
  if (kind === "gem") extra.push({ key: "gemLevel", label: "Level" }, { key: "quality", label: "Q" });
  if (kind === "unique" || kind === "unidentified-unique") {
    extra.push({ key: "requiredLevel", label: "Req" });
  }
  if (kind === "currency") extra.push({ key: "stock", label: "Stack" });
  if (kind === "rare" || kind === "magic" || kind === "normal") extra.push({ key: "ilvl", label: "iLvl" });
  return [{ key: "price", label: "Price" }, { key: "age", label: "Age" }, ...extra];
});

const peekRow = computed(() => props.rows.find((row) => row.id === peekId.value));

function toggleSort(key: RowSortKey): void {
  if (sortKey.value === key) sortDirection.value = sortDirection.value === "asc" ? "desc" : "asc";
  else {
    sortKey.value = key;
    sortDirection.value = key === "price" ? "asc" : "desc";
  }
}

function cell(row: EvaluateListingRow, key: RowSortKey): string {
  switch (key) {
    case "price":
      return row.priceText || "unpriced";
    case "age":
      return row.ageMs === undefined ? "—" : describeAge(row.ageMs);
    case "dps":
      return row.dps?.total === undefined ? "—" : formatAmount(row.dps.total);
    case "gemLevel":
      return row.gemLevel === undefined ? "—" : String(row.gemLevel);
    case "quality":
      return row.quality === undefined ? "—" : `${row.quality}%`;
    case "requiredLevel":
      return row.requiredLevel === undefined ? "—" : String(row.requiredLevel);
    case "stock":
      return row.stackSize === undefined ? "—" : String(row.stackSize);
    case "ilvl":
      return row.itemLevel === undefined ? "—" : String(row.itemLevel);
    default:
      return "—";
  }
}
</script>

<template>
  <section class="results" aria-labelledby="evaluate-results-title">
    <div class="section-heading">
      <h3 id="evaluate-results-title">Listings</h3>
      <span>{{ visible.length }} of {{ rows.length }}</span>
    </div>

    <div class="filters-strip">
      <button
        type="button"
        class="button compact"
        :class="currency === '' ? 'primary' : 'ghost'"
        @click="currency = ''"
      >
        All currencies
      </button>
      <button
        v-for="chip in chips"
        :key="chip.currency"
        type="button"
        class="button compact"
        :class="currency === chip.currency ? 'primary' : 'ghost'"
        @click="currency = chip.currency"
      >
        {{ chip.currency }} <span class="count-badge">{{ chip.count }}</span>
      </button>
      <label class="inline-toggle"><input v-model="onlineOnly" type="checkbox" /> Online only</label>
      <label class="inline-toggle"><input v-model="freshOnly" type="checkbox" /> ≤ 3 days</label>
      <label class="inline-toggle"><input v-model="secureOnly" type="checkbox" /> Secure only</label>
      <label class="inline-toggle"><input v-model="grouped" type="checkbox" /> Group by seller</label>
    </div>

    <p v-if="rows.length === 0" class="state-panel compact-state">
      <span class="state-icon" aria-hidden="true">⌕</span>
      No listings matched — loosen a bound, or switch the profile to Broad.
    </p>

    <div v-else class="table-scroll">
      <table class="listing-table">
        <thead>
          <tr>
            <th v-for="column in columns" :key="column.key" scope="col">
              <button type="button" class="text-link" @click="toggleSort(column.key)">
                {{ column.label }}
                <span v-if="sortKey === column.key" aria-hidden="true">{{
                  sortDirection === "asc" ? "▲" : "▼"
                }}</span>
              </button>
            </th>
            <th scope="col">Seller</th>
            <th scope="col">Type</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody v-if="!grouped">
          <tr v-for="row in visible" :key="row.id" :class="`stale-${row.stale}`">
            <td v-for="column in columns" :key="column.key" class="num" :title="row.fractional ?? ''">
              {{ cell(row, column.key) }}
              <span v-if="column.key === 'price' && row.priceExalted !== undefined" class="muted">
                ({{ formatAmount(row.priceExalted) }} ex)
              </span>
            </td>
            <td>
              <span class="presence-dot" :class="{ online: row.presence === 'online' }" aria-hidden="true"></span>
              {{ row.seller }}
              <span v-if="row.presence === 'afk'" class="tag neutral">AFK</span>
            </td>
            <td>{{ row.listingType === "secure" ? "Secure" : "Whisper" }}</td>
            <td class="row-actions">
              <button
                type="button"
                class="icon-button"
                :aria-label="`Show the listing item from ${row.seller}`"
                @click="peekId = peekId === row.id ? '' : row.id"
              >
                ◉
              </button>
              <button
                type="button"
                class="button compact ghost"
                :aria-label="`Copy ${row.priceText} as a stash note`"
                :disabled="!row.stashNote"
                @click="emit('copy', 'note', row.id)"
              >
                Note
              </button>
              <button
                type="button"
                class="button compact ghost"
                :aria-label="`Copy the whisper for ${row.seller}`"
                :disabled="!row.whisper"
                @click="emit('copy', 'whisper', row.id)"
              >
                Whisper
              </button>
            </td>
          </tr>
        </tbody>
        <tbody v-else>
          <tr v-for="group in groups" :key="group.seller" :class="`stale-${group.cheapest.stale}`">
            <td v-for="column in columns" :key="column.key" class="num">
              {{ cell(group.cheapest, column.key) }}
            </td>
            <td>
              {{ group.seller }}
              <span class="count-badge">{{ group.rows.length }}</span>
            </td>
            <td>{{ group.cheapest.listingType === "secure" ? "Secure" : "Whisper" }}</td>
            <td class="row-actions">
              <button
                type="button"
                class="button compact ghost"
                :disabled="!group.cheapest.stashNote"
                @click="emit('copy', 'note', group.cheapest.id)"
              >
                Note
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <ListingPeek v-if="peekRow" :row="peekRow" :our-mods="ourMods" @close="peekId = ''" />
    <p class="disclaimer">
      Listings are other players' asking prices, not sales. Nothing here whispers, buys or lists anything.
    </p>
  </section>
</template>

<style scoped>
.results {
  display: grid;
  gap: 0.4rem;
}
.filters-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  align-items: center;
}
.inline-toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.76rem;
}
.inline-toggle input {
  width: auto;
  min-height: 0;
}
.table-scroll {
  overflow-x: auto;
}
.listing-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.78rem;
}
.listing-table th,
.listing-table td {
  text-align: left;
  padding: 0.3rem 0.5rem;
  border-bottom: 1px solid rgba(140, 140, 160, 0.15);
}
.listing-table th {
  text-transform: uppercase;
  font-size: 0.7rem;
  opacity: 0.7;
}
.num {
  font-variant-numeric: tabular-nums;
}
.stale-aging {
  opacity: 0.65;
}
.stale-stale {
  opacity: 0.45;
}
.row-actions {
  display: flex;
  gap: 0.25rem;
  align-items: center;
}
</style>
