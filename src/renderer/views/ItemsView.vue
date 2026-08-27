<script setup lang="ts">
import { computed, ref, watch } from "vue";
import ItemDetail from "../components/ItemDetail.vue";
import { useIntelligenceStore } from "../composables/useIntelligenceStore";
import { formatAmount, formatDate } from "../utils/intelligence";

const store = useIntelligenceStore();
const sourceText = ref(store.currentEvaluation.value?.raw ?? "");
const catalogQuery = ref("");
const pendingDeleteId = ref("");

const filteredCatalog = computed(() => {
  const query = catalogQuery.value.trim().toLowerCase();
  if (!query) return store.catalog.value;
  return store.catalog.value.filter((entry) =>
    [
      entry.name,
      entry.baseType,
      entry.itemClass,
      entry.currentLocation,
      entry.recommendation ?? "",
      entry.item?.mods.map((mod) => mod.text).join(" ") ?? "",
    ]
      .join(" ")
      .toLowerCase()
      .includes(query),
  );
});

watch(
  store.currentEvaluation,
  (evaluation) => {
    if (evaluation?.raw) sourceText.value = evaluation.raw;
  },
  { flush: "post" },
);

async function evaluatePaste(): Promise<void> {
  await store.evaluateText(sourceText.value);
}

async function readClipboard(): Promise<void> {
  const applied = await store.evaluateClipboard();
  if (applied && store.currentEvaluation.value?.raw) {
    sourceText.value = store.currentEvaluation.value.raw;
  }
}

function selectCatalog(entry: (typeof store.catalog.value)[number]): void {
  store.selectCatalogItem(entry);
  if (entry.item?.rawText) sourceText.value = entry.item.rawText;
}

async function removeCatalogEntry(
  entry: (typeof store.catalog.value)[number],
): Promise<void> {
  if (pendingDeleteId.value !== entry.id) {
    pendingDeleteId.value = entry.id;
    return;
  }
  pendingDeleteId.value = "";
  await store.removeCatalogItem(entry);
}
</script>

<template>
  <div class="items-workspace">
    <aside class="catalog-panel card" aria-labelledby="catalog-title">
      <div class="section-heading">
        <div>
          <span class="eyebrow">Local-first</span>
          <h2 id="catalog-title">Catalog</h2>
        </div>
        <span class="count-badge">{{ store.catalog.value.length }}</span>
      </div>

      <label class="search-field">
        <span class="sr-only">Search catalog</span>
        <span aria-hidden="true">⌕</span>
        <input
          v-model="catalogQuery"
          type="search"
          placeholder="Name, class, modifier…"
          autocomplete="off"
        />
      </label>

      <p v-if="store.catalogError.value" class="inline-notice danger" role="alert">
        {{ store.catalogError.value }}
      </p>
      <div
        v-if="store.catalogState.value === 'loading'"
        class="state-panel compact-state"
        aria-live="polite"
      >
        <span class="spinner" aria-hidden="true" />
        <p>Loading the durable catalog…</p>
      </div>
      <div
        v-else-if="!store.catalog.value.length"
        class="state-panel compact-state"
      >
        <span class="state-icon" aria-hidden="true">◇</span>
        <strong>No evaluated items</strong>
        <p>Paste an item or read the clipboard to create the first local record.</p>
      </div>
      <div
        v-else-if="!filteredCatalog.length"
        class="state-panel compact-state"
      >
        <span class="state-icon" aria-hidden="true">⌕</span>
        <strong>No catalog matches</strong>
        <p>Try a base type, item class, recommendation, or modifier.</p>
      </div>

      <ul v-else class="catalog-list">
        <li v-for="entry in filteredCatalog" :key="entry.id">
          <button
            type="button"
            class="catalog-entry"
            :class="{
              selected:
                store.currentCatalogItem.value?.id === entry.id ||
                store.currentEvaluation.value?.item.fingerprint === entry.fingerprint,
            }"
            @click="selectCatalog(entry)"
          >
            <span class="catalog-rarity" :class="`rarity-${entry.item?.rarity?.toLowerCase() ?? 'normal'}`" />
            <span class="catalog-copy">
              <strong>{{ entry.name }}</strong>
              <small>{{ entry.baseType }} · {{ entry.itemClass }}</small>
              <span>
                <span v-if="entry.recommendation" class="tag">{{ entry.recommendation }}</span>
                <span v-if="entry.fairValue !== undefined">
                  ~{{ formatAmount(entry.fairValue) }} {{ entry.valuation?.currency ?? "exalted" }}
                </span>
              </span>
            </span>
          </button>
          <button
            type="button"
            class="icon-button catalog-delete"
            :aria-label="pendingDeleteId === entry.id ? `Confirm delete ${entry.name}` : `Delete ${entry.name}`"
            :title="pendingDeleteId === entry.id ? 'Click again to confirm' : 'Delete catalog item'"
            @click="removeCatalogEntry(entry)"
          >
            {{ pendingDeleteId === entry.id ? "✓" : "×" }}
          </button>
        </li>
      </ul>
    </aside>

    <div class="items-main">
      <section class="card capture-card" aria-labelledby="capture-title">
        <div class="section-heading">
          <div>
            <span class="eyebrow">Source</span>
            <h2 id="capture-title">Evaluate item text</h2>
          </div>
          <span class="shortcut-hint"><kbd>Ctrl</kbd> + <kbd>Enter</kbd></span>
        </div>
        <p class="muted">
          Hover an item in Path of Exile 2 and copy it, or paste exported item text below.
        </p>
        <label>
          <span class="sr-only">Path of Exile item text</span>
          <textarea
            v-model="sourceText"
            rows="9"
            spellcheck="false"
            placeholder="Item Class: Rings&#10;Rarity: Rare&#10;…"
            @keydown.ctrl.enter.prevent="evaluatePaste"
          />
        </label>
        <p v-if="store.itemError.value" class="inline-notice danger" role="alert">
          {{ store.itemError.value }}
        </p>
        <div class="button-row">
          <button
            type="button"
            class="button primary"
            :disabled="store.evaluating.value || !sourceText.trim()"
            @click="evaluatePaste"
          >
            {{ store.evaluating.value ? "Evaluating…" : "Evaluate text" }}
          </button>
          <button
            type="button"
            class="button secondary"
            :disabled="store.evaluating.value"
            @click="readClipboard"
          >
            Read clipboard
          </button>
          <span class="privacy-note">Local processing · no automatic game input</span>
        </div>
      </section>

      <ItemDetail
        v-if="store.currentItem.value"
        :item="store.currentItem.value"
        :valuation="store.currentEvaluation.value?.valuation"
        :desirability="store.currentEvaluation.value?.desirability"
      />
      <section v-else class="card state-panel item-empty">
        <span class="state-icon large" aria-hidden="true">◇</span>
        <span class="eyebrow">Awaiting source</span>
        <h2>Item intelligence starts here</h2>
        <p>
          Parsed identity, ordered properties and affixes, valuation confidence,
          comparable sample size, and desirability reasons will appear here.
        </p>
      </section>

      <p
        v-if="store.currentCatalogItem.value && !store.currentCatalogItem.value.item"
        class="inline-notice warning"
      >
        This legacy catalog record has summary data only. Last updated
        {{ formatDate(store.currentCatalogItem.value.updatedAt) }}.
      </p>
    </div>
  </div>
</template>
