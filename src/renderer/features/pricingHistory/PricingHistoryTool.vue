<script setup lang="ts">
/**
 * Tools → Pricing: browse every item poe2scout prices for the current
 * league, star favorites, and read one item's timeline.
 *
 * It never sends game input and never touches trade2: rows come from the
 * Market trends cache (one paced page per category, shared with Tools →
 * Market) and from the local price table. Every number is an estimate.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import {
  ALL_CATEGORY,
  categoryLabel,
  displayPrice,
  filterRows,
  LOW_STOCK_MIN_BARS,
  LOW_STOCK_VOLUME_7D,
  MAX_FAVORITES,
  sortRows,
  type PricingRow,
  type PricingSortKey,
} from "@core/pricingHistory";
import { formatPercent } from "@core/priceTrends";
import { DEFAULT_PRICING_SETTINGS } from "../../../shared/pricingHistory.js";
import type {
  PricingHistoryView,
  PricingLeagueFile,
  PricingOverviewView,
  PricingSettings,
} from "../../../shared/pricingHistory.js";
import { formatAmount, formatDate } from "../../utils/intelligence";
import PriceTimeline from "./PriceTimeline.vue";
import PriceSparkline from "./PriceSparkline.vue";
import { getPricingApi } from "./pricingApi";

const PAGE_SIZE = 100;
const POLL_MS = 60_000;

const SORT_OPTIONS: ReadonlyArray<{ key: PricingSortKey; label: string }> = [
  { key: "name", label: "Name" },
  { key: "price", label: "Price" },
  { key: "change1d", label: "1 d" },
  { key: "change3d", label: "3 d" },
  { key: "change7d", label: "7 d" },
  { key: "volume7d", label: "Volume 7 d" },
];

const api = getPricingApi();
const route = useRoute();

const view = ref<PricingOverviewView | null>(null);
const settings = ref<PricingSettings>({ ...DEFAULT_PRICING_SETTINGS });
const loading = ref(true);
const busy = ref(false);
const error = ref("");
const search = ref("");
const visibleCount = ref(PAGE_SIZE);
const selectedKey = ref("");
const detail = ref<PricingHistoryView | null>(null);
const detailError = ref("");
const leagueFiles = ref<PricingLeagueFile[]>([]);
const pendingClear = ref(false);
const copied = ref(false);
const searchInput = ref<HTMLInputElement | null>(null);
const tableBody = ref<HTMLElement | null>(null);

let previousCategory = "";
let pollTimer: ReturnType<typeof setInterval> | undefined;
let stopSettings: (() => void) | undefined;
let stopRefreshed: (() => void) | undefined;
let requestSeq = 0;
let disposed = false;

function describeError(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

async function load(query: { refresh?: boolean; cachedOnly?: boolean } = { cachedOnly: true }): Promise<void> {
  if (!api) return;
  const seq = ++requestSeq;
  try {
    const next = await api.invoke("pricing:overview", query);
    if (disposed || seq !== requestSeq) return;
    view.value = next;
    settings.value = next.settings;
    error.value = "";
  } catch (reason) {
    if (disposed || seq !== requestSeq) return;
    error.value = describeError(reason, "Pricing history could not be loaded.");
  }
}

async function refresh(): Promise<void> {
  if (!api || busy.value) return;
  busy.value = true;
  try {
    await load({ refresh: true });
  } finally {
    if (!disposed) busy.value = false;
  }
}

async function retryLoad(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  loading.value = true;
  error.value = "";
  try {
    await load();
  } finally {
    if (!disposed) {
      loading.value = false;
      busy.value = false;
    }
  }
}

async function configure(patch: Partial<PricingSettings>): Promise<void> {
  if (!api) return;
  const optimistic = { ...settings.value, ...patch } as PricingSettings;
  settings.value = optimistic;
  try {
    const next = await api.invoke("pricing:configure", patch);
    if (disposed) return;
    settings.value = next;
  } catch (reason) {
    if (disposed) return;
    error.value = describeError(reason, "The Pricing settings could not be saved.");
  }
}

async function toggleFavorite(key: string): Promise<void> {
  if (!api) return;
  const wasFavorite = settings.value.favorites.includes(key);
  try {
    const next = await api.invoke("pricing:toggle-favorite", key);
    if (disposed) return;
    settings.value = next;
    // Main refuses silently past the cap (it only logs); say so, or the star
    // just never lights up and the click looks broken.
    if (!wasFavorite && !next.favorites.includes(key)) {
      error.value = `Favorites are capped at ${MAX_FAVORITES} — unstar one first.`;
    } else {
      error.value = "";
    }
  } catch (reason) {
    if (disposed) return;
    error.value = describeError(reason, "The favorite could not be saved.");
  }
}

async function select(key: string): Promise<void> {
  if (!api) return;
  selectedKey.value = key;
  detail.value = null;
  detailError.value = "";
  try {
    const next = await api.invoke("pricing:history", key);
    if (disposed || selectedKey.value !== key) return;
    detail.value = next ?? null;
    if (!next) detailError.value = "No bars stored for this item yet.";
  } catch (reason) {
    if (disposed) return;
    detailError.value = describeError(reason, "That item's history could not be loaded.");
  }
}

async function loadLeagues(): Promise<void> {
  if (!api) return;
  try {
    const next = await api.invoke("pricing:leagues");
    if (disposed) return;
    leagueFiles.value = next;
  } catch {
    if (!disposed) leagueFiles.value = [];
  }
}

async function clearHistory(): Promise<void> {
  if (!api || busy.value) return;
  if (!pendingClear.value) {
    pendingClear.value = true;
    return;
  }
  pendingClear.value = false;
  busy.value = true;
  try {
    await api.invoke("pricing:clear-history");
    if (disposed) return;
    await Promise.all([load(), loadLeagues()]);
  } catch (reason) {
    if (disposed) return;
    error.value = describeError(reason, "The local history could not be cleared.");
  } finally {
    if (!disposed) busy.value = false;
  }
}

/** Renderer-side clipboard only: main never writes the clipboard for us. */
async function copyName(): Promise<void> {
  const name = detail.value?.name ?? selectedRow.value?.name ?? "";
  if (!name) return;
  try {
    await navigator.clipboard.writeText(name);
    copied.value = true;
    setTimeout(() => {
      if (!disposed) copied.value = false;
    }, 1_500);
  } catch (reason) {
    error.value = describeError(reason, "The name could not be copied.");
  }
}

function selectCategory(id: string): void {
  visibleCount.value = PAGE_SIZE;
  // A category the user picked by hand wins over the one the search box
  // remembered; otherwise clearing the search would yank them back.
  previousCategory = "";
  void configure({ category: id });
}

function setSortKey(key: string): void {
  const match = SORT_OPTIONS.find((option) => option.key === key);
  if (!match) return;
  void configure({ sort: { key: match.key, direction: settings.value.sort.direction } });
}

function toggleDirection(): void {
  void configure({
    sort: {
      key: settings.value.sort.key,
      direction: settings.value.sort.direction === "asc" ? "desc" : "asc",
    },
  });
}

/**
 * PoE Overlay's global search finds items across every category; typing
 * therefore switches the strip to All and restores the previous category
 * when the field is cleared.
 */
watch(search, (next, previous) => {
  visibleCount.value = PAGE_SIZE;
  if (next.trim() && !previous.trim() && settings.value.category !== ALL_CATEGORY) {
    previousCategory = settings.value.category;
    void configure({ category: ALL_CATEGORY });
    return;
  }
  if (!next.trim() && previous.trim() && previousCategory) {
    const restore = previousCategory;
    previousCategory = "";
    void configure({ category: restore });
  }
});

/** "/" anywhere in the tool jumps to the search field (never while typing). */
function onToolKeydown(event: KeyboardEvent): void {
  if (event.key !== "/" || event.ctrlKey || event.altKey || event.metaKey) return;
  const target = event.target as HTMLElement | null;
  const tag = target?.tagName?.toLowerCase() ?? "";
  if (tag === "input" || tag === "select" || tag === "textarea") return;
  event.preventDefault();
  searchInput.value?.focus();
}

function setDisplayCurrency(value: string): void {
  const mode =
    value === "exalted" || value === "divine" ? value : ("auto" as PricingSettings["displayCurrency"]);
  void configure({ displayCurrency: mode });
}

function setHideLowStock(checked: boolean): void {
  visibleCount.value = PAGE_SIZE;
  void configure({ hideLowStock: checked });
}

function setKeepHistory(checked: boolean): void {
  void configure({ keepHistory: checked });
}

function moveRowFocus(index: number, delta: number): void {
  const buttons = tableBody.value?.querySelectorAll<HTMLButtonElement>("button.row-name");
  const next = buttons?.item(index + delta);
  next?.focus();
}

/**
 * The server's rows carry the favorite flags of the overview that produced
 * them; a star clicked since then only lives in `settings`. Correct them once
 * so the table, the hidden-row count and the Favorites count all agree.
 */
const decoratedRows = computed<PricingRow[]>(
  () =>
    view.value?.rows.map((row) => ({
      ...row,
      favorite: settings.value.favorites.includes(row.key),
    })) ?? [],
);

const filtered = computed(() =>
  filterRows(decoratedRows.value, {
    category: settings.value.category,
    search: search.value,
    hideLowStock: settings.value.hideLowStock,
  }),
);

const rows = computed<PricingRow[]>(() => sortRows(filtered.value.rows, settings.value.sort));

const hiddenLowStock = computed(() => filtered.value.hiddenLowStock);

const visibleRows = computed(() => rows.value.slice(0, visibleCount.value));

const favoriteCount = computed(() => decoratedRows.value.filter((row) => row.favorite).length);

const selectedRow = computed(() => rows.value.find((row) => row.key === selectedKey.value));

const statusText = computed(() => {
  const current = view.value;
  if (!current) return "";
  if (current.refreshing || busy.value) return "Fetching price history from poe2scout…";
  if (!current.ok) return current.error ? "" : "No price history yet.";
  return `${current.league ?? "?"} · ${current.rows.length} items · fetched ${formatDate(current.fetchedAt)}`;
});

const rateNote = computed(() => {
  const current = view.value;
  if (!current) return "";
  const source =
    current.divineRateSource === "feed"
      ? "poe2scout divine"
      : current.divineRateSource === "price-table"
        ? "your price table"
        : "fallback";
  return `1 div ≈ ${formatAmount(current.divineRate)} ex (${source})`;
});

function priceText(row: PricingRow): string {
  return displayPrice(row.current, view.value?.divineRate ?? 0, settings.value.displayCurrency).text;
}

function changeClass(value: number | undefined): string {
  if (value === undefined || value === 0) return "";
  return value > 0 ? "rising" : "falling";
}

onMounted(async () => {
  const raw = route?.query?.q;
  const initial = Array.isArray(raw) ? raw[0] : raw;
  if (typeof initial === "string" && initial.trim()) search.value = initial.trim();
  if (api) {
    stopSettings = api.on("pricing:settings", (next) => {
      if (!disposed) settings.value = next;
    });
    // A refresh started anywhere (here, or Tools → Market sharing the same
    // paced cache) repaints us straight away instead of after the next poll.
    stopRefreshed = api.on("pricing:refreshed", () => {
      if (!disposed && !busy.value) void load();
    });
  }
  await load();
  await loadLeagues();
  if (!disposed) {
    loading.value = false;
    // The poll must yield to a user-initiated refresh: its cachedOnly answer
    // returns from the old cache long before the fetch lands, and bumping the
    // request sequence would drop the refresh the user is waiting for.
    pollTimer = setInterval(() => {
      if (busy.value) return;
      void load();
    }, POLL_MS);
  }
});

onBeforeUnmount(() => {
  disposed = true;
  requestSeq += 1;
  if (pollTimer) clearInterval(pollTimer);
  stopSettings?.();
  stopRefreshed?.();
});
</script>

<template>
  <section
    class="card tool-panel pricing-tool"
    aria-labelledby="pricing-title"
    @keydown="onToolKeydown"
  >
    <div class="section-heading">
      <div>
        <span class="eyebrow">Market intelligence</span>
        <h2 id="pricing-title">Pricing history</h2>
      </div>
      <span class="status-chip neutral">Estimates, never guarantees</span>
    </div>
    <p class="muted">
      Every item poe2scout prices for your league, with daily bars kept locally so the timeline
      grows past the seven days the feed serves. It sends no game input, makes no trade2 request
      and shares one paced refresh with Tools → Market.
    </p>

    <div v-if="!api" class="state-panel compact-state">
      <span class="state-icon" aria-hidden="true">◇</span>
      <strong>Pricing history needs the desktop app</strong>
      <p>This preview has no poe2scout bridge.</p>
    </div>

    <div v-else-if="loading" class="state-panel compact-state" aria-live="polite">
      <span class="spinner" aria-hidden="true" />
      <p>Loading price history…</p>
    </div>

    <div v-else-if="!view" class="state-panel compact-state">
      <span class="state-icon" aria-hidden="true">!</span>
      <strong>Pricing history could not be loaded</strong>
      <p role="alert">{{ error || "The desktop app did not answer." }}</p>
      <button type="button" class="button secondary compact" :disabled="busy" @click="retryLoad">
        Retry
      </button>
    </div>

    <template v-else>
      <div class="button-row">
        <button
          type="button"
          class="button secondary compact"
          :disabled="busy || view.refreshing"
          @click="refresh"
        >
          {{ busy || view.refreshing ? "Refreshing…" : "Refresh" }}
        </button>
        <span class="muted" role="status">{{ statusText }}</span>
        <span v-if="view.stale" class="status-chip warning">older than 12 h</span>
        <span v-if="error" class="danger-text" role="alert">{{ error }}</span>
      </div>

      <div v-if="!view.ok" class="state-panel compact-state">
        <span class="state-icon" aria-hidden="true">▽</span>
        <strong>No price history yet</strong>
        <p>Refresh pulls one page per category from poe2scout (paced, ~12 requests).</p>
        <p v-if="view.error" role="alert" class="danger-text">{{ view.error }}</p>
      </div>
      <p v-else-if="view.error" class="inline-notice warning">
        Last refresh failed: {{ view.error }}
      </p>

      <nav class="category-strip" aria-label="Categories">
        <button
          type="button"
          class="button ghost compact"
          :class="{ selected: settings.category === 'all' }"
          :aria-pressed="settings.category === 'all'"
          @click="selectCategory('all')"
        >
          All <span class="count-badge">{{ view.rows.length }}</span>
        </button>
        <button
          type="button"
          class="button ghost compact"
          :class="{ selected: settings.category === 'favorites' }"
          :aria-pressed="settings.category === 'favorites'"
          @click="selectCategory('favorites')"
        >
          ★ Favorites <span class="count-badge">{{ favoriteCount }}</span>
        </button>
        <button
          v-for="category in view.categories"
          :key="category.id"
          type="button"
          class="button ghost compact"
          :class="{ selected: settings.category === category.id }"
          :aria-pressed="settings.category === category.id"
          @click="selectCategory(category.id)"
        >
          {{ category.label }} <span class="count-badge">{{ category.count }}</span>
        </button>
      </nav>

      <div class="pricing-toolbar">
        <label class="search-field">
          <span class="sr-only">Search every category</span>
          <input
            ref="searchInput"
            v-model="search"
            type="search"
            placeholder="Search every category…"
            @keydown.esc="search = ''"
          />
        </label>
        <label>
          Sort
          <select :value="settings.sort.key" @change="setSortKey(($event.target as HTMLSelectElement).value)">
            <option v-for="option in SORT_OPTIONS" :key="option.key" :value="option.key">
              {{ option.label }}
            </option>
          </select>
        </label>
        <button
          type="button"
          class="icon-button"
          :aria-label="settings.sort.direction === 'asc' ? 'Sort descending' : 'Sort ascending'"
          @click="toggleDirection"
        >
          {{ settings.sort.direction === "asc" ? "↑" : "↓" }}
        </button>
        <label>
          Show prices in
          <select
            :value="settings.displayCurrency"
            @change="setDisplayCurrency(($event.target as HTMLSelectElement).value)"
          >
            <option value="auto">Auto (div over 1 div)</option>
            <option value="exalted">Exalted</option>
            <option value="divine">Divine</option>
          </select>
        </label>
        <label class="inline-toggle">
          <input
            type="checkbox"
            :checked="settings.hideLowStock"
            @change="setHideLowStock(($event.target as HTMLInputElement).checked)"
          />
          Hide low-stock
        </label>
      </div>

      <div v-if="!visibleRows.length" class="state-panel compact-state">
        <span class="state-icon" aria-hidden="true">⌕</span>
        <strong>No items match</strong>
        <p v-if="hiddenLowStock">
          {{ hiddenLowStock }} low-stock row{{ hiddenLowStock === 1 ? "" : "s" }} hidden — untick
          “Hide low-stock” to see {{ hiddenLowStock === 1 ? "it" : "them" }}.
        </p>
        <p v-else>Clear the search or pick another category.</p>
      </div>

      <div v-else class="table-scroll">
        <table class="pricing-table">
          <thead>
            <tr>
              <th scope="col"><span class="sr-only">Favorite</span>★</th>
              <th scope="col">Item</th>
              <th scope="col">Category</th>
              <th scope="col" class="num">Price</th>
              <th scope="col" class="num">1 d</th>
              <th scope="col" class="num">3 d</th>
              <th scope="col" class="num">7 d</th>
              <th scope="col" class="num">Volume 7 d</th>
              <th scope="col">7 days</th>
            </tr>
          </thead>
          <tbody ref="tableBody">
            <tr
              v-for="(row, index) in visibleRows"
              :key="row.key"
              :data-row-key="row.key"
              :class="{ selected: row.key === selectedKey }"
            >
              <td>
                <button
                  type="button"
                  class="icon-button star"
                  :aria-pressed="row.favorite"
                  :aria-label="row.favorite ? `Unstar ${row.name}` : `Star ${row.name}`"
                  @click="toggleFavorite(row.key)"
                >
                  {{ row.favorite ? "★" : "☆" }}
                </button>
              </td>
              <td>
                <button
                  type="button"
                  class="text-link row-name"
                  @click="select(row.key)"
                  @keydown.down.prevent="moveRowFocus(index, 1)"
                  @keydown.up.prevent="moveRowFocus(index, -1)"
                >
                  {{ row.name }}
                </button>
                <small v-if="row.baseType && row.baseType !== row.name" class="muted">{{ row.baseType }}</small>
              </td>
              <td>{{ categoryLabel(row.category) }}</td>
              <td class="num">
                {{ priceText(row) }}
                <small v-if="!row.hasHistory" class="muted">no history</small>
                <small v-else-if="row.lowStock" class="muted">low stock</small>
              </td>
              <td class="num" :class="changeClass(row.change1d)">{{ formatPercent(row.change1d) }}</td>
              <td class="num" :class="changeClass(row.change3d)">{{ formatPercent(row.change3d) }}</td>
              <td class="num" :class="changeClass(row.change7d)">{{ formatPercent(row.change7d) }}</td>
              <td class="num">
                {{ row.hasHistory ? formatAmount(row.volume7d) : "—" }}
                <small v-if="row.liquidity" class="muted">{{ row.liquidity }}</small>
              </td>
              <td><PriceSparkline :values="row.spark" :tone="row.trend ?? 'stable'" /></td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <td colspan="9">
                <span class="muted">
                  Showing {{ visibleRows.length }} of {{ rows.length }}
                  <template v-if="hiddenLowStock">· {{ hiddenLowStock }} low-stock rows hidden</template>
                  · {{ rateNote }}
                </span>
                <button
                  v-if="rows.length > visibleRows.length"
                  type="button"
                  class="button ghost compact"
                  @click="visibleCount += PAGE_SIZE"
                >
                  Show more
                </button>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <section v-if="selectedKey" class="pricing-detail">
        <h3>{{ detail?.name ?? selectedRow?.name ?? selectedKey }}</h3>
        <p v-if="detailError" class="inline-notice warning" role="status">{{ detailError }}</p>
        <dl v-if="selectedRow" class="property-list">
          <div><dt>Current</dt><dd>{{ priceText(selectedRow) }}</dd></div>
          <div><dt>1 d</dt><dd>{{ formatPercent(selectedRow.change1d) }}</dd></div>
          <div><dt>3 d</dt><dd>{{ formatPercent(selectedRow.change3d) }}</dd></div>
          <div><dt>7 d</dt><dd>{{ formatPercent(selectedRow.change7d) }}</dd></div>
          <div><dt>Volatility 7 d</dt><dd>{{ formatAmount(selectedRow.volatility7d) }}</dd></div>
          <div><dt>Volume 7 d</dt><dd>{{ formatAmount(selectedRow.volume7d) }} · {{ selectedRow.liquidity ?? "unknown" }}</dd></div>
          <div><dt>Bars stored</dt><dd>{{ detail?.points.length ?? 0 }} ({{ detail?.source ?? "none" }})</dd></div>
          <div v-if="detail?.since"><dt>Collected since</dt><dd>{{ formatDate(detail.since) }}</dd></div>
        </dl>
        <PriceTimeline
          v-if="detail && detail.points.length"
          :points="detail.points"
          :rate="view.divineRate"
          :mode="settings.displayCurrency"
          :name="detail.name"
        />
        <div class="button-row">
          <button type="button" class="button secondary compact" @click="copyName">
            {{ copied ? "Copied" : "Copy name" }}
          </button>
          <button type="button" class="button ghost compact" @click="selectedKey = ''">Close</button>
        </div>
      </section>

      <details class="advanced-options">
        <summary>Expert options</summary>
        <div class="form-grid">
          <label class="inline-toggle">
            <input
              type="checkbox"
              :checked="settings.keepHistory"
              @change="setKeepHistory(($event.target as HTMLInputElement).checked)"
            />
            Keep collecting daily bars locally
          </label>
        </div>
        <dl v-if="view.history" class="property-list">
          <div><dt>History file</dt><dd>{{ view.history.file }}</dd></div>
          <div><dt>Collected since</dt><dd>{{ formatDate(view.history.since) }}</dd></div>
          <div><dt>Items · bars</dt><dd>{{ view.history.keys }} · {{ view.history.bars }}</dd></div>
          <div><dt>File size</dt><dd>{{ formatAmount(Math.round(view.history.bytes / 1024)) }} KB</dd></div>
        </dl>
        <p v-else class="empty-copy">No local history stored for this league yet.</p>
        <p v-if="view.history && !settings.keepHistory" class="muted">
          Collection is paused — the bars above stay on disk until you clear them.
        </p>
        <p v-if="view.historyError" class="inline-notice warning" role="status">
          The history file could not be written: {{ view.historyError }}
        </p>
        <ul v-if="leagueFiles.length" class="league-list">
          <li v-for="file in leagueFiles" :key="file.file">
            {{ file.league }} — {{ file.keys }} items, {{ file.bars }} bars since
            {{ formatDate(file.since) }}
          </li>
        </ul>
        <div class="button-row">
          <button type="button" class="button danger compact" :disabled="busy" @click="clearHistory">
            {{ pendingClear ? "Confirm: delete every history file" : "Clear local history" }}
          </button>
          <button
            v-if="pendingClear"
            type="button"
            class="button ghost compact"
            @click="pendingClear = false"
          >
            Cancel
          </button>
        </div>
      </details>

      <p class="disclaimer">
        Prices are poe2scout's daily medians for your league — estimates, never guaranteed sale
        prices. The newest bar keeps moving until its day closes, low-stock rows (under
        {{ LOW_STOCK_VOLUME_7D }} units over 7 days, or fewer than {{ LOW_STOCK_MIN_BARS }} bars)
        are hidden by default, and history only exists from the first refresh this app ran.
      </p>
    </template>
  </section>
</template>

<style scoped>
.pricing-tool {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}
.pricing-tool h3 {
  margin: 0.4rem 0 0.2rem;
  font-size: 1rem;
}
.category-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}
.category-strip .selected {
  border-color: var(--gold);
  color: var(--gold-bright);
}
.pricing-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 0.6rem;
}
.pricing-toolbar label {
  display: grid;
  gap: 0.32rem;
}
.pricing-toolbar .search-field {
  flex: 1 1 16rem;
}
.table-scroll {
  overflow-x: auto;
}
.pricing-table {
  width: 100%;
  min-width: 52rem;
  border-collapse: collapse;
  font-variant-numeric: tabular-nums;
}
.pricing-table th,
.pricing-table td {
  text-align: left;
  padding: 0.25rem 0.35rem;
  border-bottom: 1px solid rgba(140, 140, 160, 0.2);
  vertical-align: top;
}
.pricing-table th {
  font-size: 0.72rem;
  text-transform: uppercase;
  opacity: 0.7;
}
.pricing-table td.num,
.pricing-table th.num {
  text-align: right;
}
.pricing-table tbody tr.selected {
  background: var(--gold-soft);
}
.pricing-table td:nth-child(2) {
  min-width: 14rem;
}
.pricing-table small {
  display: block;
}
.pricing-table .star {
  width: 26px;
  min-width: 26px;
  min-height: 26px;
}
.rising {
  color: #3aa76d;
}
.falling {
  color: #d9534f;
}
.pricing-detail {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  border-top: 1px solid var(--line);
  padding-top: 0.6rem;
}
.league-list {
  list-style: none;
  margin: 0.4rem 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.75rem;
  color: var(--text-muted);
}
</style>
