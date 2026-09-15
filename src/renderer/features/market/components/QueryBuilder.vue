<script setup lang="ts">
/**
 * The search builder: name / base type / free text, category, rarity,
 * online status and the sort, then the modifier groups and the filter
 * disclosure.
 *
 * Enter in any field searches (the stat picker swallows Enter while its
 * list is open). Reset is two-click, like every destructive control in the
 * app. Nothing here talks to the network — the parent owns the invoke.
 */
import { computed, ref } from "vue";
import { MARKET_SORT_KEYS } from "@core/marketQuery";
import type { StatIndex } from "@core/marketStatSearch";
import type { TradeQuery, TradeStatGroup } from "@core/tradeQuery";
import type { WeightTemplateView } from "../../../../shared/market.js";
import categoryData from "../../../../data/market/category-labels.json";
import FilterCards from "./FilterCards.vue";
import StatGroupsCard from "./StatGroupsCard.vue";

const props = defineProps<{
  query: TradeQuery;
  statIndex: StatIndex | null;
  templates: WeightTemplateView[];
  hasSession: boolean;
  busy?: boolean;
  searchDisabled?: boolean;
  searchDisabledReason?: string;
  nameSuggestions?: string[];
}>();
const emit = defineEmits<{
  (event: "update:query", query: TradeQuery): void;
  (event: "search"): void;
  (event: "save"): void;
  (event: "update-favorite"): void;
  (event: "copy-link"): void;
  (event: "open-site"): void;
  (event: "from-current-item"): void;
}>();

const resetArmed = ref(false);

const categories = computed(() => {
  const rows = (categoryData as { categories: Array<{ id: string; label: string; group: string; verified: boolean }> })
    .categories;
  const groups = new Map<string, Array<{ id: string; label: string; verified: boolean }>>();
  for (const row of rows) {
    const list = groups.get(row.group) ?? [];
    list.push({ id: row.id, label: row.label, verified: row.verified });
    groups.set(row.group, list);
  }
  return [...groups.entries()].map(([group, options]) => ({ group, options }));
});

function patch(part: Partial<TradeQuery>): void {
  emit("update:query", { ...props.query, ...part });
}

function setText(key: "name" | "type" | "term" | "category" | "rarity", raw: string): void {
  const value = raw.trim();
  const next = { ...props.query } as TradeQuery;
  if (value) next[key] = value;
  else delete next[key];
  emit("update:query", next);
}

function setSort(key: string): void {
  patch({ sort: { key, direction: props.query.sort?.direction ?? "asc" } });
}

function toggleDirection(): void {
  patch({
    sort: {
      key: props.query.sort?.key ?? "price",
      direction: props.query.sort?.direction === "desc" ? "asc" : "desc",
    },
  });
}

function setStats(groups: TradeStatGroup[]): void {
  patch({ stats: groups });
}

function onReset(): void {
  if (!resetArmed.value) {
    resetArmed.value = true;
    return;
  }
  resetArmed.value = false;
  emit("update:query", { stats: [], status: props.query.status ?? "online", sort: { key: "price", direction: "asc" } });
}

function onEnter(): void {
  if (props.searchDisabled || props.busy) return;
  emit("search");
}
</script>

<template>
  <section class="card query-builder" aria-labelledby="market-query-title">
    <div class="section-heading">
      <div>
        <span class="eyebrow">Build a search</span>
        <h3 id="market-query-title">Query</h3>
      </div>
    </div>

    <div class="form-grid three-up" @keydown.enter.prevent="onEnter">
      <label>
        <span>Item name</span>
        <input
          type="text"
          list="market-name-suggestions"
          placeholder="Doom Loop"
          :disabled="props.busy"
          :value="props.query.name ?? ''"
          @change="setText('name', ($event.target as HTMLInputElement).value)"
        />
        <datalist id="market-name-suggestions">
          <option v-for="name in props.nameSuggestions ?? []" :key="name" :value="name" />
        </datalist>
      </label>
      <label>
        <span>Base type</span>
        <input
          type="text"
          placeholder="Ruby Ring"
          :disabled="props.busy"
          :value="props.query.type ?? ''"
          @change="setText('type', ($event.target as HTMLInputElement).value)"
        />
      </label>
      <label>
        <span>Free text</span>
        <input
          type="text"
          placeholder="anything on the item"
          :disabled="props.busy"
          :value="props.query.term ?? ''"
          @change="setText('term', ($event.target as HTMLInputElement).value)"
        />
      </label>
      <label>
        <span>Category</span>
        <select
          :disabled="props.busy"
          :value="props.query.category ?? ''"
          @change="setText('category', ($event.target as HTMLSelectElement).value)"
        >
          <option value="">Any</option>
          <optgroup v-for="group in categories" :key="group.group" :label="group.group">
            <option v-for="option in group.options" :key="option.id" :value="option.id">
              {{ option.label }}{{ option.verified ? "" : " (unverified)" }}
            </option>
          </optgroup>
        </select>
      </label>
      <label>
        <span>Rarity</span>
        <select
          :disabled="props.busy"
          :value="props.query.rarity ?? ''"
          @change="setText('rarity', ($event.target as HTMLSelectElement).value)"
        >
          <option value="">Any</option>
          <option value="normal">Normal</option>
          <option value="magic">Magic</option>
          <option value="rare">Rare</option>
          <option value="unique">Unique</option>
          <option value="nonunique">Non-unique</option>
        </select>
      </label>
      <label>
        <span>Seller status</span>
        <select
          :disabled="props.busy"
          :value="props.query.status ?? 'online'"
          @change="patch({ status: ($event.target as HTMLSelectElement).value as TradeQuery['status'] })"
        >
          <option value="online">Online</option>
          <option value="onlineleague">Online in this league</option>
          <option value="any">Any</option>
        </select>
      </label>
      <label>
        <span>Sort by</span>
        <span class="sort-pair">
          <select
            :disabled="props.busy"
            :value="props.query.sort?.key ?? 'price'"
            @change="setSort(($event.target as HTMLSelectElement).value)"
          >
            <option v-for="option in MARKET_SORT_KEYS" :key="option.key" :value="option.key">{{ option.label }}</option>
          </select>
          <button
            type="button"
            class="button compact ghost"
            :disabled="props.busy"
            :aria-label="`Sort ${props.query.sort?.direction === 'desc' ? 'descending' : 'ascending'}`"
            @click="toggleDirection"
          >
            {{ props.query.sort?.direction === "desc" ? "↓" : "↑" }}
          </button>
        </span>
      </label>
    </div>

    <div class="button-row">
      <button
        type="button"
        class="button primary"
        :disabled="props.busy || props.searchDisabled"
        :title="props.searchDisabled ? props.searchDisabledReason : 'One trade2 search plus one fetch'"
        @click="emit('search')"
      >
        {{ props.busy ? "Searching…" : "Search" }}
      </button>
      <button type="button" class="button compact secondary" :disabled="props.busy" @click="emit('save')">
        Save as favourite
      </button>
      <button type="button" class="button compact ghost" :disabled="props.busy" @click="emit('update-favorite')">
        Update favourite
      </button>
      <button type="button" class="button compact ghost" :disabled="props.busy" @click="emit('copy-link')">
        Copy link
      </button>
      <button type="button" class="button compact ghost" :disabled="props.busy" @click="emit('open-site')">
        Open on trade site
      </button>
      <button
        type="button"
        class="button compact danger"
        :disabled="props.busy"
        @click="onReset"
        @blur="resetArmed = false"
      >
        {{ resetArmed ? "Confirm reset" : "Reset" }}
      </button>
    </div>

    <StatGroupsCard
      :groups="props.query.stats"
      :stat-index="props.statIndex"
      :templates="props.templates"
      :has-session="props.hasSession"
      :disabled="props.busy"
      @update:groups="setStats"
      @from-current-item="emit('from-current-item')"
    />

    <FilterCards :query="props.query" :disabled="props.busy" @update:query="emit('update:query', $event)" />
  </section>
</template>

<style scoped>
.query-builder {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
}
.sort-pair {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 0.3rem;
  align-items: center;
}
</style>
