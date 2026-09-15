<script setup lang="ts">
/**
 * Bookmarks: a label and an address, opened by hotkey either in the OS
 * browser (default) or in one always-on-top window beside the game. The
 * window is a normal browser window — it takes keyboard focus, which is why
 * exclusive-fullscreen players should stay on "External browser".
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { checkBookmarkUrl } from "@core/commandsBookmarksNotes";
import type {
  BookmarkItem,
  BookmarkOpenOutcome,
  BookmarksView,
} from "../../../shared/commandsBookmarksNotes.js";
import { getBookmarksApi } from "./api";
import HotkeyBindCell from "./HotkeyBindCell.vue";
import ItemListEditor from "./ItemListEditor.vue";
import type { EditorRow } from "./editorRow";

const api = getBookmarksApi();
const view = ref<BookmarksView | null>(null);
const draft = ref<BookmarkItem[]>([]);
const loading = ref(true);
const busy = ref(false);
const error = ref("");
const notice = ref("");
const pendingDeleteId = ref("");
const outcomes = ref<Record<string, BookmarkOpenOutcome>>({});
let stopChanged: (() => void) | undefined;
let disposed = false;
let newRowCount = 0;

function strip(item: BookmarksView["bookmarks"][number]): BookmarkItem {
  return { id: item.id, label: item.label, url: item.url, mode: item.mode, enabled: item.enabled };
}

const dirty = computed(
  () => JSON.stringify(draft.value) !== JSON.stringify(view.value?.bookmarks.map(strip) ?? []),
);

function describe(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

function adopt(next: BookmarksView): void {
  view.value = next;
  draft.value = next.bookmarks.map(strip);
  pendingDeleteId.value = "";
}

async function load(): Promise<void> {
  if (!api) return;
  try {
    const next = await api.invoke("bookmarks:list");
    if (disposed) return;
    adopt(next);
    error.value = "";
  } catch (reason) {
    if (disposed) return;
    error.value = describe(reason, "The bookmarks could not be loaded.");
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
      label: `Bookmark ${draft.value.length + 1}`,
      url: "https://poe2db.tw/us/",
      mode: "external",
      enabled: true,
    },
  ];
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
    const next = await api.invoke("bookmarks:save", { bookmarks: draft.value });
    if (disposed) return;
    adopt(next);
    notice.value = "Saved.";
  } catch (reason) {
    if (disposed) return;
    error.value = describe(reason, "The bookmarks could not be saved.");
  } finally {
    busy.value = false;
  }
}

function revert(): void {
  if (view.value) draft.value = view.value.bookmarks.map(strip);
  pendingDeleteId.value = "";
}

async function open(id: string): Promise<void> {
  if (!api || busy.value) return;
  busy.value = true;
  try {
    const outcome = await api.invoke("bookmarks:open", id);
    if (disposed) return;
    outcomes.value = { ...outcomes.value, [id]: outcome };
  } catch (reason) {
    if (disposed) return;
    error.value = describe(reason, "The bookmark could not be opened.");
  } finally {
    busy.value = false;
  }
}

async function closeWindow(): Promise<void> {
  if (!api || busy.value) return;
  busy.value = true;
  try {
    await api.invoke("bookmarks:close-window");
    await load();
  } catch (reason) {
    if (disposed) return;
    error.value = describe(reason, "The window could not be closed.");
  } finally {
    busy.value = false;
  }
}

async function saveWindow(patch: Partial<BookmarksView["window"]>): Promise<void> {
  if (!api || busy.value || !view.value) return;
  busy.value = true;
  try {
    const next = await api.invoke("bookmarks:save", { window: { ...view.value.window, ...patch } });
    if (disposed) return;
    adopt(next);
  } catch (reason) {
    if (disposed) return;
    error.value = describe(reason, "The window settings could not be saved.");
  } finally {
    busy.value = false;
  }
}

function urlCheck(item: BookmarkItem) {
  return checkBookmarkUrl(item.url);
}

function outcomeLine(id: string): string {
  const outcome = outcomes.value[id];
  if (!outcome) return "";
  return outcome.ok
    ? `Opened in the ${outcome.mode === "window" ? "overlay window" : "external browser"}.`
    : `Blocked: ${outcome.error ?? "the address could not be opened"}`;
}

const rows = computed<EditorRow[]>(() =>
  draft.value.map((item) => ({
    id: item.id,
    title: item.label,
    detail: item.url,
    chip: urlCheck(item).ok
      ? { label: item.mode === "window" ? "Window" : "Browser", tone: "neutral" as const }
      : { label: "Bad address", tone: "danger" as const },
  })),
);

function saved(id: string): boolean {
  return !id.startsWith("new_");
}

function hotkeyOf(id: string) {
  return view.value?.bookmarks.find((item) => item.id === id)?.hotkey;
}

onMounted(async () => {
  if (!api) {
    loading.value = false;
    return;
  }
  stopChanged = api.on("bookmarks:changed", (next) => {
    if (dirty.value) {
      view.value = { ...next, bookmarks: view.value?.bookmarks ?? next.bookmarks };
      return;
    }
    adopt(next);
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
  <div class="bookmarks-tab">
    <div v-if="loading" class="state-panel compact-state" aria-live="polite">
      <span class="spinner" aria-hidden="true" />
      <p>Loading bookmarks…</p>
    </div>
    <div v-else-if="!view" class="state-panel compact-state">
      <span class="state-icon" aria-hidden="true">!</span>
      <strong>Bookmarks could not be loaded</strong>
      <p role="alert">{{ error || "The desktop app did not answer." }}</p>
      <button type="button" class="button secondary compact" :disabled="busy" @click="retryLoad">Retry</button>
    </div>
    <template v-else>
      <div class="button-row">
        <span class="status-chip" :class="view.windowVisible ? 'safe' : 'neutral'">
          {{ view.windowVisible ? "Window open" : view.windowOpen ? "Window hidden" : "No window" }}
        </span>
        <button
          type="button"
          class="button compact ghost"
          :disabled="busy || !view.windowOpen"
          @click="closeWindow"
        >
          Close window
        </button>
      </div>
      <p v-if="error" class="inline-notice danger" role="alert">{{ error }}</p>
      <p v-else-if="notice" class="inline-notice" role="status">{{ notice }}</p>

      <ItemListEditor
        :rows="rows"
        :dirty="dirty"
        :busy="busy"
        :issues="view.issues"
        add-label="Add bookmark"
        empty-copy="No bookmarks yet — add a wiki or trade page and bind it to a key."
        :pending-delete-id="pendingDeleteId"
        @add="addRow"
        @save="save"
        @revert="revert"
        @delete="deleteRow"
      >
        <template #row="{ id, index }">
          <div class="form-grid">
            <label>
              <span>Name</span>
              <input v-model="draft[index].label" type="text" maxlength="60" />
            </label>
            <label>
              <span>Address</span>
              <input v-model="draft[index].url" type="text" maxlength="2048" />
            </label>
          </div>
          <p v-if="!urlCheck(draft[index]).ok" class="danger-text">{{ urlCheck(draft[index]).reason }}</p>
          <div class="preset-row" role="radiogroup" :aria-label="`How to open ${draft[index].label}`">
            <label class="inline-toggle">
              <input v-model="draft[index].mode" type="radio" value="external" :name="`mode-${id}`" />
              <span>External browser</span>
            </label>
            <label class="inline-toggle">
              <input v-model="draft[index].mode" type="radio" value="window" :name="`mode-${id}`" />
              <span>Overlay window (always on top)</span>
            </label>
          </div>
          <p class="muted">
            The overlay window takes keyboard focus from the game and stays behind an
            exclusive-fullscreen client — pick the external browser unless you play borderless.
          </p>
          <label class="toggle-field">
            <input v-model="draft[index].enabled" type="checkbox" />
            <span>Enabled (an off bookmark contributes no hotkey)</span>
          </label>
          <HotkeyBindCell
            :action-id="`bookmarks.${id}`"
            :label="draft[index].label"
            :hotkey="hotkeyOf(id)"
            :bindable="saved(id)"
          />
          <p v-if="outcomeLine(id)" class="outcome-line" role="status">{{ outcomeLine(id) }}</p>
        </template>
        <template #row-actions="{ id }">
          <button type="button" class="button compact secondary" :disabled="busy || !saved(id)" @click="open(id)">
            Open
          </button>
        </template>
      </ItemListEditor>

      <details class="advanced-options">
        <summary>Overlay window size</summary>
        <div class="form-grid">
          <label>
            <span>Width</span>
            <input
              type="number"
              min="480"
              max="3840"
              :value="view.window.width"
              :disabled="busy"
              @change="saveWindow({ width: Number(($event.target as HTMLInputElement).value) })"
            />
          </label>
          <label>
            <span>Height</span>
            <input
              type="number"
              min="320"
              max="2160"
              :value="view.window.height"
              :disabled="busy"
              @change="saveWindow({ height: Number(($event.target as HTMLInputElement).value) })"
            />
          </label>
        </div>
        <label class="toggle-field">
          <input
            type="checkbox"
            :checked="view.window.alwaysOnTop"
            :disabled="busy"
            @change="saveWindow({ alwaysOnTop: ($event.target as HTMLInputElement).checked })"
          />
          <span>Keep the window above the game</span>
        </label>
      </details>
    </template>
  </div>
</template>

<style scoped>
.bookmarks-tab {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
}
.outcome-line {
  font-size: 0.76rem;
  color: var(--text-soft, #b9b4aa);
}
.danger-text {
  font-size: 0.76rem;
  color: #e5a49f;
}
</style>
