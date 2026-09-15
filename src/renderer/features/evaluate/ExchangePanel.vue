<script setup lang="ts">
/**
 * Bulk exchange for a stackable: the best asks, the median per unit and the
 * total stock on offer. One refresh = one paced exchange request (a SEARCH
 * slot), so the button is disabled while the budget says no.
 */
import { computed } from "vue";
import type { EvaluateExchange } from "../../../shared/evaluate.js";
import { formatAmount, formatDate } from "../../utils/intelligence";

const props = defineProps<{
  exchange?: EvaluateExchange;
  busy: boolean;
  disabled: boolean;
  disabledReason?: string;
}>();

const emit = defineEmits<{ refresh: [] }>();

const best = computed(() => props.exchange?.offers.slice(0, 8) ?? []);
</script>

<template>
  <section class="exchange card" aria-labelledby="evaluate-exchange-title">
    <div class="section-heading">
      <h3 id="evaluate-exchange-title">Bulk exchange</h3>
      <button
        type="button"
        class="button compact secondary"
        :disabled="busy || disabled"
        :title="disabled ? (disabledReason ?? '') : 'One paced exchange request'"
        @click="emit('refresh')"
      >
        {{ busy ? "Checking…" : exchange ? "Refresh exchange" : "Check exchange" }}
      </button>
    </div>

    <p v-if="!exchange" class="empty-copy">
      No exchange data yet — one request asks trade2 what people pay for this stack.
    </p>

    <template v-else>
      <p class="currency-line">
        Best {{ formatAmount(exchange.bestAskQuoted) }} · median
        {{ formatAmount(exchange.medianAskQuoted) }} {{ exchange.quoteCurrency }} per unit
        <span class="muted">· {{ exchange.stockTotal }} in stock · {{ formatDate(exchange.fetchedAt) }}</span>
      </p>
      <p v-if="exchange.caution" class="inline-notice warning" role="note">{{ exchange.caution }}</p>
      <div class="table-scroll">
        <table class="exchange-table">
          <thead>
            <tr>
              <th scope="col">Seller</th>
              <th scope="col">Ratio</th>
              <th scope="col">Stock</th>
              <th scope="col">Per unit</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="offer in best" :key="offer.id">
              <td>
                <span class="presence-dot" :class="{ online: offer.online }" aria-hidden="true"></span>
                {{ offer.seller }}
              </td>
              <td>{{ offer.ratio }}</td>
              <td class="num">{{ offer.stock }}</td>
              <td class="num">{{ formatAmount(offer.perUnitQuoted) }} {{ exchange.quoteCurrency }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="disclaimer">Exchange rates are live asks — an estimate of what a stack trades for, not a quote.</p>
    </template>
  </section>
</template>

<style scoped>
.exchange {
  display: grid;
  gap: 0.35rem;
  padding: 0.7rem 0.8rem;
}
.currency-line {
  margin: 0;
  font-variant-numeric: tabular-nums;
}
.table-scroll {
  overflow-x: auto;
}
.exchange-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.78rem;
}
.exchange-table th,
.exchange-table td {
  text-align: left;
  padding: 0.28rem 0.5rem;
  border-bottom: 1px solid rgba(140, 140, 160, 0.15);
}
.num {
  font-variant-numeric: tabular-nums;
}
</style>
