<script setup lang="ts">
/**
 * The bulk-exchange builder: what you have, what you want, a minimum stock
 * and the group-by-seller fold (which turns itself on once more than two
 * currencies are in play). One click = one trade2 exchange request.
 */
import { computed, ref } from "vue";
import { shouldGroupBySeller } from "@core/marketExchange";
import type { ExchangeQuery } from "@core/tradeQuery";
import type { ExchangeCurrencyOption } from "../../../../shared/market.js";

const props = defineProps<{
  query: ExchangeQuery;
  currencies: ExchangeCurrencyOption[];
  busy?: boolean;
  searchDisabled?: boolean;
  searchDisabledReason?: string;
}>();
const emit = defineEmits<{
  (event: "update:query", query: ExchangeQuery): void;
  (event: "search"): void;
  (event: "save"): void;
}>();

const haveFilter = ref("");
const wantFilter = ref("");

const autoGroup = computed(() => shouldGroupBySeller(props.query));

function options(filter: string, chosen: readonly string[]): ExchangeCurrencyOption[] {
  const needle = filter.trim().toLowerCase();
  return props.currencies
    .filter((option) => !chosen.includes(option.id))
    .filter((option) => !needle || option.label.toLowerCase().includes(needle) || option.id.includes(needle))
    .slice(0, 12);
}

function add(side: "have" | "want", id: string): void {
  if (!id) return;
  const next = { ...props.query, have: [...props.query.have], want: [...props.query.want] };
  if (!next[side].includes(id)) next[side].push(id);
  emit("update:query", next);
}

function remove(side: "have" | "want", id: string): void {
  const next = { ...props.query, have: [...props.query.have], want: [...props.query.want] };
  next[side] = next[side].filter((entry) => entry !== id);
  emit("update:query", next);
}

function labelFor(id: string): string {
  return props.currencies.find((option) => option.id === id)?.label ?? id;
}

function setMinimum(raw: string): void {
  const value = Number(raw);
  const next = { ...props.query };
  if (!raw.trim() || !Number.isFinite(value) || value <= 0) delete next.minimum;
  else next.minimum = Math.floor(value);
  emit("update:query", next);
}
</script>

<template>
  <section class="card exchange-builder" aria-labelledby="market-exchange-title">
    <div class="section-heading">
      <div>
        <span class="eyebrow">Bulk exchange</span>
        <h3 id="market-exchange-title">Currency exchange</h3>
        <p class="muted">One click is one trade2 exchange request. Rates shown anywhere here are estimates.</p>
      </div>
    </div>

    <div class="exchange-grid">
      <div>
        <h4>You have</h4>
        <ul class="chip-list">
          <li v-for="id in props.query.have" :key="id">
            <span class="pill">{{ labelFor(id) }}</span>
            <button type="button" class="icon-button" :aria-label="`Remove ${labelFor(id)}`" @click="remove('have', id)">
              ✕
            </button>
          </li>
        </ul>
        <input v-model="haveFilter" type="search" placeholder="Search currency…" :disabled="props.busy" />
        <ul class="option-list">
          <li v-for="option in options(haveFilter, props.query.have)" :key="option.id">
            <button type="button" class="button compact ghost" @click="add('have', option.id)">
              {{ option.label }}<span v-if="!option.verified" class="muted"> (unverified id)</span>
            </button>
          </li>
        </ul>
      </div>
      <div>
        <h4>You want</h4>
        <ul class="chip-list">
          <li v-for="id in props.query.want" :key="id">
            <span class="pill">{{ labelFor(id) }}</span>
            <button type="button" class="icon-button" :aria-label="`Remove ${labelFor(id)}`" @click="remove('want', id)">
              ✕
            </button>
          </li>
        </ul>
        <input v-model="wantFilter" type="search" placeholder="Search currency…" :disabled="props.busy" />
        <ul class="option-list">
          <li v-for="option in options(wantFilter, props.query.want)" :key="option.id">
            <button type="button" class="button compact ghost" @click="add('want', option.id)">
              {{ option.label }}<span v-if="!option.verified" class="muted"> (unverified id)</span>
            </button>
          </li>
        </ul>
      </div>
    </div>

    <div class="form-grid">
      <label>
        <span>Minimum stock</span>
        <input
          type="number"
          min="0"
          :disabled="props.busy"
          :value="props.query.minimum ?? ''"
          @change="setMinimum(($event.target as HTMLInputElement).value)"
        />
      </label>
      <label>
        <span>Seller status</span>
        <select
          :disabled="props.busy"
          :value="props.query.status ?? 'online'"
          @change="emit('update:query', { ...props.query, status: ($event.target as HTMLSelectElement).value as 'online' | 'onlineleague' })"
        >
          <option value="online">Online</option>
          <option value="onlineleague">Online in this league</option>
        </select>
      </label>
      <label class="toggle-field">
        <input
          type="checkbox"
          :disabled="props.busy || autoGroup"
          :checked="props.query.collapse === true || autoGroup"
          @change="emit('update:query', { ...props.query, collapse: ($event.target as HTMLInputElement).checked })"
        />
        <span>Group by seller{{ autoGroup ? " (on: more than two currencies)" : "" }}</span>
      </label>
    </div>

    <div class="button-row">
      <button
        type="button"
        class="button primary"
        :disabled="props.busy || props.searchDisabled || !props.query.have.length || !props.query.want.length"
        :title="props.searchDisabled ? props.searchDisabledReason : 'One trade2 exchange request'"
        @click="emit('search')"
      >
        {{ props.busy ? "Searching…" : "Search exchange" }}
      </button>
      <button type="button" class="button compact secondary" :disabled="props.busy" @click="emit('save')">
        Save as favourite
      </button>
    </div>
  </section>
</template>

<style scoped>
.exchange-builder {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.exchange-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 0.7rem;
}
.chip-list,
.option-list {
  list-style: none;
  margin: 0 0 0.35rem;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  align-items: center;
}
.chip-list li {
  display: inline-flex;
  align-items: center;
  gap: 0.15rem;
}
.option-list {
  margin-top: 0.35rem;
  max-height: 160px;
  overflow-y: auto;
}
</style>
