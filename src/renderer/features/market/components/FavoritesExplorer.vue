<script setup lang="ts">
/**
 * Favourite searches in folders. Drag-and-drop reorders and moves between
 * folders; the ⋯ menu does the same by keyboard (Move up / Move down /
 * Move to folder), because a drag is not a usable control for everyone.
 *
 * Opening a favourite opens a TEMPORARY tab — editing it makes it stick.
 * Deleting is two-click, never a confirm() dialog.
 */
import { computed, ref } from "vue";
import { favoritesTree } from "@core/marketFavorites";
import type { MarketFavoritesFile } from "../../../../shared/market.js";

const props = defineProps<{ favorites: MarketFavoritesFile; busy?: boolean }>();
const emit = defineEmits<{
  (event: "open", id: string): void;
  (event: "remove", id: string): void;
  (event: "move", input: { id: string; folderId: string | null; index: number }): void;
  (event: "rename", id: string, name: string): void;
  (event: "new-folder", name: string): void;
  (event: "remove-folder", id: string): void;
  (event: "import"): void;
}>();

const groups = computed(() => favoritesTree(props.favorites));
const pendingDeleteId = ref("");
const renamingId = ref("");
const draftName = ref("");
const newFolderName = ref("");
const dragId = ref("");

function startRename(id: string, name: string): void {
  renamingId.value = id;
  draftName.value = name;
}

function commitRename(): void {
  const id = renamingId.value;
  const name = draftName.value.trim();
  renamingId.value = "";
  if (id && name) emit("rename", id, name);
}

function confirmDelete(id: string): void {
  if (pendingDeleteId.value !== id) {
    pendingDeleteId.value = id;
    return;
  }
  pendingDeleteId.value = "";
  emit("remove", id);
}

function move(id: string, folderId: string | null, index: number): void {
  emit("move", { id, folderId, index });
}

function onDragStart(id: string): void {
  dragId.value = id;
}

function onDrop(folderId: string | null, index: number): void {
  if (!dragId.value) return;
  move(dragId.value, folderId, index);
  dragId.value = "";
}

function addFolder(): void {
  const name = newFolderName.value.trim();
  if (!name) return;
  newFolderName.value = "";
  emit("new-folder", name);
}
</script>

<template>
  <aside class="card favorites-panel" aria-labelledby="market-favorites-title">
    <div class="section-heading">
      <div>
        <span class="eyebrow">Saved</span>
        <h3 id="market-favorites-title">Favourites</h3>
      </div>
      <span class="count-badge">{{ props.favorites.favorites.length }}</span>
    </div>

    <div class="button-row">
      <input
        v-model="newFolderName"
        type="text"
        placeholder="New folder…"
        aria-label="New folder name"
        :disabled="props.busy"
        @keydown.enter.prevent="addFolder"
      />
      <button type="button" class="button compact secondary" :disabled="props.busy || !newFolderName.trim()" @click="addFolder">
        Add
      </button>
      <button type="button" class="button compact ghost" :disabled="props.busy" @click="emit('import')">Import…</button>
    </div>

    <p v-if="!props.favorites.favorites.length" class="empty-copy">
      No favourites yet — build a search and press <strong>Save as favourite</strong>.
    </p>

    <div v-for="group in groups" :key="group.folder?.id ?? 'root'" class="favorite-group">
      <header v-if="group.folder" class="folder-head">
        <span class="folder-dot" :class="`colour-${group.folder.colour}`" aria-hidden="true" />
        <strong>{{ group.folder.name }}</strong>
        <span class="count-badge">{{ group.favorites.length }}</span>
        <button
          type="button"
          class="icon-button"
          :aria-label="`Delete folder ${group.folder.name}`"
          :disabled="props.busy"
          @click="emit('remove-folder', group.folder.id)"
        >
          ✕
        </button>
      </header>
      <p v-else-if="group.favorites.length" class="muted">Not in a folder</p>

      <ul
        class="favorite-list"
        @dragover.prevent
        @drop.prevent="onDrop(group.folder?.id ?? null, group.favorites.length)"
      >
        <li
          v-for="(favorite, index) in group.favorites"
          :key="favorite.id"
          draggable="true"
          :data-favorite-id="favorite.id"
          @dragstart="onDragStart(favorite.id)"
          @dragover.prevent
          @drop.prevent.stop="onDrop(group.folder?.id ?? null, index)"
        >
          <span class="favorite-dot" :class="`colour-${favorite.colour}`" aria-hidden="true" />
          <template v-if="renamingId === favorite.id">
            <input
              v-model="draftName"
              class="favorite-rename"
              :aria-label="`Rename ${favorite.name}`"
              @keydown.enter.prevent="commitRename"
              @keydown.esc.prevent="renamingId = ''"
              @blur="commitRename"
            />
          </template>
          <template v-else>
            <button
              type="button"
              class="text-link favorite-name"
              :title="`Open ${favorite.name} in a temporary tab`"
              :disabled="props.busy"
              @click="emit('open', favorite.id)"
            >
              {{ favorite.name }}
            </button>
            <span class="tag neutral">{{ favorite.draft.kind }}</span>
          </template>
          <span class="favorite-actions">
            <button
              type="button"
              class="icon-button"
              :aria-label="`Move ${favorite.name} up`"
              :disabled="props.busy || index === 0"
              @click="move(favorite.id, group.folder?.id ?? null, index - 1)"
            >
              ↑
            </button>
            <button
              type="button"
              class="icon-button"
              :aria-label="`Move ${favorite.name} down`"
              :disabled="props.busy || index === group.favorites.length - 1"
              @click="move(favorite.id, group.folder?.id ?? null, index + 1)"
            >
              ↓
            </button>
            <select
              class="folder-move"
              :aria-label="`Move ${favorite.name} to a folder`"
              :value="favorite.folderId ?? ''"
              :disabled="props.busy"
              @change="move(favorite.id, ($event.target as HTMLSelectElement).value || null, 0)"
            >
              <option value="">Root</option>
              <option v-for="folder in props.favorites.folders" :key="folder.id" :value="folder.id">
                {{ folder.name }}
              </option>
            </select>
            <button
              type="button"
              class="icon-button"
              :aria-label="`Rename ${favorite.name}`"
              :disabled="props.busy"
              @click="startRename(favorite.id, favorite.name)"
            >
              ✎
            </button>
            <button
              type="button"
              class="button compact danger"
              :aria-label="pendingDeleteId === favorite.id ? `Confirm delete ${favorite.name}` : `Delete ${favorite.name}`"
              :disabled="props.busy"
              @click="confirmDelete(favorite.id)"
              @blur="pendingDeleteId = ''"
            >
              {{ pendingDeleteId === favorite.id ? "Sure?" : "✕" }}
            </button>
          </span>
        </li>
      </ul>
    </div>
  </aside>
</template>

<style scoped>
.favorites-panel {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.favorite-group {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.folder-head {
  display: flex;
  align-items: center;
  gap: 0.35rem;
}
.favorite-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  min-height: 0.6rem;
}
.favorite-list li {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 0.3rem;
  align-items: center;
  padding: 0.25rem 0;
  border-bottom: 1px solid rgba(140, 140, 160, 0.15);
}
.favorite-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}
.favorite-actions {
  display: inline-flex;
  gap: 0.15rem;
  align-items: center;
  grid-column: 1 / -1;
}
.folder-move {
  width: auto;
  min-height: 26px;
  font-size: 0.72rem;
}
.folder-dot,
.favorite-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
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
</style>
