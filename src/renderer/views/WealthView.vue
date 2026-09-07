<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import {
  describeAge,
  searchObservations,
  type ValuedObservation,
} from "@core/inventoryLedger";
import type { InventoryOverviewView } from "../../shared/ipc.js";
import { getInventoryApi } from "../services/rendererApi";

const api = getInventoryApi();
const available = computed(() => api !== undefined);

const overview = ref<InventoryOverviewView | null>(null);
const loading = ref(false);
const error = ref("");
const notice = ref("");
const query = ref("");
const minExalted = ref(1);
const maxExalted = ref(5);
const excludeLocations = ref("");

function sellQuery() {
  return {
    minExalted: Math.max(0, Number(minExalted.value) || 0),
    maxExalted: Math.max(0, Number(maxExalted.value) || 0),
    excludeLocations: excludeLocations.value
      .split(",")
      .map((label) => label.trim())
      .filter(Boolean),
  };
}

async function load(persist: boolean): Promise<void> {
  if (!api) return;
  loading.value = true;
  error.value = "";
  notice.value = "";
  try {
    const next = persist ? await api.refresh(sellQuery()) : await api.overview(sellQuery());
    overview.value = next;
    if (next.error) error.value = next.error;
    if (persist && next.catalogUpserts !== undefined) {
      notice.value = `${next.catalogUpserts} catalog row(s) updated with current locations.`;
    }
    if (next.catalogError) notice.value = `Catalog mirror skipped: ${next.catalogError}`;
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "The ledger could not be read.";
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void load(false);
});

const worth = computed(() => overview.value?.worth);

const staleByLocation = computed(() => {
  const map = new Map<string, string>();
  for (const entry of overview.value?.staleness ?? []) {
    map.set(entry.location, describeAge(entry.ageMs));
  }
  return map;
});

const searchResults = computed<ValuedObservation[]>(() => {
  const valued = worth.value?.valued ?? [];
  if (!query.value.trim()) return [];
  const matches = new Set(
    searchObservations(
      valued.map((entry) => entry.observation),
      query.value,
    ),
  );
  return valued
    .filter((entry) => matches.has(entry.observation))
    .sort((a, b) => (b.valueExalted ?? 0) - (a.valueExalted ?? 0))
    .slice(0, 200);
});

const sellNames = computed(() =>
  (overview.value?.sellCandidates ?? []).map((entry) => entry.observation.name),
);

async function copySellNames(): Promise<void> {
  const text = sellNames.value.join("\n");
  if (!text) return;
  try {
    await globalThis.navigator?.clipboard?.writeText(text);
    notice.value = `Copied ${sellNames.value.length} name(s).`;
  } catch {
    notice.value = "Clipboard unavailable — select the list and copy it by hand.";
  }
}

function ex(value: number | undefined): string {
  if (value === undefined) return "—";
  return `${Math.round(value * 100) / 100} ex`;
}

function when(at: string): string {
  const date = new Date(at);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : at;
}

function copies(entry: ValuedObservation): string {
  const { observation } = entry;
  if (observation.stackCount !== undefined) return `×${observation.stackCount}`;
  return (observation.count ?? 1) > 1 ? `×${observation.count}` : "";
}

function locationLabel(location: string): string {
  return location === "bag" ? "bag (in transit)" : location;
}
</script>

<template>
  <div class="wealth-workspace">
    <section class="card wealth-hero">
      <div class="wealth-hero-copy">
        <span class="eyebrow">Ledger</span>
        <h2>Stash net worth</h2>
        <p class="muted">
          Every sort run reads each item by Ctrl+C and journals what it saw and
          where. This page prices that ledger with your
          <RouterLink to="/sort">price table</RouterLink> — a running estimate, never a
          guaranteed sale price. A tab's contents are whatever its latest scan
          showed; items last seen in the bag settle into their tabs on the next
          scan of those tabs.
        </p>
      </div>
      <div class="wealth-actions">
        <button
          type="button"
          class="button primary"
          :disabled="!available || loading"
          @click="load(true)"
        >
          {{ loading ? "Reading…" : "Refresh" }}
        </button>
        <small v-if="overview" class="muted">
          {{ overview.recordCount }} record(s) · {{ overview.observationCount }} current ·
          generated {{ when(overview.generatedAt) }}
        </small>
      </div>
    </section>

    <p v-if="!available" class="inline-notice warning">
      The Wealth page needs the desktop app — the ledger is a local file the
      sorter writes (artifacts/tab-admin/inventory.jsonl).
    </p>
    <p v-if="error" class="inline-notice danger" role="alert">{{ error }}</p>
    <p v-if="notice" class="inline-notice" role="status">{{ notice }}</p>

    <template v-if="worth">
      <section class="card" aria-labelledby="worth-totals-title">
        <div class="section-heading">
          <div>
            <span class="eyebrow">Total</span>
            <h2 id="worth-totals-title">Net worth</h2>
          </div>
        </div>
        <dl class="metric-grid wealth-metrics">
          <div>
            <dt>Exalted</dt>
            <dd class="wealth-total">{{ ex(worth.totalExalted) }}</dd>
          </div>
          <div>
            <dt>Divine</dt>
            <dd class="wealth-total">{{ worth.totalDivine }} div</dd>
          </div>
          <div>
            <dt>Rate</dt>
            <dd>{{ worth.divineRate }} ex / div</dd>
          </div>
          <div>
            <dt>Items</dt>
            <dd>{{ worth.items }} ({{ worth.priced }} priced, {{ worth.unpriced }} unpriced)</dd>
          </div>
        </dl>
        <p v-if="worth.items === 0" class="muted">
          Nothing in the ledger yet — run a sort (the Sort page's button or
          <code>npx tsx scripts/sort-gear.ts</code>) and come back.
        </p>
      </section>

      <section v-if="worth.locations.length" class="card" aria-labelledby="worth-locations-title">
        <div class="section-heading">
          <div>
            <span class="eyebrow">By location</span>
            <h2 id="worth-locations-title">Tabs and bag</h2>
          </div>
        </div>
        <div class="table-scroll">
          <table class="wealth-table">
            <thead>
              <tr>
                <th>Location</th>
                <th class="num">Items</th>
                <th class="num">Unpriced</th>
                <th class="num">Value</th>
                <th>Last scanned</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in worth.locations" :key="row.location">
                <td>{{ locationLabel(row.location) }}</td>
                <td class="num">{{ row.items }}</td>
                <td class="num">{{ row.unpriced }}</td>
                <td class="num value">{{ ex(row.valueExalted) }}</td>
                <td>
                  {{ when(row.lastScanAt) }}
                  <small class="muted">{{ staleByLocation.get(row.location) ?? "" }}</small>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section v-if="overview?.topItems.length" class="card" aria-labelledby="worth-top-title">
        <div class="section-heading">
          <div>
            <span class="eyebrow">Top 25</span>
            <h2 id="worth-top-title">Most valuable items</h2>
          </div>
        </div>
        <ol class="wealth-list">
          <li v-for="entry in overview.topItems" :key="`${entry.observation.location}-${entry.observation.fingerprint}`">
            <span class="item-copy">
              <strong>{{ entry.observation.name }} <em>{{ copies(entry) }}</em></strong>
              <small>
                {{ entry.observation.itemClass }} · {{ entry.observation.rarity || "—" }} ·
                {{ locationLabel(entry.observation.location) }} · via {{ entry.source }}
              </small>
            </span>
            <span class="item-value">{{ ex(entry.valueExalted) }}</span>
          </li>
        </ol>
      </section>

      <section class="card" aria-labelledby="worth-sell-title">
        <div class="section-heading">
          <div>
            <span class="eyebrow">Sell list</span>
            <h2 id="worth-sell-title">Candidates {{ minExalted }}–{{ maxExalted }} ex</h2>
          </div>
          <button
            type="button"
            class="button compact secondary"
            :disabled="sellNames.length === 0"
            @click="copySellNames"
          >
            Copy names
          </button>
        </div>
        <div class="form-grid compact-grid">
          <label>
            Min (ex each)
            <input v-model.number="minExalted" type="number" min="0" step="0.5" @change="load(false)" />
          </label>
          <label>
            Max (ex each)
            <input v-model.number="maxExalted" type="number" min="0" step="0.5" @change="load(false)" />
          </label>
          <label>
            Skip locations <span class="optional">(comma-separated)</span>
            <input
              v-model="excludeLocations"
              type="text"
              placeholder="Review, Shop"
              @change="load(false)"
            />
          </label>
        </div>
        <p v-if="overview && overview.sellCandidates.length === 0" class="muted">
          Nothing priced in this band. Currency and unidentified items never
          appear here; widen the band or price more entries.
        </p>
        <ul v-else class="wealth-list">
          <li
            v-for="entry in overview?.sellCandidates ?? []"
            :key="`${entry.observation.location}-${entry.observation.fingerprint}`"
          >
            <span class="item-copy">
              <strong>{{ entry.observation.name }} <em>{{ copies(entry) }}</em></strong>
              <small>
                {{ entry.observation.itemClass }} · {{ locationLabel(entry.observation.location) }}
                <template v-if="entry.observation.cells[0]">
                  · r{{ entry.observation.cells[0].row }}c{{ entry.observation.cells[0].col }}
                </template>
              </small>
            </span>
            <span class="item-value">{{ ex(entry.valueExalted) }}</span>
          </li>
        </ul>
      </section>

      <section class="card" aria-labelledby="worth-search-title">
        <div class="section-heading">
          <div>
            <span class="eyebrow">Search</span>
            <h2 id="worth-search-title">Find an item</h2>
          </div>
        </div>
        <input
          v-model="query"
          type="search"
          class="wealth-search"
          placeholder="name, base, class, rarity, tab …"
          aria-label="Search the inventory ledger"
        />
        <p v-if="query.trim() && searchResults.length === 0" class="muted">No matches.</p>
        <ul v-else-if="searchResults.length" class="wealth-list">
          <li
            v-for="entry in searchResults"
            :key="`${entry.observation.location}-${entry.observation.fingerprint}`"
          >
            <span class="item-copy">
              <strong>{{ entry.observation.name }} <em>{{ copies(entry) }}</em></strong>
              <small>
                {{ entry.observation.itemClass }} · {{ entry.observation.rarity || "—" }}
                <template v-if="entry.observation.itemLevel"> · iLvl {{ entry.observation.itemLevel }}</template>
                · {{ locationLabel(entry.observation.location) }}
                <template v-if="entry.observation.cells[0]">
                  r{{ entry.observation.cells[0].row }}c{{ entry.observation.cells[0].col }}
                </template>
                · seen {{ when(entry.observation.at) }}
              </small>
            </span>
            <span class="item-value">{{ ex(entry.valueExalted) }}</span>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>

<style scoped>
.wealth-workspace { display: flex; flex-direction: column; gap: 1rem; }
.wealth-hero { display: flex; flex-wrap: wrap; gap: 1.25rem; justify-content: space-between; align-items: flex-start; }
.wealth-hero-copy { max-width: 42rem; display: flex; flex-direction: column; gap: 0.4rem; }
.wealth-actions { display: flex; flex-direction: column; gap: 0.4rem; align-items: flex-end; }
.wealth-metrics { grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); }
.wealth-metrics dd { text-transform: none; }
.wealth-total { font-size: 1.25rem; color: #e0c46a; }
.table-scroll { overflow-x: auto; }
.wealth-table { border-collapse: collapse; width: 100%; min-width: 32rem; font-size: 0.9rem; }
.wealth-table th, .wealth-table td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid rgba(140, 140, 160, 0.15); vertical-align: top; }
.wealth-table th { font-size: 0.72rem; text-transform: uppercase; opacity: 0.7; }
.wealth-table .num { text-align: right; }
.wealth-table .value { color: #e0c46a; }
.wealth-table td small { display: block; }
.wealth-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
.wealth-list li { display: flex; gap: 0.7rem; align-items: flex-start; justify-content: space-between; border-bottom: 1px solid rgba(140, 140, 160, 0.15); padding-bottom: 0.45rem; }
.item-copy { display: flex; flex-direction: column; min-width: 0; }
.item-copy small { opacity: 0.65; }
.item-copy em { font-style: normal; opacity: 0.7; font-weight: 400; }
.item-value { flex: none; color: #e0c46a; font-variant-numeric: tabular-nums; }
.wealth-search { width: 100%; max-width: 32rem; margin-bottom: 0.6rem; }
</style>
