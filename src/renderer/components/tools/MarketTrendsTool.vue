<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import {
  farmRanking,
  formatPercent,
  stackAdvice,
  type StackAdvice,
  type TrendReport,
} from "@core/priceTrends";
import type { PriceTable } from "@core/priceTable";
import { getMarketApi, rendererApi, type MarketTrendsView } from "../../services/rendererApi";
import { formatAmount, formatDate } from "../../utils/intelligence";

const api = getMarketApi();
const view = ref<MarketTrendsView | null>(null);
const priceTable = ref<PriceTable | null>(null);
const loading = ref(true);
const busy = ref(false);
const error = ref("");
let disposed = false;

async function load(refresh: boolean): Promise<void> {
  if (!api || busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const next = refresh ? await api.refresh() : await api.trends();
    if (disposed) return;
    view.value = next;
    if (next.error && !next.ok) error.value = next.error;
  } catch (reason) {
    if (disposed) return;
    error.value = reason instanceof Error ? reason.message : "Market trends could not be loaded.";
  } finally {
    busy.value = false;
  }
}

onMounted(async () => {
  try {
    const table = await rendererApi.intelligence.prices.get();
    if (!disposed) priceTable.value = table;
  } catch {
    priceTable.value = null;
  }
  await load(false);
  loading.value = false;
});

onBeforeUnmount(() => {
  disposed = true;
});

const trends = computed<TrendReport[]>(() => view.value?.trends ?? []);

const statusText = computed(() => {
  const current = view.value;
  if (!current) return "";
  if (current.refreshing || busy.value) return "Fetching price history from poe2scout…";
  // A failed load's message is the alert below; do not print it twice.
  if (!current.ok) return current.error ? "" : "No price history yet — Refresh pulls 7 days of daily prices.";
  const stale = current.stale ? " · older than 12 h, refresh when convenient" : "";
  const warning = current.error ? ` · last refresh failed: ${current.error}` : "";
  return `${current.league ?? "?"} · ${current.trends.length} items · fetched ${formatDate(current.fetchedAt)}${stale}${warning}`;
});

const MOVERS = 8;

const rising = computed(() =>
  trends.value
    .filter((trend) => trend.change3d !== undefined && trend.change3d > 0)
    .sort((a, b) => (b.change3d ?? 0) - (a.change3d ?? 0))
    .slice(0, MOVERS),
);

const falling = computed(() =>
  trends.value
    .filter((trend) => trend.change3d !== undefined && trend.change3d < 0)
    .sort((a, b) => (a.change3d ?? 0) - (b.change3d ?? 0))
    .slice(0, MOVERS),
);

interface StackRow {
  trend: TrendReport;
  advice: StackAdvice;
}

const VERDICT_ORDER: Record<StackAdvice["verdict"], number> = { sell: 0, hold: 1, neutral: 2 };

/** Every currency the price table names (manual or feed) that has a trend. */
const stackRows = computed<StackRow[]>(() => {
  const table = priceTable.value;
  if (!table) return [];
  const byName = new Map(trends.value.map((trend) => [trend.name.toLowerCase(), trend] as const));
  const seen = new Set<string>();
  const rows: StackRow[] = [];
  for (const entry of table.entries) {
    const name = entry.match.name?.trim().toLowerCase();
    if (!name || seen.has(name)) continue;
    if (entry.match.rarity?.toLowerCase() === "unique") continue;
    const trend = byName.get(name);
    if (!trend || trend.unique) continue;
    seen.add(name);
    rows.push({ trend, advice: stackAdvice(trend) });
  }
  return rows.sort(
    (a, b) =>
      VERDICT_ORDER[a.advice.verdict] - VERDICT_ORDER[b.advice.verdict] ||
      Math.abs(b.trend.change3d ?? 0) - Math.abs(a.trend.change3d ?? 0),
  );
});

const farm = computed(() =>
  farmRanking(trends.value, { limit: 10, ...(priceTable.value ? { priceTable: priceTable.value } : {}) }),
);

function arrow(trend: TrendReport): string {
  return trend.trend === "rising" ? "▲" : trend.trend === "falling" ? "▼" : "▸";
}

function verdictChip(verdict: StackAdvice["verdict"]): string {
  return verdict === "hold" ? "safe" : verdict === "sell" ? "warning" : "neutral";
}
</script>

<template>
  <section class="card tool-panel market-tool" aria-labelledby="market-title">
    <div class="section-heading">
      <div>
        <span class="eyebrow">Market intelligence</span>
        <h2 id="market-title">Trends, stacks &amp; farming</h2>
      </div>
      <span class="status-chip neutral">Estimates, never guarantees</span>
    </div>
    <p class="muted">
      Seven days of daily poe2scout prices for currency-style items. Momentum over 3 days
      decides hold / sell; price × 7-day volume ranks what is worth farming.
    </p>

    <div v-if="!api" class="state-panel compact-state">
      <span class="state-icon" aria-hidden="true">◇</span>
      <strong>Market trends need the desktop app</strong>
      <p>This preview has no poe2scout bridge.</p>
    </div>

    <template v-else>
      <div class="button-row">
        <button
          type="button"
          class="button secondary compact"
          :disabled="busy || view?.refreshing"
          @click="load(true)"
        >
          {{ busy || view?.refreshing ? "Refreshing…" : "Refresh" }}
        </button>
        <span class="muted" role="status">{{ statusText }}</span>
        <span v-if="error" class="danger-text" role="alert">{{ error }}</span>
      </div>

      <div v-if="loading" class="state-panel compact-state" aria-live="polite">
        <span class="spinner" aria-hidden="true" />
        <p>Loading price history…</p>
      </div>

      <template v-else-if="trends.length">
        <div class="movers">
          <div>
            <h3>Rising · 3 d</h3>
            <ol class="mover-list">
              <li v-for="trend in rising" :key="trend.key">
                <span class="mover-name">{{ trend.name }}</span>
                <span class="mover-change rising">▲ {{ formatPercent(trend.change3d) }}</span>
                <small class="muted">{{ formatAmount(trend.current) }} ex · {{ trend.liquidity }}</small>
              </li>
              <li v-if="!rising.length" class="muted">Nothing rising more than a rounding error.</li>
            </ol>
          </div>
          <div>
            <h3>Falling · 3 d</h3>
            <ol class="mover-list">
              <li v-for="trend in falling" :key="trend.key">
                <span class="mover-name">{{ trend.name }}</span>
                <span class="mover-change falling">▼ {{ formatPercent(trend.change3d) }}</span>
                <small class="muted">{{ formatAmount(trend.current) }} ex · {{ trend.liquidity }}</small>
              </li>
              <li v-if="!falling.length" class="muted">Nothing falling.</li>
            </ol>
          </div>
        </div>

        <h3>Stack advice</h3>
        <p v-if="!stackRows.length" class="muted">
          No currency in the price table has price history yet — refresh market prices in
          the price table, then refresh here.
        </p>
        <div v-else class="table-scroll">
          <table class="trend-table">
            <thead>
              <tr>
                <th>Currency</th>
                <th>Now (ex)</th>
                <th>1 d</th>
                <th>3 d</th>
                <th>7 d</th>
                <th>Volume 7 d</th>
                <th>Verdict</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in stackRows" :key="row.trend.key">
                <td>{{ row.trend.name }}</td>
                <td>{{ formatAmount(row.trend.current) }}</td>
                <td :class="row.trend.change1d && row.trend.change1d > 0 ? 'rising' : row.trend.change1d && row.trend.change1d < 0 ? 'falling' : ''">
                  {{ formatPercent(row.trend.change1d) }}
                </td>
                <td :class="row.trend.trend">{{ arrow(row.trend) }} {{ formatPercent(row.trend.change3d) }}</td>
                <td>{{ formatPercent(row.trend.change7d) }}</td>
                <td>{{ formatAmount(row.trend.volume7d) }} · {{ row.trend.liquidity }}</td>
                <td>
                  <span class="status-chip" :class="verdictChip(row.advice.verdict)">{{ row.advice.verdict }}</span>
                  <small class="muted reason">{{ row.advice.reason }}</small>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <h3>What to farm</h3>
        <ol class="farm-list">
          <li v-for="candidate in farm" :key="candidate.key">
            <span class="farm-score" :aria-label="`score ${candidate.score}`">{{ candidate.score }}</span>
            <span>
              <strong>{{ candidate.name }}</strong>
              <small class="muted">{{ candidate.why }}</small>
            </span>
          </li>
        </ol>
        <p class="disclaimer">
          Volume is poe2scout's daily quantity, not your sales. Farm ranking = price × 7-day
          volume, relative to the leader; a manual price-table row overrides the feed price.
        </p>
      </template>

      <p v-else-if="!busy" class="empty-copy">
        No price history loaded. Refresh pulls one page per category (paced, ~10 requests).
      </p>
    </template>
  </section>
</template>

<style scoped>
.market-tool { display: flex; flex-direction: column; gap: 0.9rem; }
.market-tool h3 { margin: 0.4rem 0 0.2rem; font-size: 1rem; }
.movers { display: grid; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); gap: 1rem; }
.mover-list, .farm-list { margin: 0; padding-left: 1.4rem; display: flex; flex-direction: column; gap: 0.3rem; }
.mover-list li { display: grid; grid-template-columns: 1fr auto; column-gap: 0.6rem; align-items: baseline; }
.mover-list small { grid-column: 1 / -1; }
.mover-change { font-variant-numeric: tabular-nums; font-weight: 600; }
.rising { color: #3aa76d; }
.falling { color: #d9534f; }
.table-scroll { overflow-x: auto; }
.trend-table { border-collapse: collapse; width: 100%; min-width: 44rem; font-variant-numeric: tabular-nums; }
.trend-table th, .trend-table td { text-align: left; padding: 0.25rem 0.35rem; border-bottom: 1px solid rgba(140, 140, 160, 0.2); vertical-align: top; }
.reason { display: block; }
.farm-list li { display: grid; grid-template-columns: 3rem 1fr; column-gap: 0.6rem; align-items: baseline; }
.farm-list small { display: block; }
.farm-score { font-weight: 700; font-variant-numeric: tabular-nums; }
</style>
