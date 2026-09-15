<script setup lang="ts">
/**
 * Live searches: at most twenty sockets (the site's own cap), each with its
 * state, its unread badge, a chime toggle and a Clear.
 *
 * Rows a live search produced were fetched by the foundation under the same
 * budget guard as everything else — when the budget was too thin the ids
 * are DROPPED, never retried, and the count is shown here rather than
 * hidden. A trade2 penalty stops every live search; the user restarts them.
 */
import { computed } from "vue";
import type { PriceTable } from "@core/priceTable";
import type { TradeListing } from "@core/tradeListings";
import type { MarketListingActionKind, MarketLiveView } from "../../../../shared/market.js";
import ListingRow from "./ListingRow.vue";

const props = defineProps<{
  live: MarketLiveView[];
  capacity: { open: number; max: number };
  hasSession: boolean;
  priceTable: PriceTable;
  staleAfterHours: number;
  canStart: boolean;
  startHint?: string;
  /** The "at N ex/div …" note behind the fractional price hint on a row. */
  rateNote?: string;
  dryRun?: boolean;
  busy?: boolean;
}>();
const emit = defineEmits<{
  (event: "start"): void;
  (event: "stop", id: string): void;
  (event: "clear", id: string): void;
  (event: "set", id: string, patch: { sound?: boolean; notify?: boolean }): void;
  (event: "seen", id: string): void;
  (event: "action", action: MarketListingActionKind, listing: TradeListing, liveId: string): void;
}>();

const totalUnread = computed(() => props.live.reduce((sum, entry) => sum + entry.unread, 0));

function tone(state: string): string {
  if (state === "open") return "safe";
  if (state === "connecting") return "neutral";
  if (state === "needs-session") return "warning";
  return "danger";
}
</script>

<template>
  <aside class="card live-panel" aria-labelledby="market-live-title">
    <div class="section-heading">
      <div>
        <span class="eyebrow">Watching</span>
        <h3 id="market-live-title">Live search</h3>
      </div>
      <span class="status-chip neutral" role="status">{{ props.capacity.open }} / {{ props.capacity.max }}</span>
    </div>

    <p v-if="!props.hasSession" class="inline-notice warning" role="note">
      Live search needs a POESESSID — add one in Tools → Settings → Market data.
    </p>

    <div class="button-row">
      <button
        type="button"
        class="button compact primary"
        :disabled="props.busy || !props.canStart || !props.hasSession"
        :title="props.canStart ? 'Follows this tab’s existing search id — no new search' : props.startHint"
        @click="emit('start')"
      >
        Start from this tab
      </button>
      <span v-if="totalUnread" class="count-badge" role="status">{{ totalUnread }} new</span>
    </div>

    <p v-if="!props.live.length" class="empty-copy">No live search running.</p>

    <article v-for="entry in props.live" :key="entry.id" class="live-entry">
      <header>
        <strong>{{ entry.label }}</strong>
        <span class="status-chip" :class="tone(entry.handle.state)">{{ entry.handle.state }}</span>
        <span v-if="entry.unread" class="count-badge">{{ entry.unread }}</span>
      </header>
      <p v-if="entry.handle.error" class="inline-notice danger" role="alert">{{ entry.handle.error }}</p>
      <p v-if="entry.handle.skippedResults" class="inline-notice warning" role="note">
        {{ entry.handle.skippedResults }} result(s) not fetched — trade2 budget.
      </p>
      <div class="live-actions">
        <label class="inline-toggle">
          <input
            type="checkbox"
            :checked="entry.sound"
            :disabled="props.busy"
            @change="emit('set', entry.id, { sound: ($event.target as HTMLInputElement).checked })"
          />
          <span>Chime</span>
        </label>
        <label class="inline-toggle">
          <input
            type="checkbox"
            :checked="entry.notify"
            :disabled="props.busy"
            @change="emit('set', entry.id, { notify: ($event.target as HTMLInputElement).checked })"
          />
          <span>Notify</span>
        </label>
        <button type="button" class="button compact ghost" :disabled="props.busy" @click="emit('seen', entry.id)">
          Mark seen
        </button>
        <button type="button" class="button compact ghost" :disabled="props.busy" @click="emit('clear', entry.id)">
          Clear
        </button>
        <button type="button" class="button compact danger" :disabled="props.busy" @click="emit('stop', entry.id)">
          Stop
        </button>
      </div>
      <p v-if="!entry.results.length" class="empty-copy">Waiting for the first listing…</p>
      <div v-else class="table-scroll">
        <table class="market-table">
          <tbody>
            <ListingRow
              v-for="listing in entry.results"
              :key="listing.id"
              :listing="listing"
              :price-table="props.priceTable"
              :stale-after-hours="props.staleAfterHours"
              :rate-note="props.rateNote"
              :dry-run="props.dryRun"
              :busy="props.busy"
              compact
              @action="(action, row) => emit('action', action, row, entry.id)"
            />
          </tbody>
        </table>
      </div>
    </article>
  </aside>
</template>

<style scoped>
.live-panel {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.live-entry {
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 0.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.live-entry header {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  flex-wrap: wrap;
}
.live-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  align-items: center;
}
.table-scroll {
  overflow-x: auto;
  max-height: 320px;
  overflow-y: auto;
}
.market-table {
  border-collapse: collapse;
  width: 100%;
  font-size: 0.8rem;
}
.market-table :deep(td) {
  padding: 0.3rem 0.4rem;
  border-bottom: 1px solid rgba(140, 140, 160, 0.15);
  vertical-align: top;
}
.market-table :deep(.num) {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
</style>
