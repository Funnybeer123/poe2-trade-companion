<script setup lang="ts">
/**
 * Renders a note's markdown subset. The HTML comes from
 * `renderNoteMarkdown`, which escapes everything before adding its own tags,
 * so `v-html` here can only ever receive our own markup. Links carry their
 * address in `data-href` and are opened by main (which validates again).
 */
import { computed } from "vue";
import { renderNoteMarkdown } from "@core/commandsBookmarksNotesMarkdown";

const props = defineProps<{ markdown: string }>();

const emit = defineEmits<{ "open-link": [url: string] }>();

const rendered = computed(() => renderNoteMarkdown(props.markdown ?? ""));

function onClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  const anchor = target?.closest?.("a[data-href]") as HTMLElement | null;
  if (!anchor) return;
  event.preventDefault();
  const url = anchor.getAttribute("data-href");
  if (url) emit("open-link", url);
}
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- escape-first renderer output only -->
  <div class="note-markdown" @click="onClick" v-html="rendered.html" />
</template>

<style scoped>
.note-markdown {
  font-size: 0.82rem;
  line-height: 1.5;
}
.note-markdown :deep(h1),
.note-markdown :deep(h2),
.note-markdown :deep(h3) {
  margin: 0.4rem 0 0.2rem;
  font-size: 0.95rem;
}
.note-markdown :deep(p),
.note-markdown :deep(ul),
.note-markdown :deep(ol) {
  margin: 0.3rem 0;
}
.note-markdown :deep(ul),
.note-markdown :deep(ol) {
  padding-left: 1.1rem;
}
.note-markdown :deep(pre) {
  overflow-x: auto;
  padding: 0.4rem 0.5rem;
}
.note-markdown :deep(blockquote) {
  margin: 0.3rem 0;
  padding-left: 0.6rem;
  border-left: 3px solid var(--line-strong, #3b424d);
  color: var(--text-soft, #b9b4aa);
}
.note-markdown :deep(a) {
  color: var(--gold-bright, #e4c587);
}
</style>
