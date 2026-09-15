<script setup lang="ts">
/**
 * Notifications & chat. Deliberately thin: chat commands are the only thing
 * this package owns. Trade webhooks and their secrets live in Trade settings
 * (a *.secret.json file, never the settings document) and the live-search
 * chime lives in Market settings — both are cross-referenced, not duplicated.
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { normalizeChatCommandSettings } from "@core/chatCommands";
import type {
  ChatCommandSettings,
  ChatCommandStatus,
  ChatContract,
  ChatEvents,
} from "../../../shared/chatCommands.js";
import { createFeatureApi } from "../../services/featureApi";
import { useAppSettings } from "./useAppSettings";

const store = useAppSettings();
const chatApi = createFeatureApi<ChatContract, ChatEvents>();

const settings = store.slice<ChatCommandSettings>(
  "chat-commands",
  (raw) => normalizeChatCommandSettings(raw).value,
);
const status = ref<ChatCommandStatus | null>(null);
const busy = ref(false);
const error = ref("");
let stopStatus: (() => void) | undefined;

const statusLine = computed(() => {
  const current = status.value;
  if (!current) return "Status unavailable.";
  const host = current.hostRunning ? "host running" : "host idle";
  const dryRun = current.dryRun ? "dry-run: lines are logged, not typed" : "live";
  return `${current.sentThisMinute}/${current.maxPerMinute} this minute · ${host} · ${dryRun}`;
});

async function toggle(event: Event): Promise<void> {
  const enabled = (event.target as HTMLInputElement).checked;
  busy.value = true;
  error.value = "";
  try {
    await store.patch<ChatCommandSettings>("chat-commands", { enabled });
    await loadStatus();
  } catch (reason) {
    error.value = reason instanceof Error && reason.message ? reason.message : "That change could not be saved.";
  } finally {
    busy.value = false;
  }
}

async function loadStatus(): Promise<void> {
  if (!chatApi) return;
  try {
    status.value = await chatApi.invoke("chat:status");
  } catch {
    status.value = null;
  }
}

onMounted(() => {
  void loadStatus();
  stopStatus = chatApi?.on("chat:status", (next) => (status.value = next));
});
onBeforeUnmount(() => stopStatus?.());
</script>

<template>
  <details class="advanced-options">
    <summary>Notifications &amp; chat</summary>

    <p v-if="error" class="inline-notice danger" role="alert">{{ error }}</p>

    <label class="toggle-field">
      <input type="checkbox" :checked="settings.enabled" :disabled="busy" @change="toggle" />
      <span>
        Allow chat commands (one line per gesture; stopped by Ctrl+Shift+Esc and by the Dry-run switch)
      </span>
    </label>
    <p class="muted" role="status">{{ statusLine }}</p>

    <p class="muted">Trade offers, quick whispers and Discord/Telegram webhooks: Trade → Trade settings.</p>
    <p class="muted">Live-search chime and toasts: Market → Market settings.</p>
  </details>
</template>
