<script setup lang="ts">
/**
 * The Trade workspace: offer cards from Client.txt whispers, the trades the
 * game confirmed, and the everyday trade settings.
 *
 * Every button here types ONE chat line through the audited chat command
 * service. Nothing accepts a trade, nothing whispers on its own, and no price
 * shown is a guarantee.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import ViewTabs from "../../../components/ViewTabs.vue";
import TradeOfferList from "../components/TradeOfferList.vue";
import TradeHistoryTable from "../components/TradeHistoryTable.vue";
import TradeSettingsCard from "../components/TradeSettingsCard.vue";
import { useTradeStore } from "../api/useTradeStore";
import { formatAmount } from "../../../utils/intelligence";
import type { TradeHistoryEdit, TradeOfferAction, TradeSettings } from "../../../../shared/trade";

const route = useRoute();
const store = useTradeStore();
const tab = ref<string>(route.hash === "#history" ? "history" : "offers");

watch(
  () => route.hash,
  (hash) => {
    if (hash === "#history") tab.value = "history";
    if (hash === "#offers") tab.value = "offers";
  },
);

watch(tab, (next) => {
  if (next === "history" && !store.history.value) void store.loadHistory();
});

onMounted(async () => {
  await store.initializeTradeStore();
  if (tab.value === "history") await store.loadHistory();
});
onBeforeUnmount(() => store.disposeTradeStore());

const status = computed(() => store.status.value);
const activeCount = computed(
  () => store.offers.value.filter((offer) => ["new", "invited", "joined", "trading"].includes(offer.state)).length,
);
const chatEnabled = computed(() => status.value?.chat?.enabled !== false);
const chatDisabledReason = computed(() =>
  chatEnabled.value ? undefined : "Chat commands are disabled in Tools → Settings",
);

const readiness = computed(() => {
  const value = status.value;
  if (!value) return [];
  return [
    {
      label: "Client.txt",
      ok: value.clientLog.watching,
      detail: value.clientLog.watching
        ? (value.clientLog.file ?? "watching")
        : `${value.clientLog.error ?? "not watching"} — set the path in Tools → Settings`,
    },
    {
      label: "Chat commands",
      ok: value.chat?.enabled === true,
      detail:
        value.chat?.enabled === true
          ? value.chat.hostRunning
            ? "enabled · input host running"
            : "enabled · host idle"
          : "disabled in Tools → Settings",
    },
    {
      label: "Pricing league",
      ok: Boolean(value.league),
      detail: value.league ?? "pin one in Tools → Settings → Market data",
    },
    {
      label: "Divine rate",
      ok: value.divineRateSource === "price-table",
      detail:
        value.divineRateSource === "price-table"
          ? `≈ ${formatAmount(value.divineRate)} ex/div from the price table${value.feedAgeHours === undefined ? "" : ` (feed ${value.feedAgeHours.toFixed(1)} h old)`}`
          : `fallback ${formatAmount(value.divineRate)} — refresh market prices`,
    },
  ];
});

const tabs = computed(() => [
  { id: "offers", label: "Offers", hint: activeCount.value ? String(activeCount.value) : undefined },
  { id: "history", label: "History" },
]);

function runAction(offerId: string, action: TradeOfferAction): void {
  void store.runAction(offerId, action, "desktop");
}

function saveSettings(patch: Partial<TradeSettings>): void {
  void store.saveSettings(patch);
}

function saveHistory(edit: TradeHistoryEdit): void {
  void store.saveHistory(edit);
}
</script>

<template>
  <div class="trade-workspace">
    <section class="card trade-hero" aria-labelledby="trade-title">
      <div class="trade-hero-copy">
        <span class="eyebrow">Operate</span>
        <h2 id="trade-title">Trade</h2>
        <p class="muted">
          Reads your Client.txt whispers. Every button types one chat line; the trade window's Accept is always
          yours.
        </p>
      </div>

      <div v-if="!store.available" class="state-panel compact-state">
        <span class="state-icon" aria-hidden="true">◇</span>
        <strong>Trade needs the desktop app</strong>
        <p>This preview has no bridge.</p>
      </div>

      <template v-else>
        <ul class="trade-readiness" aria-label="Trade readiness">
          <li v-for="check in readiness" :key="check.label" :class="{ ok: check.ok }">
            <span class="readiness-dot" aria-hidden="true" />
            <strong>{{ check.label }}</strong>
            <span class="muted">{{ check.detail }}</span>
          </li>
        </ul>
        <div class="button-row">
          <button
            type="button"
            class="button secondary compact"
            :disabled="store.busy.value || !status?.poeRunning"
            :title="status?.poeRunning ? undefined : 'Path of Exile is not running'"
            @click="store.togglePanel('toggle')"
          >
            {{ status?.panelVisible ? "Hide in-game panel" : "Show in-game panel" }}
          </button>
          <span v-if="status?.dryRun" class="status-chip warning">Dry-run: chat lines are previewed, not typed</span>
          <span class="privacy-note">One chat line per click. Never accepts a trade.</span>
        </div>
      </template>
    </section>

    <template v-if="store.available">
      <ViewTabs v-model="tab" :tabs="tabs" label="Trade sections" />

      <section v-if="tab === 'offers'" class="card trade-offers-card" aria-label="Offers">
        <div v-if="store.loading.value" class="state-panel compact-state" aria-live="polite">
          <span class="spinner" aria-hidden="true" />
          <p>Loading offers…</p>
        </div>
        <template v-else>
          <p v-if="status && !status.clientLog.watching" class="inline-notice warning">
            Client.txt is not being watched — {{ status.clientLog.error ?? "no file found" }}. Set the path in
            Tools → Settings.
          </p>
          <p v-if="store.notice.value" class="inline-notice" role="status">{{ store.notice.value }}</p>
          <p v-if="store.error.value" class="inline-notice danger" role="alert">{{ store.error.value }}</p>

          <TradeOfferList
            :offers="store.offers.value"
            :compact="store.settings.value.compact"
            :in-town="status?.area?.inTown ?? false"
            :auto-expand-in-town="store.settings.value.autoExpandInTown"
            :quick-whispers="store.settings.value.quickWhispers"
            :busy-offer-id="store.busyOfferId.value"
            :busy="store.busy.value"
            :dry-run="status?.dryRun ?? false"
            :chat-enabled="chatEnabled"
            :chat-disabled-reason="chatDisabledReason"
            origin="desktop"
            :divine-rate="status?.divineRate"
            :divine-rate-source="status?.divineRateSource"
            :feed-age-hours="status?.feedAgeHours"
            @action="runAction"
          />

          <div v-if="activeCount" class="button-row">
            <button type="button" class="button ghost compact" :disabled="store.busy.value" @click="store.dismissAll()">
              Dismiss all
            </button>
          </div>
        </template>
      </section>

      <section v-else class="card trade-history-card" aria-label="Trade history">
        <div v-if="!store.history.value" class="state-panel compact-state" aria-live="polite">
          <span class="spinner" aria-hidden="true" />
          <p>Loading history…</p>
        </div>
        <template v-else>
          <p v-if="store.notice.value" class="inline-notice" role="status">{{ store.notice.value }}</p>
          <p v-if="store.error.value" class="inline-notice danger" role="alert">{{ store.error.value }}</p>
          <TradeHistoryTable
            :view="store.history.value"
            :busy="store.busy.value"
            @save="saveHistory"
            @remove="(id) => store.deleteHistory(id)"
            @export="(target) => store.exportHistory(target)"
          />
        </template>
      </section>

      <details class="advanced-options">
        <summary>Trade settings</summary>
        <TradeSettingsCard :settings="store.settings.value" :busy="store.busy.value" @save="saveSettings" />
      </details>
    </template>
  </div>
</template>

<style scoped>
.trade-workspace {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.trade-hero {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
}
.trade-hero-copy {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}
.trade-hero-copy p {
  margin: 0;
}
.trade-readiness {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 1.2rem;
}
.trade-readiness li {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.8rem;
}
.readiness-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--amber, #d0a45f);
}
.trade-readiness li.ok .readiness-dot {
  background: var(--green, #80b886);
}
.trade-offers-card,
.trade-history-card {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
}
</style>
