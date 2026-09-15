<script setup lang="ts">
/**
 * The chrome shared by the four list editors: one `<details>` per row (the
 * first is open, like the original overlay's lists), a Save/Revert pair that
 * stays disabled until something changed, a two-click delete, and the
 * sanitizer's `issues` under the list.
 */
import type { EditorRow } from "./editorRow";

defineProps<{
  rows: readonly EditorRow[];
  dirty: boolean;
  busy: boolean;
  issues: readonly string[];
  addLabel: string;
  emptyCopy: string;
  /** The row whose Delete was clicked once (two-click delete). */
  pendingDeleteId: string;
}>();

const emit = defineEmits<{
  add: [];
  save: [];
  revert: [];
  delete: [id: string];
}>();
</script>

<template>
  <div class="item-list-editor">
    <div class="button-row">
      <button type="button" class="button compact secondary" :disabled="busy" @click="emit('add')">
        {{ addLabel }}
      </button>
      <button type="button" class="button compact primary" :disabled="busy || !dirty" @click="emit('save')">
        {{ busy ? "Saving…" : "Save" }}
      </button>
      <button type="button" class="button compact ghost" :disabled="busy || !dirty" @click="emit('revert')">
        Revert
      </button>
      <span v-if="rows.length" class="count-badge">{{ rows.length }}</span>
    </div>

    <p v-if="!rows.length" class="empty-copy">{{ emptyCopy }}</p>

    <details
      v-for="(row, index) in rows"
      :key="row.id"
      class="editor-row"
      :open="index === 0"
      :data-row-id="row.id"
    >
      <summary>
        <strong>{{ row.title }}</strong>
        <span v-if="row.detail" class="muted row-detail">{{ row.detail }}</span>
        <span v-if="row.chip" class="status-chip" :class="row.chip.tone">{{ row.chip.label }}</span>
      </summary>
      <div class="editor-row-body">
        <slot name="row" :id="row.id" :index="index" />
        <div class="button-row row-footer">
          <button
            type="button"
            class="button compact danger"
            :disabled="busy"
            :aria-label="pendingDeleteId === row.id ? `Confirm delete ${row.title}` : `Delete ${row.title}`"
            @click="emit('delete', row.id)"
          >
            {{ pendingDeleteId === row.id ? "Confirm delete" : "Delete" }}
          </button>
          <slot name="row-actions" :id="row.id" :index="index" />
        </div>
      </div>
    </details>

    <ul v-if="issues.length" class="notice-list" aria-label="What was adjusted when saving">
      <li v-for="issue in issues" :key="issue">{{ issue }}</li>
    </ul>
  </div>
</template>

<style scoped>
.item-list-editor {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.editor-row {
  border: 1px solid var(--line, #2b3038);
  border-radius: 9px;
  padding: 0.5rem 0.7rem;
}
.editor-row summary {
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.row-detail {
  font-size: 0.75rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.editor-row summary .status-chip {
  margin-left: auto;
}
.editor-row-body {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
  padding-top: 0.6rem;
}
.row-footer {
  justify-content: flex-end;
}
.notice-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.75rem;
  color: var(--text-muted, #888b8e);
}
</style>
