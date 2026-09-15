<script setup lang="ts">
/**
 * Overlay panel "notes": the cheat sheet, shown without taking keyboard
 * focus from the game. Escape and the × are the host's job; this panel never
 * captures a key. Links are opened by main, which validates the address
 * again before handing it to the OS browser.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { NotesPanelPayload, NotesView } from "../../../../shared/commandsBookmarksNotes.js";
import { getBookmarksApi, getNotesApi } from "../api";
import NoteMarkdown from "../NoteMarkdown.vue";

const props = defineProps<{
  panelId: string;
  payload: unknown;
  visible: boolean;
}>();

defineEmits<{ close: [] }>();

const notesApi = getNotesApi();
const bookmarksApi = getBookmarksApi();
const view = ref<NotesView | null>(null);
const selectedId = ref("");
const images = ref<Record<string, string>>({});
const loading = ref(true);
const error = ref("");
let stopChanged: (() => void) | undefined;
let disposed = false;

const payload = computed<NotesPanelPayload>(() => {
  const source = typeof props.payload === "object" && props.payload !== null ? props.payload : {};
  const noteId = (source as NotesPanelPayload).noteId;
  return typeof noteId === "string" ? { noteId } : {};
});

const selected = computed(() => view.value?.notes.find((note) => note.id === selectedId.value));

/**
 * The panel's height setting is a HINT the host does not enforce, so the body
 * caps itself: the configured height minus the host's title bar. Without this
 * a long cheat sheet grows past the bottom of an anchored panel.
 */
const bodyStyle = computed(() => ({
  maxHeight: `${Math.max(120, (view.value?.panel.height ?? 380) - 44)}px`,
}));

async function loadImage(id: string): Promise<void> {
  if (!notesApi || images.value[id] !== undefined) return;
  try {
    const detail = await notesApi.invoke("notes:get", id);
    if (disposed) return;
    images.value = { ...images.value, [id]: detail?.imageDataUri ?? "" };
  } catch {
    // A missing image must not blank the note.
  }
}

function select(id: string): void {
  selectedId.value = id;
  const note = view.value?.notes.find((entry) => entry.id === id);
  if (note?.image) void loadImage(id);
}

async function load(): Promise<void> {
  if (!notesApi) return;
  try {
    const next = await notesApi.invoke("notes:list");
    if (disposed) return;
    view.value = next;
    error.value = "";
    const wanted = payload.value.noteId ?? next.lastNoteId ?? next.notes[0]?.id ?? "";
    if (wanted) select(wanted);
  } catch (reason) {
    if (disposed) return;
    error.value = reason instanceof Error ? reason.message : "The notes could not be loaded.";
  }
}

async function openLink(url: string): Promise<void> {
  if (!bookmarksApi) return;
  try {
    await bookmarksApi.invoke("bookmarks:open-url", url, "external");
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "That link could not be opened.";
  }
}

watch(
  () => payload.value.noteId,
  (noteId) => {
    if (noteId && view.value?.notes.some((note) => note.id === noteId)) select(noteId);
  },
);

onMounted(async () => {
  if (!notesApi) {
    loading.value = false;
    return;
  }
  stopChanged = notesApi.on("notes:changed", (next) => {
    view.value = next;
    if (!next.notes.some((note) => note.id === selectedId.value)) {
      selectedId.value = next.lastNoteId ?? next.notes[0]?.id ?? "";
    }
  });
  await load();
  loading.value = false;
});

onBeforeUnmount(() => {
  disposed = true;
  stopChanged?.();
});
</script>

<template>
  <div class="notes-panel">
    <p v-if="loading" class="muted">Loading notes…</p>
    <p v-else-if="error" class="danger-text" role="alert">{{ error }}</p>
    <p v-else-if="!view || !view.notes.length" class="empty-copy">
      No notes yet — add one in Tools → Commands &amp; notes.
    </p>
    <template v-else>
      <aside v-if="view.notes.length > 1" class="notes-rail" :style="bodyStyle">
        <button
          v-for="note in view.notes"
          :key="note.id"
          type="button"
          class="notes-rail-item"
          :aria-current="note.id === selectedId ? 'true' : undefined"
          :class="{ selected: note.id === selectedId }"
          @click="select(note.id)"
        >
          <span aria-hidden="true">{{ note.icon }}</span>
          <span class="notes-rail-title">{{ note.title }}</span>
        </button>
      </aside>
      <article v-if="selected" class="notes-body" :style="bodyStyle">
        <header>
          <span class="note-icon" aria-hidden="true">{{ selected.icon }}</span>
          <h3 class="note-title">{{ selected.title }}</h3>
        </header>
        <NoteMarkdown :markdown="selected.markdown" @open-link="openLink" />
        <img v-if="images[selected.id]" class="note-image" :src="images[selected.id]" :alt="selected.title" />
      </article>
    </template>
  </div>
</template>

<style scoped>
.notes-panel {
  display: flex;
  gap: 0.6rem;
  max-height: 100%;
}
.notes-rail {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  min-width: 6.5rem;
  max-width: 9rem;
  overflow-y: auto;
}
.notes-rail-item {
  display: flex;
  gap: 0.3rem;
  align-items: center;
  background: none;
  border: none;
  color: inherit;
  text-align: left;
  font-size: 0.76rem;
  padding: 0.2rem 0.3rem;
  border-radius: 6px;
  cursor: pointer;
}
.notes-rail-item.selected {
  background: var(--gold-soft, rgba(200, 166, 106, 0.14));
}
.notes-rail-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.notes-body {
  flex: 1;
  overflow: auto;
}
.notes-body header {
  display: flex;
  align-items: center;
  gap: 0.35rem;
}
.note-title {
  margin: 0;
  font-size: 0.9rem;
}
.note-image {
  max-width: 100%;
  margin-top: 0.4rem;
  border-radius: 6px;
}
.danger-text {
  color: #e5a49f;
  font-size: 0.78rem;
}
</style>
