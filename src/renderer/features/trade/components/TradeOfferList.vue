<script setup lang="ts">
/**
 * Buyers / Sellers / Recently finished. Owns only which cards are expanded;
 * everything else comes from main.
 */
import { computed, ref } from "vue";
import TradeOfferCard from "./TradeOfferCard.vue";
import type { TradeOffer, TradeOfferAction, TradeQuickWhisper } from "../../../../shared/trade";

const props = defineProps<{
  offers: TradeOffer[];
  compact: boolean;
  inTown: boolean;
  autoExpandInTown: boolean;
  quickWhispers: TradeQuickWhisper[];
  busyOfferId: string;
  busy: boolean;
  dryRun: boolean;
  chatEnabled: boolean;
  chatDisabledReason?: string;
  origin: "desktop" | "overlay";
  divineRate?: number;
  divineRateSource?: "price-table" | "fallback";
  feedAgeHours?: number;
}>();

const emit = defineEmits<{
  action: [offerId: string, action: TradeOfferAction];
  focusRequest: [focus: boolean];
}>();

const expandedIds = ref<string[]>([]);
const collapsedIds = ref<string[]>([]);

const ACTIVE = ["new", "invited", "joined", "trading"];

const buyers = computed(() =>
  props.offers.filter((offer) => offer.direction === "incoming" && ACTIVE.includes(offer.state)),
);
const sellers = computed(() =>
  props.offers.filter((offer) => offer.direction === "outgoing" && ACTIVE.includes(offer.state)),
);
const finished = computed(() => props.offers.filter((offer) => !ACTIVE.includes(offer.state)));

function isExpanded(offer: TradeOffer): boolean {
  if (expandedIds.value.includes(offer.id)) return true;
  if (collapsedIds.value.includes(offer.id)) return false;
  return props.autoExpandInTown ? props.inTown : false;
}

function toggle(offer: TradeOffer): void {
  if (isExpanded(offer)) {
    expandedIds.value = expandedIds.value.filter((id) => id !== offer.id);
    if (!collapsedIds.value.includes(offer.id)) collapsedIds.value = [...collapsedIds.value, offer.id];
    return;
  }
  collapsedIds.value = collapsedIds.value.filter((id) => id !== offer.id);
  expandedIds.value = [...expandedIds.value, offer.id];
}
</script>

<template>
  <div class="trade-offer-list">
    <section v-if="buyers.length" class="trade-group">
      <h3>Buyers <span class="count-badge">{{ buyers.length }}</span></h3>
      <TradeOfferCard
        v-for="offer in buyers"
        :key="offer.id"
        :offer="offer"
        :compact="props.compact"
        :expanded="isExpanded(offer)"
        :quick-whispers="props.quickWhispers"
        :busy="props.busy && props.busyOfferId === offer.id"
        :dry-run="props.dryRun"
        :chat-enabled="props.chatEnabled"
        :chat-disabled-reason="props.chatDisabledReason"
        :origin="props.origin"
        :divine-rate="props.divineRate"
        :divine-rate-source="props.divineRateSource"
        :feed-age-hours="props.feedAgeHours"
        @toggle="toggle(offer)"
        @action="(action) => emit('action', offer.id, action)"
        @focus-request="(focus) => emit('focusRequest', focus)"
      />
    </section>

    <section v-if="sellers.length" class="trade-group">
      <h3>Sellers <span class="count-badge">{{ sellers.length }}</span></h3>
      <TradeOfferCard
        v-for="offer in sellers"
        :key="offer.id"
        :offer="offer"
        :compact="props.compact"
        :expanded="isExpanded(offer)"
        :quick-whispers="props.quickWhispers"
        :busy="props.busy && props.busyOfferId === offer.id"
        :dry-run="props.dryRun"
        :chat-enabled="props.chatEnabled"
        :chat-disabled-reason="props.chatDisabledReason"
        :origin="props.origin"
        :divine-rate="props.divineRate"
        :divine-rate-source="props.divineRateSource"
        :feed-age-hours="props.feedAgeHours"
        @toggle="toggle(offer)"
        @action="(action) => emit('action', offer.id, action)"
        @focus-request="(focus) => emit('focusRequest', focus)"
      />
    </section>

    <section v-if="finished.length" class="trade-group">
      <h3>Recently finished <span class="count-badge">{{ finished.length }}</span></h3>
      <TradeOfferCard
        v-for="offer in finished"
        :key="offer.id"
        :offer="offer"
        :compact="props.compact"
        :expanded="isExpanded(offer)"
        :quick-whispers="props.quickWhispers"
        :busy="props.busy && props.busyOfferId === offer.id"
        :dry-run="props.dryRun"
        :chat-enabled="props.chatEnabled"
        :chat-disabled-reason="props.chatDisabledReason"
        :origin="props.origin"
        :divine-rate="props.divineRate"
        :divine-rate-source="props.divineRateSource"
        :feed-age-hours="props.feedAgeHours"
        @toggle="toggle(offer)"
        @action="(action) => emit('action', offer.id, action)"
        @focus-request="(focus) => emit('focusRequest', focus)"
      />
    </section>

    <p v-if="!props.offers.length" class="empty-copy">
      No offers yet. Trade whispers from Client.txt appear here within a second.
    </p>
  </div>
</template>

<style scoped>
.trade-offer-list {
  display: flex;
  flex-direction: column;
  gap: 0.8rem;
}
.trade-group {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}
.trade-group h3 {
  margin: 0;
}
</style>
