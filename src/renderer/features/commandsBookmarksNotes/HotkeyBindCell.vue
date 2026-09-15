<script setup lang="ts">
/**
 * Binds one item's hotkey without leaving the editor: capture a combination,
 * validate it through main (grammar, reserved keys, collisions), then rebind.
 * Mirrors the capture rules of Tools → Hotkeys (Esc cancels, blur cancels,
 * a bare modifier keeps waiting).
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { acceleratorFromKeyEvent } from "@core/hotkeyRegistry";
import type { HotkeyRef } from "../../../shared/commandsBookmarksNotes.js";
import type { HotkeyBindingView } from "../../../shared/hotkeys.js";
import { getHotkeysApi } from "../hotkeys/hotkeysApi";

const props = defineProps<{
  actionId: string;
  label: string;
  hotkey?: HotkeyRef;
  /**
   * The row exists in main and has a hotkey action to bind. A never-saved row
   * — and a starter example nobody has kept yet — has none.
   */
  bindable: boolean;
}>();

const api = getHotkeysApi();
const capturing = ref(false);
const note = ref("");
const bad = ref(false);
const busy = ref(false);
/** The registry's own answer, which is fresher than the list snapshot. */
const live = ref<HotkeyBindingView | null>(null);
let stopChanged: (() => void) | undefined;

/**
 * A rebind changes nothing in `commands:changed`, so the row's own snapshot
 * would keep showing "Unbound" until the tab is re-entered. Take the binding
 * from the rebind answer and from `hotkeys:changed` instead.
 */
function adoptBindings(list: readonly HotkeyBindingView[]): void {
  if (!Array.isArray(list)) return;
  const match = list.find((entry) => entry.id === props.actionId);
  if (match) live.value = match;
  else if (live.value) live.value = { ...live.value, accelerator: null, registered: false };
}

// `live` wins whenever it exists — including when it says "unbound now".
const accelerator = computed(() => (live.value ? live.value.accelerator : props.hotkey?.accelerator ?? null));
const bindError = computed(() => (live.value ? live.value.error ?? "" : props.hotkey?.error ?? ""));

function start(): void {
  capturing.value = true;
  note.value = "Press the key combination (Esc cancels).";
  bad.value = false;
}

function cancel(): void {
  capturing.value = false;
  note.value = "";
  bad.value = false;
}

function describe(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

async function apply(next: string | null): Promise<void> {
  if (!api || busy.value) return;
  busy.value = true;
  try {
    adoptBindings(await api.invoke("hotkeys:rebind", props.actionId, next));
    note.value = "";
    bad.value = false;
  } catch (reason) {
    note.value = describe(reason, "The binding could not be saved.");
    bad.value = true;
  } finally {
    busy.value = false;
  }
}

async function onKeydown(event: KeyboardEvent): Promise<void> {
  event.preventDefault();
  event.stopPropagation();
  if (!api || !capturing.value) return;
  if (event.key === "Escape" && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
    cancel();
    return;
  }
  if (event.key === "Backspace" || event.key === "Delete") {
    await apply(null);
    cancel();
    return;
  }
  const accelerator = acceleratorFromKeyEvent(event);
  if (!accelerator) {
    note.value = "Hold a modifier, then press a key…";
    bad.value = false;
    return;
  }
  try {
    const validation = await api.invoke("hotkeys:validate", accelerator, props.actionId);
    if (!validation.ok) {
      note.value = validation.reason ?? `${accelerator} cannot be used.`;
      bad.value = true;
      return;
    }
  } catch (reason) {
    note.value = describe(reason, "Validation failed.");
    bad.value = true;
    return;
  }
  await apply(accelerator);
  cancel();
}

/** The capture input is inserted on demand, so `autofocus` would not fire. */
const vFocus = {
  mounted: (element: HTMLElement) => element.focus(),
};

// A reordered list can hand this cell a different row; forget the old binding.
watch(
  () => props.actionId,
  () => {
    live.value = null;
    cancel();
  },
);

onMounted(() => {
  stopChanged = api?.on("hotkeys:changed", (list) => adoptBindings(list));
});

onBeforeUnmount(() => {
  stopChanged?.();
});
</script>

<template>
  <div class="hotkey-cell">
    <span class="hotkey-cell-label">Hotkey</span>
    <template v-if="!bindable">
      <span class="muted">Save to bind</span>
    </template>
    <template v-else-if="capturing">
      <input
        v-focus
        class="capture-input"
        readonly
        placeholder="Press keys…"
        :aria-label="`Capture shortcut for ${label}`"
        @keydown="onKeydown"
        @blur="cancel"
      />
      <button type="button" class="button compact ghost" @mousedown.prevent @click="cancel">Cancel</button>
    </template>
    <template v-else>
      <kbd v-if="accelerator">{{ accelerator }}</kbd>
      <span v-else class="muted">Unbound</span>
      <button type="button" class="button compact ghost" :disabled="busy || !api" @click="start">Rebind</button>
      <button
        v-if="accelerator"
        type="button"
        class="button compact ghost"
        :disabled="busy"
        @click="apply(null)"
      >
        Clear
      </button>
    </template>
    <span v-if="bindError" class="danger-text">{{ bindError }}</span>
    <span v-if="note" class="capture-note" :class="{ bad }">{{ note }}</span>
  </div>
</template>

<style scoped>
.hotkey-cell {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  flex-wrap: wrap;
  font-size: 0.78rem;
}
.hotkey-cell-label {
  font-weight: 650;
  color: var(--text-muted, #888b8e);
}
.capture-input {
  width: 11rem;
  min-height: 31px;
}
.capture-note {
  font-size: 0.72rem;
  color: var(--text-muted, #888b8e);
}
.capture-note.bad,
.danger-text {
  color: #e5a49f;
}
</style>
