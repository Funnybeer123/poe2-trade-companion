<script setup lang="ts">
/**
 * Market's own settings, on the Market view (rule 4: a feature's config
 * sits on the feature's own panel; Tools → Settings only cross-references
 * it). Everyday fields are visible; the two that change what the app does
 * while you are away live behind the expert disclosure with the reason
 * spelled out.
 */
import { computed } from "vue";
import type { MarketSettings } from "../../../../shared/market.js";

const props = defineProps<{ settings: MarketSettings; busy?: boolean }>();
const emit = defineEmits<{ (event: "patch", patch: Partial<MarketSettings>): void }>();

const stale = computed(() => props.settings.staleAfterHours);

function number(raw: string, low: number, high: number, fallback: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(high, Math.max(low, Math.round(value)));
}
</script>

<template>
  <details class="advanced-options market-settings">
    <summary>Market settings</summary>
    <div class="form-grid">
      <label>
        <span>Default seller status</span>
        <select
          :disabled="props.busy"
          :value="props.settings.defaultStatus"
          @change="emit('patch', { defaultStatus: ($event.target as HTMLSelectElement).value as MarketSettings['defaultStatus'] })"
        >
          <option value="online">Online</option>
          <option value="onlineleague">Online in this league</option>
          <option value="any">Any</option>
        </select>
      </label>
      <label>
        <span>Default sale type</span>
        <select
          :disabled="props.busy"
          :value="props.settings.defaultSaleType"
          @change="emit('patch', { defaultSaleType: ($event.target as HTMLSelectElement).value as MarketSettings['defaultSaleType'] })"
        >
          <option value="any">Any</option>
          <option value="priced">Buyout or fixed price</option>
          <option value="priced_with_price">Buyout only (unverified)</option>
          <option value="unpriced">No price</option>
        </select>
      </label>
      <label>
        <span>Default price currency</span>
        <input
          type="text"
          placeholder="exalted"
          :disabled="props.busy"
          :value="props.settings.defaultCurrency"
          @change="emit('patch', { defaultCurrency: ($event.target as HTMLInputElement).value })"
        />
      </label>
      <label>
        <span>Dim listings older than ({{ stale }} h; fully faded after {{ stale * 7 }} h)</span>
        <input
          type="number"
          min="1"
          max="720"
          :disabled="props.busy"
          :value="props.settings.staleAfterHours"
          @change="emit('patch', { staleAfterHours: number(($event.target as HTMLInputElement).value, 1, 720, 24) })"
        />
      </label>
      <label class="toggle-field">
        <input
          type="checkbox"
          :disabled="props.busy"
          :checked="props.settings.collapseAfterOffer"
          @change="emit('patch', { collapseAfterOffer: ($event.target as HTMLInputElement).checked })"
        />
        <span>Collapse a seller’s other rows after you whisper them</span>
      </label>
      <label class="toggle-field">
        <input
          type="checkbox"
          :disabled="props.busy"
          :checked="props.settings.liveSound"
          @change="emit('patch', { liveSound: ($event.target as HTMLInputElement).checked })"
        />
        <span>Chime on a live-search hit</span>
      </label>
      <label class="toggle-field">
        <input
          type="checkbox"
          :disabled="props.busy"
          :checked="props.settings.liveNotify"
          @change="emit('patch', { liveNotify: ($event.target as HTMLInputElement).checked })"
        />
        <span>Windows notification on a live-search hit</span>
      </label>
      <label class="toggle-field">
        <input
          type="checkbox"
          :disabled="props.busy"
          :checked="props.settings.defaultInstantBuyout"
          @change="emit('patch', { defaultInstantBuyout: ($event.target as HTMLInputElement).checked })"
        />
        <span>New tabs start with “Buyout only” (unverified mapping)</span>
      </label>
    </div>

    <details class="advanced-options nested">
      <summary>Expert</summary>
      <div class="form-grid">
        <label>
          <span>Fetch slots kept spare for price checks</span>
          <input
            type="number"
            min="0"
            max="8"
            :disabled="props.busy"
            :value="props.settings.minSpareFetches"
            @change="emit('patch', { minSpareFetches: number(($event.target as HTMLInputElement).value, 0, 8, 2) })"
          />
        </label>
        <label>
          <span>Stop live searches after (hours, 0 = never)</span>
          <input
            type="number"
            min="0"
            max="48"
            :disabled="props.busy"
            :value="props.settings.stopLiveAfterHours"
            @change="emit('patch', { stopLiveAfterHours: number(($event.target as HTMLInputElement).value, 0, 48, 6) })"
          />
        </label>
        <label class="toggle-field">
          <input
            type="checkbox"
            :disabled="props.busy"
            :checked="props.settings.resumeLiveSearches"
            @change="emit('patch', { resumeLiveSearches: ($event.target as HTMLInputElement).checked })"
          />
          <span>
            Re-open saved live searches at start — opens websockets to pathofexile.com with your POESESSID on every app
            start
          </span>
        </label>
      </div>
    </details>
    <p class="disclaimer">
      Prices anywhere in Market are other players’ asks and feed estimates, never guaranteed sale prices.
    </p>
  </details>
</template>

<style scoped>
.market-settings {
  margin-top: 0.4rem;
}
</style>
