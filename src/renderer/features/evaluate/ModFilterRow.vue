<script setup lang="ts">
/**
 * One toggleable line of the query: a mod, a pseudo total or a property.
 * The row explains itself — affix side, tier (from the advanced copy or the
 * learned ladder), the appraisal score, and why a line cannot be searched —
 * so the user can see exactly what the query will ask trade2 for.
 */
import { computed } from "vue";
import type { EvaluateFilterRow } from "../../../shared/evaluate.js";

const props = defineProps<{ row: EvaluateFilterRow; disabled?: boolean }>();

const emit = defineEmits<{
  change: [patch: { enabled?: boolean; min?: number | undefined; max?: number | undefined }];
}>();

const searchable = computed(() =>
  props.row.kind === "property" ? props.row.equipmentKey !== undefined : props.row.statIds.length > 0,
);

const locked = computed(() => props.disabled === true || !searchable.value);

const sideBadge = computed(() => {
  const affix = props.row.affix;
  if (!affix || affix === "unknown") return "";
  return affix.charAt(0).toUpperCase() + affix.slice(1);
});

const tierBadge = computed(() =>
  props.row.tier === undefined ? "" : `T${props.row.tier}${props.row.tierSource === "learned" ? "·learned" : ""}`,
);

const title = computed(() => {
  const parts: string[] = [];
  if (props.row.modName) parts.push(`"${props.row.modName}"`);
  if (props.row.score !== undefined) parts.push(`score ${props.row.score} pts`);
  if (props.row.sources?.length) parts.push(`from: ${props.row.sources.join(" · ")}`);
  if (props.row.note) parts.push(props.row.note);
  if (props.row.statIds.length > 0) parts.push(props.row.statIds.join(", "));
  if (props.row.unsearchableReason) parts.push(props.row.unsearchableReason);
  return parts.join(" — ");
});

function onToggle(event: Event): void {
  emit("change", { enabled: (event.target as HTMLInputElement).checked });
}

function onBound(which: "min" | "max", event: Event): void {
  const raw = (event.target as HTMLInputElement).value.trim();
  const value = raw === "" ? undefined : Number(raw);
  emit("change", { [which]: value !== undefined && Number.isFinite(value) ? value : undefined });
}
</script>

<template>
  <li class="filter-row" :class="{ consumed: !!row.consumedBy, unsearchable: !searchable }">
    <label class="filter-check" :title="title">
      <input
        type="checkbox"
        :checked="row.enabled"
        :disabled="locked"
        :aria-label="`Search on ${row.label}`"
        @change="onToggle"
      />
      <span class="filter-label">{{ row.label }}</span>
    </label>
    <span class="filter-badges">
      <span v-if="sideBadge" class="tag neutral">{{ sideBadge }}</span>
      <span v-if="tierBadge" class="tag neutral">{{ tierBadge }}</span>
      <span v-if="row.note" class="tag neutral">{{ row.note }}</span>
      <span v-if="row.consumedBy" class="tag neutral">in pseudo</span>
      <span v-if="!searchable" class="tag missed" :title="row.unsearchableReason">not searchable</span>
    </span>
    <span class="filter-bounds">
      <label class="sr-only" :for="`${row.key}-min`">Minimum for {{ row.label }}</label>
      <input
        :id="`${row.key}-min`"
        class="bound"
        type="number"
        step="any"
        placeholder="min"
        :value="row.min ?? ''"
        :disabled="locked"
        @change="onBound('min', $event)"
      />
      <label class="sr-only" :for="`${row.key}-max`">Maximum for {{ row.label }}</label>
      <input
        :id="`${row.key}-max`"
        class="bound"
        type="number"
        step="any"
        placeholder="max"
        :value="row.max ?? ''"
        :disabled="locked"
        @change="onBound('max', $event)"
      />
    </span>
  </li>
</template>

<style scoped>
.filter-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 0.4rem;
  padding: 0.16rem 0;
  border-bottom: 1px solid rgba(140, 140, 160, 0.12);
}
.filter-check {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-weight: 500;
  font-size: 0.78rem;
  min-width: 0;
}
.filter-check input {
  width: auto;
  min-height: 0;
}
.filter-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.filter-badges {
  display: flex;
  gap: 0.24rem;
  align-items: center;
}
.filter-bounds {
  display: flex;
  gap: 0.24rem;
}
.bound {
  width: 68px;
  min-height: 27px;
  padding: 0.1rem 0.3rem;
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
}
.consumed .filter-label {
  color: var(--text-muted, #888b8e);
}
.unsearchable .filter-label {
  opacity: 0.6;
}
</style>
