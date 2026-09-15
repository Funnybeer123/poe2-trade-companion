<script setup lang="ts">
/**
 * Desktop-window options plus the "get me out of trouble" reset: a panel that
 * ended up on a monitor that no longer exists is exactly what Reset window
 * positions recovers from (it hides pinned panels too, so the next show
 * re-anchors them).
 */
import { ref } from "vue";
import { normalizeAppSettings, type AppSettings } from "../../../shared/appSettings.js";
import { getAppSettingsApi } from "./appSettingsApi";
import { useAppSettings } from "./useAppSettings";

const store = useAppSettings();
const api = getAppSettingsApi();

const settings = store.slice<AppSettings>("app", normalizeAppSettings);
const busy = ref(false);
const error = ref("");
const note = ref("");

async function patchWindow(value: Partial<AppSettings["window"]>): Promise<void> {
  busy.value = true;
  error.value = "";
  try {
    await store.patch<AppSettings>("app", { window: { ...settings.value.window, ...value } });
  } catch (reason) {
    error.value = reason instanceof Error && reason.message ? reason.message : "That change could not be saved.";
  } finally {
    busy.value = false;
  }
}

function onFlag(key: "rememberBounds" | "alwaysOnTop" | "showOnGameStart", event: Event): void {
  void patchWindow({ [key]: (event.target as HTMLInputElement).checked });
}

async function resetWindows(): Promise<void> {
  if (!api) return;
  busy.value = true;
  error.value = "";
  note.value = "";
  try {
    const result = await api.invoke("app:reset-windows");
    const panels = result.overlayPanelsHidden;
    note.value = `Window re-centred · ${panels} overlay panel${panels === 1 ? "" : "s"} hidden`;
  } catch (reason) {
    error.value = reason instanceof Error && reason.message ? reason.message : "The windows could not be reset.";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <details class="advanced-options">
    <summary>Window</summary>

    <p v-if="error" class="inline-notice danger" role="alert">{{ error }}</p>

    <label class="toggle-field">
      <input
        type="checkbox"
        :checked="settings.window.rememberBounds"
        :disabled="busy"
        @change="onFlag('rememberBounds', $event)"
      />
      <span>Remember the window position and size</span>
    </label>
    <label class="toggle-field">
      <input
        type="checkbox"
        :checked="settings.window.alwaysOnTop"
        :disabled="busy"
        @change="onFlag('alwaysOnTop', $event)"
      />
      <span>Keep the companion window above the game</span>
    </label>

    <details class="advanced-options nested">
      <summary>Expert</summary>
      <label class="toggle-field">
        <input
          type="checkbox"
          :checked="settings.window.showOnGameStart"
          :disabled="busy"
          @change="onFlag('showOnGameStart', $event)"
        />
        <span>Open the companion window when the game starts</span>
      </label>
      <p class="muted">
        Checked about every 20 seconds while the window is hidden or minimised; it never takes focus
        away from the game.
      </p>
    </details>

    <div class="button-row">
      <button type="button" class="button secondary compact" :disabled="busy || !api" @click="resetWindows">
        Reset window positions
      </button>
      <span v-if="note" class="success-text" role="status">{{ note }}</span>
    </div>
  </details>
</template>
