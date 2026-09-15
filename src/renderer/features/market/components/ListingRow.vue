<script setup lang="ts">
/**
 * One result row: price (with the fractional hand-over hint), age, seller,
 * the numbers that matter for the item's kind, and the per-row actions.
 *
 * Every action is one gesture: Copy whisper and Send whisper are separate
 * buttons, /hideout is a third, and a secure listing offers neither — it
 * opens on the trade site. Send whisper types ONE chat line through the
 * chat-command service, which owns the kill switch, the allow-list, the
 * foreground check and the dry-run switch.
 */
import { computed } from "vue";
import { describeAge } from "@core/inventoryLedger";
import { describeListing, type TradeListing } from "@core/tradeListings";
import type { PriceTable } from "@core/priceTable";
import type { MarketListingActionKind } from "../../../../shared/market.js";
import { useMarketClock } from "../marketClock";

const props = defineProps<{
  listing: TradeListing;
  priceTable: PriceTable;
  staleAfterHours: number;
  hiddenSiblings?: number;
  dryRun?: boolean;
  busy?: boolean;
  compact?: boolean;
  rateNote?: string;
}>();
const emit = defineEmits<{
  (event: "action", action: MarketListingActionKind, listing: TradeListing): void;
  (event: "peek", listing: TradeListing): void;
  (event: "expand", account: string): void;
}>();

// A shared ticking clock, so the age column and the stale fade keep moving
// on a tab that stays open instead of freezing at mount time.
const now = useMarketClock();

const display = computed(() =>
  describeListing(props.listing, {
    now: now.value,
    agingAfterMs: Math.max(1, props.staleAfterHours) * 3_600_000,
    staleAfterMs: Math.max(1, props.staleAfterHours) * 3_600_000 * 7,
    priceTable: props.priceTable,
  }),
);

const secure = computed(() => props.listing.listingType === "secure");
/**
 * The secure-listing fee field has never been captured from the live site,
 * so the row badges the listing but never prints a number that might be
 * wrong (compliance review §2, recommended).
 */
const flags = computed(() => display.value.flags.filter((flag) => !flag.startsWith("secure fee")));
const name = computed(() => props.listing.item.name || props.listing.item.typeLine);
const onlineTone = computed(() => {
  switch (display.value.online) {
    case "online":
      return "safe";
    case "afk":
      return "warning";
    case "offline":
      return "danger";
    default:
      return "neutral";
  }
});
</script>

<template>
  <tr class="listing-row" :class="{ stale: display.stale === 'stale', aging: display.stale === 'aging' }">
    <td>
      <button type="button" class="text-link" :aria-label="`Show ${name}`" @click="emit('peek', props.listing)">
        {{ name }}
      </button>
      <div v-if="props.listing.item.baseType && props.listing.item.name" class="muted">
        {{ props.listing.item.baseType }}
      </div>
      <div v-if="flags.length" class="row-flags">
        <span v-for="flag in flags" :key="flag" class="pill" :class="flag === 'corrupted' ? 'danger' : 'neutral'">
          {{ flag }}
        </span>
      </div>
    </td>
    <td class="num">
      <template v-if="display.priceText">
        <strong>{{ display.priceText }}</strong>
        <div v-if="display.priceExalted !== undefined" class="muted">≈ {{ display.priceExalted }} ex</div>
        <div v-if="display.fractional" class="muted fractional" :title="props.rateNote">
          ≈ {{ display.fractional }}
        </div>
      </template>
      <span v-else class="muted">no price</span>
    </td>
    <td class="num">
      <span v-if="display.ageMs !== undefined">{{ describeAge(display.ageMs) }}</span>
      <span v-else class="muted">—</span>
    </td>
    <td>
      <span class="status-chip" :class="onlineTone">{{ display.online }}</span>
      <div class="muted">{{ props.listing.seller.account }}</div>
      <div v-if="props.listing.seller.character" class="muted">{{ props.listing.seller.character }}</div>
      <button
        v-if="props.hiddenSiblings"
        type="button"
        class="text-link"
        @click="emit('expand', props.listing.seller.account)"
      >
        ▸ {{ props.hiddenSiblings }} more from this seller
      </button>
    </td>
    <td v-if="!props.compact" class="num stat-cell">
      <div v-if="display.dps !== undefined">{{ display.dps }} dps</div>
      <div v-if="display.pdps !== undefined" class="muted">{{ display.pdps }} pdps</div>
      <div v-if="display.arQ20 !== undefined" class="muted">{{ display.arQ20 }} ar (Q20 est.)</div>
      <div v-if="display.evQ20 !== undefined" class="muted">{{ display.evQ20 }} ev (Q20 est.)</div>
      <div v-if="display.esQ20 !== undefined" class="muted">{{ display.esQ20 }} es (Q20 est.)</div>
      <div v-if="props.listing.item.itemLevel !== undefined" class="muted">
        ilvl {{ props.listing.item.itemLevel }}
      </div>
    </td>
    <td class="row-actions">
      <template v-if="secure">
        <span class="pill warning">Secure listing</span>
        <button type="button" class="button compact ghost" @click="emit('action', 'open-site', props.listing)">
          Open on trade site
        </button>
      </template>
      <template v-else>
        <button
          type="button"
          class="button compact secondary"
          :disabled="props.busy"
          @click="emit('action', 'copy-whisper', props.listing)"
        >
          Copy whisper
        </button>
        <button
          type="button"
          class="button compact primary"
          :disabled="props.busy"
          :title="props.dryRun ? 'Dry-run is on: the line is shown, never typed' : 'Types one chat line into the game'"
          @click="emit('action', 'send-whisper', props.listing)"
        >
          {{ props.dryRun ? "Send whisper (dry-run)" : "Send whisper" }}
        </button>
        <button
          type="button"
          class="button compact ghost"
          :disabled="props.busy || !props.listing.seller.character"
          :title="props.listing.seller.character ? '/hideout' : 'This listing names no character'"
          @click="emit('action', 'hideout', props.listing)"
        >
          /hideout
        </button>
        <button
          type="button"
          class="button compact ghost"
          :disabled="props.busy"
          @click="emit('action', 'copy-stats', props.listing)"
        >
          Use as filters
        </button>
        <button
          type="button"
          class="button compact ghost"
          :disabled="props.busy || !props.listing.price"
          @click="emit('action', 'copy-price-note', props.listing)"
        >
          Copy price note
        </button>
      </template>
    </td>
  </tr>
</template>

<style scoped>
.listing-row.aging {
  opacity: 0.8;
}
.listing-row.stale {
  opacity: 0.55;
}
.row-flags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.2rem;
  margin-top: 0.2rem;
}
.row-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  align-items: center;
}
.stat-cell div {
  font-variant-numeric: tabular-nums;
}
.fractional {
  border-bottom: 1px dotted var(--line-strong);
  display: inline-block;
}
</style>
