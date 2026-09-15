<script setup lang="ts">
/**
 * Replay-lite: the screenshots taken shortly after a death line (or on the
 * capture hotkey). Thumbnails are pulled one at a time so a folder of sixty
 * JPEGs never crosses the bridge at once.
 */
import { onBeforeUnmount, onMounted, ref } from "vue";
import type { DeathCapture } from "../../../../shared/session";
import { getSessionApi } from "../api";
import { describeError, when } from "../format";

const api = getSessionApi();
const captures = ref<DeathCapture[] | null>(null);
const thumbs = ref<Record<string, string>>({});
const loading = ref(true);
const busy = ref(false);
const error = ref("");
const notice = ref("");
const pendingDeleteId = ref("");
let disposed = false;

const SKIP_REASONS: Record<string, string> = {
  disabled: "Death screenshots are turned off in Tools → Settings.",
  "no-source": "No Path of Exile window was offered for capture.",
  "black-frame":
    "The capture came out black — the game blocks screenshots in exclusive fullscreen. Use borderless windowed.",
  "write-failed": "The screenshot could not be written to disk.",
  busy: "A capture is already running.",
  "no-display": "No display could be measured for the capture.",
};

async function loadThumb(capture: DeathCapture): Promise<void> {
  if (!api || thumbs.value[capture.id]) return;
  try {
    const data = await api.invoke("session:death-thumbnail", capture.id);
    if (disposed || !data) return;
    thumbs.value = { ...thumbs.value, [capture.id]: data };
  } catch {
    // A missing thumbnail is not worth an error banner.
  }
}

async function load(): Promise<void> {
  if (!api) return;
  try {
    const next = await api.invoke("session:deaths", 50);
    if (disposed) return;
    captures.value = next;
    for (const capture of next) void loadThumb(capture);
  } catch (reason) {
    if (disposed) return;
    error.value = describeError(reason, "Screenshots could not be listed.");
  }
}

async function open(id: string): Promise<void> {
  if (!api || busy.value) return;
  busy.value = true;
  notice.value = "";
  try {
    const ok = await api.invoke("session:death-open", id);
    if (disposed) return;
    if (!ok) notice.value = "That screenshot could not be opened.";
  } catch (reason) {
    if (disposed) return;
    error.value = describeError(reason, "That screenshot could not be opened.");
  } finally {
    busy.value = false;
  }
}

async function remove(id: string): Promise<void> {
  if (!api || busy.value) return;
  if (pendingDeleteId.value !== id) {
    pendingDeleteId.value = id;
    return;
  }
  busy.value = true;
  pendingDeleteId.value = "";
  try {
    const next = await api.invoke("session:death-delete", id);
    if (disposed) return;
    captures.value = next;
  } catch (reason) {
    if (disposed) return;
    error.value = describeError(reason, "That screenshot could not be deleted.");
  } finally {
    busy.value = false;
  }
}

async function captureNow(): Promise<void> {
  if (!api || busy.value) return;
  busy.value = true;
  notice.value = "";
  error.value = "";
  try {
    const result = await api.invoke("session:capture-now");
    if (disposed) return;
    if (result && "skipped" in result) notice.value = SKIP_REASONS[result.skipped] ?? "The capture was skipped.";
    else await load();
  } catch (reason) {
    if (disposed) return;
    error.value = describeError(reason, "The screenshot could not be taken.");
  } finally {
    busy.value = false;
  }
}

async function openFolder(): Promise<void> {
  if (!api || busy.value) return;
  busy.value = true;
  try {
    await api.invoke("session:deaths-open-folder");
  } catch (reason) {
    if (disposed) return;
    error.value = describeError(reason, "The folder could not be opened.");
  } finally {
    busy.value = false;
  }
}

onMounted(async () => {
  await load();
  if (!disposed) loading.value = false;
});
onBeforeUnmount(() => {
  disposed = true;
});
</script>

<template>
  <section class="card tool-panel deaths-panel" aria-labelledby="deaths-title">
    <div class="section-heading">
      <div>
        <span class="eyebrow">Replay-lite</span>
        <h2 id="deaths-title">Deaths</h2>
      </div>
      <span class="status-chip neutral">Screenshots, not video</span>
    </div>

    <div v-if="!api" class="state-panel compact-state">
      <span class="state-icon" aria-hidden="true">◇</span>
      <strong>Screenshots need the desktop app</strong>
      <p>This preview has no bridge.</p>
    </div>
    <div v-else-if="loading" class="state-panel compact-state" aria-live="polite">
      <span class="spinner" aria-hidden="true" />
      <p>Loading screenshots…</p>
    </div>
    <template v-else>
      <div class="button-row">
        <button type="button" class="button primary compact" :disabled="busy" @click="captureNow">
          {{ busy ? "Capturing…" : "Capture now" }}
        </button>
        <button type="button" class="button ghost compact" :disabled="busy" @click="openFolder">
          Open folder
        </button>
        <p class="privacy-note">Screenshots stay on this PC and can show chat and player names.</p>
      </div>
      <p v-if="notice" class="inline-notice" role="status">{{ notice }}</p>
      <p v-if="error" class="inline-notice danger" role="alert">{{ error }}</p>

      <p v-if="!captures?.length" class="empty-copy">
        No screenshots yet — one is taken automatically a moment after each death.
      </p>
      <ul v-else class="death-grid" aria-label="Death screenshots">
        <li v-for="capture in captures" :key="capture.id">
          <button
            type="button"
            class="thumb-button"
            :disabled="busy"
            :aria-label="`Open screenshot from ${capture.areaName ?? 'an unknown area'} at ${when(capture.at)}`"
            @click="open(capture.id)"
          >
            <img v-if="thumbs[capture.id]" :src="thumbs[capture.id]" alt="" />
            <span v-else class="thumb-placeholder" aria-hidden="true">◇</span>
          </button>
          <span class="death-copy">
            <strong>{{ capture.areaName ?? capture.areaId ?? "Unknown area" }}</strong>
            <small class="muted">
              {{ when(capture.at) }} · {{ capture.character ?? "unknown" }}
              <template v-if="capture.kind === 'manual'"> · manual</template>
            </small>
          </span>
          <button
            type="button"
            class="button danger compact"
            :disabled="busy"
            :aria-label="pendingDeleteId === capture.id ? `Confirm delete ${capture.id}` : `Delete ${capture.id}`"
            @click="remove(capture.id)"
          >
            {{ pendingDeleteId === capture.id ? "Confirm" : "Delete" }}
          </button>
        </li>
      </ul>
    </template>

    <p class="disclaimer">
      One frame per death, taken shortly after the line appears — there is no pre-death buffer and no
      video. Nothing is uploaded.
    </p>
  </section>
</template>

<style scoped>
.deaths-panel { display: flex; flex-direction: column; gap: 0.7rem; }
.death-grid { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr)); gap: 0.8rem; }
.death-grid li { display: flex; flex-direction: column; gap: 0.35rem; }
.thumb-button { padding: 0; border: 1px solid var(--line, #2b3038); border-radius: 8px; background: var(--panel-soft, #121519); cursor: pointer; overflow: hidden; min-height: 7rem; display: flex; align-items: center; justify-content: center; }
.thumb-button img { display: block; width: 100%; height: auto; }
.thumb-placeholder { opacity: 0.4; font-size: 1.4rem; }
.death-copy { display: flex; flex-direction: column; min-width: 0; }
.death-copy small { opacity: 0.7; }
</style>
