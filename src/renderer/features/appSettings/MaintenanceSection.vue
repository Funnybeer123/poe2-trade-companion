<script setup lang="ts">
/**
 * Version, where the data lives, and the two-click "start over" button.
 *
 * The reset only ever touches the `app` and `overlay` namespaces — main
 * refuses every other id — so a mis-click can never wipe trade history,
 * market settings or anything holding a secret.
 */
import { ref } from "vue";
import type { AppInfo } from "../../../shared/appSettings.js";
import { getAppSettingsApi } from "./appSettingsApi";

const props = defineProps<{ info: AppInfo | null }>();

const api = getAppSettingsApi();
const busy = ref(false);
const pendingReset = ref(false);
const error = ref("");
const note = ref("");

async function openFolder(which: "userData" | "configDir"): Promise<void> {
  if (!api) return;
  busy.value = true;
  error.value = "";
  try {
    const result = await api.invoke("app:open-folder", which);
    if (!result.ok) error.value = result.error ?? "The folder could not be opened.";
  } catch (reason) {
    error.value = reason instanceof Error && reason.message ? reason.message : "The folder could not be opened.";
  } finally {
    busy.value = false;
  }
}

async function resetSettings(): Promise<void> {
  if (!api) return;
  if (!pendingReset.value) {
    pendingReset.value = true;
    return;
  }
  pendingReset.value = false;
  busy.value = true;
  error.value = "";
  note.value = "";
  try {
    await api.invoke("app:reset-settings", ["app", "overlay"]);
    note.value = "App and overlay settings are back to their defaults.";
  } catch (reason) {
    error.value = reason instanceof Error && reason.message ? reason.message : "The settings could not be reset.";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <details class="advanced-options">
    <summary>About &amp; maintenance</summary>

    <p v-if="error" class="inline-notice danger" role="alert">{{ error }}</p>

    <dl v-if="props.info" class="property-list">
      <div>
        <dt>Version</dt>
        <dd>{{ props.info.version }} · {{ props.info.buildMode }}</dd>
      </div>
      <div>
        <dt>Runtime</dt>
        <dd>Electron {{ props.info.electron }} · Node {{ props.info.node }} · Chrome {{ props.info.chrome }}</dd>
      </div>
      <div>
        <dt>Data folder</dt>
        <dd>{{ props.info.userDataDir }}</dd>
      </div>
      <div>
        <dt>Shared config folder</dt>
        <dd>{{ props.info.configDir }}</dd>
      </div>
      <div>
        <dt>Settings file</dt>
        <dd>{{ props.info.settingsFile }}</dd>
      </div>
      <div>
        <dt>Hotkeys file</dt>
        <dd>{{ props.info.hotkeysFile }}</dd>
      </div>
    </dl>

    <div class="button-row">
      <button type="button" class="button ghost compact" :disabled="busy || !api" @click="openFolder('userData')">
        Open data folder
      </button>
      <button type="button" class="button ghost compact" :disabled="busy || !api" @click="openFolder('configDir')">
        Open shared config folder
      </button>
    </div>

    <p class="privacy-note">
      The settings file holds overlay, app, chat-command and per-feature settings — never a token or
      cookie (those live in their own <code>*.secret.json</code> files).
    </p>

    <div class="button-row">
      <button type="button" class="button danger compact" :disabled="busy || !api" @click="resetSettings">
        {{ pendingReset ? "Click again to confirm" : "Reset app & overlay settings" }}
      </button>
      <button v-if="pendingReset" type="button" class="button ghost compact" @click="pendingReset = false">
        Cancel
      </button>
      <span v-if="note" class="success-text" role="status">{{ note }}</span>
    </div>
  </details>
</template>
