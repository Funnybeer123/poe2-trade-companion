<script setup lang="ts">
/**
 * Commands: a label and one chat line each. The line is previewed against the
 * live placeholder values before it is ever bound to a key, so "unresolved
 * {player}" and "the host cannot type …" are visible in the editor rather
 * than at the moment the key is pressed.
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { CHAT_PLACEHOLDERS } from "@core/chatCommands";
import { commandPreview, STARTER_ISSUE } from "@core/commandsBookmarksNotes";
import type { CommandItem, CommandsView, RunOutcome } from "../../../shared/commandsBookmarksNotes.js";
import { getAppApi, getCommandsApi } from "./api";
import HotkeyBindCell from "./HotkeyBindCell.vue";
import ItemListEditor from "./ItemListEditor.vue";
import type { EditorRow } from "./editorRow";
import PlaceholderChips from "./PlaceholderChips.vue";

const api = getCommandsApi();
const appApi = getAppApi();
const view = ref<CommandsView | null>(null);
const draft = ref<CommandItem[]>([]);
const loading = ref(true);
const busy = ref(false);
const error = ref("");
const notice = ref("");
const pendingDeleteId = ref("");
const outcomes = ref<Record<string, RunOutcome>>({});
/** The tokens the chat service actually understands — never a second list. */
const tokens = CHAT_PLACEHOLDERS.map((name) => `{${name}}`);
let stopChanged: (() => void) | undefined;
let stopDryRun: (() => void) | undefined;
let disposed = false;
let newRowCount = 0;

const dirty = computed(
  () => JSON.stringify(draft.value) !== JSON.stringify(view.value?.commands.map(stripView) ?? []),
);

function stripView(item: CommandsView["commands"][number]): CommandItem {
  return { id: item.id, label: item.label, template: item.template, enabled: item.enabled };
}

function describe(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

function adopt(next: CommandsView): void {
  view.value = next;
  draft.value = next.commands.map(stripView);
  pendingDeleteId.value = "";
}

/**
 * Take the fresh read-only parts (placeholders, dry-run, hotkeys) without
 * throwing away a line the user is still typing.
 */
function refresh(next: CommandsView): void {
  if (dirty.value) {
    view.value = { ...next, commands: view.value?.commands ?? next.commands };
    return;
  }
  adopt(next);
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
    error.value = describe(reason, "The commands could not be loaded.");
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
    { id: `new_${newRowCount}`, label: `Command ${draft.value.length + 1}`, template: "/hideout", enabled: true },
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
    const next = await api.invoke("commands:save", { commands: draft.value });
    if (disposed) return;
    adopt(next);
    notice.value = "Saved.";
  } catch (reason) {
    if (disposed) return;
    error.value = describe(reason, "The commands could not be saved.");
  } finally {
    busy.value = false;
  }
}

function revert(): void {
  if (view.value) draft.value = view.value.commands.map(stripView);
  pendingDeleteId.value = "";
}

async function setFeedbackNotices(value: boolean): Promise<void> {
  if (!api || busy.value) return;
  busy.value = true;
  try {
    const next = await api.invoke("commands:save", { feedbackNotices: value });
    if (disposed) return;
    refresh(next);
  } catch (reason) {
    if (disposed) return;
    error.value = describe(reason, "The setting could not be saved.");
  } finally {
    busy.value = false;
  }
}

async function run(id: string): Promise<void> {
  if (!api || busy.value) return;
  busy.value = true;
  try {
    // A button in the desktop app needs the hand-off: the chat service brings
    // Path of Exile to the front, verifies, then types once.
    const outcome = await api.invoke("commands:run", id, { focus: true });
    if (disposed) return;
    outcomes.value = { ...outcomes.value, [id]: outcome };
  } catch (reason) {
    if (disposed) return;
    error.value = describe(reason, "The command could not be run.");
  } finally {
    busy.value = false;
  }
}

function insertToken(id: string, token: string): void {
  draft.value = draft.value.map((item) =>
    item.id === id ? { ...item, template: `${item.template}${token}` } : item,
  );
}

function previewOf(item: CommandItem) {
  const snapshot = view.value?.placeholders ?? { context: {}, sources: {} };
  return commandPreview(item.template, snapshot);
}

function outcomeLine(id: string): string {
  const outcome = outcomes.value[id];
  if (!outcome) return "";
  if (outcome.dryRun) return `Dry-run · would send: ${outcome.resolved}`;
  if (outcome.ok) return `Sent: ${outcome.sent ?? outcome.resolved}`;
  return `Blocked: ${outcome.blockedBy ?? "unknown"}${outcome.error ? ` — ${outcome.error}` : ""}`;
}

const rows = computed<EditorRow[]>(() =>
  draft.value.map((item) => {
    const preview = previewOf(item);
    return {
      id: item.id,
      title: item.label,
      detail: item.template,
      chip: preview.ok
        ? { label: "Ready", tone: "safe" as const }
        : { label: "Needs attention", tone: "warning" as const },
    };
  }),
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
  return view.value?.commands.find((item) => item.id === id)?.hotkey;
}

onMounted(async () => {
  if (!api) {
    loading.value = false;
    return;
  }
  stopChanged = api.on("commands:changed", (next) => refresh(next));
  // The top-bar Dry-run switch lives outside this tool; follow it so the run
  // button never promises a real send during a dry-run (or the reverse).
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
  <div class="commands-tab">
    <div v-if="loading" class="state-panel compact-state" aria-live="polite">
      <span class="spinner" aria-hidden="true" />
      <p>Loading commands…</p>
    </div>
    <div v-else-if="!view" class="state-panel compact-state">
      <span class="state-icon" aria-hidden="true">!</span>
      <strong>Commands could not be loaded</strong>
      <p role="alert">{{ error || "The desktop app did not answer." }}</p>
      <button type="button" class="button secondary compact" :disabled="busy" @click="retryLoad">Retry</button>
    </div>
    <template v-else>
      <p v-if="!view.chatEnabled" class="inline-notice warning" role="status">
        Chat commands are switched off in Tools → Settings → chat commands; nothing will be typed.
      </p>
      <p v-if="error" class="inline-notice danger" role="alert">{{ error }}</p>
      <p v-else-if="notice" class="inline-notice" role="status">{{ notice }}</p>

      <details class="advanced-options" open>
        <summary>Current placeholder values</summary>
        <PlaceholderChips :snapshot="view.placeholders" />
      </details>

      <ItemListEditor
        :rows="rows"
        :dirty="dirty"
        :busy="busy"
        :issues="view.issues"
        add-label="Add command"
        empty-copy="No commands yet — add one and bind it to a key."
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
              <span>Chat line</span>
              <input v-model="draft[index].template" type="text" maxlength="300" class="template-input" />
            </label>
          </div>
          <div class="chip-row">
            <button
              v-for="token in tokens"
              :key="`${id}-${token}`"
              type="button"
              class="pill"
              :aria-label="`Insert ${token}`"
              @click="insertToken(id, token)"
            >
              {{ token }}
            </button>
          </div>
          <p class="preview-line">
            <code>Would send: {{ previewOf(draft[index]).resolved || "—" }}</code>
          </p>
          <p v-if="previewOf(draft[index]).issues.length" class="danger-text">
            {{ previewOf(draft[index]).issues[0] }}
          </p>
          <p
            v-else-if="draft[index].template && !/^[/@]/.test(draft[index].template)"
            class="muted"
          >
            This line has no <code>/</code> or <code>@</code>: it goes to whatever chat channel the game
            currently has selected — usually local chat.
          </p>
          <label class="toggle-field">
            <input v-model="draft[index].enabled" type="checkbox" />
            <span>Enabled (an off command contributes no hotkey)</span>
          </label>
          <HotkeyBindCell
            :action-id="`commands.${id}`"
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
            :title="
              saved(id)
                ? 'Brings Path of Exile to the front and types this one line once.'
                : 'Save the command first.'
            "
            @click="run(id)"
          >
            {{ view.dryRun ? "Preview send (dry-run)" : "Send now" }}
          </button>
        </template>
      </ItemListEditor>

      <details class="advanced-options">
        <summary>Expert options</summary>
        <label class="toggle-field">
          <input
            type="checkbox"
            :checked="view.feedbackNotices"
            :disabled="busy"
            @change="setFeedbackNotices(($event.target as HTMLInputElement).checked)"
          />
          <span>Show a short overlay notice after every hotkey run</span>
        </label>
      </details>
    </template>
  </div>
</template>

<style scoped>
.commands-tab {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
}
.chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
}
.template-input {
  font-family: "Cascadia Code", Consolas, monospace;
}
.preview-line code {
  font-size: 0.76rem;
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
