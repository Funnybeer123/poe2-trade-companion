<script setup lang="ts">
/**
 * Market — the in-app trade browser (/market, Alt+M).
 *
 * Three columns: favourites, the tab being built and its rows, and the
 * live searches. Every trade2 request is a click: Search, Load 10 more,
 * Search exchange. Nothing refreshes itself, nothing scans favourites in
 * the background, and no row is ever bought — Send whisper types ONE chat
 * line through the audited chat-command path.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { draftBody, type MarketDraft } from "@core/marketQuery";
import { statIdForText } from "@core/marketStatSearch";
import { tradeQueryUrl } from "@core/tradeQuery";
import type { ExchangeQuery, TradeQuery, TradeStatGroup } from "@core/tradeQuery";
import type { ExchangeOffer, TradeListing } from "@core/tradeListings";
import { isSearchResult, type MarketExchangeResult, type MarketSearchResult } from "@core/marketTabs";
import { useGameActions } from "../../../composables/useGameActions";
import { useIntelligenceStore } from "../../../composables/useIntelligenceStore";
import { getPriceFeedApi } from "../../../services/rendererApi";
import { pricingReadiness, type ReadinessCheck } from "../../../utils/readiness";
import type { MarketImportResult, MarketListingActionKind } from "../../../../shared/market.js";
import BudgetChip from "../components/BudgetChip.vue";
import ExchangeBuilder from "../components/ExchangeBuilder.vue";
import ExchangeResults from "../components/ExchangeResults.vue";
import FavoritesExplorer from "../components/FavoritesExplorer.vue";
import ImportDialog from "../components/ImportDialog.vue";
import LiveSearchColumn from "../components/LiveSearchColumn.vue";
import MarketTabStrip from "../components/MarketTabStrip.vue";
import QueryBuilder from "../components/QueryBuilder.vue";
import ResultTable from "../components/ResultTable.vue";
import MarketSettingsSection from "../settings/MarketSettingsSection.vue";
import {
  disposeMarketStore,
  initializeMarket,
  mutate,
  rememberScroll,
  run,
  scrollFor,
  useMarketStore,
} from "../useMarketStore";

const store = useMarketStore();
const api = store.api;
const { dryRun } = useGameActions();
const intelligence = useIntelligenceStore();

const importResult = ref<MarketImportResult | null>(null);
const showImport = ref(false);
const resultsPane = ref<HTMLElement | null>(null);
let disposed = false;

const state = store.state;
const activeTab = store.activeTab;
const readiness = ref<ReadinessCheck[]>([]);

const settings = computed(() => state.value?.settings);
const searchResult = computed<MarketSearchResult | undefined>(() =>
  activeTab.value && isSearchResult(activeTab.value.result) ? activeTab.value.result : undefined,
);
const exchangeResult = computed<MarketExchangeResult | undefined>(() => {
  const result = activeTab.value?.result;
  return result && !isSearchResult(result) ? result : undefined;
});

/**
 * A ticking clock, so a trade2 penalty un-disables Search the moment it
 * expires. The budget snapshot only changes when main pushes a new state,
 * and nothing here polls: comparing the stored instant against a live clock
 * is what keeps the button from staying dead after the wait is over.
 */
const now = ref(Date.now());
let clockTimer: ReturnType<typeof setInterval> | undefined;

const penaltyActive = computed(() => {
  const until = state.value?.budget.restrictedUntilIso;
  if (!until) return false;
  const at = Date.parse(until);
  return Number.isFinite(at) && at > now.value;
});

// Once the penalty instant passes, ask main for an honest budget exactly
// once — the spare counts it held were taken before the wait started.
watch(penaltyActive, (active, was) => {
  if (was && !active) void store.refresh();
});

const searchDisabledReason = computed(() => {
  if (!state.value) return "";
  if (state.value.leagueAmbiguous) {
    return "Two current leagues are live — pick one in Tools → Settings → Market data.";
  }
  if (penaltyActive.value) return "trade2 asked us to wait — the budget chip shows how long.";
  if (state.value.budget.searchesSpare < 1 || state.value.budget.fetchesSpare < 1) {
    return "No trade2 slot spare right now.";
  }
  return "";
});
const searchDisabled = computed(() => Boolean(searchDisabledReason.value));

const rateNote = computed(() => {
  const rate = state.value?.currencyRates.find((entry) => entry.id === "divine");
  if (!rate) return "Estimated from the price feed.";
  const age = state.value?.feedAgeHours;
  const source = rate.fromTable
    ? `price table${age === undefined ? "" : ` (feed ${age < 1 ? "under an hour" : `${Math.round(age)} h`} old)`}`
    : "fallback rate — refresh market prices";
  return `at ${rate.exalted} ex/div from the ${source} — estimate`;
});

const canStartLive = computed(() => Boolean(searchResult.value?.searchId));

async function loadReadiness(): Promise<void> {
  const feed = getPriceFeedApi();
  if (!feed) return;
  try {
    readiness.value = pricingReadiness(await feed.status());
  } catch {
    readiness.value = [];
  }
}

function currentQuery(): TradeQuery | undefined {
  const draft = activeTab.value?.draft;
  return draft && draft.kind === "search" ? draft.query : undefined;
}

function currentExchange(): ExchangeQuery | undefined {
  const draft = activeTab.value?.draft;
  return draft && draft.kind === "exchange" ? draft.query : undefined;
}

async function updateDraft(draft: MarketDraft): Promise<void> {
  const id = activeTab.value?.id;
  if (!id) return;
  const next = await run((client) => client.invoke("market:update-draft", id, draft), "The query could not be saved.");
  if (next) activeTab.value = next;
}

async function search(): Promise<void> {
  const id = activeTab.value?.id;
  if (!id) return;
  const next = await run((client) => client.invoke("market:search", id), "The search failed.");
  if (next) activeTab.value = next;
  await store.refresh();
}

async function exchange(): Promise<void> {
  const id = activeTab.value?.id;
  if (!id) return;
  const next = await run((client) => client.invoke("market:exchange", id), "The exchange search failed.");
  if (next) activeTab.value = next;
  await store.refresh();
}

async function loadMore(): Promise<void> {
  const id = activeTab.value?.id;
  if (!id) return;
  const next = await run((client) => client.invoke("market:load-more", id), "That page could not be fetched.");
  if (next) activeTab.value = next;
  await store.refresh();
}

async function onAction(action: MarketListingActionKind, listing: TradeListing, liveId?: string): Promise<void> {
  const outcome = await run(
    (client) =>
      client.invoke("market:listing-action", {
        action,
        listingId: listing.id,
        ...(liveId ? { liveId } : { tabId: activeTab.value?.id }),
      }),
    "That action failed.",
  );
  if (!outcome) return;
  applyOutcome(action, outcome);
}

async function onOfferAction(action: MarketListingActionKind, offer: ExchangeOffer): Promise<void> {
  const outcome = await run(
    (client) =>
      client.invoke("market:listing-action", {
        action,
        listingId: offer.id,
        offerId: offer.id,
        tabId: activeTab.value?.id,
      }),
    "That action failed.",
  );
  if (!outcome) return;
  applyOutcome(action, outcome);
}

interface ActionOutcomeLike {
  ok: boolean;
  error?: string;
  copied?: string;
  statGroups?: TradeStatGroup[];
  chat?: { dryRun: boolean; sent?: string; blockedBy?: string; error?: string };
}

/**
 * Why the chat service refused, in the user's words. Anything it did not
 * name is shown verbatim rather than smoothed over — a refusal the user
 * cannot act on is worse than a blunt one.
 */
const BLOCK_TEXT: Record<string, string> = {
  "kill-switch": "Blocked: the kill switch is latched — re-arm it in the top bar.",
  "not-foreground": "Blocked: Path of Exile was not in the foreground — click the game first.",
  "another-host": "Blocked: another input host is running (the numpad daemon or a CLI).",
  "process-not-allowed": "Blocked: the foreground window is not an allow-listed Path of Exile process.",
  "rate-limit": "Blocked: too many chat lines just now — wait a moment.",
  disabled: "Blocked: chat commands are switched off in Tools → Settings.",
};

function blockedText(outcome: ActionOutcomeLike): string {
  const blockedBy = outcome.chat?.blockedBy;
  if (blockedBy) return BLOCK_TEXT[blockedBy] ?? `Blocked: ${blockedBy}${outcome.chat?.error ? ` — ${outcome.chat.error}` : ""}`;
  return outcome.chat?.error ?? outcome.error ?? "That action failed.";
}

/**
 * Replacing the tab's stat groups is destructive — minutes of filter
 * building vanish with no undo — so it is armed first and applied on the
 * second click, like Reset and Delete favourite.
 */
const pendingStats = ref<TradeStatGroup[] | null>(null);

function replaceStats(groups: TradeStatGroup[], done: string): void {
  const query = currentQuery();
  if (!query) return;
  const existing = (query.stats ?? []).filter((group) => (group.filters?.length ?? 0) > 0);
  if (existing.length > 0 && pendingStats.value === null) {
    pendingStats.value = groups;
    store.notice.value = `Replace ${existing.length} stat group(s)? Click again to confirm.`;
    return;
  }
  pendingStats.value = null;
  void updateDraft({ kind: "search", query: { ...query, stats: groups } });
  store.notice.value = done;
}

function applyOutcome(action: MarketListingActionKind, outcome: ActionOutcomeLike): void {
  if (!outcome.ok) {
    store.error.value = blockedText(outcome);
    return;
  }
  if (action === "copy-stats" && outcome.statGroups) {
    replaceStats(outcome.statGroups, "The listing's modifiers replaced this tab's stat groups.");
    return;
  }
  if (outcome.chat) {
    store.notice.value = outcome.chat.dryRun
      ? `Dry-run: would type «${outcome.chat.sent ?? ""}»`
      : `Sent: ${outcome.chat.sent ?? ""}`;
    return;
  }
  if (outcome.copied) store.notice.value = `Copied: ${outcome.copied}`;
}

/** Build stat filters from the Item log's last Ctrl+C item, locally. */
function fromCurrentItem(): void {
  const item = intelligence.currentItem.value;
  const index = store.statIndex.value;
  const query = currentQuery();
  if (!item || !index || !query) {
    store.error.value = "Copy an item into the Item log first (Ctrl+D), then try again.";
    return;
  }
  const filters = item.mods
    .filter((mod) => mod.kind !== "rune" && mod.kind !== "enchant")
    .flatMap((mod) => {
      const id = statIdForText(index, mod.text, ["explicit", "implicit", "fractured", "desecrated"]);
      if (!id) return [];
      const roll = mod.values && mod.values.length > 1 ? (mod.values[0]! + mod.values[1]!) / 2 : mod.value;
      return [{ id, ...(roll !== undefined ? { value: { min: Math.floor(roll * 0.9) } } : {}) }];
    });
  if (filters.length === 0) {
    store.error.value = "None of that item's modifiers matched the trade2 catalogue.";
    return;
  }
  replaceStats(
    [{ type: "and", filters }],
    `${filters.length} modifier(s) from the current item became filters.`,
  );
}

function copyLink(): void {
  const draft = activeTab.value?.draft;
  if (!draft) return;
  const league = state.value?.league ?? "";
  const url = tradeQueryUrl(league, draftBody(draft));
  void navigator.clipboard?.writeText(url);
  store.notice.value = "Query link copied.";
}

async function openOnSite(): Promise<void> {
  const id = activeTab.value?.id;
  if (!id || !activeTab.value?.result?.url) {
    copyLink();
    return;
  }
  await run(
    (client) => client.invoke("market:listing-action", { action: "open-site", listingId: "", tabId: id }),
    "The trade site could not be opened.",
  );
}

async function parseImport(text: string): Promise<void> {
  const result = await run((client) => client.invoke("market:import", text), "That paste could not be parsed.");
  if (result) importResult.value = result;
}

async function openImported(indexes: number[]): Promise<void> {
  const result = importResult.value;
  if (!result) return;
  await mutate((client) => client.invoke("market:import-open", result, indexes), "Those tabs could not be opened.");
  showImport.value = false;
}

function onScroll(): void {
  const id = activeTab.value?.id;
  if (id && resultsPane.value) rememberScroll(id, resultsPane.value.scrollTop);
}

watch(
  () => activeTab.value?.id,
  (id) => {
    // An armed "replace the stat groups" belongs to the tab it was armed on.
    pendingStats.value = null;
    if (!id || !resultsPane.value) return;
    requestAnimationFrame(() => {
      if (resultsPane.value) resultsPane.value.scrollTop = scrollFor(id);
    });
  },
);

onMounted(async () => {
  clockTimer = setInterval(() => {
    now.value = Date.now();
  }, 1000);
  await initializeMarket();
  if (disposed) return;
  await loadReadiness();
});

onBeforeUnmount(() => {
  disposed = true;
  if (clockTimer) clearInterval(clockTimer);
  disposeMarketStore();
});
</script>

<template>
  <div class="market-workspace">
    <header class="card market-hero" aria-labelledby="market-title">
      <div class="market-hero-copy">
        <span class="eyebrow">Trade browser</span>
        <h2 id="market-title">Market browser</h2>
        <p class="muted">
          Builds trade2 searches, keeps favourites, watches live searches and whispers sellers — one chat line per
          click. It never buys, never accepts a trade and never whispers by itself.
        </p>
      </div>
      <div class="market-hero-status">
        <div class="budget-row">
          <BudgetChip v-if="state" :budget="state.budget" />
          <button
            v-if="state"
            type="button"
            class="button compact ghost"
            title="Re-read the trade2 budget and the league. Costs no trade2 request."
            @click="store.refresh()"
          >
            Refresh
          </button>
        </div>
        <span v-if="state?.league" class="status-chip neutral">{{ state.league }}</span>
        <span v-if="state" class="status-chip" :class="state.hasSession ? 'safe' : 'warning'">
          {{ state.hasSession ? "Session cookie set" : "No POESESSID — live search & secure listings off" }}
        </span>
        <ul v-if="readiness.length" class="pricing-readiness" aria-label="Pricing readiness">
          <li v-for="check in readiness" :key="check.label" :class="{ ok: check.ok }">
            <span class="readiness-dot" aria-hidden="true" />
            <strong>{{ check.label }}</strong>
            <span class="muted">{{ check.detail }}</span>
          </li>
        </ul>
      </div>
    </header>

    <div v-if="!api" class="state-panel compact-state">
      <span class="state-icon" aria-hidden="true">◇</span>
      <strong>Market needs the desktop app</strong>
      <p>This preview has no bridge to the trade2 plumbing.</p>
    </div>
    <div v-else-if="store.loading.value" class="state-panel compact-state" aria-live="polite">
      <span class="spinner" aria-hidden="true" />
      <p>Loading Market…</p>
    </div>
    <div v-else-if="!state" class="state-panel compact-state">
      <span class="state-icon" aria-hidden="true">!</span>
      <strong>Market could not be loaded</strong>
      <p role="alert">{{ store.error.value || "The desktop app did not answer." }}</p>
      <button type="button" class="button secondary compact" @click="store.refresh()">Retry</button>
    </div>

    <template v-else>
      <FavoritesExplorer
        :favorites="state.favorites"
        :busy="store.busy.value"
        @open="mutate((client) => client.invoke('market:favorite-open', $event), 'That favourite could not be opened.')"
        @remove="mutate((client) => client.invoke('market:favorite-remove', $event), 'That favourite could not be deleted.')"
        @move="mutate((client) => client.invoke('market:favorite-move', $event), 'That favourite could not be moved.')"
        @rename="
          (id, name) =>
            mutate(
              (client) => client.invoke('market:favorite-save', { tabId: '', favoriteId: id, name }),
              'That favourite could not be renamed.',
            )
        "
        @new-folder="mutate((client) => client.invoke('market:folder-save', { name: $event }), 'That folder could not be added.')"
        @remove-folder="mutate((client) => client.invoke('market:folder-remove', $event), 'That folder could not be removed.')"
        @import="showImport = true"
      />

      <section class="market-main">
        <MarketTabStrip
          :tabs="state.tabs"
          :active-tab-id="state.activeTabId"
          :busy="store.busy.value"
          @select="mutate((client) => client.invoke('market:select-tab', $event), 'That tab could not be selected.')"
          @close="mutate((client) => client.invoke('market:close-tab', $event), 'That tab could not be closed.')"
          @rename="
            (id, label) =>
              mutate((client) => client.invoke('market:rename-tab', id, label), 'That tab could not be renamed.')
          "
          @new-search="
            mutate((client) => client.invoke('market:new-tab', 'search'), 'A tab could not be opened.')
          "
          @new-exchange="
            mutate((client) => client.invoke('market:new-tab', 'exchange'), 'A tab could not be opened.')
          "
        />

        <p v-if="store.notice.value" class="inline-notice" role="status">{{ store.notice.value }}</p>
        <p v-if="store.error.value" class="inline-notice danger" role="alert">{{ store.error.value }}</p>
        <p v-else-if="state.lastError" class="inline-notice warning" role="note">{{ state.lastError }}</p>
        <p v-if="activeTab?.error" class="inline-notice danger" role="alert">
          {{ activeTab.error }}
          <button type="button" class="button compact ghost" @click="search">Retry</button>
        </p>
        <p v-if="searchDisabled" class="inline-notice warning" role="note">{{ searchDisabledReason }}</p>

        <ImportDialog
          v-if="showImport"
          :result="importResult"
          :busy="store.busy.value"
          @parse="parseImport"
          @open="openImported"
          @close="showImport = false"
        />

        <p v-if="!state.tabs.length" class="empty-copy">No tabs yet — start a search or open a favourite.</p>

        <template v-else-if="activeTab">
          <p v-if="activeTab.idOnly" class="inline-notice warning" role="note">
            This tab only carries a search id from a share link — Search asks the site for that saved search. Edit the
            query below and it becomes a normal search of your own.
          </p>

          <QueryBuilder
            v-if="currentQuery()"
            :query="currentQuery()!"
            :stat-index="store.statIndex.value"
            :templates="store.templates.value"
            :has-session="state.hasSession"
            :busy="store.busy.value"
            :search-disabled="searchDisabled"
            :search-disabled-reason="searchDisabledReason"
            @update:query="updateDraft({ kind: 'search', query: $event })"
            @search="search"
            @save="
              mutate(
                (client) => client.invoke('market:favorite-save', { tabId: activeTab!.id, fromTab: true }),
                'That favourite could not be saved.',
              )
            "
            @update-favorite="
              mutate(
                (client) =>
                  client.invoke('market:favorite-save', {
                    tabId: activeTab!.id,
                    favoriteId: activeTab!.favoriteId,
                    fromTab: true,
                  }),
                'That favourite could not be updated.',
              )
            "
            @copy-link="copyLink"
            @open-site="openOnSite"
            @from-current-item="fromCurrentItem"
          />

          <ExchangeBuilder
            v-else-if="currentExchange()"
            :query="currentExchange()!"
            :currencies="store.currencies.value"
            :busy="store.busy.value"
            :search-disabled="searchDisabled"
            :search-disabled-reason="searchDisabledReason"
            @update:query="updateDraft({ kind: 'exchange', query: $event })"
            @search="exchange"
            @save="
              mutate(
                (client) => client.invoke('market:favorite-save', { tabId: activeTab!.id, fromTab: true }),
                'That favourite could not be saved.',
              )
            "
          />

          <div ref="resultsPane" class="results-pane" @scroll="onScroll">
            <div
              v-if="activeTab.state === 'searching' || activeTab.state === 'fetching'"
              class="state-panel compact-state"
              aria-live="polite"
            >
              <span class="spinner" aria-hidden="true" />
              <p>{{ activeTab.state === "searching" ? "Searching trade2…" : "Fetching the next ten rows…" }}</p>
            </div>

            <ResultTable
              v-if="searchResult && settings"
              :result="searchResult"
              :price-table="store.priceTable.value"
              :stale-after-hours="settings.staleAfterHours"
              :fetches-spare="state.budget.fetchesSpare"
              :dry-run="dryRun"
              :busy="store.busy.value"
              :rate-note="rateNote"
              @action="(action, listing) => onAction(action, listing)"
              @load-more="loadMore"
              @expand="
                (account) =>
                  mutate(
                    async (client) => {
                      await client.invoke('market:collapse-account', activeTab!.id, account, false);
                      return undefined;
                    },
                    'That seller could not be expanded.',
                  )
              "
            />

            <ExchangeResults
              v-else-if="exchangeResult && currentExchange()"
              :result="exchangeResult"
              :query="currentExchange()!"
              :price-table="store.priceTable.value"
              :grouped="currentExchange()!.collapse === true || currentExchange()!.have.length + currentExchange()!.want.length > 2"
              :dry-run="dryRun"
              :busy="store.busy.value"
              @action="onOfferAction"
            />
          </div>
        </template>

        <p class="disclaimer">
          Listings are other players’ asks, not sale prices. The app never buys, trades, or clicks accept.
        </p>

        <MarketSettingsSection
          v-if="settings"
          :settings="settings"
          :busy="store.busy.value"
          @patch="
            (patch) =>
              run(async (client) => {
                await client.invoke('market:settings', patch);
                await store.refresh();
                return undefined;
              }, 'Those settings could not be saved.')
          "
        />
      </section>

      <LiveSearchColumn
        v-if="settings"
        :live="state.live"
        :capacity="state.liveCapacity"
        :has-session="state.hasSession"
        :price-table="store.priceTable.value"
        :stale-after-hours="settings.staleAfterHours"
        :rate-note="rateNote"
        :can-start="canStartLive"
        start-hint="Search this tab first — a live search follows an existing search id."
        :dry-run="dryRun"
        :busy="store.busy.value"
        @start="
          mutate(
            (client) => client.invoke('market:live-start', { tabId: activeTab?.id }),
            'That live search could not be started.',
          )
        "
        @stop="mutate((client) => client.invoke('market:live-stop', $event), 'That live search could not be stopped.')"
        @clear="mutate((client) => client.invoke('market:live-clear', $event), 'Those results could not be cleared.')"
        @set="(id, patch) => mutate((client) => client.invoke('market:live-set', id, patch), 'That change was not saved.')"
        @seen="mutate((client) => client.invoke('market:live-seen', $event), 'That could not be marked seen.')"
        @action="(action, listing, liveId) => onAction(action, listing, liveId)"
      />
    </template>
  </div>
</template>

<style scoped>
.market-workspace {
  display: grid;
  grid-template-columns: minmax(240px, 280px) minmax(0, 1fr) minmax(260px, 320px);
  gap: 0.9rem;
  align-items: start;
}
.market-hero {
  grid-column: 1 / -1;
  display: flex;
  flex-wrap: wrap;
  gap: 0.9rem;
  justify-content: space-between;
}
.market-hero-copy {
  max-width: 62ch;
}
.market-hero-status {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  align-items: flex-end;
}
.budget-row {
  display: flex;
  align-items: center;
  gap: 0.35rem;
}
.market-main {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
  min-width: 0;
}
.results-pane {
  max-height: 62vh;
  overflow-y: auto;
}
.state-panel,
.empty-copy {
  grid-column: 1 / -1;
}
@media (max-width: 1380px) {
  .market-workspace {
    grid-template-columns: minmax(0, 1fr) minmax(260px, 320px);
  }
  .market-workspace > .favorites-panel {
    grid-column: 1 / -1;
  }
}
@media (max-width: 900px) {
  .market-workspace {
    grid-template-columns: minmax(0, 1fr);
  }
  .market-hero-status {
    align-items: flex-start;
  }
}
</style>
