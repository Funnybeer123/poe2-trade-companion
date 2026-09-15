<script setup lang="ts">
/**
 * Import from the trade site: paste one or more trade2 URLs, or a raw
 * search document. Parsing is local and spends nothing; the checkboxes
 * decide which rows become tabs.
 *
 * An id-form URL (the one the site's share button emits) opens as an
 * "id only" tab: usable for live search, not editable, until the
 * search-by-id endpoint is proven against the live site.
 */
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { MarketImportResult } from "../../../../shared/market.js";

const props = defineProps<{ result: MarketImportResult | null; busy?: boolean }>();
const emit = defineEmits<{
  (event: "parse", text: string): void;
  (event: "open", indexes: number[]): void;
  (event: "close"): void;
}>();

const text = ref("");
const chosen = ref<Set<number>>(new Set());
const paste = ref<HTMLTextAreaElement | null>(null);

watch(
  () => props.result,
  (next) => {
    chosen.value = new Set((next?.drafts ?? []).map((_row, index) => index));
  },
);

/**
 * The dialog opens from a button in the favourites column, so focus starts
 * outside it: the wrapper's own `@keydown` fires only once the user has
 * tabbed in. Listening at the document makes Escape work from the moment
 * it opens, as the panel says it does.
 */
function onKey(event: KeyboardEvent): void {
  if (event.key === "Escape") emit("close");
}

onMounted(() => {
  paste.value?.focus();
  document.addEventListener("keydown", onKey);
});

onBeforeUnmount(() => {
  document.removeEventListener("keydown", onKey);
});

function toggle(index: number, on: boolean): void {
  const next = new Set(chosen.value);
  if (on) next.add(index);
  else next.delete(index);
  chosen.value = next;
}
</script>

<template>
  <section class="card import-panel" aria-labelledby="market-import-title" @keydown.esc="emit('close')">
    <div class="section-heading">
      <div>
        <span class="eyebrow">Import</span>
        <h3 id="market-import-title">From the trade site</h3>
        <p class="muted">Parsing happens on this PC. Nothing is sent until you press Search on a tab.</p>
      </div>
      <button type="button" class="button compact ghost" @click="emit('close')">Close</button>
    </div>

    <label class="field-stack">
      <span>Paste trade2 links or a search document</span>
      <textarea
        ref="paste"
        v-model="text"
        rows="4"
        placeholder="https://www.pathofexile.com/trade2/search/poe2/…"
        :disabled="props.busy"
        @keydown.ctrl.enter.prevent="emit('parse', text)"
      />
      <span class="shortcut-hint"><kbd>Ctrl</kbd>+<kbd>Enter</kbd> parses</span>
    </label>

    <div class="button-row">
      <button type="button" class="button compact primary" :disabled="props.busy || !text.trim()" @click="emit('parse', text)">
        Parse
      </button>
      <button
        type="button"
        class="button compact secondary"
        :disabled="props.busy || !chosen.size"
        @click="emit('open', [...chosen])"
      >
        Open {{ chosen.size }} tab(s)
      </button>
    </div>

    <template v-if="props.result">
      <p v-for="(issue, index) in props.result.errors" :key="`err-${index}`" class="inline-notice danger" role="alert">
        {{ issue }}
      </p>
      <p v-for="(issue, index) in props.result.warnings" :key="`warn-${index}`" class="inline-notice warning" role="note">
        {{ issue }}
      </p>

      <ul class="import-result">
        <li v-for="(draft, index) in props.result.drafts" :key="`draft-${index}`">
          <label class="inline-toggle">
            <input
              type="checkbox"
              :checked="chosen.has(index)"
              @change="toggle(index, ($event.target as HTMLInputElement).checked)"
            />
            <span>{{ draft.label }}</span>
          </label>
          <span class="muted">{{ draft.league ?? "no league in the link" }}</span>
        </li>
        <li v-for="(row, offset) in props.result.idOnly" :key="`id-${offset}`">
          <label class="inline-toggle">
            <input
              type="checkbox"
              :checked="chosen.has(props.result.drafts.length + offset)"
              @change="toggle(props.result.drafts.length + offset, ($event.target as HTMLInputElement).checked)"
            />
            <span>{{ row.searchId }} <span class="tag neutral">id only</span></span>
          </label>
          <span class="muted">{{ row.league }} · usable for live search, not editable</span>
        </li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
.import-panel {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.import-result {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.import-result li {
  display: flex;
  gap: 0.6rem;
  align-items: center;
  justify-content: space-between;
}
</style>
