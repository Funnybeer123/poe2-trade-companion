<script setup lang="ts">
/**
 * Overlay panel "session-recap". Shown when the player goes AFK and from the
 * recap hotkey; the post-game recap lives on Home because the overlay hides
 * itself once Path of Exile is gone.
 *
 * It renders ONLY from `payload` — no bridge calls — so the overlay bundle
 * stays small and the panel cannot stall on IPC while the game has focus.
 * Anything may arrive in `payload`, so it is sanitized the way
 * NoticePanel.vue does it.
 */
import { computed, ref, watch } from "vue";
import { formatDuration } from "@core/sessionTracker";
import type { MapRun } from "@core/sessionTracker";
import type { RecapMode } from "../../../../shared/session";

const props = defineProps<{ panelId: string; payload: unknown; visible: boolean }>();
const emit = defineEmits<{ close: [] }>();

type Page = "session" | "maps" | "stash";

function record(raw: unknown): Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

function count(raw: unknown): number {
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

const recap = computed(() => {
  const source = record(props.payload);
  const mode = source.mode;
  const metrics = record(source.metrics);
  const summary = record(source.summary);
  const character = record(summary.character);
  const stash = record(source.stash);
  const campaign = record(source.campaign);
  const trade = record(source.trade);
  const trades = record(source.trades);
  const whispers = record(source.whispers);
  const runs = Array.isArray(source.recentRuns) ? (source.recentRuns as MapRun[]).slice(0, 5) : [];
  return {
    mode: (mode === "afk" || mode === "mini" || mode === "full" ? mode : "full") as RecapMode,
    characterName: typeof character.name === "string" ? character.name : "Unknown character",
    characterLevel: typeof character.level === "number" ? character.level : undefined,
    wallMs: count(metrics.wallMs),
    activeMs: count(metrics.activeMs),
    afkMs: count(metrics.afkMs),
    mapsCompleted: count(metrics.mapsCompleted),
    mapsPerHour: typeof metrics.mapsPerHour === "number" ? metrics.mapsPerHour : undefined,
    avgMapMs: typeof metrics.avgMapMs === "number" ? metrics.avgMapMs : undefined,
    deaths: count(metrics.deaths),
    levelUps: count(metrics.levelUps),
    campaignName: typeof campaign.name === "string" ? campaign.name : "",
    campaignHint: typeof campaign.hint === "string" ? campaign.hint : "",
    tradesAccepted: count(trades.accepted),
    tradesCancelled: count(trades.cancelled),
    whispersIn: count(whispers.in),
    whispersOut: count(whispers.out),
    runs,
    stashAvailable: stash.available === true,
    stashReason: typeof stash.reason === "string" ? stash.reason : "No stash session yet.",
    baselineExalted: typeof stash.baselineExalted === "number" ? stash.baselineExalted : undefined,
    latestExalted: typeof stash.latestExalted === "number" ? stash.latestExalted : undefined,
    deltaExalted: typeof stash.deltaExalted === "number" ? stash.deltaExalted : undefined,
    perHourExalted: typeof stash.perHourExalted === "number" ? stash.perHourExalted : undefined,
    rateAssumed: stash.rateAssumed === true,
    divineRate: typeof stash.divineRate === "number" ? stash.divineRate : undefined,
    tradeAvailable: trade.available === true,
    tradeSales: count(trade.sales),
    tradePurchases: count(trade.purchases),
    tradeNetExalted: typeof trade.netExalted === "number" ? trade.netExalted : undefined,
    // "since the session started" or "every trade on file" — never unlabelled.
    tradeWindow: trade.window === "session" ? "this session" : "all recorded trades",
  };
});

const page = ref<Page>(recap.value.mode === "full" ? "maps" : "session");

watch(
  () => recap.value.mode,
  (mode) => {
    page.value = mode === "full" ? "maps" : "session";
  },
);

const PAGES: Array<{ id: Page; label: string }> = [
  { id: "session", label: "Session" },
  { id: "maps", label: "Maps" },
  { id: "stash", label: "Stash" },
];

const amount = (value: number | undefined): string =>
  value === undefined ? "—" : `${Math.round(value * 100) / 100} ex`;

const rateText = computed(() =>
  recap.value.mapsPerHour === undefined ? "—" : `${recap.value.mapsPerHour.toFixed(1)}/h`,
);
</script>

<template>
  <div class="recap" role="group" :aria-label="`Session recap for ${recap.characterName}`">
    <header class="recap-head">
      <span class="recap-chip">{{ recap.mode === "afk" ? "AFK recap" : "Session recap" }}</span>
      <strong>{{ recap.characterName }}</strong>
      <span class="recap-elapsed">{{ formatDuration(recap.wallMs) }}</span>
    </header>

    <nav v-if="recap.mode !== 'mini'" class="recap-pages" aria-label="Recap pages">
      <button
        v-for="entry in PAGES"
        :key="entry.id"
        type="button"
        :class="{ selected: page === entry.id }"
        :aria-pressed="page === entry.id"
        @click="page = entry.id"
      >
        {{ entry.label }}
      </button>
    </nav>

    <dl v-if="recap.mode === 'mini' || page === 'session'" class="recap-list">
      <div><dt>Active</dt><dd>{{ formatDuration(recap.activeMs) }}</dd></div>
      <div><dt>AFK</dt><dd>{{ formatDuration(recap.afkMs) }}</dd></div>
      <div><dt>Maps</dt><dd>{{ recap.mapsCompleted }}</dd></div>
      <div><dt>Per hour</dt><dd>{{ rateText }}</dd></div>
      <div><dt>Average map</dt><dd>{{ formatDuration(recap.avgMapMs) }}</dd></div>
      <div><dt>Deaths</dt><dd>{{ recap.deaths }}</dd></div>
      <div><dt>Level-ups</dt><dd>{{ recap.levelUps }}</dd></div>
      <div v-if="recap.campaignName"><dt>Campaign</dt><dd>{{ recap.campaignName }}<small v-if="recap.campaignHint"> · {{ recap.campaignHint }}</small></dd></div>
      <div><dt>Trades</dt><dd>{{ recap.tradesAccepted }} / {{ recap.tradesCancelled }} cancelled</dd></div>
      <div><dt>Whispers</dt><dd>{{ recap.whispersIn }} in / {{ recap.whispersOut }} out</dd></div>
    </dl>

    <div v-else-if="page === 'maps'" class="recap-runs">
      <p v-if="!recap.runs.length" class="recap-empty">No runs yet this session.</p>
      <ul v-else>
        <li v-for="run in recap.runs" :key="run.id">
          <span class="run-name">{{ run.name }}</span>
          <span class="run-facts">
            <template v-if="run.tier">T{{ run.tier }} · </template>{{ formatDuration(run.activeMs) }}
            · {{ run.deaths }} deaths
          </span>
        </li>
      </ul>
    </div>

    <div v-else class="recap-stash">
      <p v-if="!recap.stashAvailable" class="recap-empty">{{ recap.stashReason }}</p>
      <dl v-else class="recap-list">
        <div><dt>Baseline</dt><dd>{{ amount(recap.baselineExalted) }}</dd></div>
        <div><dt>Latest</dt><dd>{{ amount(recap.latestExalted) }}</dd></div>
        <div><dt>Change</dt><dd>{{ amount(recap.deltaExalted) }}</dd></div>
        <div v-if="recap.perHourExalted !== undefined"><dt>Per hour</dt><dd>{{ amount(recap.perHourExalted) }}</dd></div>
      </dl>
      <p v-if="recap.stashAvailable && recap.rateAssumed" class="recap-empty">
        Divine figures use an assumed {{ recap.divineRate }} ex/div — no snapshot carried a rate.
      </p>
      <dl v-if="recap.tradeAvailable" class="recap-list">
        <div><dt>Trades</dt><dd>{{ recap.tradeSales }} sold / {{ recap.tradePurchases }} bought</dd></div>
        <div><dt>Net</dt><dd>{{ amount(recap.tradeNetExalted) }}</dd></div>
      </dl>
      <p v-if="recap.tradeAvailable" class="recap-empty">Trades cover {{ recap.tradeWindow }}.</p>
    </div>

    <footer class="recap-foot">
      <small>Estimates from Client.txt; experience and gold need an account link (not available).</small>
      <button type="button" class="recap-dismiss" @click="emit('close')">Dismiss</button>
    </footer>
  </div>
</template>

<style scoped>
.recap { display: flex; flex-direction: column; gap: 0.45rem; font-size: 0.82rem; }
.recap-head { display: flex; align-items: baseline; gap: 0.45rem; }
.recap-chip { font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--gold, #c8a66a); }
.recap-elapsed { margin-left: auto; opacity: 0.7; font-variant-numeric: tabular-nums; }
.recap-pages { display: flex; gap: 0.3rem; }
.recap-pages button { background: none; border: 1px solid var(--line, #2b3038); border-radius: 999px; color: inherit; font: inherit; font-size: 0.72rem; padding: 0.1rem 0.55rem; cursor: pointer; }
.recap-pages button.selected { border-color: var(--gold, #c8a66a); color: var(--gold-bright, #e4c587); }
.recap-list { margin: 0; display: grid; gap: 0.2rem; }
.recap-list div { display: grid; grid-template-columns: minmax(0, 7rem) minmax(0, 1fr); gap: 0.4rem; }
.recap-list dt { opacity: 0.7; }
.recap-list dd { margin: 0; font-variant-numeric: tabular-nums; }
.recap-runs ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.25rem; }
.recap-runs li { display: flex; justify-content: space-between; gap: 0.5rem; }
.run-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.run-facts { flex: none; opacity: 0.75; font-variant-numeric: tabular-nums; }
.recap-empty { margin: 0; opacity: 0.7; }
.recap-foot { display: flex; align-items: center; gap: 0.5rem; margin-top: auto; padding-top: 0.3rem; border-top: 1px solid var(--line, #2b3038); }
.recap-foot small { opacity: 0.6; font-size: 0.68rem; line-height: 1.3; }
.recap-dismiss { margin-left: auto; background: none; border: 1px solid var(--line, #2b3038); border-radius: 6px; color: inherit; font: inherit; font-size: 0.72rem; padding: 0.12rem 0.5rem; cursor: pointer; }
</style>
