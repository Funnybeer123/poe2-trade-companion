<script setup lang="ts">
/**
 * "Overlay & command hotkeys" — a section for Tools → Hotkeys. Lists every
 * action features contributed (grouped), captures a key combination into an
 * Electron accelerator, validates it live through main (grammar, reserved
 * keys, collisions) and rebinds on the spot; registration failures from
 * the OS are shown next to the binding.
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { acceleratorFromKeyEvent } from "@core/hotkeyRegistry";
import type { HotkeyBindingView } from "../../../shared/hotkeys.js";
import { getHotkeysApi } from "./hotkeysApi";

const api = getHotkeysApi();
const bindings = ref<HotkeyBindingView[]>([]);
const loading = ref(true);
const error = ref("");
const busy = ref(false);
const capturingId = ref("");
const captureNote = ref("");
const captureBad = ref(false);
let stopChanges: (() => void) | undefined;
let disposed = false;

/** The capture input is inserted on demand, so `autofocus` would not fire; focus it on mount. */
const vFocus = {
  mounted: (element: HTMLElement) => element.focus(),
};

const groups = computed(() => {
  const byGroup = new Map<string, HotkeyBindingView[]>();
  for (const binding of bindings.value) {
    const list = byGroup.get(binding.group) ?? [];
    list.push(binding);
    byGroup.set(binding.group, list);
  }
  return [...byGroup.entries()].map(([name, actions]) => ({ name, actions }));
});

function describe(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

async function load(): Promise<void> {
  if (!api) return;
  try {
    const next = await api.invoke("hotkeys:list");
    if (disposed) return;
    bindings.value = next;
    error.value = "";
  } catch (reason) {
    if (disposed) return;
    error.value = describe(reason, "The hotkey bindings could not be loaded.");
  }
}

async function retry(): Promise<void> {
  loading.value = true;
  await load();
  loading.value = false;
}

function startCapture(id: string): void {
  capturingId.value = id;
  captureNote.value = "Press the key combination (Esc cancels).";
  captureBad.value = false;
}

function cancelCapture(): void {
  capturingId.value = "";
  captureNote.value = "";
  captureBad.value = false;
}

async function apply(id: string, accelerator: string | null): Promise<void> {
  if (!api || busy.value) return;
  busy.value = true;
  try {
    bindings.value = await api.invoke("hotkeys:rebind", id, accelerator);
    error.value = "";
  } catch (reason) {
    error.value = describe(reason, "The binding could not be saved.");
  } finally {
    busy.value = false;
  }
}

async function onCaptureKeydown(event: KeyboardEvent): Promise<void> {
  event.preventDefault();
  event.stopPropagation();
  if (!api || !capturingId.value) return;
  if (event.key === "Escape" && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
    cancelCapture();
    return;
  }
  const accelerator = acceleratorFromKeyEvent(event);
  if (!accelerator) {
    captureNote.value = "Hold a modifier, then press a key…";
    captureBad.value = false;
    return;
  }
  const id = capturingId.value;
  try {
    const validation = await api.invoke("hotkeys:validate", accelerator, id);
    if (!validation.ok) {
      captureNote.value = validation.reason ?? `${accelerator} cannot be used.`;
      captureBad.value = true;
      return;
    }
  } catch (reason) {
    captureNote.value = describe(reason, "Validation failed.");
    captureBad.value = true;
    return;
  }
  await apply(id, accelerator);
  cancelCapture();
}

async function reset(id?: string): Promise<void> {
  if (!api || busy.value) return;
  busy.value = true;
  try {
    bindings.value = await api.invoke("hotkeys:reset", id);
    error.value = "";
  } catch (reason) {
    error.value = describe(reason, "The binding could not be reset.");
  } finally {
    busy.value = false;
  }
}

function statusOf(binding: HotkeyBindingView): { label: string; tone: "safe" | "danger" | "neutral" } {
  if (binding.error) return { label: "Not active", tone: "danger" };
  if (binding.registered) return { label: "Active", tone: "safe" };
  return { label: "Unbound", tone: "neutral" };
}

function isDefault(binding: HotkeyBindingView): boolean {
  return (binding.accelerator ?? null) === (binding.defaultAccelerator ?? null);
}

onMounted(async () => {
  if (!api) {
    loading.value = false;
    return;
  }
  stopChanges = api.on("hotkeys:changed", (next) => {
    bindings.value = next;
  });
  await load();
  loading.value = false;
});

onBeforeUnmount(() => {
  disposed = true;
  stopChanges?.();
});
</script>

<template>
  <section class="card tool-panel overlay-hotkeys" aria-labelledby="overlay-hotkeys-title">
    <header class="section-heading">
      <div>
        <h2 id="overlay-hotkeys-title">Overlay &amp; command hotkeys</h2>
        <p class="muted">
          Global shortcuts for the overlay panels and commands. Click <strong>Rebind</strong>, then press the
          combination. <kbd>Ctrl+D</kbd>, <kbd>Ctrl+Shift+Esc</kbd>, <kbd>Ctrl+C</kbd>/<kbd>V</kbd>, the voice
          hotkey and the numpad daemon keys stay reserved.
        </p>
      </div>
      <span v-if="bindings.length" class="count-badge">{{ bindings.length }}</span>
    </header>

    <p v-if="!api" class="empty-copy">Hotkeys are managed by the desktop app; this preview cannot bind them.</p>
    <p v-else-if="loading" class="muted">Loading bindings…</p>
    <template v-else>
      <p v-if="error" class="issue" role="alert">
        {{ error }}
        <button type="button" class="button compact ghost" @click="retry">Retry</button>
      </p>
      <p v-if="!bindings.length && !error" class="empty-copy">
        No feature has contributed a hotkey action yet.
      </p>

      <div v-for="group in groups" :key="group.name" class="hotkey-group">
        <h3>{{ group.name }}</h3>
        <table class="bindings">
          <thead>
            <tr>
              <th scope="col">Action</th>
              <th scope="col">Shortcut</th>
              <th scope="col">Status</th>
              <th scope="col"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="binding in group.actions" :key="binding.id" :data-action-id="binding.id">
              <td>
                <strong>{{ binding.label }}</strong>
                <div v-if="binding.detail" class="muted">{{ binding.detail }}</div>
              </td>
              <td>
                <template v-if="capturingId === binding.id">
                  <input
                    v-focus
                    class="capture-input"
                    readonly
                    placeholder="Press keys…"
                    :aria-label="`Capture shortcut for ${binding.label}`"
                    @keydown="onCaptureKeydown"
                    @blur="cancelCapture"
                  />
                  <div class="capture-note" :class="{ bad: captureBad }">{{ captureNote }}</div>
                </template>
                <template v-else>
                  <kbd v-if="binding.accelerator">{{ binding.accelerator }}</kbd>
                  <span v-else class="muted">Unbound</span>
                </template>
              </td>
              <td>
                <span class="status-chip" :class="statusOf(binding).tone">{{ statusOf(binding).label }}</span>
                <div v-if="binding.error" class="binding-error">{{ binding.error }}</div>
              </td>
              <td class="row-actions">
                <button
                  v-if="capturingId !== binding.id"
                  type="button"
                  class="button compact primary"
                  :disabled="busy"
                  @click="startCapture(binding.id)"
                >
                  Rebind
                </button>
                <button v-else type="button" class="button compact ghost" @mousedown.prevent @click="cancelCapture">
                  Cancel
                </button>
                <button
                  v-if="binding.accelerator"
                  type="button"
                  class="button compact ghost"
                  :disabled="busy"
                  @click="apply(binding.id, null)"
                >
                  Clear
                </button>
                <button
                  v-if="!isDefault(binding)"
                  type="button"
                  class="button compact ghost"
                  :disabled="busy"
                  @click="reset(binding.id)"
                >
                  Reset
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <details v-if="bindings.length" class="advanced-options">
        <summary>Reset every shortcut to its default</summary>
        <button type="button" class="button compact danger" :disabled="busy" @click="reset()">Reset all</button>
      </details>
    </template>
  </section>
</template>

<style scoped>
.overlay-hotkeys h3 {
  margin: 0.9rem 0 0.2rem;
  font-size: 0.78rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted);
}
.bindings {
  width: 100%;
  border-collapse: collapse;
  margin: 0.4rem 0 0.6rem;
}
.bindings th,
.bindings td {
  text-align: left;
  padding: 0.4rem 0.6rem;
  border-bottom: 1px solid rgba(128, 128, 128, 0.2);
  vertical-align: top;
}
.row-actions {
  white-space: nowrap;
}
.row-actions .button + .button {
  margin-left: 0.35rem;
}
.capture-input {
  width: 12rem;
  min-height: 32px;
  padding: 0.3rem 0.5rem;
  border-color: var(--gold);
}
.capture-note {
  margin-top: 0.25rem;
  font-size: 0.72rem;
  color: var(--text-muted);
}
.capture-note.bad,
.binding-error,
.issue {
  color: #e5a49f;
  font-size: 0.74rem;
}
.issue {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.advanced-options {
  margin-top: 0.6rem;
}
.advanced-options summary {
  cursor: pointer;
  color: var(--text-muted);
  font-size: 0.78rem;
}
.advanced-options .button {
  margin-top: 0.5rem;
}
</style>
