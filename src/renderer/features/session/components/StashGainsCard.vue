<script setup lang="ts">
import { RouterLink } from "vue-router";
import type { StashGains, TradeEarnings } from "../../../../shared/session";
import { computed } from "vue";
import { deltaTone, div, ex, signedEx, when } from "../format";

const props = defineProps<{ stash: StashGains; trade: TradeEarnings }>();

/**
 * The trade totals mean "since this session started" only while a session is
 * running; otherwise they cover every trade still on file (the trade package
 * keeps two weeks). The card has to say which, or an evening's card silently
 * becomes a fortnight's.
 */
const tradeWindow = computed(() =>
  props.trade.window === "session" && props.trade.sinceIso
    ? `Since ${when(props.trade.sinceIso)}`
    : "All recorded trades",
);
</script>

<template>
  <section class="card stash-gains" aria-labelledby="home-stash-title">
    <div class="section-heading">
      <div>
        <span class="eyebrow">Wealth</span>
        <h2 id="home-stash-title">Stash gains</h2>
      </div>
      <span class="status-chip neutral">Estimates, never guarantees</span>
    </div>

    <p v-if="!stash.available" class="empty-copy">
      {{ stash.reason ?? "No stash session yet." }}
      <RouterLink class="text-link" to="/tools/stash-tracker">Open the stash tracker</RouterLink>
    </p>
    <template v-else>
      <p class="gain-line">
        <span class="status-chip" :class="deltaTone(stash.deltaExalted)">{{ signedEx(stash.deltaExalted) }}</span>
        <span v-if="stash.deltaDivine !== undefined" class="muted">
          {{ div(stash.deltaDivine) }}
          <template v-if="stash.rateAssumed">
            <small>at an assumed {{ stash.divineRate }} ex/div</small>
          </template>
        </span>
      </p>
      <dl class="property-list">
        <div>
          <dt>Baseline</dt>
          <dd>{{ ex(stash.baselineExalted) }} <small class="muted">{{ when(stash.baselineAt) }}</small></dd>
        </div>
        <div>
          <dt>Latest</dt>
          <dd>{{ ex(stash.latestExalted) }} <small class="muted">{{ when(stash.latestAt) }}</small></dd>
        </div>
        <div v-if="stash.perHourExalted !== undefined">
          <dt>Per hour</dt>
          <dd>{{ ex(stash.perHourExalted) }}</dd>
        </div>
        <div>
          <dt>Snapshots</dt>
          <dd>{{ stash.snapshots }}</dd>
        </div>
      </dl>
      <p class="muted">
        {{ stash.source === "session-file" ? "From the stash tracker's session summary." : "From the stash tracker's snapshot journal." }}
      </p>
    </template>

    <h3>Trade activity</h3>
    <p class="muted trade-window">{{ tradeWindow }}</p>
    <p v-if="!trade.available" class="empty-copy">{{ trade.reason ?? "No trade history yet." }}</p>
    <dl v-else class="property-list">
      <div>
        <dt>Sales</dt>
        <dd>{{ trade.sales }} <small class="muted">{{ ex(trade.earnedExalted) }}</small></dd>
      </div>
      <div>
        <dt>Purchases</dt>
        <dd>{{ trade.purchases }} <small class="muted">{{ ex(trade.spentExalted) }}</small></dd>
      </div>
      <div>
        <dt>Net</dt>
        <dd>{{ signedEx(trade.netExalted) }}</dd>
      </div>
    </dl>
    <p v-if="trade.partial" class="muted">Some trades carried no exalted price, so the totals are partial.</p>
  </section>
</template>

<style scoped>
.stash-gains { display: flex; flex-direction: column; gap: 0.55rem; }
.gain-line { margin: 0; display: flex; align-items: center; gap: 0.6rem; }
.gain-line small { opacity: 0.8; }
.trade-window { margin: 0; font-size: 0.76rem; }
.property-list { margin: 0; display: grid; gap: 0.35rem; }
.property-list div { display: grid; grid-template-columns: minmax(0, 8rem) minmax(0, 1fr); gap: 0.6rem; }
.property-list dt { font-size: 0.78rem; opacity: 0.75; }
.property-list dd { margin: 0; font-variant-numeric: tabular-nums; }
.property-list dd small { display: block; }
</style>
