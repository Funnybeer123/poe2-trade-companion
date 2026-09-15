<script setup lang="ts">
/**
 * Saved stash/vendor search strings. Each is typed into the game's search box
 * exactly as written (regex included) on one key press — never repeated,
 * never cleared, never followed by a click.
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { checkStashSearchText, STARTER_ISSUE } from "@core/commandsBookmarksNotes";
import type { CommandsView, RunOutcome, StashSearchItem } from "../../../shared/commandsBookmarksNotes.js";
import { getAppApi, getCommandsApi } from "./api";
import HotkeyBindCell from "./HotkeyBindCell.vue";
import ItemListEditor from "./ItemListEditor.vue";
import type { EditorRow } from "./editorRow";

const api = getCommandsApi();
const appApi = getAppApi();
const view = ref<CommandsView | null>(null);
const draft = ref<StashSearchItem[]>([]);
const loading = ref(true);
const busy = ref(false);
const error = ref("");
const notice = ref("");
const pendingDeleteId = ref("");
const outcomes = ref<Record<string, RunOutcome>>({});
let stopChanged: (() => void) | undefined;
let stopDryRun: (() => void) | undefined;
let disposed = false;
let newRowCount = 0;

function strip(item: CommandsView["searches"][number]): StashSearchItem {
  return { id: item.id, label: item.label, text: item.text, enabled: item.enabled };
}

const dirty = computed(
  () => JSON.stringify(draft.value) !== JSON.stringify(view.value?.searches.map(strip) ?? []),
);

function describe(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

function adopt(next: CommandsView): void {
  view.value = next;
  draft.value = next.searches.map(strip);
  pendingDeleteId.value = "";
}

async function load(): Promise<void> {
  if (!api) return;
  try {
    const next = await api.invoke("commands:list");
    if (disposed) return;
    adopt(next);
    error.value = "";
  } catch (reason) {
    if (disposed) return;
    error.value = describe(reason, "The stash searches could not be loaded.");
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
    { id: `new_${newRowCount}`, label: `Search ${draft.value.length + 1}`, text: '"^Waystone"', enabled: true },
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
    const next = await api.invoke("commands:save", { searches: draft.value });
    if (disposed) return;
    adopt(next);
    notice.value = "Saved.";
  } catch (reason) {
    if (disposed) return;
    error.value = describe(reason, "The stash searches could not be saved.");
  } finally {
    busy.value = false;
  }
}

function revert(): void {
  if (view.value) draft.value = view.value.searches.map(strip);
  pendingDeleteId.value = "";
}

async function run(id: string): Promise<void> {
  if (!api || busy.value) return;
  busy.value = true;
  try {
    const outcome = await api.invoke("commands:run-search", id, { focus: true });
    if (disposed) return;
    outcomes.value = { ...outcomes.value, [id]: outcome };
  } catch (reason) {
    if (disposed) return;
    error.value = describe(reason, "The search could not be typed.");
  } finally {
    busy.value = false;
  }
}

async function openPanel(): Promise<void> {
  if (!api) return;
  try {
    await api.invoke("commands:show-search-panel");
  } catch (reason) {
    error.value = describe(reason, "The search panel could not be opened.");
  }
}

function checkOf(item: StashSearchItem) {
  return checkStashSearchText(item.text);
}

function outcomeLine(id: string): string {
  const outcome = outcomes.value[id];
  if (!outcome) return "";
  if (outcome.dryRun) return `Dry-run · would type: ${outcome.resolved}`;
  if (outcome.ok) return `Typed: ${outcome.sent ?? outcome.resolved}`;
  return `Blocked: ${outcome.blockedBy ?? "unknown"}${outcome.error ? ` — ${outcome.error}` : ""}`;
}

const rows = computed<EditorRow[]>(() =>
  draft.value.map((item) => ({
    id: item.id,
    title: item.label,
    detail: item.text,
    chip: checkOf(item).ok
      ? { label: "Ready", tone: "safe" as const }
      : { label: "Cannot be typed", tone: "danger" as const },
  })),
);

function saved(id: string): boolean {
  return !id.startsWith("new_");
}

/** The starter examples are not persisted yet, so main has no action for them. */
const showingStarters = computed(() => view.value?.issues.includes(STARTER_ISSUE) ?? false);

function bindable(id: string): boolean {
  return saved(id) && !showingStarters.value;
}

function hotkeyOf(id: string) {
  return view.value?.searches.find((item) => item.id === id)?.hotkey;
}

onMounted(async () => {
  if (!api) {
    loading.value = false;
    return;
  }
  stopChanged = api.on("commands:changed", (next) => {
    if (dirty.value) {
      view.value = { ...next, searches: view.value?.searches ?? next.searches };
      return;
    }
    adopt(next);
  });
  // Follow the top-bar Dry-run switch, which lives outside this tool.
  stopDryRun = appApi?.on("app:dry-run-changed", (dryRun) => {
    if (view.value) view.value = { ...view.value, dryRun };
  });
  await load();
  loading.value = false;
});

onBeforeUnmount(() => {
  disposed = true;
  stopChanged?.();
  stopDryRun?.();
});
</script>

<template>
  <div class="searches-tab">
    <div v-if="loading" class="state-panel compact-state" aria-live="polite">
      <span class="spinner" aria-hidden="true" />
      <p>Loading stash searches…</p>
    </div>
    <div v-else-if="!view" class="state-panel compact-state">
      <span class="state-icon" aria-hidden="true">!</span>
      <strong>Stash searches could not be loaded</strong>
      <p role="alert">{{ error || "The desktop app did not answer." }}</p>
      <button type="button" class="button secondary compact" :disabled="busy" @click="retryLoad">Retry</button>
    </div>
    <template v-else>
      <div class="button-row">
        <button type="button" class="button compact ghost" @click="openPanel">Open search panel</button>
        <span class="muted">Alt+F opens the same panel while you play.</span>
      </div>
      <p v-if="error" class="inline-notice danger" role="alert">{{ error }}</p>
      <p v-else-if="notice" class="inline-notice" role="status">{{ notice }}</p>

      <ItemListEditor
        :rows="rows"
        :dirty="dirty"
        :busy="busy"
        :issues="view.issues"
        add-label="Add search"
        empty-copy="No saved searches yet — add one and bind it to a key."
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
              <span>Search text</span>
              <input v-model="draft[index].text" type="text" maxlength="250" class="search-text" />
            </label>
          </div>
          <p class="muted">
            Typed into the stash search box exactly as written — regex like
            <code>"^Waystone"</code> or <code>"tier: 1[5-6]"</code> works.
          </p>
          <p v-if="!checkOf(draft[index]).ok" class="danger-text">{{ checkOf(draft[index]).reason }}</p>
          <label class="toggle-field">
            <input v-model="draft[index].enabled" type="checkbox" />
            <span>Enabled (an off search contributes no hotkey)</span>
          </label>
          <HotkeyBindCell
            :action-id="`stash-searches.${id}`"
            :label="draft[index].label"
            :hotkey="hotkeyOf(id)"
            :bindable="bindable(id)"
          />
          <p v-if="outcomeLine(id)" class="outcome-line" role="status">{{ outcomeLine(id) }}</p>
        </template>
        <template #row-actions="{ id }">
          <button
            type="button"
            class="button compact secondary"
            :disabled="busy || !saved(id)"
            title="Brings Path of Exile to the front and fills the search box once."
            @click="run(id)"
          >
            {{ view.dryRun ? "Preview (dry-run)" : "Type into stash" }}
          </button>
        </template>
      </ItemListEditor>
    </template>
  </div>
</template>

<style scoped>
.searches-tab {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
}
.search-text {
  font-family: "Cascadia Code", Consolas, monospace;
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
