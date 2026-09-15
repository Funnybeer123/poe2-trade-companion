<script setup lang="ts">
/**
 * The stat picker: a combobox over the trade2 stats catalogue. Typing
 * scores options (exact > prefix > token order > substring); ↑↓ move,
 * Enter picks the highlighted one, Escape closes the list without
 * searching. The type badge tells an explicit mod from a pseudo total.
 */
import { computed, ref, watch } from "vue";
import { searchStats, statOptionById, type MarketStatOption, type StatIndex } from "@core/marketStatSearch";

const props = defineProps<{
  index: StatIndex | null;
  modelValue: string;
  types?: string[];
  placeholder?: string;
  disabled?: boolean;
}>();
const emit = defineEmits<{ (event: "update:modelValue", id: string): void }>();

const query = ref("");
const open = ref(false);
const highlighted = ref(0);

const selected = computed(() =>
  props.index && props.modelValue ? statOptionById(props.index, props.modelValue) : undefined,
);

const matches = computed<MarketStatOption[]>(() => {
  if (!props.index || !open.value) return [];
  return searchStats(props.index, query.value, {
    limit: 20,
    ...(props.types && props.types.length ? { types: props.types } : {}),
  });
});

watch(query, () => {
  highlighted.value = 0;
});

function openList(): void {
  open.value = true;
}

function close(): void {
  open.value = false;
}

function pick(option: MarketStatOption): void {
  emit("update:modelValue", option.id);
  query.value = "";
  open.value = false;
}

function move(delta: number): void {
  if (!open.value) {
    open.value = true;
    return;
  }
  const count = matches.value.length;
  if (count === 0) return;
  highlighted.value = (highlighted.value + delta + count) % count;
}

/** Enter picks the highlighted option; the parent only searches when closed. */
function onEnter(event: KeyboardEvent): void {
  if (!open.value || matches.value.length === 0) return;
  event.preventDefault();
  event.stopPropagation();
  const option = matches.value[highlighted.value];
  if (option) pick(option);
}

function onEscape(event: KeyboardEvent): void {
  if (!open.value) return;
  event.stopPropagation();
  close();
}

const listId = `stat-list-${Math.random().toString(36).slice(2, 8)}`;
</script>

<template>
  <div class="stat-autocomplete">
    <input
      class="stat-input"
      role="combobox"
      :aria-expanded="open"
      :aria-controls="listId"
      aria-autocomplete="list"
      :disabled="props.disabled || !props.index"
      :placeholder="selected ? selected.text : (props.placeholder ?? 'Search a modifier…')"
      :value="open ? query : (selected?.text ?? '')"
      @focus="openList"
      @input="query = ($event.target as HTMLInputElement).value"
      @keydown.down.prevent="move(1)"
      @keydown.up.prevent="move(-1)"
      @keydown.enter="onEnter"
      @keydown.esc="onEscape"
      @blur="close"
    />
    <ul v-if="open && matches.length" :id="listId" class="stat-list" role="listbox">
      <li
        v-for="(option, position) in matches"
        :key="option.id"
        role="option"
        :aria-selected="position === highlighted"
        :class="{ highlighted: position === highlighted }"
        @mousedown.prevent="pick(option)"
        @mouseenter="highlighted = position"
      >
        <span class="stat-text">{{ option.text }}</span>
        <span class="tag neutral">{{ option.type }}</span>
      </li>
    </ul>
    <p v-else-if="open && !props.index" class="muted stat-empty">
      The stat catalogue is still loading — it is fetched once a week.
    </p>
    <p v-else-if="open" class="muted stat-empty">No modifier matches that.</p>
  </div>
</template>

<style scoped>
.stat-autocomplete {
  position: relative;
  min-width: 0;
}
.stat-list {
  position: absolute;
  z-index: 20;
  left: 0;
  right: 0;
  top: 100%;
  margin: 0.15rem 0 0;
  padding: 0.2rem;
  list-style: none;
  max-height: 260px;
  overflow-y: auto;
  background: var(--panel-raised);
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  box-shadow: var(--shadow);
}
.stat-list li {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.3rem 0.4rem;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.82rem;
}
.stat-list li.highlighted {
  background: var(--gold-soft);
}
.stat-text {
  flex: 1;
  min-width: 0;
}
.stat-empty {
  margin: 0.2rem 0 0;
}
</style>
