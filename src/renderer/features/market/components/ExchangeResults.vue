<script setup lang="ts">
/**
 * Bulk-exchange offers, optionally grouped by seller, above a rate strip
 * that says what the price feed thinks each side is worth. The rates are
 * estimates from poe2scout, never a trade2 quote — the strip says so.
 */
import { computed } from "vue";
import { exchangeRateStrip, formatRatio, groupOffersBySeller } from "@core/marketExchange";
import type { PriceTable } from "@core/priceTable";
import type { ExchangeQuery } from "@core/tradeQuery";
import type { ExchangeOffer } from "@core/tradeListings";
import type { MarketExchangeResult, MarketListingActionKind } from "../../../../shared/market.js";

const props = defineProps<{
  result: MarketExchangeResult;
  query: ExchangeQuery;
  priceTable: PriceTable;
  grouped: boolean;
  dryRun?: boolean;
  busy?: boolean;
}>();
const emit = defineEmits<{
  (event: "action", action: MarketListingActionKind, offer: ExchangeOffer): void;
}>();

const strip = computed(() => exchangeRateStrip(props.query, props.priceTable));
const groups = computed(() => (props.grouped ? groupOffersBySeller(props.result.offers) : []));
</script>

<template>
  <section class="exchange-results" aria-labelledby="market-exchange-results-title">
    <div class="section-heading">
      <div>
        <h3 id="market-exchange-results-title">Offers</h3>
        <p class="muted">{{ props.result.offers.length }} of {{ props.result.total }}</p>
      </div>
      <span class="count-badge">{{ props.result.offers.length }}</span>
    </div>

    <ul v-if="strip.length" class="rate-strip" aria-label="Feed rates">
      <li v-for="row in strip" :key="row.id">
        <strong>{{ row.name }}</strong>
        <span v-if="row.exalted !== undefined" class="muted">≈ {{ row.exalted }} ex (feed estimate)</span>
        <span v-else class="muted">no feed price</span>
      </li>
    </ul>

    <p v-if="!props.result.offers.length" class="empty-copy">No offers match.</p>

    <template v-else-if="props.grouped">
      <article v-for="group in groups" :key="group.seller.account" class="offer-group">
        <header>
          <strong>{{ group.seller.account }}</strong>
          <span class="muted">{{ group.offers.length }} offer(s)</span>
        </header>
        <ul class="offer-list">
          <li v-for="offer in group.offers" :key="offer.id">
            <span>{{ formatRatio(offer) }}</span>
            <span class="muted">stock {{ offer.stock }}</span>
            <span class="row-actions">
              <button
                type="button"
                class="button compact secondary"
                :disabled="props.busy || !offer.whisper"
                @click="emit('action', 'copy-whisper', offer)"
              >
                Copy whisper
              </button>
              <button
                type="button"
                class="button compact primary"
                :disabled="props.busy || !offer.whisper"
                @click="emit('action', 'send-whisper', offer)"
              >
                {{ props.dryRun ? "Send whisper (dry-run)" : "Send whisper" }}
              </button>
            </span>
          </li>
        </ul>
      </article>
    </template>

    <ul v-else class="offer-list">
      <li v-for="offer in props.result.offers" :key="offer.id">
        <span>{{ formatRatio(offer) }}</span>
        <span class="muted">{{ offer.seller.account }} · stock {{ offer.stock }}</span>
        <span class="row-actions">
          <button
            type="button"
            class="button compact secondary"
            :disabled="props.busy || !offer.whisper"
            @click="emit('action', 'copy-whisper', offer)"
          >
            Copy whisper
          </button>
          <button
            type="button"
            class="button compact primary"
            :disabled="props.busy || !offer.whisper"
            @click="emit('action', 'send-whisper', offer)"
          >
            {{ props.dryRun ? "Send whisper (dry-run)" : "Send whisper" }}
          </button>
          <button
            type="button"
            class="button compact ghost"
            :disabled="props.busy || !offer.seller.character"
            @click="emit('action', 'hideout', offer)"
          >
            /hideout
          </button>
        </span>
      </li>
    </ul>

    <p class="disclaimer">
      Ratios are what sellers ask for right now, not a market price. The app never buys or completes a trade.
    </p>
  </section>
</template>

<style scoped>
.exchange-results {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.rate-strip {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.7rem;
}
.rate-strip li {
  display: flex;
  flex-direction: column;
}
.offer-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.offer-list li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 0.6rem;
  align-items: center;
  padding: 0.35rem 0;
  border-bottom: 1px solid rgba(140, 140, 160, 0.2);
}
.offer-group {
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 0.5rem;
  margin-bottom: 0.4rem;
}
.offer-group header {
  display: flex;
  gap: 0.5rem;
  align-items: baseline;
  margin-bottom: 0.3rem;
}
.row-actions {
  display: inline-flex;
  gap: 0.25rem;
  flex-wrap: wrap;
}
</style>
