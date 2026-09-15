<script setup lang="ts">
/**
 * Stat filter groups: and / not / count / weighted sum, each row with its
 * own min, max (and weight), an enable checkbox, and a collapse.
 *
 * Weighted groups are refused by trade2 without a session cookie ("Query is
 * too complex"), so the header says so rather than letting the search fail.
 */
import { computed, ref } from "vue";
import type { TradeStatGroup } from "@core/tradeQuery";
import type { StatIndex } from "@core/marketStatSearch";
import { MARKET_STAT_TYPES } from "@core/marketStatSearch";
import type { WeightTemplateView } from "../../../../shared/market.js";
import StatAutocomplete from "./StatAutocomplete.vue";

const props = defineProps<{
  groups: TradeStatGroup[];
  statIndex: StatIndex | null;
  templates: WeightTemplateView[];
  hasSession: boolean;
  disabled?: boolean;
}>();
const emit = defineEmits<{
  (event: "update:groups", groups: TradeStatGroup[]): void;
  (event: "from-current-item"): void;
}>();

const collapsed = ref<Record<number, boolean>>({});
const typeFilter = ref<string>("");
const showTemplates = ref(false);

const GROUP_TYPES: Array<{ value: TradeStatGroup["type"]; label: string }> = [
  { value: "and", label: "And" },
  { value: "not", label: "Not" },
  { value: "count", label: "Count" },
  { value: "weight", label: "Weighted sum" },
  { value: "weight2", label: "Weighted sum 2" },
];

const weighted = computed(() => props.groups.some((group) => group.type === "weight" || group.type === "weight2"));

function commit(next: TradeStatGroup[]): void {
  emit("update:groups", next);
}

function clone(): TradeStatGroup[] {
  return props.groups.map((group) => ({
    ...group,
    filters: group.filters.map((filter) => ({ ...filter, ...(filter.value ? { value: { ...filter.value } } : {}) })),
    ...(group.value ? { value: { ...group.value } } : {}),
  }));
}

function addGroup(): void {
  commit([...clone(), { type: "and", filters: [] }]);
}

function removeGroup(index: number): void {
  const next = clone();
  next.splice(index, 1);
  commit(next);
}

function setGroupType(index: number, type: TradeStatGroup["type"]): void {
  const next = clone();
  const group = next[index];
  if (group) group.type = type;
  commit(next);
}

function setGroupBound(index: number, key: "min" | "max", raw: string): void {
  const next = clone();
  const group = next[index];
  if (!group) return;
  const value = raw.trim() === "" ? undefined : Number(raw);
  const bound = { ...(group.value ?? {}) };
  if (value === undefined || !Number.isFinite(value)) delete bound[key];
  else bound[key] = value;
  if (Object.keys(bound).length === 0) delete group.value;
  else group.value = bound;
  commit(next);
}

function addFilter(index: number): void {
  const next = clone();
  next[index]?.filters.push({ id: "" });
  commit(next);
}

function removeFilter(groupIndex: number, filterIndex: number): void {
  const next = clone();
  next[groupIndex]?.filters.splice(filterIndex, 1);
  commit(next);
}

function setFilterId(groupIndex: number, filterIndex: number, id: string): void {
  const next = clone();
  const filter = next[groupIndex]?.filters[filterIndex];
  if (filter) filter.id = id;
  commit(next);
}

function setFilterBound(groupIndex: number, filterIndex: number, key: "min" | "max" | "weight", raw: string): void {
  const next = clone();
  const filter = next[groupIndex]?.filters[filterIndex];
  if (!filter) return;
  const value = raw.trim() === "" ? undefined : Number(raw);
  const bound = { ...(filter.value ?? {}) };
  if (value === undefined || !Number.isFinite(value)) delete bound[key];
  else bound[key] = value;
  if (Object.keys(bound).length === 0) delete filter.value;
  else filter.value = bound;
  commit(next);
}

function toggleFilter(groupIndex: number, filterIndex: number, enabled: boolean): void {
  const next = clone();
  const filter = next[groupIndex]?.filters[filterIndex];
  if (!filter) return;
  if (enabled) delete filter.disabled;
  else filter.disabled = true;
  commit(next);
}

function applyTemplate(template: WeightTemplateView): void {
  const filters = template.filters
    .filter((filter) => filter.id)
    .map((filter) => ({ id: filter.id, value: { weight: filter.weight } }));
  if (filters.length === 0) return;
  commit([
    ...clone(),
    {
      type: template.type,
      filters,
      ...(template.min !== undefined ? { value: { min: template.min } } : {}),
    },
  ]);
  showTemplates.value = false;
}

function enabledCount(group: TradeStatGroup): number {
  return group.filters.filter((filter) => !filter.disabled && filter.id).length;
}
</script>

<template>
  <section class="card stat-groups" aria-labelledby="market-stats-title">
    <div class="section-heading">
      <div>
        <h3 id="market-stats-title">Modifiers</h3>
        <p class="muted">
          Each group is one trade2 stat filter. Weighted sums need a session cookie — trade2 refuses them anonymously.
        </p>
      </div>
      <span v-if="props.groups.length" class="count-badge">{{ props.groups.length }}</span>
    </div>

    <p v-if="weighted && !props.hasSession" class="inline-notice warning" role="note">
      A weighted group needs a POESESSID (Tools → Settings → Market data); without one trade2 answers “Query is too
      complex”.
    </p>

    <label class="stat-type-filter">
      <span>Modifier type in the picker</span>
      <select v-model="typeFilter" :disabled="props.disabled">
        <option value="">All types</option>
        <option v-for="type in MARKET_STAT_TYPES" :key="type" :value="type">{{ type }}</option>
      </select>
    </label>

    <div v-for="(group, groupIndex) in props.groups" :key="groupIndex" class="stat-group">
      <header class="stat-group-head">
        <select
          :value="group.type"
          :aria-label="`Group ${groupIndex + 1} type`"
          :disabled="props.disabled"
          @change="setGroupType(groupIndex, ($event.target as HTMLSelectElement).value as TradeStatGroup['type'])"
        >
          <option v-for="option in GROUP_TYPES" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
        <template v-if="group.type !== 'and' && group.type !== 'not'">
          <input
            class="bound"
            type="number"
            :aria-label="`Group ${groupIndex + 1} minimum`"
            placeholder="min"
            :value="group.value?.min ?? ''"
            :disabled="props.disabled"
            @change="setGroupBound(groupIndex, 'min', ($event.target as HTMLInputElement).value)"
          />
          <input
            class="bound"
            type="number"
            :aria-label="`Group ${groupIndex + 1} maximum`"
            placeholder="max"
            :value="group.value?.max ?? ''"
            :disabled="props.disabled"
            @change="setGroupBound(groupIndex, 'max', ($event.target as HTMLInputElement).value)"
          />
        </template>
        <span class="count-badge">{{ enabledCount(group) }} of {{ group.filters.length }} on</span>
        <button
          type="button"
          class="icon-button"
          :aria-label="collapsed[groupIndex] ? 'Expand group' : 'Collapse group'"
          @click="collapsed[groupIndex] = !collapsed[groupIndex]"
        >
          {{ collapsed[groupIndex] ? "▸" : "▾" }}
        </button>
        <button
          type="button"
          class="icon-button"
          :aria-label="`Remove group ${groupIndex + 1}`"
          :disabled="props.disabled"
          @click="removeGroup(groupIndex)"
        >
          ✕
        </button>
      </header>

      <div v-if="!collapsed[groupIndex]" class="stat-rows">
        <div v-for="(filter, filterIndex) in group.filters" :key="filterIndex" class="stat-rule-row">
          <label class="inline-toggle">
            <input
              type="checkbox"
              :checked="!filter.disabled"
              :aria-label="`Enable modifier ${filterIndex + 1}`"
              :disabled="props.disabled"
              @change="toggleFilter(groupIndex, filterIndex, ($event.target as HTMLInputElement).checked)"
            />
          </label>
          <StatAutocomplete
            :index="props.statIndex"
            :model-value="filter.id"
            :types="typeFilter ? [typeFilter] : undefined"
            :disabled="props.disabled"
            @update:model-value="setFilterId(groupIndex, filterIndex, $event)"
          />
          <input
            class="bound"
            type="number"
            placeholder="min"
            :aria-label="`Modifier ${filterIndex + 1} minimum`"
            :value="filter.value?.min ?? ''"
            :disabled="props.disabled"
            @change="setFilterBound(groupIndex, filterIndex, 'min', ($event.target as HTMLInputElement).value)"
          />
          <input
            class="bound"
            type="number"
            placeholder="max"
            :aria-label="`Modifier ${filterIndex + 1} maximum`"
            :value="filter.value?.max ?? ''"
            :disabled="props.disabled"
            @change="setFilterBound(groupIndex, filterIndex, 'max', ($event.target as HTMLInputElement).value)"
          />
          <input
            v-if="group.type === 'weight' || group.type === 'weight2'"
            class="bound"
            type="number"
            placeholder="weight"
            :aria-label="`Modifier ${filterIndex + 1} weight`"
            :value="filter.value?.weight ?? ''"
            :disabled="props.disabled"
            @change="setFilterBound(groupIndex, filterIndex, 'weight', ($event.target as HTMLInputElement).value)"
          />
          <button
            type="button"
            class="icon-button"
            :aria-label="`Remove modifier ${filterIndex + 1}`"
            :disabled="props.disabled"
            @click="removeFilter(groupIndex, filterIndex)"
          >
            ✕
          </button>
        </div>
        <button type="button" class="button compact ghost" :disabled="props.disabled" @click="addFilter(groupIndex)">
          + Modifier
        </button>
      </div>
    </div>

    <div class="button-row">
      <button type="button" class="button compact secondary" :disabled="props.disabled" @click="addGroup">
        + Group
      </button>
      <button
        type="button"
        class="button compact ghost"
        :disabled="props.disabled || !props.templates.length"
        @click="showTemplates = !showTemplates"
      >
        Templates
      </button>
      <button type="button" class="button compact ghost" :disabled="props.disabled" @click="emit('from-current-item')">
        From current item
      </button>
    </div>

    <ul v-if="showTemplates" class="template-list">
      <li v-for="template in props.templates" :key="template.id">
        <button
          type="button"
          class="button compact ghost"
          :disabled="!template.resolved"
          :title="template.resolved ? template.label : 'Some modifiers are not in the current catalogue'"
          @click="applyTemplate(template)"
        >
          {{ template.label }}
        </button>
        <span v-if="!template.resolved" class="muted">not in the current catalogue</span>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.stat-groups {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.stat-type-filter {
  max-width: 260px;
}
.stat-group {
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 0.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.stat-group-head {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
}
.stat-group-head select {
  width: auto;
  min-width: 9rem;
}
.stat-rows {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.stat-rule-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) 5.5rem 5.5rem auto;
  gap: 0.35rem;
  align-items: center;
}
.bound {
  width: 100%;
  min-height: 31px;
}
.template-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  align-items: center;
}
</style>
