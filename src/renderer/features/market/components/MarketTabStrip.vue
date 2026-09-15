<script setup lang="ts">
/**
 * The tab strip: up to ten alive tabs, a dashed chip for a temporary tab
 * (opened from a favourite and not yet edited), a dot for an edited one,
 * and the two "new tab" buttons. Renaming happens in place — Enter saves,
 * Escape cancels — and never happens by itself when a sort changes.
 */
import { nextTick, ref } from "vue";
import { MAX_MARKET_TABS } from "@core/marketTabs";
import type { MarketTabSummary } from "../../../../shared/market.js";

const props = defineProps<{ tabs: MarketTabSummary[]; activeTabId?: string; busy?: boolean }>();
const emit = defineEmits<{
  (event: "select", id: string): void;
  (event: "close", id: string): void;
  (event: "rename", id: string, label: string): void;
  (event: "new-search"): void;
  (event: "new-exchange"): void;
}>();

const renamingId = ref("");
const draftLabel = ref("");
const renameInput = ref<HTMLInputElement | null>(null);

async function startRename(tab: MarketTabSummary): Promise<void> {
  renamingId.value = tab.id;
  draftLabel.value = tab.label;
  await nextTick();
  renameInput.value?.focus();
  renameInput.value?.select();
}

function commitRename(): void {
  const id = renamingId.value;
  const label = draftLabel.value.trim();
  renamingId.value = "";
  if (id && label) emit("rename", id, label);
}

function cancelRename(): void {
  renamingId.value = "";
}

function stateGlyph(tab: MarketTabSummary): string {
  if (tab.state === "searching") return "…";
  if (tab.state === "fetching") return "…";
  if (tab.state === "error") return "!";
  return "";
}
</script>

<template>
  <div class="market-tabs" role="tablist" aria-label="Market tabs">
    <div
      v-for="tab in props.tabs"
      :key="tab.id"
      class="market-tab"
      :class="{
        active: tab.id === props.activeTabId,
        temporary: tab.temporary,
        dirty: tab.dirty,
        error: tab.state === 'error',
      }"
      :data-tab-id="tab.id"
    >
      <span class="tab-colour" :class="`colour-${tab.colour}`" aria-hidden="true" />
      <template v-if="renamingId === tab.id">
        <input
          ref="renameInput"
          v-model="draftLabel"
          class="tab-rename"
          :aria-label="`Rename ${tab.label}`"
          maxlength="60"
          @keydown.enter.prevent="commitRename"
          @keydown.esc.prevent="cancelRename"
          @blur="commitRename"
        />
      </template>
      <template v-else>
        <button
          type="button"
          class="tab-button"
          role="tab"
          :aria-selected="tab.id === props.activeTabId"
          :title="tab.temporary ? 'Temporary tab — edit it to keep it' : tab.label"
          @click="emit('select', tab.id)"
          @dblclick="startRename(tab)"
        >
          <span class="tab-label">{{ tab.label }}</span>
          <span v-if="tab.dirty" class="tab-dirty" aria-label="edited">•</span>
          <span v-if="stateGlyph(tab)" class="tab-state" aria-hidden="true">{{ stateGlyph(tab) }}</span>
          <span v-if="tab.resultCount !== undefined" class="tab-count">{{ tab.resultCount }}</span>
        </button>
      </template>
      <button
        type="button"
        class="icon-button tab-close"
        :aria-label="`Close ${tab.label}`"
        :disabled="props.busy"
        @click="emit('close', tab.id)"
      >
        ✕
      </button>
    </div>

    <div class="tab-actions">
      <button type="button" class="button compact secondary" :disabled="props.busy" @click="emit('new-search')">
        + Search
      </button>
      <button type="button" class="button compact ghost" :disabled="props.busy" @click="emit('new-exchange')">
        + Exchange
      </button>
      <span class="muted tab-cap" role="status">{{ props.tabs.length }} / {{ MAX_MARKET_TABS }}</span>
    </div>
  </div>
</template>

<style scoped>
.market-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  align-items: center;
}
.market-tab {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel-soft);
  padding-right: 0.2rem;
}
.market-tab.active {
  border-color: var(--gold);
  background: var(--panel-raised);
}
.market-tab.temporary {
  border-style: dashed;
}
.market-tab.error {
  border-color: var(--red);
}
.tab-colour {
  width: 4px;
  align-self: stretch;
  border-radius: 8px 0 0 8px;
  background: var(--line-strong);
}
.colour-gold {
  background: var(--gold);
}
.colour-blue {
  background: var(--blue);
}
.colour-green {
  background: var(--green);
}
.colour-amber {
  background: var(--amber);
}
.colour-red {
  background: var(--red);
}
.colour-purple {
  background: var(--purple);
}
.colour-teal {
  background: #6fbfb0;
}
.colour-grey {
  background: var(--line-strong);
}
.tab-button {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  background: none;
  border: 0;
  color: var(--text);
  padding: 0.3rem 0.4rem;
  min-height: 31px;
  cursor: pointer;
}
.tab-label {
  max-width: 16ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tab-dirty {
  color: var(--gold-bright);
}
.tab-state {
  color: var(--amber);
}
.tab-count {
  font-size: 0.72rem;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
.tab-close {
  min-width: 22px;
  width: 22px;
  height: 22px;
  padding: 0;
  font-size: 0.72rem;
}
.tab-rename {
  min-height: 28px;
  width: 14ch;
  margin: 0.15rem;
}
.tab-actions {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  margin-left: auto;
}
.tab-cap {
  font-variant-numeric: tabular-nums;
}
</style>
