<script setup lang="ts">
/**
 * Cheat-sheet notes: a title, an icon, a markdown body and one optional
 * image, shown in the `notes` overlay panel (Alt+N, or a per-note hotkey).
 * The preview on the right is the same renderer the panel uses.
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { NoteItem, NoteImageMeta, NotesView } from "../../../shared/commandsBookmarksNotes.js";
import { getBookmarksApi, getNotesApi } from "./api";
import HotkeyBindCell from "./HotkeyBindCell.vue";
import ItemListEditor from "./ItemListEditor.vue";
import type { EditorRow } from "./editorRow";
import NoteImageField from "./NoteImageField.vue";
import NoteMarkdown from "./NoteMarkdown.vue";

const api = getNotesApi();
const bookmarksApi = getBookmarksApi();
const view = ref<NotesView | null>(null);
const draft = ref<NoteItem[]>([]);
const images = ref<Record<string, string>>({});
const loading = ref(true);
const busy = ref(false);
const error = ref("");
const notice = ref("");
const pendingDeleteId = ref("");
const previewId = ref("");
let stopChanged: (() => void) | undefined;
let disposed = false;
let newRowCount = 0;

function strip(item: NotesView["notes"][number]): NoteItem {
  const note: NoteItem = {
    id: item.id,
    title: item.title,
    icon: item.icon,
    markdown: item.markdown,
    enabled: item.enabled,
  };
  if (item.image) note.image = item.image;
  return note;
}

const dirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(view.value?.notes.map(strip) ?? []));

function describe(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

function adopt(next: NotesView): void {
  view.value = next;
  draft.value = next.notes.map(strip);
  pendingDeleteId.value = "";
  if (!next.notes.some((note) => note.id === previewId.value)) previewId.value = next.notes[0]?.id ?? "";
}

/**
 * Take the fresh read-only parts (panel placement, hotkeys) without throwing
 * away a cheat sheet the user is still typing.
 */
function refresh(next: NotesView, wasDirty = dirty.value): void {
  if (wasDirty) {
    view.value = { ...next, notes: view.value?.notes ?? next.notes };
    return;
  }
  adopt(next);
}

async function loadImage(id: string): Promise<void> {
  if (!api || images.value[id]) return;
  try {
    const detail = await api.invoke("notes:get", id);
    if (disposed || !detail?.imageDataUri) return;
    images.value = { ...images.value, [id]: detail.imageDataUri };
  } catch {
    // A missing image file is not worth an error banner.
  }
}

async function load(): Promise<void> {
  if (!api) return;
  try {
    const next = await api.invoke("notes:list");
    if (disposed) return;
    adopt(next);
    error.value = "";
    for (const note of next.notes) if (note.image) void loadImage(note.id);
  } catch (reason) {
    if (disposed) return;
    error.value = describe(reason, "The notes could not be loaded.");
  }
}

async function retryLoad(): Promise<void> {
  loading.value = true;
  await load();
  loading.value = false;
}

function addRow(): void {
  newRowCount += 1;
  draft.value = [
    ...draft.value,
    {
      id: `new_${newRowCount}`,
      title: `Note ${draft.value.length + 1}`,
      icon: "📝",
      markdown: "# Title\n- first line",
      enabled: true,
    },
  ];
  previewId.value = draft.value[draft.value.length - 1].id;
}

function deleteRow(id: string): void {
  if (pendingDeleteId.value !== id) {
    pendingDeleteId.value = id;
    return;
  }
  draft.value = draft.value.filter((item) => item.id !== id);
  pendingDeleteId.value = "";
}

async function save(): Promise<void> {
  if (!api || busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const next = await api.invoke("notes:save", { notes: draft.value });
    if (disposed) return;
    adopt(next);
    notice.value = "Saved.";
  } catch (reason) {
    if (disposed) return;
    error.value = describe(reason, "The notes could not be saved.");
  } finally {
    busy.value = false;
  }
}

function revert(): void {
  if (view.value) draft.value = view.value.notes.map(strip);
  pendingDeleteId.value = "";
}

function withImage(item: NoteItem, image?: NoteImageMeta): NoteItem {
  const next: NoteItem = { ...item };
  if (image) next.image = image;
  else delete next.image;
  return next;
}

/**
 * The image is stored by main immediately (it is a file, not part of the
 * draft), so this never reloads over unsaved text: the new meta is merged
 * into the row being edited instead.
 */
async function setImage(id: string, dataUri: string | null): Promise<void> {
  if (!api || busy.value) return;
  if (!saved(id)) {
    error.value = "Save the note first — an image needs a saved note to belong to.";
    return;
  }
  busy.value = true;
  error.value = "";
  const wasDirty = dirty.value;
  try {
    const updated = await api.invoke("notes:set-image", id, dataUri);
    if (disposed) return;
    if (!updated) {
      error.value = "That note is not in the saved list any more — save the list and try again.";
      return;
    }
    const nextImages = { ...images.value };
    delete nextImages[id];
    images.value = nextImages;
    const next = await api.invoke("notes:list");
    if (disposed) return;
    if (wasDirty) {
      draft.value = draft.value.map((item) => (item.id === id ? withImage(item, updated.image) : item));
    }
    refresh(next, wasDirty);
    if (dataUri) await loadImage(id);
  } catch (reason) {
    if (disposed) return;
    error.value = describe(reason, "The image could not be stored.");
  } finally {
    busy.value = false;
  }
}

async function showInOverlay(id: string): Promise<void> {
  if (!api) return;
  try {
    await api.invoke("notes:show", id);
  } catch (reason) {
    error.value = describe(reason, "The overlay panel could not be opened.");
  }
}

/** The preview renders the same links the panel does; main validates them again. */
async function openLink(url: string): Promise<void> {
  if (!bookmarksApi) return;
  try {
    await bookmarksApi.invoke("bookmarks:open-url", url, "external");
  } catch (reason) {
    error.value = describe(reason, "That link could not be opened.");
  }
}

async function savePanel(patch: Partial<NotesView["panel"]>): Promise<void> {
  if (!api || busy.value || !view.value) return;
  busy.value = true;
  try {
    const next = await api.invoke("notes:save", { panel: { ...view.value.panel, ...patch } });
    if (disposed) return;
    refresh(next);
  } catch (reason) {
    if (disposed) return;
    error.value = describe(reason, "The panel settings could not be saved.");
  } finally {
    busy.value = false;
  }
}

const rows = computed<EditorRow[]>(() =>
  draft.value.map((item) => ({
    id: item.id,
    title: `${item.icon} ${item.title}`.trim(),
    detail: item.markdown.split("\n")[0] ?? "",
    ...(item.image ? { chip: { label: "Image", tone: "neutral" as const } } : {}),
  })),
);

const previewNote = computed(() => draft.value.find((item) => item.id === previewId.value) ?? draft.value[0]);

function saved(id: string): boolean {
  return !id.startsWith("new_");
}

function hotkeyOf(id: string) {
  return view.value?.notes.find((item) => item.id === id)?.hotkey;
}

function anchorValue(): string {
  const anchor = view.value?.panel.anchor;
  return typeof anchor === "string" ? anchor : "left";
}

onMounted(async () => {
  if (!api) {
    loading.value = false;
    return;
  }
  stopChanged = api.on("notes:changed", (next) => refresh(next));
  await load();
  loading.value = false;
});

onBeforeUnmount(() => {
  disposed = true;
  stopChanged?.();
});
</script>

<template>
  <div class="notes-tab">
    <div v-if="loading" class="state-panel compact-state" aria-live="polite">
      <span class="spinner" aria-hidden="true" />
      <p>Loading notes…</p>
    </div>
    <div v-else-if="!view" class="state-panel compact-state">
      <span class="state-icon" aria-hidden="true">!</span>
      <strong>Notes could not be loaded</strong>
      <p role="alert">{{ error || "The desktop app did not answer." }}</p>
      <button type="button" class="button secondary compact" :disabled="busy" @click="retryLoad">Retry</button>
    </div>
    <template v-else>
      <p v-if="error" class="inline-notice danger" role="alert">{{ error }}</p>
      <p v-else-if="notice" class="inline-notice" role="status">{{ notice }}</p>

      <div class="result-grid">
        <ItemListEditor
          :rows="rows"
          :dirty="dirty"
          :busy="busy"
          :issues="view.issues"
          add-label="Add note"
          empty-copy="No notes yet — add a cheat sheet and show it with Alt+N."
          :pending-delete-id="pendingDeleteId"
          @add="addRow"
          @save="save"
          @revert="revert"
          @delete="deleteRow"
        >
          <template #row="{ id, index }">
            <div class="form-grid">
              <label>
                <span>Title</span>
                <input v-model="draft[index].title" type="text" maxlength="80" @focus="previewId = id" />
              </label>
              <label>
                <span>Icon</span>
                <input v-model="draft[index].icon" type="text" maxlength="4" />
              </label>
            </div>
            <label>
              <span>Text (markdown subset)</span>
              <textarea
                v-model="draft[index].markdown"
                rows="10"
                @focus="previewId = id"
                @keydown.ctrl.enter.prevent="save"
              />
            </label>
            <p class="muted">
              <code>#</code> heading · <code>**bold**</code> · <code>- list</code> · <code>`code`</code> ·
              <code>[text](https://…)</code> — <kbd>Ctrl</kbd>+<kbd>Enter</kbd> saves. Tables, images by URL
              and raw HTML are not rendered.
            </p>
            <NoteImageField
              :image="draft[index].image"
              :data-uri="images[id]"
              :busy="busy"
              :saved="saved(id)"
              :note-title="draft[index].title"
              @image="setImage(id, $event)"
              @remove="setImage(id, null)"
              @error="error = $event"
            />
            <label class="toggle-field">
              <input v-model="draft[index].enabled" type="checkbox" />
              <span>Enabled (an off note contributes no hotkey)</span>
            </label>
            <HotkeyBindCell
              :action-id="`notes.${id}`"
              :label="draft[index].title"
              :hotkey="hotkeyOf(id)"
              :bindable="saved(id)"
            />
          </template>
          <template #row-actions="{ id }">
            <button
              type="button"
              class="button compact secondary"
              :disabled="busy || !saved(id)"
              @click="showInOverlay(id)"
            >
              Show in overlay
            </button>
          </template>
        </ItemListEditor>

        <aside class="note-preview card">
          <h3>Preview</h3>
          <p v-if="!previewNote" class="empty-copy">Nothing to preview yet.</p>
          <template v-else>
            <p class="note-preview-title">
              <span aria-hidden="true">{{ previewNote.icon }}</span> <strong>{{ previewNote.title }}</strong>
            </p>
            <NoteMarkdown :markdown="previewNote.markdown" @open-link="openLink" />
            <img v-if="images[previewNote.id]" :src="images[previewNote.id]" :alt="previewNote.title" />
          </template>
        </aside>
      </div>

      <details class="advanced-options">
        <summary>Overlay panel placement</summary>
        <div class="form-grid">
          <label>
            <span>Anchor</span>
            <select :value="anchorValue()" :disabled="busy" @change="savePanel({ anchor: ($event.target as HTMLSelectElement).value as NotesView['panel']['anchor'] })">
              <option value="left">Left</option>
              <option value="right">Right</option>
              <option value="center">Centre</option>
              <option value="cursor">At the cursor</option>
              <option value="top-left">Top left</option>
              <option value="top-right">Top right</option>
              <option value="bottom-left">Bottom left</option>
              <option value="bottom-right">Bottom right</option>
            </select>
          </label>
          <label>
            <span>Width</span>
            <input
              type="number"
              min="280"
              max="1200"
              :value="view.panel.width"
              :disabled="busy"
              @change="savePanel({ width: Number(($event.target as HTMLInputElement).value) })"
            />
          </label>
          <label>
            <span>Height</span>
            <input
              type="number"
              min="200"
              max="1000"
              :value="view.panel.height"
              :disabled="busy"
              @change="savePanel({ height: Number(($event.target as HTMLInputElement).value) })"
            />
          </label>
        </div>
      </details>
    </template>
  </div>
</template>

<style scoped>
.notes-tab {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
}
.note-preview {
  position: sticky;
  top: 108px;
  align-self: start;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.note-preview h3 {
  margin: 0;
}
.note-preview-title {
  margin: 0;
}
.note-preview img {
  max-width: 100%;
  border-radius: 6px;
}
</style>
