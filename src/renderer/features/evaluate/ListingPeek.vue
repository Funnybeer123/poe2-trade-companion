<script setup lang="ts">
/**
 * The "eye" popover: the listing's own item, by mod kind, with the lines our
 * item also has highlighted so the comparison is visible rather than
 * implied. Nothing here is clickable except Close.
 */
import { computed } from "vue";
import type { EvaluateListingRow } from "../../../shared/evaluate.js";

const props = defineProps<{ row: EvaluateListingRow; ourMods: readonly string[] }>();
defineEmits<{ close: [] }>();

const ours = computed(() => new Set(props.ourMods.map((mod) => mod.trim().toLowerCase())));

const groups = computed(() =>
  (
    [
      ["Enchant", props.row.mods.enchant],
      ["Implicit", props.row.mods.implicit],
      ["Explicit", props.row.mods.explicit],
      ["Fractured", props.row.mods.fractured],
      ["Desecrated", props.row.mods.desecrated],
      ["Rune", props.row.mods.rune],
    ] as const
  ).filter(([, lines]) => lines.length > 0),
);

function matches(line: string): boolean {
  return ours.value.has(line.trim().toLowerCase());
}
</script>

<template>
  <div class="listing-peek card" role="dialog" :aria-label="`Listing from ${row.seller}`">
    <div class="section-heading">
      <h4>{{ row.name || row.typeLine }}</h4>
      <button type="button" class="button ghost compact" @click="$emit('close')">Close</button>
    </div>
    <p class="muted">
      {{ row.typeLine }}
      <span v-if="row.itemLevel !== undefined"> · iLvl {{ row.itemLevel }}</span>
      <span v-if="row.quality !== undefined"> · Q{{ row.quality }}%</span>
      <span v-if="row.requiredLevel !== undefined"> · requires level {{ row.requiredLevel }}</span>
    </p>
    <dl v-if="row.properties.length > 0" class="property-list compact-list">
      <template v-for="property in row.properties" :key="property.name">
        <dt>{{ property.name }}</dt>
        <dd>{{ property.value }}</dd>
      </template>
    </dl>
    <template v-for="[label, lines] in groups" :key="label">
      <h5>{{ label }}</h5>
      <ol class="affix-list">
        <li v-for="line in lines" :key="`${label}-${line}`" :class="{ matched: matches(line) }">{{ line }}</li>
      </ol>
    </template>
    <p v-if="row.flags.length > 0" class="muted">{{ row.flags.join(" · ") }}</p>
  </div>
</template>

<style scoped>
.listing-peek {
  display: grid;
  gap: 0.3rem;
  padding: 0.6rem 0.7rem;
  font-size: 0.78rem;
}
.listing-peek h5 {
  margin: 0.2rem 0 0;
  font-size: 0.74rem;
  text-transform: uppercase;
  opacity: 0.7;
}
.affix-list {
  margin: 0;
  padding-left: 1rem;
}
.affix-list li.matched {
  color: var(--green, #80b886);
}
</style>
