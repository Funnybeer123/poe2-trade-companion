<script setup lang="ts">
/**
 * Equipment, misc and trade filters, behind one disclosure that opens
 * itself when the query already carries a value (minimal-config rule 3).
 *
 * Corrupted and twice-corrupted are one exclusive control: twice corrupted
 * implies corrupted, so the pair can never ask for something impossible.
 */
import { computed } from "vue";
import { isTwiceCorruptedExclusive } from "@core/marketQuery";
import type { EquipmentFilterKey, MiscBooleanKey, MiscRangeKey, TradeQuery } from "@core/tradeQuery";

const props = defineProps<{ query: TradeQuery; disabled?: boolean }>();
const emit = defineEmits<{ (event: "update:query", query: TradeQuery): void }>();

const EQUIPMENT: Array<{ key: EquipmentFilterKey; label: string }> = [
  { key: "damage", label: "Damage" },
  { key: "dps", label: "DPS" },
  { key: "pdps", label: "Physical DPS" },
  { key: "edps", label: "Elemental DPS" },
  { key: "aps", label: "Attacks / sec" },
  { key: "crit", label: "Critical chance" },
  { key: "ar", label: "Armour" },
  { key: "ev", label: "Evasion" },
  { key: "es", label: "Energy shield" },
  { key: "ward", label: "Ward" },
  { key: "block", label: "Block" },
  { key: "spirit", label: "Spirit" },
  { key: "rune_sockets", label: "Rune sockets" },
  { key: "empty_rune_sockets", label: "Empty rune sockets" },
  { key: "gem_sockets", label: "Gem sockets" },
];

const MISC_RANGES: Array<{ key: MiscRangeKey; label: string }> = [
  { key: "ilvl", label: "Item level" },
  { key: "quality", label: "Quality" },
  { key: "gem_level", label: "Gem level" },
  { key: "gem_sockets", label: "Gem sockets" },
  { key: "stack_size", label: "Stack size" },
  { key: "area_level", label: "Area level" },
  { key: "map_tier", label: "Waystone tier" },
  { key: "unidentified_tier", label: "Unidentified tier" },
];

const MISC_BOOLEANS: Array<{ key: MiscBooleanKey; label: string }> = [
  { key: "corrupted", label: "Corrupted" },
  { key: "twice_corrupted", label: "Twice corrupted" },
  { key: "mirrored", label: "Mirrored" },
  { key: "identified", label: "Identified" },
  { key: "sanctified", label: "Sanctified" },
  { key: "fractured_item", label: "Fractured" },
  { key: "desecrated_item", label: "Desecrated" },
  { key: "crafted", label: "Crafted" },
  { key: "veiled", label: "Veiled" },
  { key: "alternate_art", label: "Alternate art" },
];

const SALE_TYPES: Array<{ value: string; label: string }> = [
  { value: "any", label: "Any" },
  { value: "priced", label: "Buyout or fixed price" },
  { value: "priced_with_price", label: "Buyout only (unverified)" },
  { value: "unpriced", label: "No price" },
];

const INDEXED: Array<{ value: string; label: string }> = [
  { value: "", label: "Any time" },
  { value: "1hour", label: "Last hour" },
  { value: "1day", label: "Last day" },
  { value: "3days", label: "Last 3 days" },
  { value: "1week", label: "Last week" },
  { value: "2weeks", label: "Last 2 weeks" },
];

const hasAnyValue = computed(
  () =>
    Object.keys(props.query.equipment ?? {}).length > 0 ||
    Object.keys(props.query.misc ?? {}).length > 0 ||
    Object.keys(props.query.trade ?? {}).length > 0,
);

function next(): TradeQuery {
  return JSON.parse(JSON.stringify(props.query)) as TradeQuery;
}

function setEquipment(key: EquipmentFilterKey, bound: "min" | "max", raw: string): void {
  const query = next();
  const equipment = { ...(query.equipment ?? {}) };
  const range = { ...(equipment[key] ?? {}) };
  const value = raw.trim() === "" ? undefined : Number(raw);
  if (value === undefined || !Number.isFinite(value)) delete range[bound];
  else range[bound] = value;
  if (Object.keys(range).length === 0) delete equipment[key];
  else equipment[key] = range;
  if (Object.keys(equipment).length === 0) delete query.equipment;
  else query.equipment = equipment;
  emit("update:query", query);
}

function setMiscRange(key: MiscRangeKey, bound: "min" | "max", raw: string): void {
  const query = next();
  const misc = { ...(query.misc ?? {}) };
  const range = { ...((misc[key] as { min?: number; max?: number } | undefined) ?? {}) };
  const value = raw.trim() === "" ? undefined : Number(raw);
  if (value === undefined || !Number.isFinite(value)) delete range[bound];
  else range[bound] = value;
  if (Object.keys(range).length === 0) delete misc[key];
  else misc[key] = range;
  if (Object.keys(misc).length === 0) delete query.misc;
  else query.misc = misc;
  emit("update:query", query);
}

function setMiscBoolean(key: MiscBooleanKey, raw: string): void {
  const query = next();
  const misc = { ...(query.misc ?? {}) };
  if (raw === "") delete misc[key];
  else misc[key] = raw === "true";
  const cleaned = isTwiceCorruptedExclusive(misc);
  if (!cleaned || Object.keys(cleaned).length === 0) delete query.misc;
  else query.misc = cleaned;
  emit("update:query", query);
}

function setTrade(patch: Partial<NonNullable<TradeQuery["trade"]>>): void {
  const query = next();
  const trade = { ...(query.trade ?? {}), ...patch };
  for (const [key, value] of Object.entries(trade)) {
    if (value === undefined || value === "" || value === false) delete (trade as Record<string, unknown>)[key];
  }
  if (Object.keys(trade).length === 0) delete query.trade;
  else query.trade = trade;
  emit("update:query", query);
}

function setPrice(key: "option" | "min" | "max", raw: string): void {
  const query = next();
  const trade = { ...(query.trade ?? {}) };
  const price = { ...(trade.price ?? {}) };
  if (key === "option") {
    if (raw.trim()) price.option = raw.trim();
    else delete price.option;
  } else {
    const value = raw.trim() === "" ? undefined : Number(raw);
    if (value === undefined || !Number.isFinite(value)) delete price[key];
    else price[key] = value;
  }
  if (Object.keys(price).length === 0) delete trade.price;
  else trade.price = price;
  if (Object.keys(trade).length === 0) delete query.trade;
  else query.trade = trade;
  emit("update:query", query);
}

function booleanValue(key: MiscBooleanKey): string {
  const flag = props.query.misc?.[key];
  return typeof flag === "boolean" ? String(flag) : "";
}

function rangeValue(map: Record<string, { min?: number; max?: number } | undefined> | undefined, key: string, bound: "min" | "max"): string {
  const range = map?.[key];
  const value = range?.[bound];
  return value === undefined ? "" : String(value);
}
</script>

<template>
  <details class="advanced-options market-filters" :open="hasAnyValue">
    <summary>Equipment, misc and trade filters</summary>

    <section aria-labelledby="market-equipment-title">
      <h4 id="market-equipment-title">Equipment</h4>
      <div class="filter-grid">
        <label v-for="entry in EQUIPMENT" :key="entry.key">
          <span>{{ entry.label }}</span>
          <span class="range-pair">
            <input
              type="number"
              placeholder="min"
              :aria-label="`${entry.label} minimum`"
              :disabled="props.disabled"
              :value="rangeValue(props.query.equipment, entry.key, 'min')"
              @change="setEquipment(entry.key, 'min', ($event.target as HTMLInputElement).value)"
            />
            <input
              type="number"
              placeholder="max"
              :aria-label="`${entry.label} maximum`"
              :disabled="props.disabled"
              :value="rangeValue(props.query.equipment, entry.key, 'max')"
              @change="setEquipment(entry.key, 'max', ($event.target as HTMLInputElement).value)"
            />
          </span>
        </label>
      </div>
    </section>

    <section aria-labelledby="market-misc-title">
      <h4 id="market-misc-title">Misc</h4>
      <div class="filter-grid">
        <label v-for="entry in MISC_RANGES" :key="entry.key">
          <span>{{ entry.label }}</span>
          <span class="range-pair">
            <input
              type="number"
              placeholder="min"
              :aria-label="`${entry.label} minimum`"
              :disabled="props.disabled"
              :value="rangeValue(props.query.misc as never, entry.key, 'min')"
              @change="setMiscRange(entry.key, 'min', ($event.target as HTMLInputElement).value)"
            />
            <input
              type="number"
              placeholder="max"
              :aria-label="`${entry.label} maximum`"
              :disabled="props.disabled"
              :value="rangeValue(props.query.misc as never, entry.key, 'max')"
              @change="setMiscRange(entry.key, 'max', ($event.target as HTMLInputElement).value)"
            />
          </span>
        </label>
        <label v-for="entry in MISC_BOOLEANS" :key="entry.key">
          <span>{{ entry.label }}</span>
          <select
            :disabled="props.disabled || (entry.key === 'corrupted' && props.query.misc?.twice_corrupted === true)"
            :title="
              entry.key === 'corrupted' && props.query.misc?.twice_corrupted === true
                ? 'Twice corrupted already implies corrupted'
                : undefined
            "
            :value="booleanValue(entry.key)"
            @change="setMiscBoolean(entry.key, ($event.target as HTMLSelectElement).value)"
          >
            <option value="">Any</option>
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        </label>
      </div>
    </section>

    <section aria-labelledby="market-trade-title">
      <h4 id="market-trade-title">Trade</h4>
      <div class="filter-grid">
        <label>
          <span>Sale type</span>
          <select
            :disabled="props.disabled"
            :value="props.query.trade?.sale_type ?? 'any'"
            @change="setTrade({ sale_type: ($event.target as HTMLSelectElement).value as never })"
          >
            <option v-for="option in SALE_TYPES" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
        </label>
        <label>
          <span>Price currency</span>
          <input
            type="text"
            placeholder="e.g. exalted"
            :disabled="props.disabled"
            :value="props.query.trade?.price?.option ?? ''"
            @change="setPrice('option', ($event.target as HTMLInputElement).value)"
          />
        </label>
        <label>
          <span>Price</span>
          <span class="range-pair">
            <input
              type="number"
              placeholder="min"
              aria-label="Price minimum"
              :disabled="props.disabled"
              :value="props.query.trade?.price?.min ?? ''"
              @change="setPrice('min', ($event.target as HTMLInputElement).value)"
            />
            <input
              type="number"
              placeholder="max"
              aria-label="Price maximum"
              :disabled="props.disabled"
              :value="props.query.trade?.price?.max ?? ''"
              @change="setPrice('max', ($event.target as HTMLInputElement).value)"
            />
          </span>
        </label>
        <label>
          <span>Listed</span>
          <select
            :disabled="props.disabled"
            :value="props.query.trade?.indexed ?? ''"
            @change="setTrade({ indexed: ($event.target as HTMLSelectElement).value })"
          >
            <option v-for="option in INDEXED" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
        </label>
        <label>
          <span>Seller account</span>
          <input
            type="text"
            :disabled="props.disabled"
            :value="props.query.trade?.account ?? ''"
            @change="setTrade({ account: ($event.target as HTMLInputElement).value })"
          />
        </label>
        <label class="toggle-field">
          <input
            type="checkbox"
            :disabled="props.disabled"
            :checked="props.query.trade?.collapse === true"
            @change="setTrade({ collapse: ($event.target as HTMLInputElement).checked })"
          />
          <span>Collapse listings by account</span>
        </label>
      </div>
      <p class="muted">
        “Buyout only” maps to trade2’s <code>priced_with_price</code>; that mapping is unverified — the Sale type select
        is the reliable control.
      </p>
    </section>
  </details>
</template>

<style scoped>
.market-filters section {
  margin-top: 0.5rem;
}
.filter-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 0.5rem;
}
.filter-grid label {
  display: grid;
  gap: 0.3rem;
}
.range-pair {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.3rem;
}
</style>
