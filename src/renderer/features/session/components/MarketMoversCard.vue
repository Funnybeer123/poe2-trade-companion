<script setup lang="ts">
import { formatPercent } from "@core/priceTrends";
import { RouterLink } from "vue-router";
import type { MarketMovers } from "../../../../shared/session";
import { ex, when } from "../format";

defineProps<{ market: MarketMovers }>();
</script>

<template>
  <section class="card market-movers" aria-labelledby="home-market-title">
    <div class="section-heading">
      <div>
        <span class="eyebrow">Market</span>
        <h2 id="home-market-title">Movers</h2>
      </div>
      <span v-if="market.stale" class="status-chip warning">Cache is stale</span>
      <span v-else class="status-chip neutral">From the local cache</span>
    </div>

    <p v-if="!market.available" class="empty-copy">
      {{ market.reason ?? "No trends cached yet." }}
      <RouterLink class="text-link" to="/tools/market">Open Market</RouterLink>
    </p>
    <template v-else>
      <p class="muted">
        {{ market.league ?? "League unknown" }} · as of {{ when(market.fetchedAt) }}
      </p>
      <div class="mover-columns">
        <div>
          <h3>Rising</h3>
          <p v-if="!market.rising.length" class="empty-copy">Nothing rising.</p>
          <ul v-else class="mover-list" aria-label="Rising prices">
            <li v-for="mover in market.rising" :key="mover.key">
              <span class="mover-copy">
                <strong>{{ mover.name }}</strong>
                <small class="muted">{{ ex(mover.current) }} · {{ mover.sampleSize }} bars</small>
              </span>
              <span class="mover-change safe">{{ formatPercent(mover.change3d) }}</span>
            </li>
          </ul>
        </div>
        <div>
          <h3>Falling</h3>
          <p v-if="!market.falling.length" class="empty-copy">Nothing falling.</p>
          <ul v-else class="mover-list" aria-label="Falling prices">
            <li v-for="mover in market.falling" :key="mover.key">
              <span class="mover-copy">
                <strong>{{ mover.name }}</strong>
                <small class="muted">{{ ex(mover.current) }} · {{ mover.sampleSize }} bars</small>
              </span>
              <span class="mover-change danger">{{ formatPercent(mover.change3d) }}</span>
            </li>
          </ul>
        </div>
      </div>
      <p class="disclaimer">
        Three-day change from the cached poe2scout bars. Home never fetches — refresh from
        <RouterLink class="text-link" to="/tools/market">Tools → Market</RouterLink>.
      </p>
    </template>
  </section>
</template>

<style scoped>
.market-movers { display: flex; flex-direction: column; gap: 0.55rem; }
.mover-columns { display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); gap: 0.9rem; }
.mover-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem; }
.mover-list li { display: flex; gap: 0.6rem; justify-content: space-between; align-items: flex-start; border-bottom: 1px solid rgba(140, 140, 160, 0.15); padding-bottom: 0.35rem; }
.mover-copy { display: flex; flex-direction: column; min-width: 0; }
.mover-change { flex: none; font-variant-numeric: tabular-nums; font-weight: 650; }
.mover-change.safe { color: var(--green, #80b886); }
.mover-change.danger { color: var(--red, #d57b76); }
</style>
