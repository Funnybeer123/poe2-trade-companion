<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { PRICE_TABLE_SCHEMA_VERSION, type PriceEntry, type PriceTable } from "@core/priceTable";
import { isFeedEntry } from "@core/priceFeed";
import {
  getPriceFeedApi,
  rendererApi,
  type PriceFeedStatusView,
} from "../services/rendererApi";

interface EditableEntry {
  id: string;
  name: string;
  baseType: string;
  itemClass: string;
  rarity: string;
  minItemLevel: string;
  value: number;
  note: string;
}

const loading = ref(true);
const saving = ref(false);
const message = ref("");
const error = ref("");
const currency = ref("exalted");
const entries = ref<EditableEntry[]>([]);

const feedApi = getPriceFeedApi();
const feedStatus = ref<PriceFeedStatusView | null>(null);
const feedBusy = ref(false);
const feedText = computed(() => {
  const status = feedStatus.value;
  if (!status) return "";
  if (status.refreshing || feedBusy.value) return "Refreshing market prices…";
  if (status.lastError) return `Market feed error: ${status.lastError}`;
  if (!status.feedEntryCount) {
    return "No market prices loaded yet — Refresh pulls live poe2scout prices for currency and uniques.";
  }
  const league = status.resolvedLeague ?? status.config.league;
  const age =
    status.feedAgeHours !== undefined
      ? status.feedAgeHours < 1
        ? "under an hour old"
        : `${Math.round(status.feedAgeHours)}h old`
      : "age unknown";
  return `${status.feedEntryCount} market prices · ${league} · ${age} · manual rows are never overwritten.`;
});

async function refreshFeedStatus(): Promise<void> {
  if (!feedApi) return;
  feedStatus.value = await feedApi.status();
}

async function refreshFeed(): Promise<void> {
  if (!feedApi) return;
  feedBusy.value = true;
  try {
    feedStatus.value = await feedApi.refresh();
  } finally {
    feedBusy.value = false;
  }
}

let unsubscribe: (() => void) | undefined;
let nextId = 0;

/** Feed-owned rows: read-only here, replaced wholesale by the next refresh. */
const feedEntries = ref<PriceEntry[]>([]);
const feedQuery = ref("");
const visibleFeedEntries = computed(() => {
  const query = feedQuery.value.trim().toLowerCase();
  const rows = query
    ? feedEntries.value.filter((entry) =>
        `${entry.match.name ?? ""} ${entry.match.baseType ?? ""} ${entry.note ?? ""}`
          .toLowerCase()
          .includes(query),
      )
    : feedEntries.value;
  return [...rows].sort((a, b) => b.value - a.value).slice(0, 50);
});

function applyTable(table: PriceTable): void {
  currency.value = table.currency;
  feedEntries.value = table.entries.filter((entry) => isFeedEntry(entry));
  entries.value = table.entries
    .filter((entry) => !isFeedEntry(entry))
    .map((entry) => ({
      id: entry.id,
      name: entry.match.name ?? "",
      baseType: entry.match.baseType ?? "",
      itemClass: entry.match.itemClass ?? "",
      rarity: entry.match.rarity ?? "",
      minItemLevel: entry.match.minItemLevel !== undefined ? String(entry.match.minItemLevel) : "",
      value: entry.value,
      note: entry.note ?? "",
    }));
}

onMounted(async () => {
  try {
    applyTable(await rendererApi.intelligence.prices.get());
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "The price table could not be loaded.";
  } finally {
    loading.value = false;
  }
  unsubscribe = rendererApi.intelligence.prices.onChanged(applyTable);
  void refreshFeedStatus();
});

onBeforeUnmount(() => unsubscribe?.());

function addEntry(): void {
  nextId += 1;
  entries.value = [
    ...entries.value,
    {
      id: `new-${Date.now()}-${nextId}`,
      name: "",
      baseType: "",
      itemClass: "",
      rarity: "",
      minItemLevel: "",
      value: 1,
      note: "",
    },
  ];
}

function removeEntry(index: number): void {
  entries.value = entries.value.filter((_, i) => i !== index);
}

async function save(): Promise<void> {
  saving.value = true;
  message.value = "";
  error.value = "";
  try {
    const table: PriceTable = {
      schemaVersion: PRICE_TABLE_SCHEMA_VERSION,
      currency: currency.value.trim() || "exalted",
      entries: [
        ...entries.value.map((entry) => ({
          id: entry.id,
          match: {
            ...(entry.name.trim() ? { name: entry.name.trim() } : {}),
            ...(entry.baseType.trim() ? { baseType: entry.baseType.trim() } : {}),
            ...(entry.itemClass.trim() ? { itemClass: entry.itemClass.trim() } : {}),
            ...(entry.rarity.trim() ? { rarity: entry.rarity.trim() } : {}),
            ...(entry.minItemLevel.trim()
              ? { minItemLevel: Number(entry.minItemLevel) || 0 }
              : {}),
          },
          value: Number(entry.value) || 0,
          ...(entry.note.trim() ? { note: entry.note.trim() } : {}),
        })),
        // Feed rows ride along untouched — the editor only owns manual rows.
        ...feedEntries.value,
      ],
    };
    applyTable(await rendererApi.intelligence.prices.save(table));
    message.value = "Price table saved.";
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "Saving the price table failed.";
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section class="card price-editor" aria-labelledby="price-editor-title">
    <div class="section-heading">
      <div>
        <span class="eyebrow">Local prices</span>
        <h2 id="price-editor-title">Price table</h2>
      </div>
      <span class="count-badge">{{ entries.length }}</span>
    </div>
    <p class="muted">
      The only price signal automation trusts — an entry matching an item
      outranks every tier rule. Values are in
      <input
        v-model="currency"
        class="currency-input"
        type="text"
        aria-label="Price table currency"
      />.
    </p>
    <div v-if="feedApi" class="button-row feed-strip">
      <button
        type="button"
        class="button secondary compact"
        :disabled="feedBusy || feedStatus?.refreshing"
        @click="refreshFeed"
      >
        {{ feedBusy || feedStatus?.refreshing ? "Refreshing…" : "Refresh market prices" }}
      </button>
      <span class="muted" role="status">{{ feedText }}</span>
    </div>
    <p v-else class="muted">
      Live market prices need the desktop app; this preview only edits the manual table.
    </p>

    <div v-if="loading" class="state-panel compact-state" aria-live="polite">
      <span class="spinner" aria-hidden="true" />
      <p>Loading the price table…</p>
    </div>

    <template v-else>
      <div class="price-table-scroll">
        <table class="price-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Base type</th>
              <th>Rarity</th>
              <th>Min iLvl</th>
              <th>Value</th>
              <th>Note</th>
              <th><span class="sr-only">Remove</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(entry, index) in entries" :key="entry.id">
              <td><input v-model="entry.name" type="text" placeholder="Divine Orb" /></td>
              <td><input v-model="entry.baseType" type="text" placeholder="—" /></td>
              <td><input v-model="entry.rarity" type="text" placeholder="Unique" /></td>
              <td><input v-model="entry.minItemLevel" type="text" inputmode="numeric" placeholder="—" /></td>
              <td><input v-model.number="entry.value" type="number" min="0" step="0.5" /></td>
              <td><input v-model="entry.note" type="text" /></td>
              <td>
                <button
                  type="button"
                  class="icon-button"
                  :aria-label="`Remove price entry ${index + 1}`"
                  @click="removeEntry(index)"
                >
                  ×
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="button-row">
        <button type="button" class="button secondary compact" @click="addEntry">+ entry</button>
        <button type="button" class="button primary" :disabled="saving" @click="save">
          {{ saving ? "Saving…" : "Save prices" }}
        </button>
        <span v-if="message" class="success-text" role="status">{{ message }}</span>
        <span v-if="error" class="danger-text" role="alert">{{ error }}</span>
      </div>

      <details v-if="feedEntries.length" class="advanced-options">
        <summary>Market prices from the feed ({{ feedEntries.length }}) — read-only</summary>
        <label class="search-field">
          <span class="sr-only">Search market prices</span>
          <span aria-hidden="true">⌕</span>
          <input v-model="feedQuery" type="search" placeholder="Divine Orb, Temporalis…" />
        </label>
        <div class="price-table-scroll">
          <table class="price-table">
            <thead>
              <tr><th>Name</th><th>Base type</th><th>Value</th><th>Source</th></tr>
            </thead>
            <tbody>
              <tr v-for="entry in visibleFeedEntries" :key="entry.id">
                <td>{{ entry.match.name }}</td>
                <td>{{ entry.match.baseType ?? "—" }}</td>
                <td>{{ entry.value }}</td>
                <td class="muted">{{ entry.note }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="muted">
          Showing {{ visibleFeedEntries.length }} of {{ feedEntries.length }} — refine the search
          to find more. A manual row for the same item always wins at lookup time.
        </p>
      </details>
    </template>
  </section>
</template>

<style scoped>
.price-editor { display: flex; flex-direction: column; gap: 0.9rem; }
.currency-input { width: 6.5rem; display: inline-block; }
.price-table-scroll { overflow-x: auto; }
.price-table { border-collapse: collapse; width: 100%; min-width: 40rem; }
.price-table th, .price-table td { text-align: left; padding: 0.25rem 0.35rem; border-bottom: 1px solid rgba(140, 140, 160, 0.2); }
.price-table input { width: 100%; min-width: 4rem; }
</style>
