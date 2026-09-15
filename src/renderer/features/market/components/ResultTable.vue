<script setup lang="ts">
/**
 * The rows one search tab holds. Local column sorting re-orders the rows
 * already fetched (no request); the server sort lives in the builder and
 * costs a new search, which is why it is not a column header here.
 *
 * "Load 10 more" is one fetch and says so, and it disappears once every id
 * of the (capped) result list has been fetched.
 */
import { computed, ref } from "vue";
import { collapseBySeller, sortListings, type LocalSortKey } from "@core/marketListing";
import type { PriceTable } from "@core/priceTable";
import type { TradeListing } from "@core/tradeListings";
import type { MarketListingActionKind, MarketSearchResult } from "../../../../shared/market.js";
import ListingRow from "./ListingRow.vue";
import ListingPeek from "./ListingPeek.vue";

const props = defineProps<{
  result: MarketSearchResult;
  priceTable: PriceTable;
  staleAfterHours: number;
  fetchesSpare: number;
  dryRun?: boolean;
  busy?: boolean;
  rateNote?: string;
}>();
const emit = defineEmits<{
  (event: "action", action: MarketListingActionKind, listing: TradeListing): void;
  (event: "load-more"): void;
  (event: "expand", account: string): void;
}>();

const sortKey = ref<LocalSortKey | "">("");
const direction = ref<"asc" | "desc">("asc");
const peeked = ref<TradeListing | null>(null);

const COLUMNS: Array<{ key: LocalSortKey | ""; label: string }> = [
  { key: "", label: "Item" },
  { key: "price", label: "Price" },
  { key: "age", label: "Listed" },
  { key: "seller", label: "Seller" },
  { key: "ilvl", label: "Numbers" },
];

const rows = computed(() => {
  const listings = sortKey.value
    ? sortListings(props.result.listings, sortKey.value, direction.value)
    : props.result.listings;
  return collapseBySeller(listings, props.result.collapsedAccounts);
});

const remaining = computed(() => Math.max(0, props.result.resultIds.length - props.result.nextOffset));

function toggleSort(key: LocalSortKey | ""): void {
  if (!key) return;
  if (sortKey.value === key) direction.value = direction.value === "asc" ? "desc" : "asc";
  else {
    sortKey.value = key;
    direction.value = "asc";
  }
}
</script>

<template>
  <section class="market-results" aria-labelledby="market-results-title">
    <div class="section-heading">
      <div>
        <h3 id="market-results-title">Listings</h3>
        <p class="muted">
          {{ props.result.listings.length }} of {{ props.result.total }} match{{ props.result.total === 1 ? "" : "es" }}
          <span v-if="props.result.cached"> · from the 60-second body cache</span>
        </p>
      </div>
      <span class="count-badge">{{ props.result.listings.length }}</span>
    </div>

    <p v-if="!props.result.listings.length" class="empty-copy">No listings match.</p>

    <div v-else class="table-scroll">
      <table class="market-table">
        <thead>
          <tr>
            <th v-for="column in COLUMNS" :key="column.label" scope="col">
              <button
                v-if="column.key"
                type="button"
                class="text-link"
                :aria-label="`Sort by ${column.label}`"
                @click="toggleSort(column.key)"
              >
                {{ column.label }}
                <span v-if="sortKey === column.key">{{ direction === "asc" ? "↑" : "↓" }}</span>
              </button>
              <span v-else>{{ column.label }}</span>
            </th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          <ListingRow
            v-for="row in rows"
            :key="row.listing.id"
            :listing="row.listing"
            :price-table="props.priceTable"
            :stale-after-hours="props.staleAfterHours"
            :hidden-siblings="row.hiddenSiblings"
            :dry-run="props.dryRun"
            :busy="props.busy"
            :rate-note="props.rateNote"
            @action="(action, listing) => emit('action', action, listing)"
            @peek="peeked = $event"
            @expand="emit('expand', $event)"
          />
        </tbody>
      </table>
    </div>

    <ListingPeek v-if="peeked" :listing="peeked" @close="peeked = null" />

    <div v-if="remaining > 0" class="button-row">
      <button type="button" class="button compact secondary" :disabled="props.busy" @click="emit('load-more')">
        Load 10 more · 1 fetch, {{ props.fetchesSpare }} spare
      </button>
      <span class="muted">{{ remaining }} id(s) left of the 100 this search kept.</span>
    </div>
  </section>
</template>

<style scoped>
.market-results {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.table-scroll {
  overflow-x: auto;
}
.market-table {
  border-collapse: collapse;
  width: 100%;
}
.market-table th,
.market-table td {
  text-align: left;
  padding: 0.4rem 0.6rem;
  border-bottom: 1px solid rgba(140, 140, 160, 0.15);
  vertical-align: top;
}
.market-table th {
  text-transform: uppercase;
  font-size: 0.72rem;
  opacity: 0.7;
}
.market-table :deep(.num) {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
</style>
