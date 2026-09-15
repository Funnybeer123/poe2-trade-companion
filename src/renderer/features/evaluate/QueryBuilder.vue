<script setup lang="ts">
/**
 * The editable query: identity, the mod / pseudo / property rows, the misc
 * ranges and flags, and the search filters. Nothing here talks to main —
 * the workbench owns the state and decides when a search is worth a lookup.
 *
 * Enter anywhere in the builder runs the search (one search + one fetch).
 */
import { computed } from "vue";
import type {
  EvaluateFilterRow,
  EvaluateItemSummary,
  EvaluateQueryState,
  EvaluateRangeToggle,
} from "../../../shared/evaluate.js";
import ModFilterRow from "./ModFilterRow.vue";

const props = defineProps<{
  query: EvaluateQueryState;
  item: EvaluateItemSummary;
  catalogueReady: boolean;
}>();

const emit = defineEmits<{
  patch: [patch: Partial<EvaluateQueryState>];
  row: [key: string, patch: { enabled?: boolean; min?: number | undefined; max?: number | undefined }];
  submit: [];
}>();

const modRows = computed(() => props.query.rows.filter((row) => row.kind === "mod" || row.kind === "fractured"));
const pseudoRows = computed(() => props.query.rows.filter((row) => row.kind === "pseudo"));
const propertyRows = computed(() => props.query.rows.filter((row) => row.kind === "property"));

const enabledCount = computed(() => props.query.rows.filter((row) => row.enabled).length);

function onRow(row: EvaluateFilterRow, patch: { enabled?: boolean; min?: number; max?: number }): void {
  emit("row", row.key, patch);
}

function toggleRange(key: keyof EvaluateQueryState, current: EvaluateRangeToggle, enabled: boolean): void {
  emit("patch", { [key]: { ...current, enabled } } as Partial<EvaluateQueryState>);
}

function setRangeBound(
  key: keyof EvaluateQueryState,
  current: EvaluateRangeToggle,
  which: "min" | "max",
  raw: string,
): void {
  const value = raw.trim() === "" ? undefined : Number(raw);
  const next: EvaluateRangeToggle = { ...current, [which]: Number.isFinite(value) ? value : undefined };
  emit("patch", { [key]: next } as Partial<EvaluateQueryState>);
}

/**
 * "Listed in" is the one filter that re-searches on change: it narrows the
 * SAME query to one currency, and trade2 serves the repeat from the feed's
 * 60 s search cache, so the user does not press Search for it.
 */
function setPriceCurrency(raw: string): void {
  emit("patch", { priceCurrency: raw as EvaluateQueryState["priceCurrency"] });
  emit("submit");
}

/** Tri-state flags: "" = any, "yes" = must be, "no" = must not be. */
function flagValue(flag: boolean | undefined): string {
  return flag === undefined ? "" : flag ? "yes" : "no";
}

function setFlag(name: "corrupted" | "mirrored" | "sanctified" | "fractured" | "desecrated", raw: string): void {
  const flags = { ...props.query.flags };
  if (raw === "") delete flags[name];
  else flags[name] = raw === "yes";
  emit("patch", { flags });
}
</script>

<template>
  <form class="query-builder" @submit.prevent="emit('submit')">
    <p v-if="!catalogueReady" class="inline-notice warning" role="status">
      The trade2 stat catalogue is not loaded yet — this search will match the base type only.
    </p>

    <div class="form-grid compact-grid">
      <label v-if="query.name !== undefined || item.rarity.toLowerCase() === 'unique'">
        Name
        <input
          type="text"
          :value="query.name ?? ''"
          @change="emit('patch', { name: ($event.target as HTMLInputElement).value })"
        />
      </label>
      <label>
        Base type
        <input
          type="text"
          :value="query.type ?? ''"
          @change="emit('patch', { type: ($event.target as HTMLInputElement).value })"
        />
      </label>
      <label v-if="item.uniqueVariants.length > 0">
        Unique variant
        <select
          :value="query.uniqueVariant ?? ''"
          @change="
            emit('patch', {
              uniqueVariant: ($event.target as HTMLSelectElement).value,
              name: ($event.target as HTMLSelectElement).value,
            })
          "
        >
          <option value="">Any unique on this base</option>
          <option v-for="variant in item.uniqueVariants" :key="variant" :value="variant">{{ variant }}</option>
        </select>
      </label>
      <label>
        Rarity
        <select
          :value="query.rarity"
          @change="emit('patch', { rarity: ($event.target as HTMLSelectElement).value as EvaluateQueryState['rarity'] })"
        >
          <option value="nonunique">Non-unique</option>
          <option value="unique">Unique</option>
          <option value="rare">Rare</option>
          <option value="magic">Magic</option>
          <option value="normal">Normal</option>
          <option value="any">Any</option>
        </select>
      </label>
    </div>

    <section v-if="pseudoRows.length > 0" class="row-group" aria-label="Pseudo totals">
      <h4>Pseudo totals</h4>
      <ul class="filter-list">
        <ModFilterRow
          v-for="row in pseudoRows"
          :key="row.key"
          :row="row"
          @change="onRow(row, $event)"
        />
      </ul>
    </section>

    <section v-if="modRows.length > 0" class="row-group" aria-label="Modifiers">
      <h4>Modifiers</h4>
      <ul class="filter-list">
        <ModFilterRow v-for="row in modRows" :key="row.key" :row="row" @change="onRow(row, $event)" />
      </ul>
    </section>

    <section v-if="propertyRows.length > 0" class="row-group" aria-label="Properties">
      <h4>Properties</h4>
      <ul class="filter-list">
        <ModFilterRow v-for="row in propertyRows" :key="row.key" :row="row" @change="onRow(row, $event)" />
      </ul>
    </section>

    <details class="advanced-options">
      <summary>Item level, quality, sockets and flags</summary>
      <div class="misc-grid">
        <label class="toggle-field">
          <input
            type="checkbox"
            :checked="query.ilvl.enabled"
            @change="toggleRange('ilvl', query.ilvl, ($event.target as HTMLInputElement).checked)"
          />
          Item level ≥
          <input
            class="bound"
            type="number"
            :value="query.ilvl.min ?? ''"
            @change="setRangeBound('ilvl', query.ilvl, 'min', ($event.target as HTMLInputElement).value)"
          />
        </label>
        <label class="toggle-field">
          <input
            type="checkbox"
            :checked="query.quality.enabled"
            @change="toggleRange('quality', query.quality, ($event.target as HTMLInputElement).checked)"
          />
          Quality ≥
          <input
            class="bound"
            type="number"
            :value="query.quality.min ?? ''"
            @change="setRangeBound('quality', query.quality, 'min', ($event.target as HTMLInputElement).value)"
          />
        </label>
        <label v-if="item.kind === 'gem'" class="toggle-field">
          <input
            type="checkbox"
            :checked="query.gemLevel.enabled"
            @change="toggleRange('gemLevel', query.gemLevel, ($event.target as HTMLInputElement).checked)"
          />
          Gem level ≥
          <input
            class="bound"
            type="number"
            :value="query.gemLevel.min ?? ''"
            @change="setRangeBound('gemLevel', query.gemLevel, 'min', ($event.target as HTMLInputElement).value)"
          />
        </label>
        <label v-if="item.kind === 'waystone'" class="toggle-field">
          <input
            type="checkbox"
            :checked="query.mapTier.enabled"
            @change="toggleRange('mapTier', query.mapTier, ($event.target as HTMLInputElement).checked)"
          />
          Waystone tier
          <input
            class="bound"
            type="number"
            :value="query.mapTier.min ?? ''"
            @change="setRangeBound('mapTier', query.mapTier, 'min', ($event.target as HTMLInputElement).value)"
          />
        </label>
        <label class="toggle-field">
          <input
            type="checkbox"
            :checked="query.runeSockets.enabled"
            @change="toggleRange('runeSockets', query.runeSockets, ($event.target as HTMLInputElement).checked)"
          />
          Rune sockets ≥
          <input
            class="bound"
            type="number"
            :value="query.runeSockets.min ?? ''"
            @change="setRangeBound('runeSockets', query.runeSockets, 'min', ($event.target as HTMLInputElement).value)"
          />
        </label>
        <label class="toggle-field">
          <input
            type="checkbox"
            :checked="query.emptyRuneSockets.enabled"
            @change="
              toggleRange('emptyRuneSockets', query.emptyRuneSockets, ($event.target as HTMLInputElement).checked)
            "
          />
          Empty rune sockets ≥
          <input
            class="bound"
            type="number"
            :value="query.emptyRuneSockets.min ?? ''"
            @change="
              setRangeBound('emptyRuneSockets', query.emptyRuneSockets, 'min', ($event.target as HTMLInputElement).value)
            "
          />
        </label>
        <label class="toggle-field" :title="query.openAffixes.statId ? '' : 'trade2 has no empty-affix stat in the loaded catalogue'">
          <input
            type="checkbox"
            :checked="query.openAffixes.enabled"
            :disabled="!query.openAffixes.statId"
            @change="
              emit('patch', {
                openAffixes: { ...query.openAffixes, enabled: ($event.target as HTMLInputElement).checked },
              })
            "
          />
          Open affixes ≥ {{ query.openAffixes.count }}
        </label>
        <label class="toggle-field">
          <input
            type="checkbox"
            :checked="query.flags.modifiableOnly"
            @change="
              emit('patch', {
                flags: { ...query.flags, modifiableOnly: ($event.target as HTMLInputElement).checked },
              })
            "
          />
          Modifiable only
        </label>
      </div>
      <div class="form-grid compact-grid">
        <label v-for="flag in (['corrupted', 'mirrored', 'sanctified', 'fractured', 'desecrated'] as const)" :key="flag">
          {{ flag.charAt(0).toUpperCase() + flag.slice(1) }}
          <select :value="flagValue(query.flags[flag])" @change="setFlag(flag, ($event.target as HTMLSelectElement).value)">
            <option value="">Any</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </label>
      </div>
    </details>

    <div class="form-grid compact-grid">
      <label>
        Seller status
        <select
          :value="query.status"
          @change="emit('patch', { status: ($event.target as HTMLSelectElement).value as EvaluateQueryState['status'] })"
        >
          <option value="online">Online</option>
          <option value="onlineleague">Online in league</option>
          <option value="any">Any</option>
        </select>
      </label>
      <label>
        Listing age
        <select
          :value="query.indexed"
          @change="emit('patch', { indexed: ($event.target as HTMLSelectElement).value as EvaluateQueryState['indexed'] })"
        >
          <option value="">Any age</option>
          <option value="1day">Last day</option>
          <option value="3days">Last 3 days</option>
          <option value="1week">Last week</option>
          <option value="2weeks">Last 2 weeks</option>
          <option value="1month">Last month</option>
          <option value="3months">Last 3 months</option>
        </select>
      </label>
      <label>
        Listed in
        <select
          :value="query.priceCurrency"
          title="Changing this re-runs the search — a repeat inside a minute is served from the cache."
          @change="setPriceCurrency(($event.target as HTMLSelectElement).value)"
        >
          <option value="">Any currency</option>
          <option value="exalted">Exalted Orbs</option>
          <option value="divine">Divine Orbs</option>
          <option value="chaos">Chaos Orbs</option>
        </select>
      </label>
    </div>

    <p class="muted shortcut-hint">
      {{ enabledCount }} filter{{ enabledCount === 1 ? "" : "s" }} selected · press <kbd>Enter</kbd> to search
      (one search + one fetch).
    </p>
    <button type="submit" class="sr-only">Search</button>
  </form>
</template>

<style scoped>
.query-builder {
  display: grid;
  gap: 0.6rem;
}
.row-group h4 {
  margin: 0 0 0.2rem;
}
.filter-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 260px;
  overflow-y: auto;
}
.misc-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 0.35rem;
  margin-bottom: 0.5rem;
}
.toggle-field {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.78rem;
}
.toggle-field input[type="checkbox"] {
  width: auto;
  min-height: 0;
}
.bound {
  width: 74px;
  min-height: 27px;
  padding: 0.1rem 0.3rem;
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
}
</style>
