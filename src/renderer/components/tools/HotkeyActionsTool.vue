<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { hotkeysApi } from "../../services/rendererApi";
import type { HotkeysStatePayload } from "../../../shared/ipc.js";

const state = ref<(HotkeysStatePayload & { preview: boolean }) | null>(null);
const draft = ref<Record<string, number | null>>({});
const issues = ref<string[]>([]);
const savedNote = ref("");
const daemon = ref<{ exists: boolean; lastEventAt?: string; lastLine?: string }>({ exists: false });

const bindableKeys = [1, 2, 3, 4, 6, 7];

const dirty = computed(() => {
  if (!state.value) return false;
  return Object.keys(draft.value).some(
    (id) => draft.value[id] !== state.value?.bindings[id],
  );
});

const daemonSummary = computed(() => {
  if (!daemon.value.exists) {
    return "Daemon log not found — the hotkey daemon has never run here.";
  }
  const when = daemon.value.lastEventAt
    ? new Date(daemon.value.lastEventAt).toLocaleString()
    : "unknown";
  return `Last daemon activity: ${when}`;
});

function keyTakenBy(key: number, exceptId: string): string | undefined {
  if (!state.value) return undefined;
  const holder = state.value.actions.find(
    (action) => action.id !== exceptId && draft.value[action.id] === key,
  );
  return holder?.label;
}

function setKey(actionId: string, raw: string): void {
  savedNote.value = "";
  draft.value = { ...draft.value, [actionId]: raw === "" ? null : Number(raw) };
}

async function save(): Promise<void> {
  const result = await hotkeysApi.save(draft.value);
  issues.value = result.issues;
  draft.value = { ...result.bindings };
  if (state.value) state.value = { ...state.value, bindings: { ...result.bindings } };
  savedNote.value = result.preview
    ? "Preview mode — bindings were validated but not persisted (no native bridge)."
    : "Saved. A running daemon picks the change up on its next keypress.";
}

function revert(): void {
  if (state.value) draft.value = { ...state.value.bindings };
  issues.value = [];
  savedNote.value = "";
}

async function refreshDaemon(): Promise<void> {
  daemon.value = await hotkeysApi.daemonStatus();
}

onMounted(async () => {
  const loaded = await hotkeysApi.load();
  state.value = loaded;
  draft.value = { ...loaded.bindings };
  issues.value = loaded.issues;
  await refreshDaemon();
});
</script>

<template>
  <section class="card tool-panel hotkeys-tool" aria-labelledby="hotkeys-title">
    <header>
      <h2 id="hotkeys-title">Numpad hotkey actions</h2>
      <p class="muted">
        One-press game actions handled by the standalone hotkey daemon — start it with
        <code>npm run actions:daemon</code>. Bindings save to
        <code>artifacts/hotkey-bindings.json</code> and apply to a running daemon immediately.
      </p>
    </header>

    <p class="daemon-status" :class="{ live: daemon.exists }">
      {{ daemonSummary }}
      <button type="button" class="ghost" @click="refreshDaemon">Refresh</button>
    </p>

    <table v-if="state" class="bindings">
      <thead>
        <tr>
          <th scope="col">Key</th>
          <th scope="col">Action</th>
          <th scope="col">Where</th>
          <th scope="col">What it does</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="action in state.actions" :key="action.id">
          <td>
            <select
              :value="draft[action.id] ?? ''"
              :aria-label="`Key for ${action.label}`"
              @change="setKey(action.id, ($event.target as HTMLSelectElement).value)"
            >
              <option value="">Unbound</option>
              <option
                v-for="key in bindableKeys"
                :key="key"
                :value="key"
                :disabled="Boolean(keyTakenBy(key, action.id))"
              >
                Num{{ key }}{{ keyTakenBy(key, action.id) ? ` — ${keyTakenBy(key, action.id)}` : "" }}
              </option>
            </select>
          </td>
          <td><strong>{{ action.label }}</strong></td>
          <td><span class="context-chip" :class="action.context">{{ action.context }}</span></td>
          <td class="muted">{{ action.detail }}</td>
        </tr>
      </tbody>
    </table>

    <div class="actions-row">
      <button type="button" :disabled="!dirty" @click="save">Save bindings</button>
      <button type="button" class="ghost" :disabled="!dirty" @click="revert">Revert</button>
      <span v-if="savedNote" class="muted">{{ savedNote }}</span>
    </div>
    <ul v-if="issues.length" class="issues">
      <li v-for="issue in issues" :key="issue">{{ issue }}</li>
    </ul>

    <details>
      <summary>Reserved control keys (always active during a run)</summary>
      <ul v-if="state" class="reserved">
        <li v-for="entry in state.reserved" :key="entry.key">
          <strong>Num{{ entry.key }}</strong> — {{ entry.label }}
        </li>
      </ul>
    </details>
  </section>
</template>

<style scoped>
.hotkeys-tool code {
  font-size: 0.85em;
}
.daemon-status {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  color: var(--text-muted, #9aa);
}
.daemon-status.live {
  color: inherit;
}
.bindings {
  width: 100%;
  border-collapse: collapse;
  margin: 0.75rem 0;
}
.bindings th,
.bindings td {
  text-align: left;
  padding: 0.4rem 0.6rem;
  border-bottom: 1px solid rgba(128, 128, 128, 0.2);
  vertical-align: top;
}
.context-chip {
  font-size: 0.75em;
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
  border: 1px solid currentColor;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.context-chip.map {
  color: #6fb3ff;
}
.context-chip.hideout {
  color: #c9a86a;
}
.actions-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}
.issues {
  color: #d08a3e;
  margin: 0.5rem 0 0;
  padding-left: 1.2rem;
}
.reserved {
  margin: 0.5rem 0 0;
  padding-left: 1.2rem;
}
.muted {
  color: var(--text-muted, #9aa);
}
button.ghost {
  background: transparent;
}
</style>
